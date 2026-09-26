type BoundEvidence<TProposal, TSplit, TTrusted> = {
  readonly proposal: TProposal;
  readonly explicit_split_request_references: readonly TSplit[];
  readonly trusted_status_evidence: readonly TTrusted[];
};

type ValidationContext<TTask, TArea, TSplit, TTrusted> = {
  readonly baseline_snapshot_hash: string;
  readonly snapshot: { readonly tasks: TTask[]; readonly areas: TArea[] };
  readonly explicit_split_request_references: readonly TSplit[];
  readonly trusted_status_evidence: readonly TTrusted[];
};

type StoredContext<TProposal, TTask, TArea, TSplit, TTrusted> =
  ValidationContext<TTask, TArea, TSplit, TTrusted> & { readonly proposal: TProposal };

type ValidationDependencies<TProposal, TTask, TArea, TSplit, TTrusted, TBasic, TGraph> = {
  readonly validateBasic: (input: {
    readonly proposal: TProposal;
    readonly baseline_snapshot_hash: string;
    readonly managed_tasks: TTask[];
    readonly existing_areas: TArea[];
    readonly explicit_split_request_references: TSplit[];
    readonly trusted_status_evidence: TTrusted[];
  }) => TBasic;
  readonly validateGraph: (input: {
    readonly proposal: TProposal;
    readonly managed_tasks: TTask[];
    readonly basic_validation_result: TBasic;
  }) => TGraph;
};

/** 保持中の変更案を基本検証とグラフ検証へ通し直します。 */
export function revalidateProposal<TProposal, TTask, TArea, TSplit, TTrusted, TBasic, TGraph>(
  proposal: TProposal,
  stored: StoredContext<TProposal, TTask, TArea, TSplit, TTrusted>,
  dependencies: ValidationDependencies<TProposal, TTask, TArea, TSplit, TTrusted, TBasic, TGraph>,
): { readonly basic: TBasic; readonly graph: TGraph } {
  const basic = dependencies.validateBasic({
    proposal,
    baseline_snapshot_hash: stored.baseline_snapshot_hash,
    managed_tasks: stored.snapshot.tasks,
    existing_areas: stored.snapshot.areas,
    explicit_split_request_references: [...stored.explicit_split_request_references],
    trusted_status_evidence: [...stored.trusted_status_evidence],
  });
  const graph = dependencies.validateGraph({
    proposal,
    managed_tasks: stored.snapshot.tasks,
    basic_validation_result: basic,
  });
  return { basic, graph };
}

/** 検証済みの変更案とターン基準値を保持値へ組み立てます。 */
export function createStoredProposal<
  TProposal,
  TTask,
  TArea,
  TSplit,
  TTrusted,
  TBasic,
  TGraph,
  TPrepared extends {
    readonly baseline_snapshot_hash: string;
    readonly snapshot: { readonly tasks: TTask[]; readonly areas: TArea[] };
    readonly baseline: unknown;
    readonly baseline_external_data: unknown;
    readonly source_map: ReadonlyMap<string, unknown>;
  },
>(
  proposalId: string,
  bound: BoundEvidence<TProposal, TSplit, TTrusted>,
  prepared: TPrepared,
  dependencies: ValidationDependencies<TProposal, TTask, TArea, TSplit, TTrusted, TBasic, TGraph> & {
    readonly eligibleOperationIds: (proposal: TProposal, graph: TGraph) => readonly string[];
  },
): {
  readonly proposal_id: string;
  readonly proposal: TProposal;
  readonly snapshot: TPrepared["snapshot"];
  readonly baseline: TPrepared["baseline"];
  readonly baseline_snapshot_hash: string;
  readonly baseline_external_data: TPrepared["baseline_external_data"];
  readonly basic_validation: TBasic;
  readonly graph_validation: TGraph;
  readonly selected_operation_ids: readonly string[];
  readonly explicit_split_request_references: TSplit[];
  readonly trusted_status_evidence: TTrusted[];
  readonly source_map: TPrepared["source_map"];
} {
  const validation = revalidateProposal(bound.proposal, {
    proposal: bound.proposal,
    baseline_snapshot_hash: prepared.baseline_snapshot_hash,
    snapshot: prepared.snapshot,
    explicit_split_request_references: bound.explicit_split_request_references,
    trusted_status_evidence: bound.trusted_status_evidence,
  }, dependencies);
  return {
    proposal_id: proposalId,
    proposal: bound.proposal,
    snapshot: prepared.snapshot,
    baseline: prepared.baseline,
    baseline_snapshot_hash: prepared.baseline_snapshot_hash,
    baseline_external_data: prepared.baseline_external_data,
    basic_validation: validation.basic,
    graph_validation: validation.graph,
    selected_operation_ids: dependencies.eligibleOperationIds(bound.proposal, validation.graph),
    explicit_split_request_references: [...bound.explicit_split_request_references],
    trusted_status_evidence: [...bound.trusted_status_evidence],
    source_map: prepared.source_map,
  };
}
