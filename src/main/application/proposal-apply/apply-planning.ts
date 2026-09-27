import {
  addTemporaryMapping,
  approvalGroupMap,
  baselineExternalMap,
  approvalOperationMap,
  collectApplicableOperationIds,
  flattenProposal,
  issueCreateUuids,
  mappingArray,
  operationMap,
  temporaryMappingMap,
} from "./application-plan";
import { orderApplicableContexts } from "./operation-order";

type Operation = {
  readonly operation: string;
  readonly operation_id: string;
  readonly temporary_ref?: string;
};
type Group<TOperation extends Operation> = {
  readonly group_id: string;
  readonly atomic: boolean;
  readonly operations: readonly TOperation[];
};
type Proposal<TOperation extends Operation> = {
  readonly groups: readonly Group<TOperation>[];
};
type Context<TOperation extends Operation> = {
  readonly group: { readonly group_id: string; readonly atomic: boolean };
  readonly operation: TOperation;
};
type Mapping = { readonly temporary_ref: string; readonly task_gid: string };
type ApprovalInput<TProposal, TTask> = {
  readonly proposal: TProposal;
  readonly current_tasks: readonly TTask[];
  readonly selected_operation_ids: readonly string[];
  readonly journal_task_mappings: readonly Mapping[];
};
type ApplicationInput<TProposal, TTask, TBaseline> = {
  readonly proposal_id: string;
  readonly project_gid: string;
  readonly approval_input: ApprovalInput<TProposal, TTask>;
  readonly baseline_external_data: readonly {
    readonly task_gid: string;
    readonly external: TBaseline;
  }[];
};
type ApprovalResult = {
  readonly operations: readonly { readonly operation_id: string; readonly kind: string }[];
  readonly groups: readonly { readonly group_id: string; readonly applicable: boolean }[];
};
type Journal = { readonly proposal_id: string; readonly operation_id: string };
type PlannedJournal = Journal & {
  readonly plan: { readonly temporary_ref_to_gid: readonly Mapping[] };
};
type ValidationDiagnostic<TOperation extends Operation> = {
  readonly severity: "warning";
  readonly proposal_id: string;
  readonly operation_id: string;
  readonly operation_kind: TOperation["operation"];
  readonly api_action: "journal_plan";
  readonly effect_certainty: "none";
  readonly task_gid: string | undefined;
  readonly reason_code: "approval_conflict" | "atomic_group_blocked";
  readonly recovery_decision: "not_applied";
  readonly attempt: number;
  readonly phase: "validation";
};
type PlanEntryInput<
  TInput,
  TOperation extends Operation,
  TBaseline,
> = {
  readonly input: TInput;
  readonly context: Context<TOperation>;
  readonly contexts: readonly Context<TOperation>[];
  readonly applicableOperationIds: ReadonlySet<string>;
  readonly mappings: ReadonlyMap<string, string>;
  readonly baselines: ReadonlyMap<string, TBaseline>;
  readonly uuids: ReadonlyMap<string, string>;
  readonly groupOrder: number;
  readonly operationOrder: number;
};
type PlanningPorts<
  TInput extends ApplicationInput<Proposal<TOperation>, TTask, TBaseline>,
  TOperation extends Operation,
  TTask,
  TBaseline,
  TJournal extends Journal,
  TPlannedJournal extends TJournal & PlannedJournal,
  TResult,
  TApproval extends ApprovalResult,
> = {
  readonly journal: {
    readonly getByProposal: (proposalId: string) => readonly TJournal[];
    readonly prepare: (entries: readonly TJournal[]) => void;
  };
  readonly hasPlan: (journal: TJournal) => journal is TPlannedJournal;
  readonly classify: (input: TInput["approval_input"]) => TApproval;
  readonly validateGraph: (input: {
    readonly proposal: TInput["approval_input"]["proposal"];
    readonly managed_tasks: TInput["approval_input"]["current_tasks"];
    readonly selected_operation_ids: string[];
    readonly temporary_ref_mappings: Mapping[];
  }) => { readonly kind: string };
  readonly validateBaselineCoverage: (
    contexts: readonly Context<TOperation>[],
    selected: ReadonlySet<string>,
    mappings: ReadonlyMap<string, string>,
    baselines: ReadonlyMap<string, TBaseline>,
  ) => void;
  readonly createTaskTemporaryReferences: (operation: TOperation) => readonly string[];
  readonly createPlanEntry: (
    input: PlanEntryInput<TInput, TOperation, TBaseline>,
  ) => TPlannedJournal;
  readonly targetGid: (
    operation: TOperation,
    mappings: ReadonlyMap<string, string>,
  ) => string | undefined;
  readonly createResult: (
    groupId: string,
    operationId: string,
    outcome: "not_applied" | "already_applied",
    reasonCode: "approval_conflict" | "atomic_group_blocked" | "already_applied",
    taskGid: string | undefined,
  ) => TResult;
  readonly reportValidation: (
    error: unknown,
    fields: ValidationDiagnostic<TOperation>,
  ) => Error;
  readonly uuidGenerator: () => string;
};

