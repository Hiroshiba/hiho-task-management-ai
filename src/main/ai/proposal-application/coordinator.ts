import { recordApplicationDiagnostic, reportSharedPostApplyCause as reportSharedCause } from "../../application/proposal-apply/application-diagnostic";
import { validateAbortSignal, throwIfAborted, parseSynchronizationResult, validateOperationWriterResult, isDefinitiveCreateRejection } from "../../application/proposal-apply/application-validation";
import { buildApplicationPlanEntry } from "../../application/proposal-apply/application-plan-entry";
import { operationTemporaryReferences, createTaskTemporaryReferences } from "../../application/proposal-apply/recovery-references";
import { createRecoveryTaskReads, uniqueTaskMap as indexRecoveryTasks, matchingExternalTasks as findRecoveryTasksByUuid } from "../../application/proposal-apply/recovery-task-read";
import { throwRecoveryFailure } from "../../application/proposal-apply/recovery-failure";
import { completeDefinitiveCreateTaskRejection } from "../../application/proposal-apply/create-rejection-completion";
import { createOperationResult, writerResultToApplicationResult, unknownOperationResult, incompleteJournalResult } from "../../application/proposal-apply/operation-result";
import { journalOperationForProposalOperation as convertJournalOperation, proposalOperationForJournalOperation as convertProposalOperation, baselineSourceForOperation as deriveBaselineSource } from "../../application/proposal-apply/recovery-plan-conversion";
import { buildRecoveryWriterInput, resolveBaselineFromJournalPlan, compareMemoryBaselineSource } from "../../application/proposal-apply/recovery-writer-input";
import { startRecoveryJournals } from "../../application/proposal-apply/recovery-journal-start";
import { completeRecoveredOperations } from "../../application/proposal-apply/recovery-completion";
import { resolveExistingJournal } from "../../application/proposal-apply/existing-journal-result";
import { buildApplicationResult, buildRecoveryApplicationResult, collectRecoveryApplications } from "../../application/proposal-apply/application-result";
import { recoverPlannedOperations } from "../../application/proposal-apply/recovery-operations";
import { prepareRecoveryStates, type PlannedRecoveryEntry as PreparedRecoveryEntry } from "../../application/proposal-apply/recovery-state";
import {
  targetGid,
  operationTargetForJournal,
  validateBaselineCoverage as validateBaselineCoverageValues,
  operationUsesCustomExternalData,
  type OperationContext as RecoveryOperationContext,
  type RecoverySettings,
} from "../../application/proposal-apply/recovery-plan";
import { finalizePendingJournals } from "../../application/proposal-apply/post-apply-completion";
import { prepareApplication } from "../../application/proposal-apply/apply-planning";
import { writePreparedOperation } from "../../application/proposal-apply/apply-write-operation";
import { applyPreparedApplication } from "../../application/proposal-apply/apply-writing";
import {
  applicationJournalOperationSchema,
  asanaTaskResponseSchema,
  canonicalizeJson,
  externalTaskGidSchema,
  isoDateTimeSchema,
  parseCustomExternalData,
  serializeCustomExternalData,
  type ApplicationJournalOperation,
  type AsanaTaskResponse,
} from "../../../shared/domain";
import {
  proposalApprovalResultSchema,
  classifyProposalConflicts,
} from "../../domain/proposal-analysis/conflict-classifier";
import { validateSelectedProposalGraph } from "../../domain/proposal-analysis/graph";
import {
  proposalOperationSchema,
  type Proposal,
  type ProposalOperation,
} from "../../../shared/ai";
import {
  applicationJournalResultSchema,
  applicationJournalPlanSchema,
  applicationJournalWithPlanSchema,
  type ApplicationJournal,
  type ApplicationJournalBaselineSource,
  type ApplicationJournalPlan,
  type ApplicationJournalResult,
  type ApplicationJournalStage,
} from "../../../shared/storage";
import {
  AsanaAuthenticationError,
  AsanaEventsResetError,
  AsanaHttpError,
  AsanaPaymentRequiredError,
  AsanaRateLimitError,
  AsanaResponseError,
  AsanaTransportError,
  getUniqueAsanaHttpStatus,
} from "../../asana/transport";
import { AsanaReadClient } from "../../asana/client/client";
import {
  combineDiagnosticFailureDispositions,
  DiagnosticFailureDispositionError,
  diagnosticFailureDispositionFromError,
  type DiagnosticFailureDisposition,
} from "../../application/common/errors/diagnostic-failure";
import {
  AsanaProposalOperationWriter,
  CreateTaskNotFoundError,
  type ProposalOperationWriteAction,
} from "./operation-writer";
import {
  asanaProposalApplicationInputSchema,
  asanaProposalApplicationResultSchema,
  asanaProposalOperationWriterResultSchema,
  asanaPostWriteSynchronizationResultSchema,
  asanaProposalRecoveryInputSchema,
  asanaProposalRecoveryResultSchema,
  applicationJournalDiagnosticSchema,
  type AsanaProposalApplicationInput,
  type AsanaProposalApplicationResult,
  type AsanaProposalRecoveryInput,
  type AsanaProposalRecoveryResult,
  type ApplicationJournalDiagnostic,
  type AsanaProposalOperationWriterInput,
  type AsanaProposalOperationWriterResult,
  type PostWriteSynchronizationResult,
} from "./schemas";

