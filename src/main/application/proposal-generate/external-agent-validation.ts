type ExternalEvidence<TSplit, TTrusted, TIssue> = {
  readonly split_references: readonly TSplit[];
  readonly trusted_status_evidence: readonly TTrusted[];
  readonly issues: TIssue[];
};

/** ワークスペースの提案を根拠から順に検証します。 */
export function validateExternalAgentWorkspaceProposal<TProposal, TBasic, TGraph, TSplit, TTrusted, TIssue>(
  proposal: TProposal,
  ports: {
    readonly collectEvidence: () => ExternalEvidence<TSplit, TTrusted, TIssue>;
    readonly validateBasic: (evidence: ExternalEvidence<TSplit, TTrusted, TIssue>) => TBasic;
    readonly validateGraph: (basic: TBasic) => TGraph;
  },
):
  | { readonly kind: "invalid"; readonly issues: TIssue[] }
  | {
      readonly kind: "valid";
      readonly proposal: TProposal;
      readonly value: {
        readonly basic: TBasic;
        readonly graph: TGraph;
        readonly evidence: {
          readonly split_references: readonly TSplit[];
          readonly trusted_status_evidence: readonly TTrusted[];
        };
      };
    } {
  const evidence = ports.collectEvidence();
  if (evidence.issues.length > 0) {
    return { kind: "invalid", issues: evidence.issues };
  }
  const basic = ports.validateBasic(evidence);
  const graph = ports.validateGraph(basic);
  return {
    kind: "valid",
    proposal,
    value: {
      basic,
      graph,
      evidence: {
        split_references: evidence.split_references,
        trusted_status_evidence: evidence.trusted_status_evidence,
      },
    },
  };
}

/** 提出済み提案を基礎検証からグラフ検証まで実行します。 */
export function validateExternalAgentSubmittedProposal<TBasic, TGraph>(ports: {
  readonly validateBasic: () => TBasic;
  readonly validateGraph: (basic: TBasic) => TGraph;
}): { readonly basic: TBasic; readonly graph: TGraph } {
  const basic = ports.validateBasic();
  const graph = ports.validateGraph(basic);
  return { basic, graph };
}
