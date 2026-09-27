import { addTemporaryMapping, flattenProposal, operationMap } from "./application-plan";
import { orderApplicableContexts } from "./operation-order";
import { recoverySettingsFromPlan, type OperationContext, type RecoverySettings } from "./recovery-plan";
import { type JournalStage } from "./journal-progress";

type RecoveryOperation = {
  readonly operation: string;
  readonly operation_id: string;
  readonly temporary_ref?: string;
};
type RecoveryPlanOperation = RecoveryOperation;
type RecoveryPlan<TOperation extends RecoveryPlanOperation> = RecoverySettings & {
  readonly group_id: string;
  readonly group_order: number;
  readonly operation_order: number;
  readonly atomic: boolean;
  readonly temporary_ref_to_gid: readonly { readonly temporary_ref: string; readonly task_gid: string }[];
  readonly operation: TOperation;
  readonly create_uuid?: string | undefined;
};
type RecoveryJournal<TPlan> = {
  readonly proposal_id: string;
  readonly operation_id: string;
  readonly stage: JournalStage;
  readonly final_result?: "applied" | "not_applied" | "unknown" | "failed" | undefined;
  readonly plan?: TPlan | undefined;
};
type RecoveryApplication<TOperation extends RecoveryOperation> = RecoverySettings & {
  readonly proposal_id: string;
  readonly proposal: {
    readonly groups: readonly {
      readonly group_id: string;
      readonly atomic: boolean;
      readonly operations: readonly TOperation[];
    }[];
  };
};
export type PlannedRecoveryEntry<TJournal, TOperation extends RecoveryOperation> = {
  readonly journal: TJournal;
  readonly context: OperationContext<TOperation>;
};
export type RecoveryApplicationState<TApplication, TResult, TEntry> = {
  readonly application: TApplication | undefined;
  readonly entries: readonly TEntry[];
  readonly plannedEntries: readonly TEntry[];
  readonly settings: RecoverySettings;
  readonly mappings: Map<string, string>;
  readonly unavailableTemporaryRefs: Set<string>;
  readonly blockedGroupIds: ReadonlySet<string>;
  readonly selected: Set<string>;
  readonly operationResults: Map<string, TResult>;
};
type RecoveryStatePorts<
  TApplication,
  TResult,
  TOperation extends RecoveryOperation,
  TJournalOperation extends RecoveryPlanOperation,
  TPlan extends RecoveryPlan<TJournalOperation>,
  TJournal extends RecoveryJournal<TPlan>,
  TPlannedJournal extends TJournal & { readonly plan: TPlan },
> = {
  readonly getByProposal: (proposalId: string) => readonly TJournal[];
  readonly hasPlan: (journal: TJournal) => journal is TPlannedJournal;
  readonly proposalOperationForJournalOperation: (operation: TJournalOperation) => TOperation;
  readonly journalOperationForProposalOperation: (operation: TOperation, uuids: ReadonlyMap<string, string>) => TJournalOperation;
  readonly journalOperationsMatch: (left: TJournalOperation, right: TJournalOperation) => boolean;
  readonly sameRecoverySettings: (left: RecoverySettings, right: RecoverySettings) => boolean;
  readonly createTaskTemporaryReferences: (operation: TOperation) => readonly string[];
  readonly createOperationResults: () => Map<string, TResult>;
  readonly throwIfAborted: (signal: AbortSignal) => void;
  readonly validateMemoryBaselineSource: (
    application: TApplication | undefined,
    entry: PlannedRecoveryEntry<TPlannedJournal, TOperation>,
    plannedEntries: readonly PlannedRecoveryEntry<TPlannedJournal, TOperation>[],
    settings: RecoverySettings,
    mappings: ReadonlyMap<string, string>,
  ) => void;
};

/** 保存済み計画と再開コンテキストを照合し、復旧対象を組み立てます。 */
export function prepareRecoveryStates<
  TApplication extends RecoveryApplication<TOperation>,
  TResult,
  TOperation extends RecoveryOperation,
  TJournalOperation extends RecoveryPlanOperation,
  TPlan extends RecoveryPlan<TJournalOperation>,
  TJournal extends RecoveryJournal<TPlan>,
  TPlannedJournal extends TJournal & { readonly plan: TPlan },