type ApplicationOperationResult =
  AsanaProposalApplicationResult["operations"][number];
type WriterInput = AsanaProposalOperationWriterInput;
type WriterResult = AsanaProposalOperationWriterResult;
export type PostWriteSynchronizationResultWithCause = PostWriteSynchronizationResult & {
  readonly cause?: unknown;
};
type BaselineExternal = NonNullable<WriterInput["baseline_external_data"]>;
type ApplicationJournalStorePort = {
  readonly prepare: (entries: readonly ApplicationJournal[]) => void;
  readonly recordCreatedTask: (
    proposalId: string,
    operationId: string,
    temporaryRef: string,
    taskGid: string,
  ) => void;
  readonly updateStage: (
    proposalId: string,
    operationId: string,
    stage: ApplicationJournalStage,
  ) => void;
  readonly complete: (
    proposalId: string,
    operationId: string,
    finalResult: ApplicationJournalResult,
  ) => void;
  readonly clearRecoveryCause: (proposalId: string, operationId: string) => void;
  readonly get: (
    proposalId: string,
    operationId: string,
  ) => ApplicationJournal | undefined;
  readonly getByProposal: (proposalId: string) => readonly ApplicationJournal[];
  readonly getIncomplete: () => readonly ApplicationJournal[];
};
type ProposalApplicationDiagnostic = (
  error: unknown,
  event: ApplicationJournalDiagnostic,
) => void;
type JournalDiagnosticFields = Omit<ApplicationJournalDiagnostic, "kind">;
type OperationDiagnosticFields = Pick<
  JournalDiagnosticFields,
  | "severity"
  | "api_action"
  | "journal_stage"
  | "effect_certainty"
  | "reason_code"
  | "recovery_decision"
  | "attempt"
  | "phase"
>;
type OperationDiagnosticContext = {
  readonly journal: ApplicationJournal;
  readonly context: OperationContext;
};
type StorageDatabaseJournalPort = {
  readonly prepareApplicationJournals: (entries: readonly ApplicationJournal[]) => void;
  readonly recordApplicationJournalTaskCreated: (
    proposalId: string,
    operationId: string,
    temporaryRef: string,
    taskGid: string,
  ) => void;
  readonly updateApplicationJournalStage: (
    proposalId: string,
    operationId: string,
    stage: ApplicationJournalStage,
  ) => void;
  readonly completeApplicationJournal: (
    proposalId: string,
    operationId: string,
    finalResult: ApplicationJournalResult,
  ) => void;
  readonly clearApplicationJournalRecoveryCause: (
    proposalId: string,
    operationId: string,
  ) => void;
  readonly getApplicationJournal: (
    proposalId: string,
    operationId: string,
  ) => ApplicationJournal | undefined;
  readonly getApplicationJournalsByProposal: (
    proposalId: string,
  ) => readonly ApplicationJournal[];
  readonly getIncompleteApplicationJournals: () => readonly ApplicationJournal[];
};
type JournalPort = ApplicationJournalStorePort | StorageDatabaseJournalPort;
type PlannedApplicationJournal = Extract<ApplicationJournal, { plan: ApplicationJournalPlan }>;
type ExistingJournalDisposition =
  | {
      readonly kind: "return_result";
      readonly block_group: boolean;
      readonly result: ApplicationOperationResult;
    }
  | {
      readonly kind: "resume_local_completion";
      readonly entry: PlannedApplicationJournal;
      readonly result: ApplicationOperationResult;
      readonly task_gid: string;
    }
  | {
      readonly kind: "persist_final_result";
      readonly entry: PlannedApplicationJournal;
      readonly result: ApplicationOperationResult;
      readonly task_gid: string;
    };
type PlannedRecoveryEntry = PreparedRecoveryEntry<PlannedApplicationJournal, ProposalOperation>;

const definitiveCreateTaskRejectionStatuses: ReadonlySet<number> = new Set([400, 401, 402, 403, 404, 429, 451]);

const parsePostWriteSynchronizationResult = (
  value: PostWriteSynchronizationResultWithCause,
): PostWriteSynchronizationResultWithCause => parseSynchronizationResult(
  value,
  (result) => asanaPostWriteSynchronizationResultSchema.parse(result),
);

