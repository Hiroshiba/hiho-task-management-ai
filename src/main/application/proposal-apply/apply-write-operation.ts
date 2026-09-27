import { addTemporaryMapping } from "./application-plan";
import {
  recordJournalResultBeforeRanking,
  type JournalStage,
} from "./journal-progress";

type Operation = {
  readonly operation: string;
  readonly operation_id: string;
  readonly temporary_ref?: string;
};
type Context<TOperation extends Operation> = {
  readonly group: { readonly group_id: string; readonly atomic: boolean };
  readonly operation: TOperation;
};
type PlannedJournal = {
  readonly proposal_id: string;
  readonly operation_id: string;
  readonly stage: JournalStage;
};
type WriterResult =
  | {
      readonly operation_id: string;
      readonly task_gid: string;
      readonly outcome: "applied" | "already_applied";
    }
  | {
      readonly operation_id: string;
      readonly task_gid: string;
      readonly outcome: "conflict";
      readonly reason_code: string;
      readonly side_effect: "none" | "possible";
    };
type DiagnosticFields<TOperation extends Operation, TAction extends string> = {
  readonly severity: "warning" | "error";
  readonly proposal_id: string;
  readonly operation_id: string;
  readonly operation_kind: TOperation["operation"];
  readonly api_action: TAction | "read_project_tasks" | "operation_writer";
  readonly journal_stage: JournalStage;
  readonly effect_certainty: "none" | "possible" | "confirmed";
  readonly task_gid?: string | undefined;
  readonly reason_code: string;
  readonly recovery_decision:
    | "resume" | "external_id_collision" | "unresolved" | "not_applied";
  readonly attempt: number;
  readonly phase: "preflight" | "external_write";
};
type OperationDiagnosticFields<TAction extends string> = {
  readonly severity: "error";
  readonly api_action: TAction | "create_task" | "operation_writer";
  readonly journal_stage: JournalStage;
  readonly effect_certainty: "none" | "possible" | "confirmed";
  readonly reason_code: "external_api_failed" | "recovery_required";
  readonly recovery_decision: "failed" | "resume" | "unresolved";
  readonly attempt: number;
  readonly phase: "preflight" | "read_back" | "external_write" | "journal";
};
type WritePorts<
  TInput extends { readonly project_gid: string },
  TOperation extends Operation,
  TJournal extends PlannedJournal,
  TWriterInput,
  TWriterResult extends WriterResult,
  TTask,
  TBaseline,
  TResult,
  TAction extends string,
  TReceipt extends Error & { readonly disposition: { readonly kind: string } },
  TNotFound extends Error & { readonly taskGid: string },
