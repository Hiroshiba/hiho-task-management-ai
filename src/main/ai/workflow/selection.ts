import type {
  Proposal,
  ProposalOperation,
} from "../../../shared/ai";
import type {
  AiWorkflowSelection,
  AiWorkflowSnapshot,
} from "../../../shared/ai-workflow";
import {
  validateSelectedProposalGraph,
  type GraphValidationResult,
} from "../proposal-validation";
import { AiWorkflowSelectionError } from "./errors";

type SelectionStoredProposal = {
  readonly proposal: Proposal;
  readonly graph_validation: GraphValidationResult;
  readonly snapshot: AiWorkflowSnapshot;
};

function validationOperationMap(
  result: GraphValidationResult,
): Map<string, GraphValidationResult["operations"][number]> {
  return new Map(result.operations.map((operation) => [operation.operation_id, operation]));
}

function validationGroupMap(
  result: GraphValidationResult,
): Map<string, GraphValidationResult["groups"][number]> {
  return new Map(result.groups.map((group) => [group.group_id, group]));
}

function operationMap(proposal: Proposal): Map<string, ProposalOperation> {
  return new Map(proposal.groups.flatMap((group) => group.operations).map((operation) => [
    operation.operation_id,
    operation,
  ]));
}

function groupMap(proposal: Proposal): Map<string, Proposal["groups"][number]> {
  return new Map(proposal.groups.map((group) => [group.group_id, group]));
}

/** 適用可能な操作IDを提案の順序で返します。 */
export function eligibleOperationIds(
  proposal: Proposal,
  graphValidation: GraphValidationResult,
): readonly string[] {
  const operationResults = validationOperationMap(graphValidation);
  const groupResults = validationGroupMap(graphValidation);
  return proposal.groups.flatMap((group) => {
    const validationGroup = groupResults.get(group.group_id);
    if (validationGroup == null || !validationGroup.applicable) {
      return [];
    }
    return group.operations
      .filter((operation) => operationResults.get(operation.operation_id)?.kind === "valid")
      .map((operation) => operation.operation_id);
  });
}

function collectTemporaryReferences(operation: ProposalOperation): readonly string[] {
  const references: string[] = [];
  const addTarget = (target: Extract<ProposalOperation, { readonly operation: "update_title" }>["target"]): void => {
    if (target.kind === "temporary") {
      references.push(target.ref);
    }
  };
  if (operation.operation === "create_task") {
    if (operation.creation.kind === "split_child") {
      addTarget(operation.creation.parent);
    }
    if (operation.after.parent != null) {
      addTarget(operation.after.parent);
    }
    for (const dependency of operation.after.dependencies ?? []) {
      addTarget(dependency.target);
    }
    return references;
  }
  addTarget(operation.target);
  if (operation.operation === "set_dependencies") {
    for (const dependency of operation.before) {
      addTarget(dependency.target);
    }
    for (const dependency of operation.after) {
      addTarget(dependency.target);
    }
  }
  if (operation.operation === "set_parent") {
    if (operation.before.kind !== "absent") {
      addTarget(operation.before);
    }
    if (operation.after.kind !== "absent") {
      addTarget(operation.after);
    }
  }
  return references;
}