function reportSharedPostApplyCause(
  error: unknown,
  fields: JournalDiagnosticFields,
  reportDiagnostic: (error: unknown, fields: JournalDiagnosticFields) => DiagnosticFailureDispositionError,
): DiagnosticFailureDispositionError {
  return reportSharedCause(error, fields, {
    fromError: diagnosticFailureDispositionFromError,
    isReceipt: (value): value is DiagnosticFailureDispositionError =>
      value instanceof DiagnosticFailureDispositionError,
    reportDiagnostic,
    combine: combineDiagnosticFailureDispositions,
    createReceipt: (disposition) => new DiagnosticFailureDispositionError(disposition),
  });
}

type OperationContext = RecoveryOperationContext<ProposalOperation>;
type JournalOperation = ApplicationJournalPlan["operation"];

const hasApplicationJournalPlan = (
  journal: ApplicationJournal,
): journal is PlannedApplicationJournal => journal.plan != null;

function journalOperationForProposalOperation(
  operation: ProposalOperation,
  uuids: ReadonlyMap<string, string>,
): JournalOperation {
  return convertJournalOperation(operation, uuids, (value) => applicationJournalOperationSchema.parse(value));
}

function proposalOperationForJournalOperation(
  operation: ApplicationJournalOperation,
): ProposalOperation {
  return convertProposalOperation(operation, (value) => proposalOperationSchema.parse(value));
}

function baselineSourceForOperation(
  proposalId: string,
  context: OperationContext,
  contexts: readonly OperationContext[],
  applicableOperationIds: ReadonlySet<string>,
  mappings: ReadonlyMap<string, string>,
  baselines: ReadonlyMap<string, BaselineExternal>,
  journal: ApplicationJournalStorePort,
): ApplicationJournalBaselineSource {
  return deriveBaselineSource(
    proposalId,
    context,
    contexts,
    applicableOperationIds,
    mappings,
    baselines,
    {
      getJournal: (itemProposalId, operationId) => journal.get(itemProposalId, operationId),
      hasPlan: (entry) => entry.plan != null,
      usesCustomExternalData: operationUsesCustomExternalData,
      targetGid,
      parseStored: (baseline) => {
        const parsed = parseCustomExternalData(baseline.data);
        if (parsed.kind !== "valid") {
          throw new Error("適用基準のCustom external dataがvalidではありません。");
        }
        if (
          externalTaskGidSchema.parse(baseline.gid) !== baseline.gid
          || baseline.gid !== `TaskHub:v1:task:${parsed.data.id}`
          || serializeCustomExternalData(parsed.data) !== baseline.data
        ) {
          throw new Error("適用基準のCustom external data識別子または形式が不正です。");
        }
        return { external_gid: baseline.gid, data: parsed.data };
      },
    },
  );
}

const sameCanonicalJson = (left: unknown, right: unknown): boolean =>
  canonicalizeJson(left) === canonicalizeJson(right);

function validateBaselineCoverage(
  contexts: readonly OperationContext[],
  selectedOperationIds: ReadonlySet<string>,
  mappings: ReadonlyMap<string, string>,
  baselines: ReadonlyMap<string, BaselineExternal>,
): void {
  validateBaselineCoverageValues(contexts, selectedOperationIds, mappings, baselines);
}

function isKnownAsanaOperationalError(error: unknown): boolean {
  return error instanceof AsanaTransportError
    || error instanceof AsanaResponseError
    || error instanceof AsanaAuthenticationError
    || error instanceof AsanaEventsResetError
    || error instanceof AsanaHttpError
    || error instanceof AsanaPaymentRequiredError
    || error instanceof AsanaRateLimitError;
}

function isKnownCreateTaskRejectionError(error: unknown): boolean {
  return error instanceof AsanaHttpError
    || error instanceof AsanaAuthenticationError
    || error instanceof AsanaPaymentRequiredError
    || error instanceof AsanaRateLimitError;
}

function isDefinitiveCreateTaskRejection(
  operation: ProposalOperation,
  lastWriteAction: ProposalOperationWriteAction | undefined,
  createdTaskGid: string | undefined,
  error: unknown,
): boolean {
  return isDefinitiveCreateRejection(operation, lastWriteAction, createdTaskGid, error,
    isKnownCreateTaskRejectionError, getUniqueAsanaHttpStatus, definitiveCreateTaskRejectionStatuses);
}