> = {
  readonly journal: {
    readonly updateStage: (
      proposalId: string,
      operationId: string,
      stage: JournalStage,
    ) => void;
    readonly recordCreatedTask: (
      proposalId: string,
      operationId: string,
      temporaryRef: string,
      taskGid: string,
    ) => void;
    readonly complete: (
      proposalId: string,
      operationId: string,
      result: "applied" | "not_applied" | "unknown" | "failed",
    ) => void;
  };
  readonly readProjectTasks: (projectGid: string, signal: AbortSignal) => Promise<readonly TTask[]>;
  readonly writer: {
    readonly applyWithCreateTaskCallback: (
      input: TWriterInput,
      signal: AbortSignal,
      onCreated: (operationId: string, taskGid: string) => void,
      onWriteAttempt: (action: TAction) => void,
    ) => Promise<TWriterResult>;
    readonly applyWithWriteAttemptCallback: (
      input: TWriterInput,
      signal: AbortSignal,
      onWriteAttempt: (action: TAction) => void,
    ) => Promise<TWriterResult>;
    readonly createInitialExternalBaseline: (input: TWriterInput) => TBaseline;
  };
  readonly targetGid: (
    operation: TOperation,
    mappings: ReadonlyMap<string, string>,
  ) => string | undefined;
  readonly operationUsesCustomExternalData: (operation: TOperation) => boolean;
  readonly matchingExternalTasks: (tasks: readonly TTask[], uuid: string) => readonly TTask[];
  readonly createWriterInput: (
    context: Context<TOperation>,
    settings: TInput,
    mappings: ReadonlyMap<string, string>,
    baseline: TBaseline | undefined,
    createUuid: string | undefined,
  ) => TWriterInput;
  readonly parseWriterResult: (value: unknown) => TWriterResult;
  readonly safeParseWriterResult: (
    value: unknown,
  ) => { readonly success: true; readonly data: TWriterResult } | { readonly success: false };
  readonly validateWriterResult: (
    context: Context<TOperation>,
    result: TWriterResult,
    expectedTaskGid: string | undefined,
  ) => TWriterResult;
  readonly writerResultToApplicationResult: (
    context: Context<TOperation>,
    result: TWriterResult,
  ) => TResult;
  readonly createResult: (
    groupId: string,
    operationId: string,
    outcome: "not_applied",
    reasonCode: "external_id_collision" | "external_api_failed",
    taskGid: string | undefined,
  ) => TResult;
  readonly unknownResult: (
    context: Context<TOperation>,
    reasonCode: "recovery_required",
    taskGid: string | undefined,
  ) => TResult;
  readonly reportJournalEvent: (
    error: unknown,
    fields: DiagnosticFields<TOperation, TAction>,
  ) => Error;
  readonly reportOperationEventOnce: (
    error: unknown,
    entry: { readonly journal: TJournal; readonly context: Context<TOperation> },
    fields: OperationDiagnosticFields<TAction>,
    taskGid: string | undefined,
  ) => TReceipt;
  readonly isDefinitiveCreateTaskRejection: (
    operation: TOperation,
    action: TAction | undefined,
    createdTaskGid: string | undefined,
    error: unknown,
  ) => boolean;
  readonly completeDefinitiveCreateTaskRejection: (
    error: unknown,
    entry: TJournal,
    entryForProgress: TJournal,
    context: Context<TOperation>,
    writeAttemptCount: number,
    taskGid: string | undefined,
  ) => TResult;
  readonly isKnownAsanaOperationalError: (error: unknown) => boolean;
  readonly isCreateTaskNotFoundError: (error: unknown) => error is TNotFound;
  readonly parseJournalWithStage: (entry: TJournal, stage: JournalStage) => TJournal;
};

type WriteResult<TJournal extends PlannedJournal, TResult> = {
  readonly result: TResult;
  readonly pending: { readonly entry: TJournal; readonly task_gid: string } | undefined;
  readonly blockAtomicGroup: boolean;
};

/** 保存済み計画の単一操作を書き込み、読み戻し後の段階まで記録します。 */
export async function writePreparedOperation<
  TInput extends { readonly project_gid: string },
  TOperation extends Operation,
  TJournal extends PlannedJournal,
  TWriterInput,
  TWriterResult extends WriterResult,
  TTask,
  TBaseline,
  TResult,
  TAction extends string,
  TReceipt extends Error & { readonly disposition: { readonly kind: string } },
  TNotFound extends Error & { readonly taskGid: string },
