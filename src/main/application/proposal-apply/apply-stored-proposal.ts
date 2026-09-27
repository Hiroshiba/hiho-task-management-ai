import type {
  ProposalExecution,
  ProposalExecutionRepository,
} from "../common/ports/proposal-execution-repository";
import type { ProposalApplicationHistoryRepository } from "../common/ports/proposal-application-history";
import type { TaskWritePlan, TaskWritePayloadFingerprint } from "../common/task-write-plan";
import { proposalWriteOperationSchema, type ProposalWriteOperation } from "../../domain/proposal-write-operation";
import { planProposalTaskWrites } from "./proposal-write-plan";
import type { ProposalOperationPlanningContext } from "../common/task-write-operation-manifest";
import { orderApplicableContexts } from "./operation-order";
import { createTaskTemporaryReferences } from "./recovery-references";
import { createOperationResult } from "./operation-result";
import { latestProposalExecution } from "./latest-proposal-execution";
import {
  projectStoredProposalResult,
  type ApplicationOperationResult,
  type SelectedProposal,
  type StoredProposalApplicationResult,
  type StoredProposalWriteResult,
} from "./stored-proposal-result";

type ApplicationInput = {
  readonly proposal_id: string;
  readonly project_gid: string;
  readonly workspace_gid: string;
  readonly section_gids: {
    readonly not_started: string;
    readonly in_progress: string;
    readonly completed: string;
    readonly withdrawn: string;
  };
  readonly device_id: string;
  readonly created_via: string;
  readonly activity_date: string;
  readonly baseline_external_data: readonly {
    readonly task_gid: string;
    readonly baseline: Extract<NonNullable<ProposalOperationPlanningContext["external_baseline"]>, { kind: "stored" }>;
  }[];
  readonly approval_input: {
    readonly proposal: SelectedProposal;
    readonly selected_operation_ids: readonly string[];
    readonly journal_task_mappings: TaskWritePlan["known_references"];
  };
};

type ApprovalResult = {
  readonly operations: readonly {
    readonly group_id: string;
    readonly operation_id: string;
    readonly kind: "applicable" | "already_applied" | "conflict";
  }[];
  readonly groups: readonly {
    readonly group_id: string;
    readonly applicable: boolean;
  }[];
};

export type StoredProposalExecutionPort = {
  readonly repository: Pick<ProposalExecutionRepository<StoredProposalWriteResult>, "get" | "getByProposal" | "getIncomplete" | "save">;
  readonly historyRepository: ProposalApplicationHistoryRepository;
  readonly engine: {
    run(executionId: string, signal: AbortSignal): Promise<ProposalExecution<StoredProposalWriteResult>>;
  };
  readonly createId: () => string;
  readonly now: () => string;
  readonly fingerprint: TaskWritePayloadFingerprint;
};

type OperationContext = {
  readonly group: SelectedProposal["groups"][number];
  readonly operation: ProposalWriteOperation;
};

function operationTargetGid(
  operation: SelectedProposal["groups"][number]["operations"][number],
  references: ReadonlyMap<string, string>,
): string | undefined {
  if (operation.operation === "create_task") {
    if (operation.temporary_ref == null) throw new Error("作成操作の一時参照がありません。");
    return references.get(operation.temporary_ref);
  }
  if (operation.target == null) throw new Error("変更操作の対象がありません。");
  return operation.target.kind === "existing"
    ? operation.target.gid
    : references.get(operation.target.ref);
}

function externalBaseline(
  operation: ProposalWriteOperation,
  contexts: readonly OperationContext[],
  references: ReadonlyMap<string, string>,
  baselines: ReadonlyMap<string, Extract<NonNullable<ProposalOperationPlanningContext["external_baseline"]>, { kind: "stored" }>>,
): ProposalOperationPlanningContext["external_baseline"] {
  if (operation.operation === "create_task") return undefined;
  if (operation.target.kind === "temporary") {
    const temporaryRef = operation.target.ref;
    const create = contexts.find((item) =>
      item.operation.operation === "create_task"
      && item.operation.temporary_ref === temporaryRef);
    if (create != null) {
      return {
        kind: "created_task",
        create_operation_id: create.operation.operation_id,
        temporary_ref: temporaryRef,
      };
    }
  }
  const gid = operationTargetGid(operation, references);
  if (gid == null) throw new Error("承認済み操作の対象GIDを解決できません。");
  return baselines.get(gid);
}

function existingExecution(
  proposalId: string,
  port: StoredProposalExecutionPort,
): ProposalExecution<StoredProposalWriteResult> | undefined {
  return latestProposalExecution(port.repository.getByProposal(proposalId));
}