function normalizeJournalPort(journal: JournalPort): ApplicationJournalStorePort {
  if ("prepare" in journal) {
    return journal;
  }
  return {
    prepare: (entries) => journal.prepareApplicationJournals(entries),
    recordCreatedTask: (proposalId, operationId, temporaryRef, taskGid) =>
      journal.recordApplicationJournalTaskCreated(
        proposalId,
        operationId,
        temporaryRef,
        taskGid,
      ),
    updateStage: (proposalId, operationId, stage) =>
      journal.updateApplicationJournalStage(proposalId, operationId, stage),
    complete: (proposalId, operationId, finalResult) =>
      journal.completeApplicationJournal(proposalId, operationId, finalResult),
    clearRecoveryCause: (proposalId, operationId) =>
      journal.clearApplicationJournalRecoveryCause(proposalId, operationId),
    get: (proposalId, operationId) =>
      journal.getApplicationJournal(proposalId, operationId),
    getByProposal: (proposalId) =>
      journal.getApplicationJournalsByProposal(proposalId),
    getIncomplete: () => journal.getIncompleteApplicationJournals(),
  };
}

function createWriterInput(
  context: OperationContext,
  settings: RecoverySettings,
  mappings: ReadonlyMap<string, string>,
  baseline: BaselineExternal | undefined,
  createUuid: string | undefined,
  existingTask: AsanaTaskResponse | undefined,
): WriterInput {
  return buildRecoveryWriterInput(context, settings, mappings, baseline, createUuid, existingTask);
}

function baselineFromJournalPlan(
  writer: AsanaProposalOperationWriter,
  entry: PlannedRecoveryEntry,
  plannedEntries: readonly PlannedRecoveryEntry[],
  settings: RecoverySettings,
  mappings: ReadonlyMap<string, string>,
): BaselineExternal | undefined {
  return resolveBaselineFromJournalPlan(entry, plannedEntries, settings, mappings, {
    serializeStored: serializeCustomExternalData,
    createWriterInput,
    createInitialExternalBaseline: (input) => writer.createInitialExternalBaseline(input),
  });
}

function validateMemoryBaselineSource(
  writer: AsanaProposalOperationWriter,
  application: AsanaProposalRecoveryInput["applications"][number] | undefined,
  entry: PlannedRecoveryEntry,
  plannedEntries: readonly PlannedRecoveryEntry[],
  settings: RecoverySettings,
  mappings: ReadonlyMap<string, string>,
): void {
  compareMemoryBaselineSource(application, entry, plannedEntries, settings, mappings, {
    targetGid,
    baselineFromJournalPlan: (item, items, itemSettings, itemMappings) =>
      baselineFromJournalPlan(writer, item, items, itemSettings, itemMappings),
  });
}

function validateWriterResult(
  context: OperationContext,
  result: WriterResult,
  expectedTaskGid: string | undefined,
): WriterResult {
  return validateOperationWriterResult(context.operation.operation_id, result,
    expectedTaskGid, (value) => asanaProposalOperationWriterResultSchema.parse(value));
}

function createApplicationResult(
  proposalId: string,
  proposal: Proposal,
  selectedOperationIds: ReadonlySet<string>,
  operationResults: ReadonlyMap<string, ApplicationOperationResult>,
): AsanaProposalApplicationResult {
  return asanaProposalApplicationResultSchema.parse(
    buildApplicationResult(proposalId, proposal, selectedOperationIds, operationResults),
  );
}

function createRecoveryApplicationResult(
  proposalId: string,
  entries: readonly PlannedRecoveryEntry[],
  selectedOperationIds: ReadonlySet<string>,
  operationResults: ReadonlyMap<string, ApplicationOperationResult>,
): AsanaProposalApplicationResult {
  return asanaProposalApplicationResultSchema.parse(
    buildRecoveryApplicationResult(proposalId, entries, selectedOperationIds, operationResults),
  );
}

function journalEntry(
  proposalId: string,
  context: OperationContext,
  target: ApplicationJournal["target"],
  groupOrder: number,
  operationOrder: number,
  settings: AsanaProposalApplicationInput,
  mappings: ReadonlyMap<string, string>,
  baselineSource: ApplicationJournalBaselineSource,
  uuids: ReadonlyMap<string, string>,
  startedAt: string,
): PlannedApplicationJournal {
  return buildApplicationPlanEntry(
    proposalId,
    context,
    target,
    groupOrder,
    operationOrder,
    settings,
    mappings,
    baselineSource,
    uuids,
    startedAt,
    {
      journalOperation: journalOperationForProposalOperation,
      parsePlan: (value) => applicationJournalPlanSchema.parse(value),
      parseTimestamp: (value) => isoDateTimeSchema.parse(value),
      parseJournal: (value) => applicationJournalWithPlanSchema.parse(value),
    },
  );
}

function finalJournalResult(value: ApplicationJournalResult): ApplicationJournalResult {
  return applicationJournalResultSchema.parse(value);
}

function expectedExternalGid(uuid: string): string {
  return externalTaskGidSchema.parse(`TaskHub:v1:task:${uuid}`);
}

