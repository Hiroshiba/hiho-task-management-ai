import { z } from "zod";
import {
  gidSchema,
  identifierSchema,
} from "../task-write-values";
import {
  analysisProposalSchema as proposalSchema,
  type AnalysisProposal as Proposal,
  type AnalysisProposalOperation as ProposalOperation,
} from "./proposal-projection";
import { analysisTaskSchema as taskSchema, type AnalysisTask as Task } from "./task-projection";
import {
  proposalValidationResultSchema,
  type ProposalValidationOperationResult,
  type ProposalValidationResult,
} from "./basic";

import { createGraphValidationSchemas } from "./graph-validation-schemas";

const graphValidationSchemas = createGraphValidationSchemas({
  gidSchema,
  identifierSchema,
  proposalSchema,
  proposalValidationResultSchema,
  taskSchema,
});

export const selectedProposalGraphValidationInputSchema = graphValidationSchemas
  .selectedProposalGraphValidationInputBaseSchema.superRefine(validateSelectedInputContext);
export const graphValidationInputSchema = graphValidationSchemas
  .graphValidationInputBaseSchema.superRefine(validateBasicResultContext);
export const graphValidationResultSchema = graphValidationSchemas.graphValidationResultSchema;
export const selectedProposalGraphValidationResultSchema = graphValidationSchemas
  .selectedProposalGraphValidationResultSchema;

export type GraphValidationInput = z.infer<typeof graphValidationInputSchema>;
export type GraphValidationError = z.infer<
  typeof graphValidationSchemas.graphValidationErrorSchema
>;
export type GraphValidationOperationResult = z.infer<
  typeof graphValidationSchemas.graphOperationResultSchema
>;
export type GraphValidationGroupResult = z.infer<
  typeof graphValidationSchemas.graphValidationGroupResultSchema
>;
export type GraphValidationResult = z.infer<typeof graphValidationResultSchema>;
export type SelectedProposalGraphValidationInput = z.infer<
  typeof selectedProposalGraphValidationInputSchema
>;
export type SelectedProposalGraphValidationResult = z.infer<
  typeof selectedProposalGraphValidationResultSchema
>;

type ProposalTarget = Extract<
  ProposalOperation,
  { readonly operation: "update_title" }
>["target"];

type RelationOperation = Extract<
  ProposalOperation,
  {
    readonly operation: "create_task" | "set_dependencies" | "set_parent";
  }
>;

type NodeKey = string;

type OperationContext = {
  readonly group_id: string;
  readonly atomic: boolean;
  readonly basic_applicable: boolean;
  readonly operation: ProposalOperation;
};

type GraphState = {
  readonly nodes: Set<NodeKey>;
  readonly edges: Map<NodeKey, Set<NodeKey>>;
  readonly base_edges: Set<string>;
  readonly removed_base_edges: Map<string, Set<string>>;
  readonly edge_owners: Map<string, Set<string>>;
};

type CycleProjection = {
  readonly cycles: readonly (readonly NodeKey[])[];
  readonly operation_ids_by_cycle: ReadonlyMap<string, readonly string[]>;
};

