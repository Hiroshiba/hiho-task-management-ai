type ProposalWithOperations = {
  readonly groups: readonly {
    readonly operations: readonly { readonly operation_id: string }[];
  }[];
};

type CreatedExternalAgentProposalRecord<
  TProposal, TSnapshot, TBaseline, TExternalData, TTurnContext, TGraph, TSplit, TTrusted, TView,
> = {
  readonly proposal_id: string;
  readonly request_id: string;
  readonly instance_id: string;
  readonly context_id: string;
  readonly proposal_context_id: string;
  readonly operation_ids: readonly string[];
  readonly source_text: string;
  readonly snapshot: TSnapshot;
  readonly baseline_snapshot: TBaseline;
  readonly baseline_external_data: TExternalData;
  readonly turn_context: TTurnContext;
  proposal: TProposal;
  explicit_split_request_references: readonly TSplit[];
  trusted_status_evidence: readonly TTrusted[];
  graph_validation: TGraph;
  selected_operation_ids: readonly string[];
  view: TView;
  revision: number;
  state: { readonly kind: "pending_approval" };
};

/** 提出済み外部提案の表示と承認用の状態を組み立てます。 */
export function createExternalAgentProposalRecord<
  TProposal extends ProposalWithOperations,
  TSnapshot,
  TBaseline,
  TExternalData,
  TTurnContext extends { readonly baseline_snapshot_hash: string },
  TBasic,
  TGraph,
  TSplit,
  TTrusted,
  TView,
>(
  input: { readonly request_id: string; readonly instance_id: string; readonly context_id: string },
  prepared: {
    readonly context_id: string;
    readonly proposal_context_id: string;
    readonly source_text: string;
    readonly snapshot: TSnapshot;
    readonly baseline_snapshot: TBaseline;
    readonly baseline_external_data: TExternalData;
    readonly turn_context: TTurnContext;
  },
  proposal: TProposal,
  validation: {
    readonly basic: TBasic;
    readonly graph: TGraph;
    readonly evidence: {
      readonly split_references: readonly TSplit[];
      readonly trusted_status_evidence: readonly TTrusted[];
    };
  },
  proposalId: string,
  ports: {
    readonly stopped: () => boolean;
    readonly currentContextId: () => string | undefined;
    readonly eligibleOperationIds: (proposal: TProposal, graph: TGraph) => readonly string[];
    readonly createView: (
      proposalId: string, proposal: TProposal, snapshot: TSnapshot,
      hash: string, basic: TBasic, graph: TGraph, selectedIds: readonly string[],
    ) => TView;
    readonly createError: () => Error;
  },
): CreatedExternalAgentProposalRecord<
  TProposal, TSnapshot, TBaseline, TExternalData, TTurnContext, TGraph, TSplit, TTrusted, TView
> {
  if (ports.stopped() || ports.currentContextId() !== prepared.context_id) {
    throw ports.createError();
  }
  const operationIds = proposal.groups.flatMap((group) =>
    group.operations.map((operation) => operation.operation_id));
  const selectedOperationIds = ports.eligibleOperationIds(proposal, validation.graph);
  return {
    proposal_id: proposalId,
    request_id: input.request_id,
    instance_id: input.instance_id,
    context_id: input.context_id,
    proposal_context_id: prepared.proposal_context_id,
    operation_ids: operationIds,
    source_text: prepared.source_text,
    snapshot: prepared.snapshot,
    baseline_snapshot: prepared.baseline_snapshot,
    baseline_external_data: prepared.baseline_external_data,
    turn_context: prepared.turn_context,
    proposal,
    explicit_split_request_references: [...validation.evidence.split_references],
    trusted_status_evidence: [...validation.evidence.trusted_status_evidence],
    graph_validation: validation.graph,
    selected_operation_ids: [...selectedOperationIds],
    view: ports.createView(
      proposalId, proposal, prepared.snapshot, prepared.turn_context.baseline_snapshot_hash,
      validation.basic, validation.graph, selectedOperationIds,
    ),
    revision: 1,
    state: { kind: "pending_approval" },
  };
}