function resultForExistingJournal(
  context: OperationContext,
  journal: ApplicationJournal,
  mappings: ReadonlyMap<string, string>,
): ExistingJournalDisposition {
  return resolveExistingJournal<ProposalOperation, ApplicationOperationResult, ApplicationJournal, PlannedApplicationJournal>(context, journal, mappings, {
    hasPlan: hasApplicationJournalPlan,
    createTemporaryRef: (operation) => {
      if (operation.operation !== "create_task" || operation.temporary_ref == null) {
        throw new Error("create_taskのtemporary_refがありません。");
      }
      return operation.temporary_ref;
    },
    createResult: createOperationResult,
    unknownResult: unknownOperationResult,
  });
}

function uniqueTaskMap(tasks: readonly AsanaTaskResponse[]): ReadonlyMap<string, AsanaTaskResponse> {
  return indexRecoveryTasks(tasks, (value) => asanaTaskResponseSchema.parse(value));
}

function matchingExternalTasks(
  tasks: ReadonlyMap<string, AsanaTaskResponse>,
  uuid: string,
): readonly AsanaTaskResponse[] {
  return findRecoveryTasksByUuid(tasks, uuid, expectedExternalGid);
}

/** 承認済み変更案の適用と起動時復旧を管理します。 */
export class AsanaProposalApplicationCoordinator {
  private readonly readClient: AsanaReadClient;
  private readonly writer: AsanaProposalOperationWriter;
  private readonly journal: ApplicationJournalStorePort;
  private readonly uuidGenerator: ProposalApplicationUuidGenerator;
  private readonly timestampProvider: ProposalApplicationTimestampProvider;
  private readonly postApply: ProposalApplicationPostApply;
  private readonly diagnostic: ProposalApplicationDiagnostic;

  public constructor(
    readClient: AsanaReadClient,
    writer: AsanaProposalOperationWriter,
    journal: JournalPort,
    uuidGenerator: ProposalApplicationUuidGenerator,
    timestampProvider: ProposalApplicationTimestampProvider,
    postApply: ProposalApplicationPostApply,
    diagnostic: ProposalApplicationDiagnostic,
  ) {
    if (typeof postApply !== "function") {
      throw new TypeError("適用後同期・順位再計算コールバックが必要です。");
    }
    this.readClient = readClient;
    this.writer = writer;
    this.journal = normalizeJournalPort(journal);
    this.uuidGenerator = uuidGenerator;
    this.timestampProvider = timestampProvider;
    this.postApply = postApply;
    this.diagnostic = diagnostic;
  }

  /** 承認済み変更案を作成・属性・関係の順で適用します。 */
  public async apply(
    input: AsanaProposalApplicationInput,
    signal: AbortSignal,
  ): Promise<AsanaProposalApplicationResult> {
    try {
      return await this.applyValidated(input, signal);
    } catch (error: unknown) {
      if (signal.aborted) {
        throw error;
      }
      if (error instanceof DiagnosticFailureDispositionError) {
        throw error;
      }
      const parsedInput = asanaProposalApplicationInputSchema.safeParse(input);
      throw this.reportEscapedError(error, {
        severity: "error",
        ...(parsedInput.success ? { proposal_id: parsedInput.data.proposal_id } : {}),
        api_action: "journal_plan",
        effect_certainty: "none",
        reason_code: "application_failed",
        recovery_decision: "failed",
        attempt: 1,
        phase: "application",
      });
    }
  }

