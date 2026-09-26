type Operation = { readonly operation_id: string; readonly evidence_refs: readonly unknown[] };
type Proposal<TOperation extends Operation> = {
  readonly groups: readonly { readonly operations: readonly TOperation[] }[];
};

/** 変更案の操作IDを重複なく索引化します。 */
export function operationMap<TOperation extends Operation>(
  proposal: Proposal<TOperation>,
  WorkflowError: new (message: string) => Error,
): Map<string, TOperation> {
  const operations = new Map<string, TOperation>();
  for (const group of proposal.groups) {
    for (const operation of group.operations) {
      if (operations.has(operation.operation_id)) {
        throw new WorkflowError("変更案のoperation_idが重複しています。");
      }
      operations.set(operation.operation_id, operation);
    }
  }
  return operations;
}

/** 編集された操作の後値を検証し、選択状態を保って変更案を再検証します。 */
export function editStoredProposal<
  TOperation extends Operation,
  TProposal extends Proposal<TOperation>,
  TStored extends {
    readonly proposal: TProposal;
    readonly snapshot: unknown;
    readonly graph_validation: TGraph;
    readonly selected_operation_ids: readonly string[];
  },
  TBasic,
  TGraph,
>(
  request: { readonly operation_id: string; readonly after: unknown; readonly evidence_locator: string },
  stored: TStored,
  dependencies: {
    readonly operationMap: (proposal: TProposal) => ReadonlyMap<string, TOperation>;
    readonly parseOperation: (value: unknown) => TOperation;
    readonly parseProposal: (value: unknown) => TProposal;
    readonly revalidate: (proposal: TProposal, stored: TStored) => {
      readonly basic: TBasic; readonly graph: TGraph;
    };
    readonly preserveSelection: (proposal: TProposal, graph: TGraph, selected: readonly string[]) => readonly string[];
    readonly assertGraphSafe: (input: {
      readonly proposal: TProposal;
      readonly snapshot: TStored["snapshot"];
      readonly graph_validation: TGraph;
    }, selected: readonly string[]) => void;
    readonly EditError: new (message: string, cause?: unknown) => Error;
  },
): {
  readonly proposal: TProposal;
  readonly basic_validation: TBasic;
  readonly graph_validation: TGraph;
  readonly selected_operation_ids: string[];
} {
  const operations = dependencies.operationMap(stored.proposal);
  const currentOperation = operations.get(request.operation_id);
  if (currentOperation == null) {
    throw new dependencies.EditError("指定した操作が変更案にありません。");
  }
  const editedEvidence = {
    kind: "user_message",
    locator: request.evidence_locator,
  };
  const candidateOperation = {
    ...currentOperation,
    after: request.after,
    basis: "explicit",
    confidence: 1,
    evidence_refs: [...currentOperation.evidence_refs, editedEvidence],
  };
  let validatedOperation: TOperation;
  try {
    validatedOperation = dependencies.parseOperation(candidateOperation);
  } catch (error: unknown) {
    throw new dependencies.EditError("操作種別に許可されない編集値です。", error);
  }
  const editedProposal = dependencies.parseProposal({
    ...stored.proposal,
    groups: stored.proposal.groups.map((group) => ({
      ...group,
      operations: group.operations.map((operation) =>
        operation.operation_id === request.operation_id ? validatedOperation : operation),
    })),
  });
  const validation = dependencies.revalidate(editedProposal, stored);
  const selectedOperationIds = dependencies.preserveSelection(
    editedProposal,
    validation.graph,
    stored.selected_operation_ids,
  );
  try {
    dependencies.assertGraphSafe({
      proposal: editedProposal,
      snapshot: stored.snapshot,
      graph_validation: validation.graph,
    }, selectedOperationIds);
  } catch (error: unknown) {
    throw new dependencies.EditError(
      "編集後の選択操作を依存・親子グラフへ投影できません。",
      error,
    );
  }
  return {
    proposal: editedProposal,
    basic_validation: validation.basic,
    graph_validation: validation.graph,
    selected_operation_ids: [...selectedOperationIds],
  };
}
