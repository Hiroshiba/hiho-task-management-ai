import { addTemporaryMapping } from "./application-plan";
import { journalStages, effectCertaintyForJournalStage, type JournalStage } from "./journal-progress";
import { type OperationContext, type RecoverySettings } from "./recovery-plan";
import { type RecoveryApplicationState } from "./recovery-state";

type RecoveryOperation = {
  readonly operation: string;
  readonly operation_id: string;
  readonly temporary_ref?: string;
  readonly target?: { readonly kind: "existing"; readonly gid: string } | { readonly kind: "temporary"; readonly ref: string };
};
type RecoveryEntry<TOperation extends RecoveryOperation> = {
  readonly journal: {
    readonly proposal_id: string;
    readonly operation_id: string;
    readonly stage: JournalStage;
    readonly plan: { readonly create_uuid?: string | undefined };
  };
  readonly context: OperationContext<TOperation>;
};
export type RecoveryPendingJournal<TEntry> = {
  readonly entry: TEntry;
  readonly task_gid: string;
};
type RecoveryReasonCode = "recovery_context_missing" | "task_not_found" | "duplicate_external_id" | "journal_target_mismatch" | "recovery_required";
type RecoveryWriterResult =
  | { readonly outcome: "applied" | "already_applied"; readonly task_gid: string }
  | { readonly outcome: "conflict"; readonly task_gid: string; readonly side_effect: "none" | "possible" };
type RecoveryInspection<TTask> = {
  readonly core_state: "before" | "partial" | "after" | "conflict";
  readonly metadata_state: "before" | "partial" | "after" | "conflict";
  readonly task: TTask;
};
type RecoveryDiagnosticFields<TAction extends string> = {
  readonly severity: "warning" | "error";
  readonly api_action: TAction | "create_task" | "journal_plan" | "read_task" | "read_project_tasks" | "operation_writer" | "post_apply";
  readonly journal_stage: JournalStage;
  readonly effect_certainty: "none" | "possible" | "confirmed";
  readonly reason_code: string;
  readonly recovery_decision: "resume" | "not_applied" | "unresolved" | "failed";
  readonly attempt: number;
  readonly phase: "journal" | "recovery" | "external_write" | "read_back" | "preflight";
};
type RecoveryOperationPorts<
  TResult,
  TOperation extends RecoveryOperation,
  TEntry extends RecoveryEntry<TOperation>,
  TTask extends { readonly gid: string },
  TWriterInput,
  TWriterResult extends RecoveryWriterResult,
  TAction extends string,
  TReceipt extends Error,