  private async applyValidated(
    input: AsanaProposalApplicationInput,
    signal: AbortSignal,
  ): Promise<AsanaProposalApplicationResult> {
    validateAbortSignal(signal);
    throwIfAborted(signal);
    const validatedInput = asanaProposalApplicationInputSchema.parse(input);
    const plan = prepareApplication(validatedInput, {
      journal: this.journal,
      hasPlan: hasApplicationJournalPlan,
      classify: (approvalInput) => proposalApprovalResultSchema.parse(
        classifyProposalConflicts(approvalInput),
      ),
      validateGraph: validateSelectedProposalGraph,
      validateBaselineCoverage,
      createTaskTemporaryReferences,
      createPlanEntry: ({
        input: planInput,
        context,
        contexts: planContexts,
        applicableOperationIds,
        mappings: planMappings,
        baselines: planBaselines,
        uuids: planUuids,
        groupOrder,
        operationOrder,
      }) => {
        const baselineSource = baselineSourceForOperation(
          planInput.proposal_id,
          context,
          planContexts,
          applicableOperationIds,
          planMappings,
          planBaselines,
          this.journal,
        );
        return journalEntry(
          planInput.proposal_id,
          context,
          operationTargetForJournal(context.operation, planUuids),
          groupOrder,
          operationOrder,
          planInput,
          planMappings,
          baselineSource,
          planUuids,
          this.timestampProvider(),
        );
      },
      targetGid,
      createResult: createOperationResult,
      reportValidation: (error, fields) => this.reportJournalEvent(error, fields),
      uuidGenerator: this.uuidGenerator,
    });
    const { contextMap, selected, mappings, uuids, baselines, operationResults, failedTemporaryRefs } = plan;
    const pendingJournals = await applyPreparedApplication(
      validatedInput.proposal_id,
      plan,
      {
        throwIfAborted,
        operationTemporaryReferences,
        targetGid,
        createResult: createOperationResult,
        existingJournalDisposition: resultForExistingJournal,
        journal: {
          complete: (proposalId, operationId, result) =>
            this.journal.complete(proposalId, operationId, finalJournalResult(result)),
        },
        reportJournalEvent: (error, fields) => this.reportJournalEvent(error, fields),
        reportCompletionFailure: (error, writeEntry, fields, taskGid) =>
          this.reportOperationEventOnce(error, writeEntry, fields, taskGid),
        writePrepared: (context, entry) => writePreparedOperation(
          context,
          entry,
          validatedInput,
          mappings,
          baselines,
          uuids,
          failedTemporaryRefs,
          {
            journal: {
              updateStage: (proposalId, operationId, stage) =>
                this.journal.updateStage(proposalId, operationId, stage),
              recordCreatedTask: (proposalId, operationId, temporaryRef, taskGid) =>
                this.journal.recordCreatedTask(
                  proposalId,
                  operationId,
                  temporaryRef,
                  taskGid,
                ),
              complete: (proposalId, operationId, result) =>
                this.journal.complete(proposalId, operationId, finalJournalResult(result)),
            },
            readProjectTasks: (projectGid, readSignal) =>
              this.readClient.listProjectTasks(projectGid, readSignal),
            writer: this.writer,
            targetGid,
            operationUsesCustomExternalData,
            matchingExternalTasks: (tasks, uuid) =>
              matchingExternalTasks(uniqueTaskMap(tasks), uuid),
            createWriterInput: (writeContext, settings, writeMappings, baseline, createUuid) =>
              createWriterInput(
                writeContext,
                settings,
                writeMappings,
                baseline,
                createUuid,
                undefined,
              ),
            parseWriterResult: (value) => asanaProposalOperationWriterResultSchema.parse(value),
            safeParseWriterResult: (value) =>
              asanaProposalOperationWriterResultSchema.safeParse(value),
            validateWriterResult,
            writerResultToApplicationResult,
            createResult: createOperationResult,
            unknownResult: unknownOperationResult,
            reportJournalEvent: (error, fields) => this.reportJournalEvent(error, fields),
            reportOperationEventOnce: (error, writeEntry, fields, taskGid) =>
              this.reportOperationEventOnce(error, writeEntry, fields, taskGid),
            isDefinitiveCreateTaskRejection,
            completeDefinitiveCreateTaskRejection: (
              error,
              journalEntry,
              entryForProgress,
              writeContext,
              writeAttemptCount,
              taskGid,
            ) => this.completeDefinitiveCreateTaskRejection(
              error,
              journalEntry,
              entryForProgress,
              writeContext,
              writeAttemptCount,
              taskGid,
            ),
            isKnownAsanaOperationalError,
            isCreateTaskNotFoundError: (error): error is CreateTaskNotFoundError =>
              error instanceof CreateTaskNotFoundError,
            parseJournalWithStage: (writeEntry, stage) =>
              stage === "write_started" || stage === "task_created"
                ? { ...writeEntry, stage }
                : applicationJournalWithPlanSchema.parse({ ...writeEntry, stage }),
          },
          signal,
        ),
      },
      signal,
    );

    await finalizePendingJournals(
      pendingJournals,
      {
        journal: this.journal,
        postApply: this.postApply,
        parseSynchronization: parsePostWriteSynchronizationResult,
        reportDiagnostic: (error, fields) => this.reportJournalEvent(error, fields),
        createLocalSyncPendingResult: (context, taskGid) =>
          unknownOperationResult(context, "local_resync_required", taskGid),
        reportSharedCause: (error, fields) => reportSharedPostApplyCause(
          error,
          fields,
          (cause, diagnosticFields) => this.reportJournalEvent(cause, diagnosticFields),
        ),
      },
      signal,
    );
    if (contextMap.size === 0) {
      throw new Error("proposalに操作がありません。");
    }
    return createApplicationResult(
      validatedInput.proposal_id,
      validatedInput.approval_input.proposal,
      selected,
      operationResults,
    );
  }