function validateAtomicSelection<TOperation extends Operation>(
  proposal: Proposal<TOperation>,
  selectedOperationIds: ReadonlySet<string>,
): void {
  for (const group of proposal.groups) {
    if (!group.atomic) {
      continue;
    }
    const selectedCount = group.operations.filter((operation) =>
      selectedOperationIds.has(operation.operation_id)).length;
    if (selectedCount > 0 && selectedCount !== group.operations.length) {
      throw new Error(`atomicグループ ${group.group_id} の操作を部分選択できません。`);
    }
  }
}

/** 承認結果から保存可能な適用計画を組み立て、書き込み前に保存します。 */
export function prepareApplication<
  TInput extends ApplicationInput<Proposal<TOperation>, TTask, TBaseline>,
  TOperation extends Operation,
  TTask,
  TBaseline,
  TJournal extends Journal,
  TPlannedJournal extends TJournal & PlannedJournal,
  TResult,
  TApproval extends ApprovalResult,
>(
  validatedInput: TInput,
  ports: PlanningPorts<
    TInput,
    TOperation,
    TTask,
    TBaseline,
    TJournal,
    TPlannedJournal,
    TResult,
    TApproval
  >,
) {
  const contexts = flattenProposal(validatedInput.approval_input.proposal);
  const contextMap = operationMap(contexts);
  const selected = new Set(validatedInput.approval_input.selected_operation_ids);
  validateAtomicSelection(validatedInput.approval_input.proposal, selected);
  const mappings = temporaryMappingMap(
    validatedInput.approval_input.journal_task_mappings,
  );
  const existingJournals = new Map<string, TJournal>();
  for (const journal of ports.journal.getByProposal(validatedInput.proposal_id)) {
    if (existingJournals.has(journal.operation_id)) {
      throw new Error("同じproposalの適用ジャーナルが重複しています。");
    }
    existingJournals.set(journal.operation_id, journal);
    if (ports.hasPlan(journal)) {
      for (const mapping of journal.plan.temporary_ref_to_gid) {
        addTemporaryMapping(mappings, mapping.temporary_ref, mapping.task_gid);
      }
    }
  }
  const existingJournalOperationIds = new Set(existingJournals.keys());
  const approvalInput = {
    ...validatedInput.approval_input,
    journal_task_mappings: mappingArray(mappings),
  };
  const approval = ports.classify(approvalInput);
  const approvalOperations = approvalOperationMap(approval);
  const approvalGroups = approvalGroupMap(approval);
  const applicableOperationIds = collectApplicableOperationIds(
    contexts,
    selected,
    approvalOperations,
    approvalGroups,
  );
  const graphSafety = ports.validateGraph({
    proposal: validatedInput.approval_input.proposal,
    managed_tasks: validatedInput.approval_input.current_tasks,
    selected_operation_ids: [...applicableOperationIds],
    temporary_ref_mappings: mappingArray(mappings),
  });
  if (graphSafety.kind === "unsafe") {
    throw new Error(
      "競合分類後の実適用操作だけでは依存関係または親子関係に新しい循環が生じます。",
    );
  }
  const operationIdsToProcess = new Set(applicableOperationIds);
  for (const operationId of selected) {
    if (existingJournals.has(operationId)) {
      operationIdsToProcess.add(operationId);
    }
  }
  const applicable = operationIdsToProcess;
  const newApplicable = new Set(
    applicableOperationIds.filter(
      (operationId) => !existingJournals.has(operationId),
    ),
  );
  const uuids = issueCreateUuids(contexts, newApplicable, ports.uuidGenerator);
  const baselines = baselineExternalMap(validatedInput.baseline_external_data);
  const newSelected = new Set(
    [...selected].filter((operationId) => !existingJournals.has(operationId)),
  );
  ports.validateBaselineCoverage(contexts, newSelected, mappings, baselines);
  const operationResults = new Map<string, TResult>();
  const operationGroupsBlocked = new Set<string>();
  const failedTemporaryRefs = new Set<string>();

  for (const context of contexts) {
    if (!selected.has(context.operation.operation_id)) {
      continue;
    }
    if (existingJournals.has(context.operation.operation_id)) {
      continue;
    }
    const classification = approvalOperations.get(context.operation.operation_id);
    if (classification == null) {
      throw new Error("承認競合結果の操作がありません。");
    }
    if (classification.kind === "conflict") {
      ports.reportValidation(
        new Error("承認時点の外部状態と一致しないため、この操作を適用しませんでした。"),
        {
          severity: "warning",
          proposal_id: validatedInput.proposal_id,
          operation_id: context.operation.operation_id,
          operation_kind: context.operation.operation,
          api_action: "journal_plan",
          effect_certainty: "none",
          task_gid: ports.targetGid(context.operation, mappings),
          reason_code: "approval_conflict",
          recovery_decision: "not_applied",
          attempt: 1,
          phase: "validation",
        },
      );
      operationResults.set(
        context.operation.operation_id,
        ports.createResult(
          context.group.group_id,
          context.operation.operation_id,
          "not_applied",
          "approval_conflict",
          ports.targetGid(context.operation, mappings),
        ),
      );
      if (context.operation.operation === "create_task") {
        if (context.operation.temporary_ref == null) {
          throw new Error("create_taskのtemporary_refがありません。");
        }
        failedTemporaryRefs.add(context.operation.temporary_ref);
      }
      continue;
    }
    const group = approvalGroups.get(context.group.group_id);
    if (group == null) {
      throw new Error("承認競合結果のグループがありません。");
    }
    if (classification.kind === "already_applied") {
      operationResults.set(
        context.operation.operation_id,
        ports.createResult(
          context.group.group_id,
          context.operation.operation_id,
          "already_applied",
          "already_applied",
          ports.targetGid(context.operation, mappings),
        ),
      );
    } else if (!group.applicable) {
      operationGroupsBlocked.add(context.group.group_id);
      ports.reportValidation(
        new Error("atomic group内に適用できない操作があるため、この操作を適用しませんでした。"),
        {
          severity: "warning",
          proposal_id: validatedInput.proposal_id,
          operation_id: context.operation.operation_id,
          operation_kind: context.operation.operation,
          api_action: "journal_plan",
          effect_certainty: "none",
          task_gid: ports.targetGid(context.operation, mappings),
          reason_code: "atomic_group_blocked",
          recovery_decision: "not_applied",
          attempt: 1,
          phase: "validation",
        },
      );
      operationResults.set(
        context.operation.operation_id,
        ports.createResult(
          context.group.group_id,
          context.operation.operation_id,
          "not_applied",
          "atomic_group_blocked",
          ports.targetGid(context.operation, mappings),
        ),
      );
      if (context.operation.operation === "create_task") {
        if (context.operation.temporary_ref == null) {
          throw new Error("create_taskのtemporary_refがありません。");
        }
        failedTemporaryRefs.add(context.operation.temporary_ref);
      }
    }
  }
  const applicableContexts = orderApplicableContexts(
    contexts.filter((context) => applicable.has(context.operation.operation_id)),
    mappings,
    ports.createTaskTemporaryReferences,
  );
  const groupOrders = new Map<string, number>();
  validatedInput.approval_input.proposal.groups.forEach((group, index) => {
    groupOrders.set(group.group_id, index);
  });
  const preparedEntries = new Map<string, TPlannedJournal>();
  const entriesToPrepare: TJournal[] = [];
  applicableContexts.forEach((context, operationOrder) => {
    const existingJournal = existingJournals.get(context.operation.operation_id);
    if (existingJournal != null) {
      return;
    }
    const groupOrder = groupOrders.get(context.group.group_id);
    if (groupOrder == null) {
      throw new Error("復旧計画のグループ順が見つかりません。");
    }
    const entry = ports.createPlanEntry({
      input: validatedInput,
      context,
      contexts,
      applicableOperationIds: applicable,
      mappings,
      baselines,
      uuids,
      groupOrder,
      operationOrder,
    });
    preparedEntries.set(context.operation.operation_id, entry);
    entriesToPrepare.push(entry);
  });
  if (entriesToPrepare.length > 0) {
    ports.journal.prepare(entriesToPrepare);
  }
  return {
    contexts,
    contextMap,
    selected,
    mappings,
    existingJournals,
    existingJournalOperationIds,
    applicableContexts,
    uuids,
    baselines,
    operationResults,
    operationGroupsBlocked,
    failedTemporaryRefs,
    preparedEntries,
  };
}
