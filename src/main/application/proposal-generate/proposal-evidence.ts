type ProposalTarget =
  | { readonly kind: "existing"; readonly gid: string }
  | { readonly kind: "temporary"; readonly ref: string };

type SplitReference = { readonly parent: ProposalTarget; readonly locator: string; readonly excerpt: string };
type TrustedReference = { readonly kind: string; readonly locator: string };

type EvidenceOperation = { readonly operation_id: string };
type EvidenceProposal<TOperation extends EvidenceOperation> = {
  readonly groups: readonly { readonly group_id: string; readonly operations: readonly TOperation[] }[];
};

type EvidenceDependencies<TOperation extends EvidenceOperation, TProposal extends EvidenceProposal<TOperation>, TPrepared, TSplit extends SplitReference, TTrusted extends TrustedReference, TIssue, TDigest> = {
  readonly bindOperation: (operation: TOperation, prepared: TPrepared) => {
    readonly operation: TOperation;
    readonly split_reference: TSplit | undefined;
    readonly trusted_reference: TTrusted | undefined;
  };
  readonly parseIssue: (value: unknown) => TIssue;
  readonly parseProposal: (value: unknown) => TProposal;
  readonly parseTrustedReferences: (value: unknown) => readonly TTrusted[];
  readonly createRetryableFailure: (issues: readonly TIssue[], digest: TDigest, cause: AggregateError) => Error;
};

/** 変更案の根拠をターン中に確認できた原文へ結び付けます。 */
export function bindProposalEvidence<
  TOperation extends EvidenceOperation,
  TProposal extends EvidenceProposal<TOperation>,
  TPrepared extends { readonly trusted_status_evidence: readonly TTrusted[] },
  TSplit extends SplitReference,
  TTrusted extends TrustedReference,
  TIssue,
  TDigest,
>(
  proposal: TProposal,
  prepared: TPrepared,
  candidateDigest: TDigest,
  dependencies: EvidenceDependencies<TOperation, TProposal, TPrepared, TSplit, TTrusted, TIssue, TDigest>,
): {
  readonly proposal: TProposal;
  readonly explicit_split_request_references: readonly TSplit[];
  readonly trusted_status_evidence: readonly TTrusted[];
} {
  const splitReferences = new Map<string, TSplit>();
  const trustedReferences = new Map<string, TTrusted>();
  const failures: {
    readonly issue: TIssue;
    readonly error: unknown;
  }[] = [];
  for (const reference of prepared.trusted_status_evidence) {
    trustedReferences.set(`${reference.kind}\u0000${reference.locator}`, reference);
  }
  const groups = proposal.groups.map((group, groupIndex) => ({
    ...group,
    operations: group.operations.map((operation, operationIndex) => {
      let bound: ReturnType<typeof dependencies.bindOperation>;
      try {
        bound = dependencies.bindOperation(operation, prepared);
      } catch (error: unknown) {
        failures.push({
          issue: dependencies.parseIssue({
            phase: "evidence_binding",
            code: "evidence_binding_invalid",
            json_pointer: `/groups/${groupIndex}/operations/${operationIndex}`,
            group_id: group.group_id,
            operation_id: operation.operation_id,
          }),
          error,
        });
        return operation;
      }
      if (bound.split_reference != null) {
        const reference = bound.split_reference;
        const parent = reference.parent.kind === "existing"
          ? `existing:${reference.parent.gid}`
          : `temporary:${reference.parent.ref}`;
        splitReferences.set(
          `${parent}\u0000${reference.locator}\u0000${reference.excerpt}`,
          reference,
        );
      }
      if (bound.trusted_reference != null) {
        const reference = bound.trusted_reference;
        trustedReferences.set(`${reference.kind}\u0000${reference.locator}`, reference);
      }
      return bound.operation;
    }),
  }));
  if (failures.length > 0) {
    const firstFailure = failures[0];
    if (firstFailure == null) {
      throw new Error("根拠検証エラーを取得できません。");
    }
    throw dependencies.createRetryableFailure(
      failures.map((failure) => failure.issue),
      candidateDigest,
      new AggregateError(
        failures.map((failure) => failure.error),
        "変更案の根拠を現在の会話へ結び付けられません。",
        { cause: firstFailure.error },
      ),
    );
  }
  return {
    proposal: dependencies.parseProposal({ ...proposal, groups }),
    explicit_split_request_references: [...splitReferences.values()],
    trusted_status_evidence: dependencies.parseTrustedReferences(
      [...trustedReferences.values()],
    ),
  };
}