  private completeDefinitiveCreateTaskRejection(
    error: unknown,
    entry: PlannedApplicationJournal,
    entryForProgress: PlannedApplicationJournal,
    context: OperationContext,
    writeAttemptCount: number,
    taskGid: string | undefined,
  ): ApplicationOperationResult {
    return completeDefinitiveCreateTaskRejection(
      error,
      entry,
      entryForProgress,
      context,
      writeAttemptCount,
      taskGid,
      {
        reportOperationEventOnce: (cause, item, fields, gid) =>
          this.reportOperationEventOnce(cause, item, fields, gid),
        dispositionFromError: diagnosticFailureDispositionFromError,
        combineDispositions: combineDiagnosticFailureDispositions,
        createDispositionError: (disposition) => new DiagnosticFailureDispositionError(disposition),
        journal: this.journal,
        finalJournalResult,
        createResult: createOperationResult,
      },
    );
  }

  /** 未完了適用ジャーナルをAsanaの実状態と照合して復旧します。 */
  public async recover(
    input: AsanaProposalRecoveryInput,
    signal: AbortSignal,
  ): Promise<AsanaProposalRecoveryResult> {
    try {
      return await this.recoverValidated(input, signal);
    } catch (error: unknown) {
      throwRecoveryFailure<ProposalOperation["operation"], ApplicationJournal, PlannedApplicationJournal, DiagnosticFailureDispositionError, DiagnosticFailureDisposition>(error, signal, {
        isReceipt: (value): value is DiagnosticFailureDispositionError =>
          value instanceof DiagnosticFailureDispositionError,
        getIncomplete: () => this.journal.getIncomplete(),
        hasPlan: hasApplicationJournalPlan,
        reportEscaped: (cause, fields) => this.reportEscapedError(cause, fields),
        reportJournal: (cause, fields) => this.reportJournalEvent(cause, fields),
        fromError: diagnosticFailureDispositionFromError,
        combine: combineDiagnosticFailureDispositions,
        createReceipt: (disposition) => new DiagnosticFailureDispositionError(disposition),
      });
    }  }

  private async recoverValidated(
    input: AsanaProposalRecoveryInput,
    signal: AbortSignal,
  ): Promise<AsanaProposalRecoveryResult> {
    validateAbortSignal(signal);
    throwIfAborted(signal);
    const validatedInput = asanaProposalRecoveryInputSchema.parse(input);
    const applicationsByProposal = new Map<
      string,
      AsanaProposalRecoveryInput["applications"][number]
    >();
    for (const application of validatedInput.applications) {
      applicationsByProposal.set(application.proposal_id, application);
    }
    const { plannedJournalsByProposal, unresolved, addUnresolved } = startRecoveryJournals<
      ProposalOperation["operation"],
      ApplicationJournal,
      PlannedApplicationJournal,
      AsanaProposalRecoveryResult["unresolved_journals"][number]
    >(
      this.journal.getIncomplete(),
      {
        hasPlan: hasApplicationJournalPlan,
        journal: this.journal,
        finalJournalResult,
        createUnresolved: incompleteJournalResult,
        reportJournalEvent: (error, fields) => this.reportJournalEvent(error, fields),
        throwIfAborted,
      },
      signal,
    );
    const { loadProjectTasks, readTask } = createRecoveryTaskReads({
      listProjectTasks: (projectGid, readSignal) =>
        this.readClient.listProjectTasks(projectGid, readSignal),
      getTask: (taskGid, readSignal) => this.readClient.getTask(taskGid, readSignal),
      parseTask: (value) => asanaTaskResponseSchema.parse(value),
      isNotFound: (error): error is AsanaHttpError =>
        error instanceof AsanaHttpError && error.status === 404,
    }, signal);
    const applicationStates = prepareRecoveryStates<
      AsanaProposalRecoveryInput["applications"][number],
      ApplicationOperationResult,
      ProposalOperation,
      ApplicationJournalOperation,
      ApplicationJournalPlan,
      ApplicationJournal,
      PlannedApplicationJournal
    >(
      applicationsByProposal,
      plannedJournalsByProposal.keys(),
      {
        getByProposal: (proposalId) => this.journal.getByProposal(proposalId),
        hasPlan: hasApplicationJournalPlan,
        proposalOperationForJournalOperation,
        journalOperationForProposalOperation,
        journalOperationsMatch: sameCanonicalJson,
        sameRecoverySettings: sameCanonicalJson,
        createTaskTemporaryReferences,
        createOperationResults: () => new Map<string, ApplicationOperationResult>(),
        throwIfAborted,
        validateMemoryBaselineSource: (application, entry, plannedEntries, settings, mappings) =>
          validateMemoryBaselineSource(
            this.writer,
            application,
            entry,
            plannedEntries,
            settings,
            mappings,
          ),
      },
      signal,
    );

    const pendingJournals = await recoverPlannedOperations(
      applicationStates,
      {
        journal: this.journal,
        writer: this.writer,
        loadProjectTasks,
        readTask,
        matchingExternalTasks,
        createWriterInput,
        baselineFromJournalPlan: (entry, plannedEntries, settings, mappings) =>
          baselineFromJournalPlan(this.writer, entry, plannedEntries, settings, mappings),
        validateWriterResult,
        safeParseWriterResult: (value) => asanaProposalOperationWriterResultSchema.safeParse(value),
        writerResultToApplicationResult,
        createOperationResult,
        finalJournalResult,
        parseJournalWithPlan: (value) => applicationJournalWithPlanSchema.parse(value),
        addUnresolved,
        operationTemporaryReferences,
        createTemporaryRef: (operation) => {
          if (operation.operation !== "create_task") {
            throw new Error("create_task以外からtemporary_refを取得できません。");
          }
          return operation.temporary_ref;
        },
        targetGid,
        throwIfAborted,
        reportOperationEvent: (error, entry, fields, taskGid) =>
          this.reportOperationEvent(error, entry, fields, taskGid),
        reportOperationEventOnce: (error, entry, fields, taskGid) =>
          this.reportOperationEventOnce(error, entry, fields, taskGid),
        isCreateTaskNotFoundError: (error): error is CreateTaskNotFoundError =>
          error instanceof CreateTaskNotFoundError,
      },
      signal,
    );

    await completeRecoveredOperations(pendingJournals, {
      journal: this.journal,
      postApply: this.postApply,
      parseSynchronization: parsePostWriteSynchronizationResult,
      reportSharedCause: (error, fields) => reportSharedPostApplyCause(
        error,
        fields,
        (cause, diagnosticFields) => this.reportJournalEvent(cause, diagnosticFields),
      ),
      reportOperationEvent: (error, entry, fields, taskGid) =>
        this.reportOperationEvent(error, entry, fields, taskGid),
      reportOperationEventOnce: (error, entry, fields, taskGid) =>
        this.reportOperationEventOnce(error, entry, fields, taskGid),
      unknownResult: unknownOperationResult,
      finalJournalResult,
    }, signal);
    const applications = collectRecoveryApplications(applicationStates, {
      createRecoveryResult: createRecoveryApplicationResult,
      createApplicationResult,
    });
    return asanaProposalRecoveryResultSchema.parse({
      applications,
      unresolved_journals: unresolved,
    });
  }