>(
  context: Context<TOperation>,
  entry: TJournal,
  settings: TInput,
  mappings: Map<string, string>,
  baselines: Map<string, TBaseline>,
  uuids: ReadonlyMap<string, string>,
  failedTemporaryRefs: Set<string>,
  ports: WritePorts<
    TInput,
    TOperation,
    TJournal,
    TWriterInput,
    TWriterResult,
    TTask,
    TBaseline,
    TResult,
    TAction,
    TReceipt,
    TNotFound
  >,
  signal: AbortSignal,
): Promise<WriteResult<TJournal, TResult>> {
  const taskGid = ports.targetGid(context.operation, mappings);
  const baseline = taskGid == null ? undefined : baselines.get(taskGid);
  if (
    context.operation.operation !== "create_task"
    && ports.operationUsesCustomExternalData(context.operation)
    && baseline == null
  ) {
    throw new Error("承認時のCustom external data baselineがありません。");
  }
  const createUuid = context.operation.operation === "create_task"
    ? uuids.get(context.operation.operation_id)
    : undefined;
  if (context.operation.operation === "create_task") {
    if (createUuid == null) {
      throw new Error("create_taskの復旧UUIDがありません。");
    }
    let projectTasks: readonly TTask[];
    try {
      projectTasks = await ports.readProjectTasks(settings.project_gid, signal);
    } catch (error: unknown) {
      if (signal.aborted) {
        signal.throwIfAborted();
        throw error;
      }
      const receipt = ports.reportJournalEvent(error, {
        severity: "error",
        proposal_id: entry.proposal_id,
        operation_id: entry.operation_id,
        operation_kind: context.operation.operation,
        api_action: "read_project_tasks",
        journal_stage: "prepared",
        effect_certainty: "none",
        reason_code: "external_api_failed",
        recovery_decision: "resume",
        attempt: 1,
        phase: "preflight",
      });
      throw receipt;
    }
    const matches = ports.matchingExternalTasks(projectTasks, createUuid);
    if (matches.length > 0) {
      ports.reportJournalEvent(
        new Error("作成UUIDが既存タスクと一致したため、重複作成を行いませんでした。"),
        {
          severity: "warning",
          proposal_id: entry.proposal_id,
          operation_id: entry.operation_id,
          operation_kind: context.operation.operation,
          api_action: "read_project_tasks",
          journal_stage: "prepared",
          effect_certainty: "none",
          reason_code: "external_id_collision",
          recovery_decision: "external_id_collision",
          attempt: 1,
          phase: "preflight",
        },
      );
      ports.journal.complete(entry.proposal_id, entry.operation_id, "not_applied");
      const temporaryRef = context.operation.temporary_ref;
      if (temporaryRef == null) {
        throw new Error("create_taskのtemporary_refがありません。");
      }
      failedTemporaryRefs.add(temporaryRef);
      return {
        result: ports.createResult(
          context.group.group_id,
          context.operation.operation_id,
          "not_applied",
          "external_id_collision",
          undefined,
        ),
        pending: undefined,
        blockAtomicGroup: true,
      };
    }
  }
  const writerInput = ports.createWriterInput(
    context,
    settings,
    mappings,
    baseline,
    createUuid,
  );
  let entryForProgress = entry;
  let writeAttemptCount = 0;
  let lastWriteAction: TAction | undefined;
  let createdTaskGid: string | undefined;
  let observedEffectCertainty: "none" | "possible" | "confirmed" = "none";
  const currentEffectCertainty = (): "none" | "possible" | "confirmed" => {
    if (createdTaskGid != null || observedEffectCertainty === "confirmed") {
      return "confirmed";
    }
    if (writeAttemptCount === 0) {
      return "none";
    }
    return "possible";
  };
  const onWriteAttempt = (action: TAction): void => {
    if (writeAttemptCount === 0) {
      try {
        ports.journal.updateStage(entry.proposal_id, entry.operation_id, "write_started");
      } catch (error: unknown) {
        const receipt = ports.reportOperationEventOnce(
          error,
          { journal: entryForProgress, context },
          {
            severity: "error",
            api_action: action,
            journal_stage: entryForProgress.stage,
            effect_certainty: observedEffectCertainty,
            reason_code: "external_api_failed",
            recovery_decision: "failed",
            attempt: 1,
            phase: "journal",
          },
          createdTaskGid ?? taskGid,
        );
        throw receipt;
      }
      entryForProgress = ports.parseJournalWithStage(entryForProgress, "write_started");
    }
    writeAttemptCount += 1;
    lastWriteAction = action;
    if (observedEffectCertainty !== "confirmed") {
      observedEffectCertainty = "possible";
    }
  };
  const onCreateTaskCreated = (operationId: string, createdGid: string): void => {
    if (operationId !== context.operation.operation_id) {
      throw new Error("作成済みタスク通知のoperation_idが一致しません。");
    }
    if (context.operation.operation !== "create_task") {
      throw new Error("create_task以外へ作成済みタスク通知を渡せません。");
    }
    const temporaryRef = context.operation.temporary_ref;
    if (temporaryRef == null) {
      throw new Error("create_taskのtemporary_refがありません。");
    }
    createdTaskGid = createdGid;
    observedEffectCertainty = "confirmed";
    try {
      addTemporaryMapping(mappings, temporaryRef, createdGid);
      ports.journal.recordCreatedTask(
        entry.proposal_id,
        entry.operation_id,
        temporaryRef,
        createdGid,
      );
    } catch (error: unknown) {
      const receipt = ports.reportOperationEventOnce(
        error,
        { journal: entryForProgress, context },
        {
          severity: "error",
          api_action: lastWriteAction ?? "create_task",
          journal_stage: entryForProgress.stage,
          effect_certainty: "confirmed",
          reason_code: "recovery_required",
          recovery_decision: "unresolved",
          attempt: Math.max(1, writeAttemptCount),
          phase: "journal",
        },
        createdTaskGid,
      );
      throw receipt;
    }
    entryForProgress = ports.parseJournalWithStage(entryForProgress, "task_created");
  };
  let rawWriterResult: TWriterResult;
  try {
    rawWriterResult = context.operation.operation === "create_task"
      ? await ports.writer.applyWithCreateTaskCallback(
          writerInput,
          signal,
          onCreateTaskCreated,
          onWriteAttempt,
        )
      : await ports.writer.applyWithWriteAttemptCallback(
          writerInput,
          signal,
          onWriteAttempt,
        );
  } catch (error) {
    if (signal.aborted) {
      signal.throwIfAborted();
      throw error;
    }
    if (context.operation.operation === "create_task") {
      const temporaryRef = context.operation.temporary_ref;
      if (temporaryRef == null) {
        throw new Error("create_taskのtemporary_refがありません。");
      }
      failedTemporaryRefs.add(temporaryRef);
    }
    if (ports.isDefinitiveCreateTaskRejection(
      context.operation,
      lastWriteAction,
      createdTaskGid,
      error,
    )) {
      return {
        result: ports.completeDefinitiveCreateTaskRejection(
          error,
          entry,
          entryForProgress,
          context,
          writeAttemptCount,
          taskGid,
        ),
        pending: undefined,
        blockAtomicGroup: true,
      };
    }
    const certainty = currentEffectCertainty();
    const reasonCode = certainty === "none"
      ? "external_api_failed"
      : "recovery_required";
    let phase: OperationDiagnosticFields<TAction>["phase"];
    if (createdTaskGid != null && lastWriteAction === "create_task") {
      phase = "read_back";
    } else if (certainty === "none") {
      phase = "preflight";
    } else {
      phase = "external_write";
    }
    const receipt = ports.reportOperationEventOnce(
      error,
      { journal: entryForProgress, context },
      {
        severity: "error",
        api_action: lastWriteAction ?? "operation_writer",
        journal_stage: entryForProgress.stage,
        effect_certainty: certainty,
        reason_code: reasonCode,
        recovery_decision: certainty === "none" ? "resume" : "unresolved",
        attempt: Math.max(1, writeAttemptCount),
        phase,
      },
      createdTaskGid ?? taskGid,
    );
    if (ports.isCreateTaskNotFoundError(error)) {
      if (receipt.disposition.kind !== "recorded_only") {
        throw receipt;
      }
      rawWriterResult = ports.parseWriterResult({
        operation_id: context.operation.operation_id,
        task_gid: error.taskGid,
        outcome: "conflict",
        reason_code: "read_back_mismatch",
        side_effect: "possible",
      });
    } else {
      if (!ports.isKnownAsanaOperationalError(error)) {
        throw receipt;
      }
      return {
        result: certainty === "none"
          ? ports.createResult(
              context.group.group_id,
              context.operation.operation_id,
              "not_applied",
              "external_api_failed",
              createdTaskGid ?? taskGid,
            )
          : ports.unknownResult(
              context,
              "recovery_required",
              createdTaskGid ?? taskGid,
            ),
        pending: undefined,
        blockAtomicGroup: true,
      };
    }
  }
  const parsedWriterResult = ports.safeParseWriterResult(rawWriterResult);
  if (parsedWriterResult.success && parsedWriterResult.data.outcome !== "conflict") {
    observedEffectCertainty = "confirmed";
  }
  let writerResult: TWriterResult;
  try {
    writerResult = ports.validateWriterResult(context, rawWriterResult, taskGid);
  } catch (error: unknown) {
    const certainty = observedEffectCertainty;
    const receipt = ports.reportOperationEventOnce(
      error,
      { journal: entryForProgress, context },
      {
        severity: "error",
        api_action: lastWriteAction ?? "operation_writer",
        journal_stage: entryForProgress.stage,
        effect_certainty: certainty,
        reason_code: certainty === "none" ? "external_api_failed" : "recovery_required",
        recovery_decision: certainty === "none" ? "failed" : "unresolved",
        attempt: Math.max(1, writeAttemptCount),
        phase: "read_back",
      },
      createdTaskGid ?? (parsedWriterResult.success
        ? parsedWriterResult.data.task_gid
        : taskGid),
    );
    throw receipt;
  }
  if (writerResult.outcome === "conflict") {
    const certainty = writerResult.side_effect === "possible" ? "possible" : "none";
    ports.reportJournalEvent(
      new Error("適用前後の外部状態を照合した結果、操作を確定できませんでした。"),
      {
        severity: certainty === "possible" ? "error" : "warning",
        proposal_id: entry.proposal_id,
        operation_id: entry.operation_id,
        operation_kind: context.operation.operation,
        api_action: lastWriteAction ?? "operation_writer",
        journal_stage: entryForProgress.stage,
        effect_certainty: certainty,
        task_gid: writerResult.task_gid,
        reason_code: writerResult.reason_code,
        recovery_decision: certainty === "possible" ? "unresolved" : "not_applied",
        attempt: Math.max(1, writeAttemptCount),
        phase: certainty === "possible" ? "external_write" : "preflight",
      },
    );
  }
  if (context.operation.operation === "create_task" && writerResult.outcome === "conflict") {
    const temporaryRef = context.operation.temporary_ref;
    if (temporaryRef == null) {
      throw new Error("create_taskのtemporary_refがありません。");
    }
    failedTemporaryRefs.add(temporaryRef);
  }
  if (context.operation.operation === "create_task" && writerResult.outcome !== "conflict") {
    const temporaryRef = context.operation.temporary_ref;
    if (temporaryRef == null) {
      throw new Error("create_taskのtemporary_refがありません。");
    }
    createdTaskGid = writerResult.task_gid;
    observedEffectCertainty = "confirmed";
    try {
      addTemporaryMapping(mappings, temporaryRef, writerResult.task_gid);
      const createdBaselineInput = ports.createWriterInput(
        context,
        settings,
        mappings,
        undefined,
        createUuid,
      );
      baselines.set(
        writerResult.task_gid,
        ports.writer.createInitialExternalBaseline(createdBaselineInput),
      );
    } catch (error: unknown) {
      const receipt = ports.reportOperationEventOnce(
        error,
        { journal: entryForProgress, context },
        {
          severity: "error",
          api_action: lastWriteAction ?? "create_task",
          journal_stage: entryForProgress.stage,
          effect_certainty: "confirmed",
          reason_code: "recovery_required",
          recovery_decision: "unresolved",
          attempt: Math.max(1, writeAttemptCount),
          phase: "journal",
        },
        createdTaskGid,
      );
      throw receipt;
    }
  }
  let metadataEntry: TJournal | undefined;
  try {
    const needsRanking = recordJournalResultBeforeRanking(
      ports.journal,
      entryForProgress,
      writerResult,
      (stage) => {
        entryForProgress = ports.parseJournalWithStage(entryForProgress, stage);
      },
    );
    if (needsRanking) {
      metadataEntry = entryForProgress;
    }
  } catch (error: unknown) {
    const certainty = writerResult.outcome === "conflict"
      ? writerResult.side_effect
      : "confirmed";
    const receipt = ports.reportOperationEventOnce(
      error,
      { journal: entryForProgress, context },
      {
        severity: "error",
        api_action: lastWriteAction ?? "operation_writer",
        journal_stage: entryForProgress.stage,
        effect_certainty: certainty,
        reason_code: certainty === "none" ? "external_api_failed" : "recovery_required",
        recovery_decision: certainty === "none" ? "failed" : "unresolved",
        attempt: Math.max(1, writeAttemptCount),
        phase: "journal",
      },
      createdTaskGid ?? writerResult.task_gid,
    );
    throw receipt;
  }
  return {
    result: ports.writerResultToApplicationResult(context, writerResult),
    pending: metadataEntry == null
      ? undefined
      : { entry: metadataEntry, task_gid: writerResult.task_gid },
    blockAtomicGroup: writerResult.outcome === "conflict",
  };
}