> = {
  readonly journal: {
    readonly complete: (proposalId: string, operationId: string, result: "applied" | "not_applied" | "unknown" | "failed") => void;
    readonly updateStage: (proposalId: string, operationId: string, stage: JournalStage) => void;
    readonly recordCreatedTask: (proposalId: string, operationId: string, temporaryRef: string, taskGid: string) => void;
  };
  readonly writer: {
    readonly inspectRecovery: (input: TWriterInput, signal: AbortSignal) => Promise<RecoveryInspection<TTask>>;
    readonly applyWithCreateTaskCallback: (input: TWriterInput, signal: AbortSignal, onCreated: (operationId: string, taskGid: string) => void, onWriteAttempt: (action: TAction) => void) => Promise<TWriterResult>;
    readonly applyWithWriteAttemptCallback: (input: TWriterInput, signal: AbortSignal, onWriteAttempt: (action: TAction) => void) => Promise<TWriterResult>;
  };
  readonly loadProjectTasks: (projectGid: string) => Promise<ReadonlyMap<string, TTask>>;
  readonly readTask: (taskGid: string) => Promise<{ readonly kind: "found"; readonly task: TTask } | { readonly kind: "missing"; readonly error: unknown }>;
  readonly matchingExternalTasks: (tasks: ReadonlyMap<string, TTask>, uuid: string) => readonly TTask[];
  readonly createWriterInput: (context: OperationContext<TOperation>, settings: RecoverySettings, mappings: ReadonlyMap<string, string>, baseline: { readonly gid: string; readonly data: string } | undefined, createUuid: string | undefined, existingTask: TTask | undefined) => TWriterInput;
  readonly baselineFromJournalPlan: (entry: TEntry, plannedEntries: readonly TEntry[], settings: RecoverySettings, mappings: ReadonlyMap<string, string>) => { readonly gid: string; readonly data: string } | undefined;
  readonly validateWriterResult: (context: OperationContext<TOperation>, result: TWriterResult, expectedTaskGid: string | undefined) => TWriterResult;
  readonly safeParseWriterResult: (value: TWriterResult) => { readonly success: true; readonly data: TWriterResult } | { readonly success: false };
  readonly writerResultToApplicationResult: (context: OperationContext<TOperation>, result: TWriterResult) => TResult;
  readonly createOperationResult: (groupId: string, operationId: string, outcome: "already_applied" | "not_applied", reasonCode: "already_applied" | "atomic_group_blocked" | "external_id_collision" | "writer_conflict" | "external_api_failed" | "task_not_found", taskGid: string | undefined) => TResult;
  readonly finalJournalResult: (value: "applied" | "not_applied" | "unknown" | "failed") => "applied" | "not_applied" | "unknown" | "failed";
  readonly parseJournalWithPlan: (value: unknown) => TEntry["journal"];
  readonly addUnresolved: (journal: TEntry["journal"], reasonCode: RecoveryReasonCode, taskGid: string | undefined) => void;
  readonly operationTemporaryReferences: (operation: TOperation) => readonly string[];
  readonly createTemporaryRef: (operation: TOperation) => string;
  readonly targetGid: (operation: TOperation, mappings: ReadonlyMap<string, string>) => string | undefined;
  readonly throwIfAborted: (signal: AbortSignal) => void;
  readonly reportOperationEvent: (error: unknown, entry: TEntry, fields: RecoveryDiagnosticFields<TAction>, taskGid: string | undefined) => TReceipt;
  readonly reportOperationEventOnce: (error: unknown, entry: TEntry, fields: RecoveryDiagnosticFields<TAction>, taskGid: string | undefined) => TReceipt;
  readonly isCreateTaskNotFoundError: (error: unknown) => error is Error & { readonly taskGid: string };
};

/** 保存済み段階と外部状態から復旧操作の再開可否を判定します。 */
export async function recoverPlannedOperations<
  TApplication,
  TResult,
  TOperation extends RecoveryOperation,
  TEntry extends RecoveryEntry<TOperation>,
  TTask extends { readonly gid: string },
  TWriterInput,
  TWriterResult extends RecoveryWriterResult,
  TAction extends string,
  TReceipt extends Error,