  private reportJournalEvent(
    error: unknown,
    fields: JournalDiagnosticFields,
  ): DiagnosticFailureDispositionError {
    return recordApplicationDiagnostic(error, fields, {
      parseEvent: (value) => applicationJournalDiagnosticSchema.parse(value),
      diagnostic: this.diagnostic,
      isReceipt: (value): value is DiagnosticFailureDispositionError =>
        value instanceof DiagnosticFailureDispositionError,
      fromError: diagnosticFailureDispositionFromError,
      combine: combineDiagnosticFailureDispositions,
      recordedDisposition: (recordedError, responseError) => ({
        kind: "recorded_only",
        recorded_error: recordedError,
        response_error: responseError,
      }),
      createReceipt: (disposition) => new DiagnosticFailureDispositionError(disposition),
    });
  }

  private reportOperationEvent(
    error: unknown,
    entry: OperationDiagnosticContext,
    fields: OperationDiagnosticFields,
    taskGid: string | undefined,
  ): DiagnosticFailureDispositionError {
    return this.reportJournalEvent(error, {
      ...fields,
      proposal_id: entry.journal.proposal_id,
      operation_id: entry.journal.operation_id,
      operation_kind: entry.context.operation.operation,
      ...(taskGid == null ? {} : { task_gid: taskGid }),
    });
  }

  private reportOperationEventOnce(
    error: unknown,
    entry: OperationDiagnosticContext,
    fields: OperationDiagnosticFields,
    taskGid: string | undefined,
  ): DiagnosticFailureDispositionError {
    if (error instanceof DiagnosticFailureDispositionError) {
      return error;
    }
    return this.reportOperationEvent(error, entry, fields, taskGid);
  }

  private reportEscapedError(
    error: unknown,
    fields: JournalDiagnosticFields,
  ): DiagnosticFailureDispositionError {
    if (error instanceof DiagnosticFailureDispositionError) {
      return error;
    }
    return this.reportJournalEvent(error, fields);
  }

}

export type ProposalApplicationUuidGenerator = () => string;
export type ProposalApplicationTimestampProvider = () => string;

/** 適用後の同期と順位再計算を実行します。 */
export type ProposalApplicationPostApply = (
  requiredTaskGids: readonly string[],
  signal: AbortSignal,
) => Promise<PostWriteSynchronizationResultWithCause>;
