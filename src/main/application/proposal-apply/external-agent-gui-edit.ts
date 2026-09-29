type GuiProposalRecord<TProposal, TGraph, TView> = {
  readonly operation_ids: readonly string[];
  proposal: TProposal;
  graph_validation: TGraph;
  selected_operation_ids: readonly string[];
  view: TView;
  revision: number;
  state: { readonly kind: string };
};

type GuiEditErrorCode = "conflict" | "not_found" | "stale_revision";

function assertRevision(
  record: { readonly revision: number },
  revision: number,
  createError: (code: GuiEditErrorCode, message: string) => Error,
): void {
  if (record.revision !== revision) {
    throw createError("stale_revision", "提案の表示版が更新されています。");
  }
}

/** GUIの選択を外部提案へ反映します。 */
export function selectExternalAgentProposal<TProposal, TGraph, TView, TSelection, TBasic, TState>(
  record: GuiProposalRecord<TProposal, TGraph, TView>,
  request: { readonly revision: number; readonly selection: TSelection },
  ports: {
    readonly resolveSelection: (selection: TSelection) => readonly string[];
    readonly validateCurrent: () => { readonly basic: TBasic };
    readonly createView: (basic: TBasic, graph: TGraph) => TView;
    readonly createError: (code: GuiEditErrorCode, message: string) => Error;
    readonly emitChanged: () => void;
    readonly getState: () => TState;
  },
): TState {
  assertRevision(record, request.revision, ports.createError);
  if (record.state.kind !== "pending_approval") {
    throw ports.createError("conflict", "この提案は選択を変更できません。");
  }
  const selectedOperationIds = ports.resolveSelection(request.selection);
  record.selected_operation_ids = [...selectedOperationIds];
  record.view = ports.createView(ports.validateCurrent().basic, record.graph_validation);
  record.revision += 1;
  ports.emitChanged();
  return ports.getState();
}

/** GUI編集を外部提案へ反映します。 */
export function editExternalAgentProposal<
  TOperation extends { readonly operation_id: string; readonly evidence_refs: readonly unknown[] },
  TProposal extends { readonly groups: readonly { readonly operations: readonly TOperation[] }[] },
  TGraph,
  TView,
  TBasic,
  TState,
>(
  record: GuiProposalRecord<TProposal, TGraph, TView>,
  request: {
    readonly operation_id: string;
    readonly revision: number;
    readonly after: unknown;
    readonly evidence_locator: string;
  },
  ports: {
    readonly parseOperation: (value: unknown) => TOperation;
    readonly parseProposal: (value: unknown) => TProposal;
    readonly validateProposal: (proposal: TProposal) => { readonly basic: TBasic; readonly graph: TGraph };
    readonly preserveSelection: (proposal: TProposal, graph: TGraph, selectedIds: readonly string[]) => readonly string[];
    readonly createView: (proposal: TProposal, basic: TBasic, graph: TGraph) => TView;
    readonly createError: (code: GuiEditErrorCode, message: string) => Error;
    readonly emitChanged: () => void;
    readonly getState: () => TState;
  },
): TState {
  if (!record.operation_ids.includes(request.operation_id)) {
    throw ports.createError("conflict", "操作IDが提案と一致しません。");
  }
  assertRevision(record, request.revision, ports.createError);
  if (record.state.kind !== "pending_approval") {
    throw ports.createError("conflict", "この提案は編集できません。");
  }
  const operation = record.proposal.groups
    .flatMap((group) => group.operations)
    .find((candidate) => candidate.operation_id === request.operation_id);
  if (operation == null) {
    throw ports.createError("not_found", "指定した操作が提案にありません。");
  }
  const editedOperation = ports.parseOperation({
    ...operation,
    after: request.after,
    basis: "explicit",
    confidence: 1,
    evidence_refs: [
      ...operation.evidence_refs,
      { kind: "external_review", locator: request.evidence_locator },
    ],
  });
  const editedProposal = ports.parseProposal({
    ...record.proposal,
    groups: record.proposal.groups.map((group) => ({
      ...group,
      operations: group.operations.map((candidate) =>
        candidate.operation_id === request.operation_id ? editedOperation : candidate),
    })),
  });
  const validation = ports.validateProposal(editedProposal);
  record.proposal = editedProposal;
  record.graph_validation = validation.graph;
  record.selected_operation_ids = ports.preserveSelection(
    editedProposal,
    validation.graph,
    record.selected_operation_ids,
  );
  record.view = ports.createView(editedProposal, validation.basic, validation.graph);
  record.revision += 1;
  record.state = { kind: "pending_approval" };
  ports.emitChanged();
  return ports.getState();
}

/** GUIから外部提案を却下します。 */
export function rejectExternalAgentProposal<TProposal, TGraph, TView, TState>(
  record: GuiProposalRecord<TProposal, TGraph, TView>,
  revision: number,
  ports: {
    readonly createError: (code: GuiEditErrorCode, message: string) => Error;
    readonly emitChanged: () => void;
    readonly getState: () => TState;
  },
): TState {
  assertRevision(record, revision, ports.createError);
  if (record.state.kind !== "pending_approval") {
    throw ports.createError("conflict", "この提案は却下できません。");
  }
  record.revision += 1;
  record.state = { kind: "rejected" };
  ports.emitChanged();
  return ports.getState();
}