>(
  applicationStates: readonly RecoveryApplicationState<TApplication, TResult, TEntry>[],
  ports: RecoveryOperationPorts<TResult, TOperation, TEntry, TTask, TWriterInput, TWriterResult, TAction, TReceipt>,
  signal: AbortSignal,
): Promise<{ readonly state: RecoveryApplicationState<TApplication, TResult, TEntry>; readonly pending: RecoveryPendingJournal<TEntry> }[]> {
  const pendingJournals: {
      readonly state: RecoveryApplicationState<TApplication, TResult, TEntry>;
      readonly pending: RecoveryPendingJournal<TEntry>;
    }[] = [];
    for (const state of applicationStates) {
      const stageByOperation = new Map<string, JournalStage>();
      const observedEffectByOperation = new Map<
        string,
        RecoveryDiagnosticFields<TAction>["effect_certainty"]
      >();
      for (const entry of state.entries) {
        stageByOperation.set(entry.journal.operation_id, entry.journal.stage);
        observedEffectByOperation.set(
          entry.journal.operation_id,
          effectCertaintyForJournalStage(entry.journal.stage),
        );
      }
      const blockedGroups = new Set(state.blockedGroupIds);
      const statePending: RecoveryPendingJournal<TEntry>[] = [];
      const markCreateTemporaryRefUnavailable = (
        entry: TEntry,
      ): void => {
        if (entry.context.operation.operation === "create_task") {
          state.unavailableTemporaryRefs.add(ports.createTemporaryRef(entry.context.operation));
        }
      };
      const markUnresolved = (
        entry: TEntry,
        reasonCode: RecoveryReasonCode,
        taskGid: string | undefined,
      ): void => {
        const stage = stageByOperation.get(entry.journal.operation_id);
        if (stage == null) {
          throw new Error("復旧対象の適用段階がありません。");
        }
        const effectCertainty = observedEffectByOperation.get(
          entry.journal.operation_id,
        );
        if (effectCertainty == null) {
          throw new Error("復旧対象の外部作用確度がありません。");
        }
        markCreateTemporaryRefUnavailable(entry);
        try {
          ports.journal.complete(
            entry.journal.proposal_id,
            entry.journal.operation_id,
            ports.finalJournalResult("unknown"),
          );
        } catch (error: unknown) {
          const receipt = ports.reportOperationEventOnce(
            error,
            entry,
            {
              severity: "error",
              api_action: "journal_plan",
              journal_stage: stage,
              effect_certainty: effectCertainty,
              reason_code: "recovery_failed",
              recovery_decision: "failed",
              attempt: 1,
              phase: "journal",
            },
            taskGid,
          );
          throw receipt;
        }
        ports.addUnresolved(entry.journal, reasonCode, taskGid);
        ports.reportOperationEvent(
          new Error("復旧時に外部状態を確定できず、要整理項目にしました。"),
          entry,
          {
            severity: "error",
            api_action: "journal_plan",
            journal_stage: stage,
            effect_certainty: effectCertainty,
            reason_code: reasonCode,
            recovery_decision: "unresolved",
            attempt: 1,
            phase: "recovery",
          },
          taskGid,
        );
        if (entry.context.group.atomic) {
          blockedGroups.add(entry.context.group.group_id);
        }
      };
      const completeNotApplied = (
        entry: TEntry,
        reasonCode:
          | "atomic_group_blocked"
          | "external_id_collision"
          | "writer_conflict"
          | "external_api_failed"
          | "task_not_found",
        taskGid: string | undefined,
      ): void => {
        const observedEffectCertainty = observedEffectByOperation.get(
          entry.context.operation.operation_id,
        );
        if (observedEffectCertainty == null) {
          throw new Error("復旧対象の外部作用確度がありません。");
        }
        if (observedEffectCertainty !== "none") {
          throw new Error("外部作用がnoneではない操作を未適用として確定できません。");
        }
        const stage = stageByOperation.get(entry.journal.operation_id);
        if (stage == null) {
          throw new Error("復旧対象の適用段階がありません。");
        }
        markCreateTemporaryRefUnavailable(entry);
        ports.journal.complete(
          entry.journal.proposal_id,
          entry.journal.operation_id,
          ports.finalJournalResult("not_applied"),
        );
        state.selected.add(entry.context.operation.operation_id);
        state.operationResults.set(
          entry.context.operation.operation_id,
          ports.createOperationResult(
            entry.context.group.group_id,
            entry.context.operation.operation_id,
            "not_applied",
            reasonCode,
            taskGid,
          ),
        );
        ports.reportOperationEvent(
          new Error("復旧時に外部変更が未適用と確定したため、再送せず完了しました。"),
          entry,
          {
            severity: "warning",
            api_action: "journal_plan",
            journal_stage: stage,
            effect_certainty: "none",
            reason_code: reasonCode,
            recovery_decision: "not_applied",
            attempt: 1,
            phase: "recovery",
          },
          taskGid,
        );
        if (entry.context.group.atomic) {
          blockedGroups.add(entry.context.group.group_id);
        }
      };
      const updateStage = (
        entry: TEntry,
        targetStage: JournalStage,
      ): void => {
        const currentStage = stageByOperation.get(entry.journal.operation_id);
        if (currentStage == null) {
          throw new Error("復旧対象の適用段階がありません。");
        }
        const currentIndex = journalStages.indexOf(currentStage);
        const targetIndex = journalStages.indexOf(targetStage);
        if (currentIndex < 0 || targetIndex < 0) {
          throw new Error("復旧対象の適用段階が不正です。");
        }
        if (targetIndex < currentIndex) {
          throw new Error("復旧対象の適用段階を後退させられません。");
        }
        for (let index = currentIndex + 1; index <= targetIndex; index += 1) {
          const stage = journalStages[index];
          if (stage == null) {
            throw new Error("復旧対象の適用段階が見つかりません。");
          }
          ports.journal.updateStage(
            entry.journal.proposal_id,
            entry.journal.operation_id,
            stage,
          );
          stageByOperation.set(entry.journal.operation_id, stage);
        }
      };
      const finishKnown = (
        entry: TEntry,
        result: TResult,
        taskGid: string,
        apiAction: RecoveryDiagnosticFields<TAction>["api_action"],
        attempt: number,
      ): void => {
        if (stageByOperation.get(entry.journal.operation_id) == null) {
          throw new Error("復旧対象の適用段階がありません。");
        }
        observedEffectByOperation.set(entry.journal.operation_id, "confirmed");
        state.selected.add(entry.context.operation.operation_id);
        state.operationResults.set(entry.context.operation.operation_id, result);
        try {
          const stage = stageByOperation.get(entry.journal.operation_id);
          if (stage == null) {
            throw new Error("復旧対象の適用段階がありません。");
          }
          const stageIndex = journalStages.indexOf(stage);
          const readBackIndex = journalStages.indexOf("read_back");
          const metadataIndex = journalStages.indexOf("metadata_verified");
          const rankingIndex = journalStages.indexOf("ranking_recalculated");
          if (stageIndex < readBackIndex) {
            updateStage(entry, "read_back");
          }
          const currentStage = stageByOperation.get(entry.journal.operation_id);
          if (currentStage == null) {
            throw new Error("復旧後の適用段階がありません。");
          }
          if (journalStages.indexOf(currentStage) < metadataIndex) {
            updateStage(entry, "metadata_verified");
          }
          const updatedStage = stageByOperation.get(entry.journal.operation_id);
          if (updatedStage == null) {
            throw new Error("復旧後の適用段階がありません。");
          }
          if (journalStages.indexOf(updatedStage) < rankingIndex) {
            statePending.push({
              entry: {
                ...entry,
                journal: ports.parseJournalWithPlan({
                  ...entry.journal,
                  stage: updatedStage,
                }),
              },
              task_gid: taskGid,
            });
          } else {
            ports.journal.complete(
              entry.journal.proposal_id,
              entry.journal.operation_id,
              ports.finalJournalResult("applied"),
            );
          }
        } catch (error: unknown) {
          const stage = stageByOperation.get(entry.journal.operation_id)
            ?? entry.journal.stage;
          const receipt = ports.reportOperationEventOnce(
            error,
            entry,
            {
              severity: "error",
              api_action: apiAction,
              journal_stage: stage,
              effect_certainty: "confirmed",
              reason_code: "recovery_required",
              recovery_decision: "unresolved",
              attempt,
              phase: "journal",
            },
            taskGid,
          );
          throw receipt;
        }
      };
      for (const entry of state.entries) {
        ports.throwIfAborted(signal);
        const operationId = entry.context.operation.operation_id;
        const currentStage = stageByOperation.get(operationId);
        if (currentStage == null) {
          throw new Error("復旧対象の適用段階がありません。");
        }
        const currentStageIndex = journalStages.indexOf(currentStage);
        if (currentStageIndex < 0) {
          throw new Error("復旧対象の適用段階が不正です。");
        }
        const unavailableTemporaryReference = ports.operationTemporaryReferences(
          entry.context.operation,
        ).find((temporaryRef) =>
          !state.mappings.has(temporaryRef)
          || state.unavailableTemporaryRefs.has(temporaryRef));
        let createdTaskGid: string | undefined;
        if (entry.context.operation.operation === "create_task") {
          createdTaskGid = state.mappings.get(ports.createTemporaryRef(entry.context.operation));
        }
        const taskGidForResult = (): string | undefined => {
          if (entry.context.operation.operation === "create_task") {
            return createdTaskGid
              ?? state.mappings.get(ports.createTemporaryRef(entry.context.operation));
          }
          return ports.targetGid(entry.context.operation, state.mappings);
        };
        let writeAttemptCount = 0;
        let lastWriteAction: TAction | undefined;
        const onWriteAttempt = (action: TAction): void => {
          const current = stageByOperation.get(operationId);
          if (current == null) {
            throw new Error("復旧対象の適用段階がありません。");
          }
          if (current === "prepared") {
            try {
              updateStage(entry, "write_started");
            } catch (error: unknown) {
              const stage = stageByOperation.get(operationId);
              if (stage == null) {
                throw error;
              }
              const receipt = ports.reportOperationEventOnce(
                error,
                entry,
                {
                  severity: "error",
                  api_action: action,
                  journal_stage: stage,
                  effect_certainty: observedEffectByOperation.get(operationId)
                    ?? "none",
                  reason_code: "recovery_required",
                  recovery_decision: "failed",
                  attempt: 1,
                  phase: "journal",
                },
                taskGidForResult(),
              );
              throw receipt;
            }
          }
          const stage = stageByOperation.get(operationId);
          if (stage == null) {
            throw new Error("復旧対象の適用段階がありません。");
          }
          writeAttemptCount += 1;
          lastWriteAction = action;
          if (observedEffectByOperation.get(operationId) !== "confirmed") {
            observedEffectByOperation.set(operationId, "possible");
          }
          ports.reportOperationEvent(
            new Error("復旧可能な外部操作を限定再開します。"),
            entry,
            {
              severity: "warning",
              api_action: action,
              journal_stage: stage,
              effect_certainty: observedEffectByOperation.get(operationId)
                ?? "none",
              reason_code: "recovery_required",
              recovery_decision: "resume",
              attempt: writeAttemptCount,
              phase: "external_write",
            },
            taskGidForResult(),
          );
        };
        const reportRecoveryError = (
          error: unknown,
          apiAction:
            | TAction
            | "create_task"
            | "operation_writer"
            | "read_task"
            | "read_project_tasks",
          phase: RecoveryDiagnosticFields<TAction>["phase"],
        ): TReceipt => {
          const stage = stageByOperation.get(operationId);
          if (stage == null) {
            throw new Error("復旧対象の適用段階がありません。");
          }
          const effectCertainty = observedEffectByOperation.get(operationId);
          if (effectCertainty == null) {
            throw new Error("復旧対象の外部作用確度がありません。");
          }
          return ports.reportOperationEventOnce(
            error,
            entry,
            {
              severity: "error",
              api_action: apiAction,
              journal_stage: stage,
              effect_certainty: effectCertainty,
              reason_code: effectCertainty === "none"
                ? "external_api_failed"
                : "recovery_required",
              recovery_decision: effectCertainty === "none"
                ? "failed"
                : "unresolved",
              attempt: Math.max(1, writeAttemptCount),
              phase,
            },
            taskGidForResult(),
          );
        };
        if (
          currentStage === "read_back"
          || currentStage === "metadata_verified"
          || currentStage === "ranking_recalculated"
        ) {
          if (unavailableTemporaryReference != null) {
            markUnresolved(entry, "recovery_required", taskGidForResult());
            continue;
          }
          const taskGid = taskGidForResult();
          if (taskGid == null) {
            markUnresolved(entry, "recovery_required", taskGid);
            continue;
          }
          finishKnown(
            entry,
            ports.createOperationResult(
              entry.context.group.group_id,
              operationId,
              "already_applied",
              "already_applied",
              taskGid,
            ),
            taskGid,
            currentStage === "ranking_recalculated" ? "post_apply" : "read_task",
            1,
          );
          continue;
        }
        if (blockedGroups.has(entry.context.group.group_id)) {
          if (currentStage === "prepared") {
            completeNotApplied(entry, "atomic_group_blocked", taskGidForResult());
          } else {
            markUnresolved(entry, "recovery_required", taskGidForResult());
          }
          continue;
        }
        if (unavailableTemporaryReference != null) {
          if (currentStage === "prepared") {
            completeNotApplied(entry, "task_not_found", taskGidForResult());
          } else {
            markUnresolved(entry, "recovery_required", taskGidForResult());
          }
          continue;
        }

        if (entry.context.operation.operation === "create_task") {
          const operation = entry.context.operation;
          const createUuid = entry.journal.plan.create_uuid;
          if (createUuid == null || operation.operation !== "create_task") {
            throw new Error("create_taskの復旧UUIDがありません。");
          }
          let existingTask: TTask | undefined;
          const mappedGid = state.mappings.get(ports.createTemporaryRef(operation));
          if (currentStage === "prepared") {
            let matches: readonly TTask[];
            try {
              const tasks = await ports.loadProjectTasks(state.settings.project_gid);
              matches = ports.matchingExternalTasks(tasks, createUuid);
            } catch (error) {
              if (signal.aborted) {
                signal.throwIfAborted();
                throw error;
              }
              throw reportRecoveryError(error, "read_project_tasks", "preflight");
            }
            if (matches.length > 0) {
              completeNotApplied(entry, "external_id_collision", undefined);
              continue;
            }
            if (mappedGid != null) {
              throw new Error("prepared create_taskに作成済みGID対応が残っています。");
            }
          } else if (mappedGid == null) {
            let matches: readonly TTask[];
            try {
              const tasks = await ports.loadProjectTasks(state.settings.project_gid);
              matches = ports.matchingExternalTasks(tasks, createUuid);
            } catch (error) {
              if (signal.aborted) {
                signal.throwIfAborted();
                throw error;
              }
              throw reportRecoveryError(error, "read_project_tasks", "read_back");
            }
            if (matches.length > 1) {
              markUnresolved(entry, "duplicate_external_id", undefined);
              continue;
            }
            existingTask = matches[0];
            if (existingTask == null) {
              markUnresolved(entry, "task_not_found", undefined);
              continue;
            }
            if (existingTask != null) {
              createdTaskGid = existingTask.gid;
              observedEffectByOperation.set(operationId, "confirmed");
              try {
                addTemporaryMapping(state.mappings, ports.createTemporaryRef(operation), existingTask.gid);
                ports.journal.recordCreatedTask(
                  entry.journal.proposal_id,
                  entry.journal.operation_id,
                  ports.createTemporaryRef(operation),
                  existingTask.gid,
                );
              } catch (error: unknown) {
                const stage = stageByOperation.get(operationId);
                if (stage == null) {
                  throw error;
                }
                const receipt = ports.reportOperationEventOnce(
                  error,
                  entry,
                  {
                    severity: "error",
                    api_action: "read_project_tasks",
                    journal_stage: stage,
                    effect_certainty: "confirmed",
                    reason_code: "recovery_required",
                    recovery_decision: "unresolved",
                    attempt: 1,
                    phase: "journal",
                  },
                  createdTaskGid,
                );
                throw receipt;
              }
              const stage = stageByOperation.get(operationId);
              if (stage == null) {
                throw new Error("復旧対象の適用段階がありません。");
              }
              stageByOperation.set(
                operationId,
                stage === "write_started" ? "task_created" : stage,
              );
              ports.reportOperationEvent(
                new Error("作成UUIDと一致するタスクが一件だけ見つかり、復旧対象として結び付けました。"),
                entry,
                {
                  severity: "warning",
                  api_action: "read_project_tasks",
                  journal_stage: stageByOperation.get(entry.journal.operation_id)
                    ?? currentStage,
                  effect_certainty: "confirmed",
                  reason_code: "recovery_required",
                  recovery_decision: "resume",
                  attempt: 1,
                  phase: "read_back",
                },
                existingTask.gid,
              );
            }
          }
          const stageBeforeWrite = stageByOperation.get(entry.journal.operation_id);
          if (stageBeforeWrite == null) {
            throw new Error("create_taskの復旧段階がありません。");
          }
          const writerInput = ports.createWriterInput(
            entry.context,
            state.settings,
            state.mappings,
            undefined,
            createUuid,
            existingTask,
          );
          let rawTWriterResult: TWriterResult;
          try {
          if (journalStages.indexOf(stageBeforeWrite) >= journalStages.indexOf("read_back")) {
              if (existingTask == null) {
                markUnresolved(entry, "task_not_found", undefined);
                continue;
              }
              const inspection = await ports.writer.inspectRecovery(writerInput, signal);
              if (inspection.core_state !== "after" || inspection.metadata_state !== "after") {
                markUnresolved(entry, "recovery_required", existingTask.gid);
                continue;
              }
              finishKnown(
                entry,
                ports.createOperationResult(
                  entry.context.group.group_id,
                  operationId,
                  "already_applied",
                  "already_applied",
                  inspection.task.gid,
                ),
                inspection.task.gid,
                "read_task",
                1,
              );
              continue;
            }
              rawTWriterResult = await ports.writer.applyWithCreateTaskCallback(
              writerInput,
              signal,
              (createdOperationId, taskGid) => {
                if (createdOperationId !== operationId) {
                  throw new Error("作成済みタスク通知のoperation_idが一致しません。");
                }
                createdTaskGid = taskGid;
                observedEffectByOperation.set(operationId, "confirmed");
                try {
                  addTemporaryMapping(state.mappings, ports.createTemporaryRef(operation), taskGid);
                  ports.journal.recordCreatedTask(
                    entry.journal.proposal_id,
                    entry.journal.operation_id,
                    ports.createTemporaryRef(operation),
                    taskGid,
                  );
                } catch (error: unknown) {
                  const stage = stageByOperation.get(operationId);
                  if (stage == null) {
                    throw error;
                  }
                  const receipt = ports.reportOperationEventOnce(
                    error,
                    entry,
                    {
                      severity: "error",
                      api_action: lastWriteAction ?? "create_task",
                      journal_stage: stage,
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
                const stage = stageByOperation.get(operationId);
                if (stage == null) {
                  throw new Error("復旧対象の適用段階がありません。");
                }
                stageByOperation.set(
                  operationId,
                  stage === "write_started" ? "task_created" : stage,
                );
              },
              onWriteAttempt,
            );
          } catch (error) {
            if (ports.isCreateTaskNotFoundError(error)) {
              reportRecoveryError(
                error,
                lastWriteAction ?? "operation_writer",
                "read_back",
              );
              markUnresolved(entry, "task_not_found", error.taskGid);
              continue;
            }
            if (signal.aborted) {
              signal.throwIfAborted();
              throw error;
            }
            throw reportRecoveryError(
              error,
              lastWriteAction ?? "operation_writer",
              journalStages.indexOf(stageBeforeWrite) >= journalStages.indexOf("read_back")
                ? "read_back"
                : "external_write",
            );
          }
          const expectedTaskGid = existingTask?.gid;
          const parsedTWriterResult = ports.safeParseWriterResult(
            rawTWriterResult,
          );
          if (
            parsedTWriterResult.success
            && parsedTWriterResult.data.outcome !== "conflict"
          ) {
            observedEffectByOperation.set(operationId, "confirmed");
          }
          let writerResult: TWriterResult;
          try {
            writerResult = ports.validateWriterResult(
              entry.context,
              rawTWriterResult,
              expectedTaskGid,
            );
          } catch (error: unknown) {
            throw reportRecoveryError(
              error,
              lastWriteAction ?? "create_task",
              "read_back",
            );
          }
          if (writerResult.outcome === "conflict") {
            markUnresolved(
              entry,
              "recovery_required",
              createdTaskGid ?? writerResult.task_gid,
            );
            continue;
          }
          createdTaskGid = writerResult.task_gid;
          observedEffectByOperation.set(operationId, "confirmed");
          try {
            addTemporaryMapping(
              state.mappings,
              ports.createTemporaryRef(operation),
              writerResult.task_gid,
            );
          } catch (error: unknown) {
            throw reportRecoveryError(
              error,
              lastWriteAction ?? "create_task",
              "journal",
            );
          }
          finishKnown(
            entry,
            ports.writerResultToApplicationResult(entry.context, writerResult),
            writerResult.task_gid,
            lastWriteAction ?? "create_task",
            Math.max(1, writeAttemptCount),
          );
          continue;
        }

        const taskGid = ports.targetGid(entry.context.operation, state.mappings);
        if (taskGid == null) {
          if (currentStage === "prepared") {
            completeNotApplied(entry, "task_not_found", undefined);
          } else {
            markUnresolved(entry, "recovery_required", undefined);
          }
          continue;
        }
        let taskRead: Awaited<ReturnType<typeof ports.readTask>>;
        try {
          taskRead = await ports.readTask(taskGid);
        } catch (error) {
          if (signal.aborted) {
            signal.throwIfAborted();
            throw error;
          }
          throw reportRecoveryError(error, "read_task", "read_back");
        }
        if (taskRead.kind === "missing") {
          reportRecoveryError(taskRead.error, "read_task", "read_back");
          if (currentStage === "prepared") {
            completeNotApplied(entry, "task_not_found", taskGid);
          } else {
            markUnresolved(entry, "task_not_found", taskGid);
          }
          continue;
        }
        const baseline = ports.baselineFromJournalPlan(
          entry,
          state.plannedEntries,
          state.settings,
          state.mappings,
        );
        const writerInput = ports.createWriterInput(
          entry.context,
          state.settings,
          state.mappings,
          baseline,
          undefined,
          undefined,
        );
        let inspection: RecoveryInspection<TTask>;
        try {
          inspection = await ports.writer.inspectRecovery(writerInput, signal);
        } catch (error) {
          if (signal.aborted) {
            signal.throwIfAborted();
            throw error;
          }
          throw reportRecoveryError(error, "operation_writer", "read_back");
        }
        if (
          inspection.core_state === "after"
          && inspection.metadata_state === "after"
        ) {
          finishKnown(
            entry,
            ports.createOperationResult(
              entry.context.group.group_id,
              operationId,
              "already_applied",
              "already_applied",
              taskGid,
            ),
            taskGid,
            "read_task",
            1,
          );
          continue;
        }
        if (
          inspection.core_state === "conflict"
          || inspection.metadata_state === "conflict"
        ) {
          if (observedEffectByOperation.get(operationId) === "none") {
            completeNotApplied(entry, "writer_conflict", taskGid);
          } else {
            markUnresolved(entry, "recovery_required", taskGid);
          }
          continue;
        }
        if (currentStageIndex >= journalStages.indexOf("read_back")) {
          markUnresolved(entry, "recovery_required", taskGid);
          continue;
        }
        let rawTWriterResult: TWriterResult;
        try {
          rawTWriterResult = await ports.writer.applyWithWriteAttemptCallback(
            writerInput,
            signal,
            onWriteAttempt,
          );
        } catch (error) {
          if (signal.aborted) {
            signal.throwIfAborted();
            throw error;
          }
          throw reportRecoveryError(
            error,
            lastWriteAction ?? "operation_writer",
            "external_write",
          );
        }
        const parsedTWriterResult = ports.safeParseWriterResult(
          rawTWriterResult,
        );
        if (
          parsedTWriterResult.success
          && parsedTWriterResult.data.outcome !== "conflict"
        ) {
          observedEffectByOperation.set(operationId, "confirmed");
        }
        let writerResult: TWriterResult;
        try {
          writerResult = ports.validateWriterResult(entry.context, rawTWriterResult, taskGid);
        } catch (error: unknown) {
          throw reportRecoveryError(
            error,
            lastWriteAction ?? "operation_writer",
            "read_back",
          );
        }
        if (writerResult.outcome === "conflict") {
          if (
            writerResult.side_effect === "none"
            && observedEffectByOperation.get(operationId) === "none"
            && currentStageIndex < journalStages.indexOf("read_back")
          ) {
            completeNotApplied(entry, "writer_conflict", taskGid);
          } else {
            markUnresolved(entry, "recovery_required", taskGid);
          }
          continue;
        }
        finishKnown(
          entry,
          ports.writerResultToApplicationResult(entry.context, writerResult),
          taskGid,
          lastWriteAction ?? "operation_writer",
          Math.max(1, writeAttemptCount),
        );
      }
      for (const pending of statePending) {
        pendingJournals.push({ state, pending });
      }
    }

  return pendingJournals;
}