/** 承認済みの全操作を一つの保存済みplanから適用します。 */
export async function applyStoredProposal(
  input: ApplicationInput,
  approval: ApprovalResult,
  assertGraphSafe: (operationIds: readonly string[]) => void,
  port: StoredProposalExecutionPort,
  signal: AbortSignal,
): Promise<StoredProposalApplicationResult> {
  signal.throwIfAborted();
  if (port.historyRepository.getByProposal(input.proposal_id) != null) {
    throw new Error("旧適用履歴がある変更案を新しいexecutionとして再実行できません。");
  }
  const proposal = input.approval_input.proposal;
  const selected = new Set(input.approval_input.selected_operation_ids);
  for (const group of proposal.groups) {
    if (!group.atomic) continue;
    const selectedCount = group.operations.filter((item) => selected.has(item.operation_id)).length;
    if (selectedCount > 0 && selectedCount !== group.operations.length) {
      throw new Error(`atomicグループ ${group.group_id} の操作を部分選択できません。`);
    }
  }
  const references = new Map(input.approval_input.journal_task_mappings.map((item) =>
    [item.temporary_ref, item.task_gid]));
  const baselineMap = new Map(input.baseline_external_data.map((item) =>
    [item.task_gid, item.baseline]));
  const approvalOperations = new Map(approval.operations.map((item) => [item.operation_id, item]));
  const approvalGroups = new Map(approval.groups.map((item) => [item.group_id, item]));
  const saved = existingExecution(input.proposal_id, port);
  const savedOperationIds = new Set(saved?.proposal_context?.groups.flatMap((group) => group.operation_ids) ?? []);
  const preflightResults = new Map<string, ApplicationOperationResult>();
  const executable: OperationContext[] = [];
  for (const group of proposal.groups) {
    const classification = approvalGroups.get(group.group_id);
    for (const original of group.operations) {
      if (!selected.has(original.operation_id)) continue;
      const decision = approvalOperations.get(original.operation_id);
      if (decision == null || decision.group_id !== group.group_id || classification == null) {
        throw new Error("承認競合結果の操作またはグループが一致しません。");
      }
      if (savedOperationIds.has(original.operation_id)) continue;
      if (decision.kind === "conflict") {
        preflightResults.set(original.operation_id, createOperationResult(
          group.group_id, original.operation_id, "not_applied", "approval_conflict",
          operationTargetGid(original, references),
        ));
      } else if (!classification.applicable) {
        const outcome = decision.kind === "already_applied" ? "already_applied" : "not_applied";
        const reason = decision.kind === "already_applied" ? "already_applied" : "atomic_group_blocked";
        preflightResults.set(original.operation_id, createOperationResult(
          group.group_id, original.operation_id, outcome, reason,
          operationTargetGid(original, references),
        ));
      } else {
        executable.push({ group, operation: proposalWriteOperationSchema.parse(original) });
      }
    }
  }
  if (saved != null) {
    if (executable.length > 0) {
      throw new Error("保存済みplanと選択された承認済み操作が一致しません。");
    }
    const completed = await port.engine.run(saved.execution_id, signal);
    return projectStoredProposalResult(input.proposal_id, proposal, selected, preflightResults, completed);
  }
  if (executable.length === 0) {
    return projectStoredProposalResult(input.proposal_id, proposal, selected, preflightResults, undefined);
  }
  assertGraphSafe(executable.map((item) => item.operation.operation_id));
  const ordered = orderApplicableContexts(executable, references, createTaskTemporaryReferences);
  const executionId = port.createId();
  const planned = planProposalTaskWrites({
    execution_id: executionId,
    known_references: input.approval_input.journal_task_mappings,
    operations: ordered.map((item) => {
      const baseline = externalBaseline(item.operation, ordered, references, baselineMap);
      return {
        operation: item.operation,
        context: {
          project_gid: input.project_gid,
          workspace_gid: input.workspace_gid,
          section_gids: input.section_gids,
          device_id: input.device_id,
          created_via: input.created_via,
          activity_date: input.activity_date,
          ...(item.operation.operation === "create_task" ? { create_uuid: port.createId() } : {}),
          ...(baseline == null ? {} : { external_baseline: baseline }),
        },
      };
    }),
  }, port.fingerprint);
  const context = {
    format_version: 1,
    groups: proposal.groups.flatMap((group) => {
      const operationIds = executable
        .filter((item) => item.group.group_id === group.group_id)
        .map((item) => item.operation.operation_id);
      return operationIds.length === 0 ? [] : [{
        group_id: group.group_id,
        atomic: group.atomic,
        operation_ids: operationIds,
      }];
    }),
  } satisfies NonNullable<ProposalExecution<StoredProposalWriteResult>["proposal_context"]>;
  port.repository.save({
    plan: planned,
    proposal_id: input.proposal_id,
    proposal_context: context,
    created_at: port.now(),
  });
  const completed = await port.engine.run(executionId, signal);
  return projectStoredProposalResult(input.proposal_id, proposal, selected, preflightResults, completed);
}