>(
  applicationsByProposal: ReadonlyMap<string, TApplication>,
  proposalIds: Iterable<string>,
  ports: RecoveryStatePorts<TApplication, TResult, TOperation, TJournalOperation, TPlan, TJournal, TPlannedJournal>,
  signal: AbortSignal,
): RecoveryApplicationState<TApplication, TResult, PlannedRecoveryEntry<TPlannedJournal, TOperation>>[] {
  const applicationStates: RecoveryApplicationState<TApplication, TResult, PlannedRecoveryEntry<TPlannedJournal, TOperation>>[] = [];
  for (const proposalId of proposalIds) {
      ports.throwIfAborted(signal);
      const mappings = new Map<string, string>();
      const unavailableTemporaryRefs = new Set<string>();
      const entries: PlannedRecoveryEntry<TPlannedJournal, TOperation>[] = [];
      const plannedEntries: PlannedRecoveryEntry<TPlannedJournal, TOperation>[] = [];
      const operationIds = new Set<string>();
      const operationOrders = new Set<number>();
      const groupDefinitions = new Map<string, { readonly order: number; readonly atomic: boolean }>();
      const groupOrders = new Map<number, string>();
      const blockedGroupIds = new Set<string>();
      let settings: RecoverySettings | undefined;
      const allProposalJournals = ports.getByProposal(proposalId);
      for (const journal of allProposalJournals) {
        if (!ports.hasPlan(journal)) {
          continue;
        }
        for (const mapping of journal.plan.temporary_ref_to_gid) {
          addTemporaryMapping(mappings, mapping.temporary_ref, mapping.task_gid);
        }
        if (
          journal.plan.operation.operation === "create_task"
          && journal.final_result != null
          && journal.final_result !== "applied"
        ) {
          if (journal.plan.operation.temporary_ref == null) {
            throw new Error("create_taskのtemporary_refがありません。");
          }
          unavailableTemporaryRefs.add(journal.plan.operation.temporary_ref);
        }
      }
      for (const journal of allProposalJournals) {
        if (!ports.hasPlan(journal)) {
          continue;
        }
        const plan = journal.plan;
        if (journal.operation_id !== plan.operation.operation_id) {
          throw new Error("適用ジャーナルと復旧計画の操作IDが一致しません。");
        }
        if (operationIds.has(journal.operation_id)) {
          throw new Error("同じ適用ジャーナルを重複して復旧できません。");
        }
        if (operationOrders.has(plan.operation_order)) {
          throw new Error("復旧計画のoperation_orderが重複しています。");
        }
        operationIds.add(journal.operation_id);
        operationOrders.add(plan.operation_order);
        const existingGroup = groupDefinitions.get(plan.group_id);
        if (
          existingGroup != null
          && (
            existingGroup.order !== plan.group_order
            || existingGroup.atomic !== plan.atomic
          )
        ) {
          throw new Error("復旧計画のグループ定義が一致しません。");
        }
        const existingGroupOrder = groupOrders.get(plan.group_order);
        if (existingGroupOrder != null && existingGroupOrder !== plan.group_id) {
          throw new Error("復旧計画のグループ順が重複しています。");
        }
        groupDefinitions.set(plan.group_id, {
          order: plan.group_order,
          atomic: plan.atomic,
        });
        groupOrders.set(plan.group_order, plan.group_id);
        const currentSettings = recoverySettingsFromPlan(plan);
        if (settings == null) {
          settings = currentSettings;
        } else if (!ports.sameRecoverySettings(settings, currentSettings)) {
          throw new Error("同じproposalの復旧計画設定が一致しません。");
        }
        for (const mapping of plan.temporary_ref_to_gid) {
          addTemporaryMapping(mappings, mapping.temporary_ref, mapping.task_gid);
        }
        const context: OperationContext<TOperation> = {
          group: {
            group_id: plan.group_id,
            atomic: plan.atomic,
          },
          operation: ports.proposalOperationForJournalOperation(plan.operation),
        };
        const plannedEntry = { journal, context };
        plannedEntries.push(plannedEntry);
        if (journal.final_result == null) {
          entries.push(plannedEntry);
        }
        if (
          plan.atomic
          && journal.final_result != null
          && journal.final_result !== "applied"
        ) {
          blockedGroupIds.add(plan.group_id);
        }
      }
      if (settings == null) {
        throw new Error("復旧計画の設定がありません。");
      }
      const application = applicationsByProposal.get(proposalId);
      if (application != null) {
        const applicationSettings: RecoverySettings = {
          project_gid: application.project_gid,
          workspace_gid: application.workspace_gid,
          section_gids: application.section_gids,
          device_id: application.device_id,
          created_via: application.created_via,
          activity_date: application.activity_date,
        };
        if (!ports.sameRecoverySettings(settings, applicationSettings)) {
          throw new Error("復旧計画と再開コンテキストの設定が一致しません。");
        }
        const memoryContexts = operationMap(flattenProposal(application.proposal));
        const memoryContextsForOrder: OperationContext<TOperation>[] = [];
        const memoryGroupOrders = new Map<string, number>();
        application.proposal.groups.forEach((group, index) => {
          memoryGroupOrders.set(group.group_id, index);
        });
        for (const entry of plannedEntries) {
          const memoryContext = memoryContexts.get(entry.context.operation.operation_id);
          if (memoryContext == null) {
            throw new Error("復旧計画の操作が再開コンテキストにありません。");
          }
          if (
            memoryContext.group.group_id !== entry.context.group.group_id
            || memoryContext.group.atomic !== entry.context.group.atomic
          ) {
            throw new Error("復旧計画と再開コンテキストのグループが一致しません。");
          }
          if (memoryGroupOrders.get(memoryContext.group.group_id) !== entry.journal.plan.group_order) {
            throw new Error("復旧計画と再開コンテキストのグループ順が一致しません。");
          }
          memoryContextsForOrder.push(memoryContext);
          const uuids = new Map<string, string>();
          if (entry.journal.plan.operation.operation === "create_task") {
            const createUuid = entry.journal.plan.create_uuid;
            if (createUuid == null) {
              throw new Error("復旧計画の作成UUIDがありません。");
            }
            uuids.set(entry.context.operation.operation_id, createUuid);
          }
          const memoryOperation = ports.journalOperationForProposalOperation(
            memoryContext.operation,
            uuids,
          );
          if (!ports.journalOperationsMatch(memoryOperation, entry.journal.plan.operation)) {
            throw new Error("復旧計画と再開コンテキストの操作が一致しません。");
          }
        }
        const orderedMemoryContexts = orderApplicableContexts(
          memoryContextsForOrder,
          mappings,
          ports.createTaskTemporaryReferences,
        );
        const orderedPlanOperationIds = [...plannedEntries]
          .sort((left, right) =>
            left.journal.plan.operation_order - right.journal.plan.operation_order)
          .map((entry) => entry.context.operation.operation_id);
        const orderedMemoryOperationIds = orderedMemoryContexts.map(
          (context) => context.operation.operation_id,
        );
        if (
          orderedPlanOperationIds.length !== orderedMemoryOperationIds.length
          || orderedPlanOperationIds.some(
            (operationId, index) => operationId !== orderedMemoryOperationIds[index],
          )
        ) {
          throw new Error("復旧計画と再開コンテキストの操作順が一致しません。");
        }
      }
      const operationResults = ports.createOperationResults();
      for (const entry of plannedEntries) {
        ports.validateMemoryBaselineSource(
          application,
          entry,
          plannedEntries,
          settings,
          mappings,
        );
      }
      applicationStates.push({
        application,
        entries,
        plannedEntries,
        settings,
        mappings,
        unavailableTemporaryRefs,
        blockedGroupIds,
        selected: new Set(),
        operationResults,
      });
    }

  return applicationStates;
}