function collectOperationTargets(
  operation: ProposalOperation,
): readonly ProposalTarget[] {
  const targets: ProposalTarget[] = [];
  const addTarget = (target: ProposalTarget): void => {
    targets.push(target);
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
    return targets;
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
  return targets;
}

function collectTemporaryReferences(
  operation: ProposalOperation,
): readonly string[] {
  const references = new Set<string>();
  for (const target of collectOperationTargets(operation)) {
    if (target.kind === "temporary") {
      references.add(target.ref);
    }
  }
  return [...references];
}

function validateSelectedInputContext(
  input: z.output<typeof graphValidationSchemas.selectedProposalGraphValidationInputBaseSchema>,
  context: z.RefinementCtx,
): void {
  const operations = new Map<string, ProposalOperation>();
  const creates = new Map<
    string,
    Extract<ProposalOperation, { readonly operation: "create_task" }>
  >();
  for (const group of input.proposal.groups) {
    for (const operation of group.operations) {
      operations.set(operation.operation_id, operation);
      if (operation.operation === "create_task") {
        creates.set(operation.temporary_ref, operation);
      }
    }
  }
  const managedTaskGids = new Set(input.managed_tasks.map((task) => task.gid));
  const mappings = new Map<string, string>();
  input.temporary_ref_mappings.forEach((mapping, index) => {
    mappings.set(mapping.temporary_ref, mapping.task_gid);
    if (!creates.has(mapping.temporary_ref)) {
      context.addIssue({
        code: "custom",
        path: ["temporary_ref_mappings", index, "temporary_ref"],
        message: `temporary_ref ${mapping.temporary_ref} に対応する作成操作がありません。`,
      });
    }
  });
  const selected = new Set(input.selected_operation_ids);
  input.selected_operation_ids.forEach((operationId, index) => {
    const operation = operations.get(operationId);
    if (operation == null) {
      context.addIssue({
        code: "custom",
        path: ["selected_operation_ids", index],
        message: `operation_id ${operationId} が変更案にありません。`,
      });
      return;
    }
    if (
      operation.operation === "create_task"
      && mappings.has(operation.temporary_ref)
    ) {
      context.addIssue({
        code: "custom",
        path: ["selected_operation_ids", index],
        message: `対応済みtemporary_ref ${operation.temporary_ref} の作成操作は投影対象にできません。`,
      });
    }
    for (const target of collectOperationTargets(operation)) {
      if (target.kind === "existing" && !managedTaskGids.has(target.gid)) {
        context.addIssue({
          code: "custom",
          path: ["selected_operation_ids", index],
          message: `参照先タスクGID ${target.gid} が現在グラフにありません。`,
        });
      }
    }
    for (const temporaryRef of collectTemporaryReferences(operation)) {
      const mappedGid = mappings.get(temporaryRef);
      if (mappedGid != null) {
        if (!managedTaskGids.has(mappedGid)) {
          context.addIssue({
            code: "custom",
            path: ["selected_operation_ids", index],
            message: `temporary_ref ${temporaryRef} の対応先タスクGID ${mappedGid} が現在グラフにありません。`,
          });
        }
        continue;
      }
      const create = creates.get(temporaryRef);
      if (create == null || !selected.has(create.operation_id)) {
        context.addIssue({
          code: "custom",
          path: ["selected_operation_ids", index],
          message: `temporary_ref ${temporaryRef} の作成操作または対応済みGIDがありません。`,
        });
      }
    }
  });
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function edgeKey(from: NodeKey, to: NodeKey): string {
  return `${from}\u0000${to}`;
}

function targetKey(
  target: ProposalTarget,
  temporaryRefMappings: ReadonlyMap<string, string>,
): NodeKey {
  if (target.kind === "existing") {
    return `existing:${target.gid}`;
  }
  const mappedGid = temporaryRefMappings.get(target.ref);
  if (mappedGid != null) {
    return `existing:${mappedGid}`;
  }
  return `temporary:${target.ref}`;
}

function existingKey(gid: string): NodeKey {
  return `existing:${gid}`;
}

function createGraph(nodes: readonly NodeKey[]): GraphState {
  const edges = new Map<NodeKey, Set<NodeKey>>();
  for (const node of nodes) {
    edges.set(node, new Set<NodeKey>());
  }
  return {
    nodes: new Set(nodes),
    edges,
    base_edges: new Set<string>(),
    removed_base_edges: new Map<string, Set<string>>(),
    edge_owners: new Map<string, Set<string>>(),
  };
}

function addBaseEdge(graph: GraphState, from: NodeKey, to: NodeKey): void {
  const fromEdges = graph.edges.get(from);
  if (fromEdges == null || !graph.nodes.has(to)) {
    return;
  }
  fromEdges.add(to);
  graph.base_edges.add(edgeKey(from, to));
}

function addEdgeOwner(graph: GraphState, key: string, operationId: string): void {
  const owners = graph.edge_owners.get(key);
  if (owners == null) {
    graph.edge_owners.set(key, new Set([operationId]));
    return;
  }
  owners.add(operationId);
}

function addProjectedEdge(
  graph: GraphState,
  from: NodeKey,
  to: NodeKey,
  operationId: string,
): void {
  const fromEdges = graph.edges.get(from);
  if (fromEdges == null || !graph.nodes.has(to)) {
    return;
  }
  const key = edgeKey(from, to);
  fromEdges.add(to);
  const removedBy = graph.removed_base_edges.get(key);
  const isUnchangedBaseEdge =
    graph.base_edges.has(key)
    && (removedBy == null || removedBy.size === 0
      || (removedBy.size === 1 && removedBy.has(operationId)));
  if (!isUnchangedBaseEdge) {
    addEdgeOwner(graph, key, operationId);
  }
}

function removeEdge(
  graph: GraphState,
  from: NodeKey,
  to: NodeKey,
  operationId: string,
): void {
  const fromEdges = graph.edges.get(from);
  if (fromEdges == null || !fromEdges.has(to)) {
    return;
  }
  fromEdges.delete(to);
  const key = edgeKey(from, to);
  if (!graph.base_edges.has(key)) {
    return;
  }
  const removedBy = graph.removed_base_edges.get(key);
  if (removedBy == null) {
    graph.removed_base_edges.set(key, new Set([operationId]));
    return;
  }
  removedBy.add(operationId);
}

function removeOutgoingEdges(
  graph: GraphState,
  from: NodeKey,
  operationId: string,
): void {
  const fromEdges = graph.edges.get(from);
  if (fromEdges == null) {
    return;
  }
  for (const to of [...fromEdges]) {
    removeEdge(graph, from, to, operationId);
  }
}

function removeIncomingEdges(
  graph: GraphState,
  to: NodeKey,
  operationId: string,
): void {
  for (const from of [...graph.nodes].sort(compareStrings)) {
    removeEdge(graph, from, to, operationId);
  }
}

function addExistingTaskEdges(
  dependencyGraph: GraphState,
  parentGraph: GraphState,
  tasks: readonly Task[],
): void {
  for (const task of tasks) {
    const taskNode = existingKey(task.gid);
    if (task.parent_gid != null) {
      addBaseEdge(parentGraph, existingKey(task.parent_gid), taskNode);
    }
    for (const childGid of task.child_gids) {
      addBaseEdge(parentGraph, taskNode, existingKey(childGid));
    }
    for (const dependency of task.dependencies) {
      addBaseEdge(dependencyGraph, taskNode, existingKey(dependency.task_gid));
    }
  }
}

function addCreateTaskNode(
  dependencyGraph: GraphState,
  parentGraph: GraphState,
  operation: Extract<RelationOperation, { readonly operation: "create_task" }>,
): void {
  const node = `temporary:${operation.temporary_ref}`;
  dependencyGraph.nodes.add(node);
  dependencyGraph.edges.set(node, new Set<NodeKey>());
  parentGraph.nodes.add(node);
  parentGraph.edges.set(node, new Set<NodeKey>());
}

function addCreateTaskEdges(
  dependencyGraph: GraphState,
  parentGraph: GraphState,
  operation: Extract<RelationOperation, { readonly operation: "create_task" }>,
  temporaryRefMappings: ReadonlyMap<string, string>,
): void {
  const node = `temporary:${operation.temporary_ref}`;
  if (operation.after.parent != null) {
    addProjectedEdge(
      parentGraph,
      targetKey(operation.after.parent, temporaryRefMappings),
      node,
      operation.operation_id,
    );
  }
  for (const dependency of operation.after.dependencies ?? []) {
    addProjectedEdge(
      dependencyGraph,
      node,
      targetKey(dependency.target, temporaryRefMappings),
      operation.operation_id,
    );
  }
}

function applyRelationOperation(
  dependencyGraph: GraphState,
  parentGraph: GraphState,
  operation: Exclude<RelationOperation, { readonly operation: "create_task" }>,
  temporaryRefMappings: ReadonlyMap<string, string>,
): void {
  const target = targetKey(operation.target, temporaryRefMappings);
  if (operation.operation === "set_dependencies") {
    removeOutgoingEdges(dependencyGraph, target, operation.operation_id);
    for (const dependency of operation.after) {
      addProjectedEdge(
        dependencyGraph,
        target,
        targetKey(dependency.target, temporaryRefMappings),
        operation.operation_id,
      );
    }
    return;
  }
  removeIncomingEdges(parentGraph, target, operation.operation_id);
  if (operation.after.kind !== "absent") {
    addProjectedEdge(
      parentGraph,
      targetKey(operation.after, temporaryRefMappings),
      target,
      operation.operation_id,
    );
  }
}

function stronglyConnectedComponents(
  graph: ReadonlyMap<NodeKey, ReadonlySet<NodeKey>>,
): readonly (readonly NodeKey[])[] {
  const indexByNode = new Map<NodeKey, number>();
  const lowLinkByNode = new Map<NodeKey, number>();
  const stack: NodeKey[] = [];
  const onStack = new Set<NodeKey>();
  const components: NodeKey[][] = [];
  let nextIndex = 0;

  const visit = (node: NodeKey): void => {
    indexByNode.set(node, nextIndex);
    lowLinkByNode.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    onStack.add(node);
    const neighbors = graph.get(node);
    if (neighbors == null) {
      throw new Error(`グラフノード ${node} の辺がありません。`);
    }
    for (const neighbor of [...neighbors].sort(compareStrings)) {
      if (!indexByNode.has(neighbor)) {
        visit(neighbor);
        const nodeLowLink = lowLinkByNode.get(node);
        const neighborLowLink = lowLinkByNode.get(neighbor);
        if (nodeLowLink == null || neighborLowLink == null) {
          throw new Error("強連結成分の順位情報がありません。");
        }
        lowLinkByNode.set(node, Math.min(nodeLowLink, neighborLowLink));
      } else if (onStack.has(neighbor)) {
        const nodeLowLink = lowLinkByNode.get(node);
        const neighborIndex = indexByNode.get(neighbor);
        if (nodeLowLink == null || neighborIndex == null) {
          throw new Error("強連結成分の探索情報がありません。");
        }
        lowLinkByNode.set(node, Math.min(nodeLowLink, neighborIndex));
      }
    }

    const nodeIndex = indexByNode.get(node);
    const nodeLowLink = lowLinkByNode.get(node);
    if (nodeIndex == null || nodeLowLink == null) {
      throw new Error("強連結成分の結果情報がありません。");
    }
    if (nodeLowLink === nodeIndex) {
      const component: NodeKey[] = [];
      let member = stack.pop();
      while (member != null) {
        onStack.delete(member);
        component.push(member);
        if (member === node) {
          break;
        }
        member = stack.pop();
      }
      components.push(component.sort(compareStrings));
    }
  };

  for (const node of [...graph.keys()].sort(compareStrings)) {
    if (!indexByNode.has(node)) {
      visit(node);
    }
  }
  return components.sort((left, right) => {
    const leftFirst = left[0];
    const rightFirst = right[0];
    if (leftFirst == null || rightFirst == null) {
      throw new Error("空の強連結成分は許可されません。");
    }
    return compareStrings(leftFirst, rightFirst);
  });
}

function isCycle(
  component: readonly NodeKey[],
  graph: ReadonlyMap<NodeKey, ReadonlySet<NodeKey>>,
): boolean {
  if (component.length > 1) {
    return true;
  }
  const node = component[0];
  if (node == null) {
    throw new Error("空の循環成分は許可されません。");
  }
  return graph.get(node)?.has(node) ?? false;
}

function findCycles(
  graph: ReadonlyMap<NodeKey, ReadonlySet<NodeKey>>,
): readonly (readonly NodeKey[])[] {
  return stronglyConnectedComponents(graph).filter((component) =>
    isCycle(component, graph),
  );
}

function cycleKey(cycle: readonly NodeKey[]): string {
  return cycle.join("\u0000");
}

function collectCycleOperationIds(
  cycle: readonly NodeKey[],
  graph: GraphState,
): readonly string[] {
  const cycleNodes = new Set(cycle);
  const operationIds = new Set<string>();
  for (const from of cycle) {
    const neighbors = graph.edges.get(from);
    if (neighbors == null) {
      throw new Error(`循環ノード ${from} の辺がありません。`);
    }
    for (const to of neighbors) {
      if (!cycleNodes.has(to)) {
        continue;
      }
      const owners = graph.edge_owners.get(edgeKey(from, to));
      if (owners == null) {
        continue;
      }
      for (const operationId of owners) {
        operationIds.add(operationId);
      }
    }
  }
  return [...operationIds].sort(compareStrings);
}

function projectCycles(
  projectedGraph: GraphState,
): CycleProjection {
  const projectedCycles = findCycles(projectedGraph.edges);
  const cycles: (readonly NodeKey[])[] = [];
  const operationIdsByCycle = new Map<string, readonly string[]>();
  for (const cycle of projectedCycles) {
    const operationIds = collectCycleOperationIds(cycle, projectedGraph);
    if (operationIds.length === 0) {
      continue;
    }
    cycles.push(cycle);
    operationIdsByCycle.set(cycleKey(cycle), operationIds);
  }
  return { cycles, operation_ids_by_cycle: operationIdsByCycle };
}

function createOperationContexts(
  proposal: Proposal,
  basicResult: ProposalValidationResult,
): readonly OperationContext[] {
  const basicByOperation = new Map<string, ProposalValidationOperationResult>();
  for (const operation of basicResult.operations) {
    basicByOperation.set(operation.operation_id, operation);
  }
  const basicGroups = new Map<string, { readonly atomic: boolean; readonly applicable: boolean }>();
  for (const group of basicResult.groups) {
    basicGroups.set(group.group_id, {
      atomic: group.atomic,
      applicable: group.applicable,
    });
  }
  const contexts: OperationContext[] = [];
  for (const group of proposal.groups) {
    const basicGroup = basicGroups.get(group.group_id);
    if (basicGroup == null) {
      throw new Error(`group_id ${group.group_id} の基本検証結果がありません。`);
    }
    for (const operation of group.operations) {
      const basicOperation = basicByOperation.get(operation.operation_id);
      if (basicOperation == null) {
        throw new Error(`operation_id ${operation.operation_id} の基本検証結果がありません。`);
      }
      contexts.push({
        group_id: group.group_id,
        atomic: basicGroup.atomic,
        basic_applicable:
          basicGroup.applicable
          && basicOperation.kind === "valid",
        operation,
      });
    }
  }
  return contexts;
}

function createSelectedOperationIds(
  contexts: readonly OperationContext[],
): ReadonlySet<string> {
  const selected = new Set<string>();
  for (const context of contexts) {
    if (context.basic_applicable) {
      selected.add(context.operation.operation_id);
    }
  }
  return selected;
}

function relationOperations(
  proposal: Proposal,
  selectedOperationIds: ReadonlySet<string>,
): readonly RelationOperation[] {
  return proposal.groups
    .flatMap((group) => group.operations)
    .filter((operation) => selectedOperationIds.has(operation.operation_id))
    .filter((operation): operation is RelationOperation =>
      operation.operation === "create_task"
      || operation.operation === "set_dependencies"
      || operation.operation === "set_parent",
    );
}

function createProjection(
  tasks: readonly Task[],
  operations: readonly RelationOperation[],
  temporaryRefMappings: ReadonlyMap<string, string>,
): {
  readonly dependency: CycleProjection;
  readonly parent: CycleProjection;
} {
  const existingNodes = tasks.map((task) => existingKey(task.gid));
  const dependencyProjected = createGraph(existingNodes);
  const parentProjected = createGraph(existingNodes);
  addExistingTaskEdges(dependencyProjected, parentProjected, tasks);

  const createOperations = operations.filter(
    (operation): operation is Extract<RelationOperation, { readonly operation: "create_task" }> =>
      operation.operation === "create_task",
  );
  for (const operation of createOperations) {
    addCreateTaskNode(dependencyProjected, parentProjected, operation);
  }
  for (const operation of createOperations) {
    addCreateTaskEdges(
      dependencyProjected,
      parentProjected,
      operation,
      temporaryRefMappings,
    );
  }
  for (const operation of operations) {
    if (operation.operation !== "create_task") {
      applyRelationOperation(
        dependencyProjected,
        parentProjected,
        operation,
        temporaryRefMappings,
      );
    }
  }
  return {
    dependency: projectCycles(dependencyProjected),
    parent: projectCycles(parentProjected),
  };
}

function addGraphError(
  errorsByOperation: Map<string, GraphValidationError[]>,
  operationId: string,
  code: "dependency_cycle" | "parent_cycle",
  cycle: readonly NodeKey[],
): void {
  const errors = errorsByOperation.get(operationId);
  if (errors == null) {
    throw new Error(`operation_id ${operationId} の検証領域がありません。`);
  }
  const message = `${code === "dependency_cycle" ? "依存関係" : "親子関係"}の新しい循環を作るため適用できません。循環: ${cycle.join("、")}`;
  if (errors.some((error) => error.code === code && error.message === message)) {
    return;
  }
  errors.push({ code, message });
}

function createGraphErrors(
  contexts: readonly OperationContext[],
  basicResult: ProposalValidationResult,
  projection: {
    readonly dependency: CycleProjection;
    readonly parent: CycleProjection;
  },
): Map<string, GraphValidationError[]> {
  const errorsByOperation = new Map<string, GraphValidationError[]>();
  const basicByOperation = new Map<string, ProposalValidationOperationResult>();
  for (const operation of basicResult.operations) {
    basicByOperation.set(operation.operation_id, operation);
  }
  for (const context of contexts) {
    const basicOperation = basicByOperation.get(context.operation.operation_id);
    if (basicOperation == null) {
      throw new Error(`operation_id ${context.operation.operation_id} の基本検証結果がありません。`);
    }
    const errors: GraphValidationError[] = [];
    if (basicOperation.kind === "invalid") {
      errors.push(...basicOperation.errors);
    }
    errorsByOperation.set(context.operation.operation_id, errors);
  }
  for (const [cycle, operationIds] of projection.dependency.operation_ids_by_cycle) {
    const cycleNodes = cycle.split("\u0000");
    for (const operationId of operationIds) {
      addGraphError(errorsByOperation, operationId, "dependency_cycle", cycleNodes);
    }
  }
  for (const [cycle, operationIds] of projection.parent.operation_ids_by_cycle) {
    const cycleNodes = cycle.split("\u0000");
    for (const operationId of operationIds) {
      addGraphError(errorsByOperation, operationId, "parent_cycle", cycleNodes);
    }
  }
  return errorsByOperation;
}

function createOperationResults(
  contexts: readonly OperationContext[],
  errorsByOperation: ReadonlyMap<string, readonly GraphValidationError[]>,
): readonly GraphValidationOperationResult[] {
  return contexts.map((context) => {
    const errors = errorsByOperation.get(context.operation.operation_id);
    if (errors == null) {
      throw new Error(`operation_id ${context.operation.operation_id} の検証結果がありません。`);
    }
    if (errors.length === 0) {
      return {
        kind: "valid",
        group_id: context.group_id,
        operation_id: context.operation.operation_id,
      };
    }
    return {
      kind: "invalid",
      group_id: context.group_id,
      operation_id: context.operation.operation_id,
      errors: [...errors],
    };
  });
}

function createGroupResults(
  proposal: Proposal,
  errorsByOperation: ReadonlyMap<string, readonly GraphValidationError[]>,
): readonly GraphValidationGroupResult[] {
  return proposal.groups.map((group) => {
    const operationIds = group.operations.map((operation) => operation.operation_id);
    let validOperationCount = 0;
    for (const operationId of operationIds) {
      const errors = errorsByOperation.get(operationId);
      if (errors == null) {
        throw new Error(`operation_id ${operationId} の検証結果がありません。`);
      }
      if (errors.length === 0) {
        validOperationCount += 1;
      }
    }
    return {
      group_id: group.group_id,
      atomic: group.atomic,
      applicable: group.atomic
        ? validOperationCount === operationIds.length
        : validOperationCount > 0,
      operation_ids: operationIds,
    };
  });
}

function validateBasicResultContext(
  input: z.output<typeof graphValidationSchemas.graphValidationInputBaseSchema>,
  context: z.RefinementCtx,
): void {
  const proposalOperations: readonly {
    readonly group_id: string;
    readonly operation_id: string;
  }[] = input.proposal.groups.flatMap((group) =>
    group.operations.map((operation) => ({
      group_id: group.group_id,
      operation_id: operation.operation_id,
    })),
  );
  if (input.basic_validation_result.operations.length !== proposalOperations.length) {
    context.addIssue({
      code: "custom",
      path: ["basic_validation_result", "operations"],
      message: "基本検証結果の操作数がproposalと一致しません。",
    });
  }
  proposalOperations.forEach((expected, index) => {
    const actual = input.basic_validation_result.operations[index];
    if (
      actual == null
      || actual.operation_id !== expected.operation_id
      || actual.group_id !== expected.group_id
    ) {
      context.addIssue({
        code: "custom",
        path: ["basic_validation_result", "operations", index],
        message: "基本検証結果の操作所属または順序がproposalと一致しません。",
      });
    }
  });

  if (input.basic_validation_result.groups.length !== input.proposal.groups.length) {
    context.addIssue({
      code: "custom",
      path: ["basic_validation_result", "groups"],
      message: "基本検証結果のグループ数がproposalと一致しません。",
    });
  }
  input.proposal.groups.forEach((expected, index) => {
    const actual = input.basic_validation_result.groups[index];
    if (
      actual == null
      || actual.group_id !== expected.group_id
      || actual.atomic !== expected.atomic
      || actual.operation_ids.length !== expected.operations.length
      || actual.operation_ids.some(
        (operationId, operationIndex) =>
          operationId !== expected.operations[operationIndex]?.operation_id,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["basic_validation_result", "groups", index],
        message: "基本検証結果のグループ定義がproposalと一致しません。",
      });
    }
  });
}

/** 基本検証済みの変更案を依存・親子グラフへ投影して新規循環を検証します。 */
export function validateProposalGraph(
  input: GraphValidationInput,
): GraphValidationResult {
  const parsedInput = graphValidationInputSchema.parse(input);
  const contexts = createOperationContexts(
    parsedInput.proposal,
    parsedInput.basic_validation_result,
  );
  const selectedOperationIds = createSelectedOperationIds(contexts);
  const operations = relationOperations(parsedInput.proposal, selectedOperationIds);
  const projection = createProjection(
    parsedInput.managed_tasks,
    operations,
    new Map<string, string>(),
  );
  const errorsByOperation = createGraphErrors(
    contexts,
    parsedInput.basic_validation_result,
    projection,
  );
  const result = {
    operations: createOperationResults(contexts, errorsByOperation),
    groups: createGroupResults(parsedInput.proposal, errorsByOperation),
    dependency_cycles: projection.dependency.cycles,
    parent_cycles: projection.parent.cycles,
  };
  return graphValidationResultSchema.parse(result);
}

/** 明示選択した操作だけを現在グラフへ投影して新規循環の有無を検証します。 */
export function validateSelectedProposalGraph(
  input: SelectedProposalGraphValidationInput,
): SelectedProposalGraphValidationResult {
  const parsedInput = selectedProposalGraphValidationInputSchema.parse(input);
  const selectedOperationIds = new Set(parsedInput.selected_operation_ids);
  const temporaryRefMappings = new Map(
    parsedInput.temporary_ref_mappings.map((mapping) => [
      mapping.temporary_ref,
      mapping.task_gid,
    ]),
  );
  const operations = relationOperations(parsedInput.proposal, selectedOperationIds);
  const projection = createProjection(
    parsedInput.managed_tasks,
    operations,
    temporaryRefMappings,
  );
  const dependencyCycles = projection.dependency.cycles;
  const parentCycles = projection.parent.cycles;
  if (dependencyCycles.length === 0 && parentCycles.length === 0) {
    return selectedProposalGraphValidationResultSchema.parse({
      kind: "safe",
      dependency_cycles: [],
      parent_cycles: [],
    });
  }
  return selectedProposalGraphValidationResultSchema.parse({
    kind: "unsafe",
    dependency_cycles: dependencyCycles,
    parent_cycles: parentCycles,
  });
}