/** 選択入力を検証して、適用する操作IDへ解決します。 */
export function resolveSelectedOperationIds(
  stored: SelectionStoredProposal,
  selection: AiWorkflowSelection,
): readonly string[] {
  const operationResults = validationOperationMap(stored.graph_validation);
  const groupResults = validationGroupMap(stored.graph_validation);
  const groups = groupMap(stored.proposal);
  const operations = operationMap(stored.proposal);
  const selected = new Set<string>();

  if (selection.kind === "all") {
    for (const operationId of eligibleOperationIds(stored.proposal, stored.graph_validation)) {
      selected.add(operationId);
    }
  } else if (selection.kind === "groups") {
    for (const groupId of selection.group_ids) {
      const group = groups.get(groupId);
      const validationGroup = groupResults.get(groupId);
      if (group == null || validationGroup == null) {
        throw new AiWorkflowSelectionError(`指定したグループ ${groupId} が存在しません。`);
      }
      if (!validationGroup.applicable) {
        throw new AiWorkflowSelectionError(`グループ ${groupId} は適用可能ではありません。`);
      }
      for (const operation of group.operations) {
        const validation = operationResults.get(operation.operation_id);
        if (validation?.kind === "valid") {
          selected.add(operation.operation_id);
        } else if (group.atomic) {
          throw new AiWorkflowSelectionError(`グループ ${groupId} に無効な操作があります。`);
        }
      }
    }
  } else {
    for (const operationId of selection.operation_ids) {
      const operation = operations.get(operationId);
      const validation = operationResults.get(operationId);
      if (operation == null || validation == null) {
        throw new AiWorkflowSelectionError(`指定した操作 ${operationId} が存在しません。`);
      }
      if (validation.kind !== "valid") {
        throw new AiWorkflowSelectionError(`操作 ${operationId} は適用可能ではありません。`);
      }
      const group = groups.get(validation.group_id);
      const validationGroup = groupResults.get(validation.group_id);
      if (group == null || validationGroup == null) {
        throw new AiWorkflowSelectionError(`操作 ${operationId} のグループが存在しません。`);
      }
      if (group.atomic) {
        if (!validationGroup.applicable) {
          throw new AiWorkflowSelectionError(`atomicグループ ${group.group_id} は適用可能ではありません。`);
        }
        for (const member of group.operations) {
          if (operationResults.get(member.operation_id)?.kind !== "valid") {
            throw new AiWorkflowSelectionError(`atomicグループ ${group.group_id} に無効な操作があります。`);
          }
          selected.add(member.operation_id);
        }
      } else {
        selected.add(operationId);
      }
    }
  }

  if (selected.size === 0) {
    throw new AiWorkflowSelectionError("適用可能な操作が選択されていません。");
  }
  const selectedCreates = new Set(
    [...selected]
      .map((operationId) => operations.get(operationId))
      .filter((operation): operation is Extract<ProposalOperation, { readonly operation: "create_task" }> =>
        operation?.operation === "create_task")
      .map((operation) => operation.temporary_ref),
  );
  for (const operationId of selected) {
    const operation = operations.get(operationId);
    if (operation == null) {
      throw new AiWorkflowSelectionError(`指定した操作 ${operationId} が存在しません。`);
    }
    for (const temporaryRef of collectTemporaryReferences(operation)) {
      if (!selectedCreates.has(temporaryRef)) {
        throw new AiWorkflowSelectionError(`一時参照 ${temporaryRef} の作成操作が選択されていません。`);
      }
    }
  }
  return stored.proposal.groups.flatMap((group) =>
    group.operations
      .filter((operation) => selected.has(operation.operation_id))
      .map((operation) => operation.operation_id),
  );
}

/** 選択中の操作が依存関係と親子関係を壊さないことを確認します。 */
export function assertSelectedProposalGraphIsSafe(
  stored: SelectionStoredProposal,
  selectedOperationIds: readonly string[],
): void {
  const result = validateSelectedProposalGraph({
    proposal: stored.proposal,
    managed_tasks: stored.snapshot.tasks,
    selected_operation_ids: [...selectedOperationIds],
    temporary_ref_mappings: [],
  });
  if (result.kind === "unsafe") {
    throw new AiWorkflowSelectionError(
      "選択した操作だけを適用すると依存関係または親子関係に新しい循環が生じます。",
    );
  }
}

/** 提案編集後も適用可能な操作の選択状態を維持します。 */
export function preserveSelection(
  proposal: Proposal,
  graphValidation: GraphValidationResult,
  previousOperationIds: readonly string[],
): readonly string[] {
  const previous = new Set(previousOperationIds);
  const operationResults = validationOperationMap(graphValidation);
  const groupResults = validationGroupMap(graphValidation);
  const selected = new Set<string>();
  for (const group of proposal.groups) {
    const groupValidation = groupResults.get(group.group_id);
    if (groupValidation == null || !groupValidation.applicable) {
      continue;
    }
    const validMembers = group.operations.filter(
      (operation) => operationResults.get(operation.operation_id)?.kind === "valid",
    );
    if (group.atomic) {
      const selectedMember = validMembers.some((operation) => previous.has(operation.operation_id));
      if (selectedMember && validMembers.length === group.operations.length) {
        for (const operation of validMembers) {
          selected.add(operation.operation_id);
        }
      }
      continue;
    }
    for (const operation of validMembers) {
      if (previous.has(operation.operation_id)) {
        selected.add(operation.operation_id);
      }
    }
  }
  return proposal.groups.flatMap((group) =>
    group.operations
      .filter((operation) => selected.has(operation.operation_id))
      .map((operation) => operation.operation_id),
  );
}
