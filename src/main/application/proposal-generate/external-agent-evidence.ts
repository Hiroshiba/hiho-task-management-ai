type EvidenceReference = {
  readonly kind: string;
  readonly locator: string;
  readonly excerpt?: string | undefined;
};

type ExternalEvidenceOperation<TParent> = {
  readonly operation_id: string;
  readonly evidence_refs: readonly EvidenceReference[];
} & (
  | {
      readonly kind: "status";
      readonly operation: "complete" | "withdraw";
      readonly target_kind: string;
      readonly target_gid?: string;
      readonly status_evidence: {
        readonly kind: string;
        readonly reference: EvidenceReference;
      };
    }
  | {
      readonly kind: "split";
      readonly parent: TParent;
      readonly instruction_reference: EvidenceReference;
    }
  | { readonly kind: "other" }
);

type ExternalEvidenceIssue = {
  readonly code: "external_source_evidence_missing" | "external_status_evidence_invalid" | "external_split_evidence_invalid";
  readonly json_pointer: string;
  readonly message: string;
  readonly group_id: string;
  readonly operation_id: string;
};

type ExternalEvidenceSourceOperation<TParent> = {
  readonly operation_id: string;
  readonly evidence_refs: readonly EvidenceReference[];
} & (
  | {
      readonly operation: "complete" | "withdraw";
      readonly target:
        | { readonly kind: "existing"; readonly gid: string }
        | { readonly kind: "temporary"; readonly ref: string };
      readonly status_evidence: { readonly kind: string; readonly reference: EvidenceReference };
    }
  | {
      readonly operation: "create_task";
      readonly creation:
        | { readonly kind: "single_task" }
        | { readonly kind: "split_child"; readonly parent: TParent; readonly instruction_reference: EvidenceReference };
    }
  | {
      readonly operation:
        | "update_title" | "update_notes" | "set_status" | "set_importance"
        | "set_due" | "clear_due" | "set_duration" | "clear_duration"
        | "set_area" | "set_dependencies" | "set_parent" | "set_parent_work_mode"
        | "link_obsidian" | "unlink_obsidian";
    }
);

/** 外部提案の操作から根拠検証に必要な情報を取り出します。 */
export function collectExternalAgentProposalEvidence<TParent>(
  prepared: { readonly proposal_context_id: string; readonly source_text: string },
  groups: readonly {
    readonly group_id: string;
    readonly operations: readonly ExternalEvidenceSourceOperation<TParent>[];
  }[],
  createLocator: (proposalContextId: string, operationId: string) => string,
): ReturnType<typeof collectExternalAgentEvidence<TParent>> {
  const evidenceGroups = groups.map((group) => ({
    group_id: group.group_id,
    operations: group.operations.map((operation): ExternalEvidenceOperation<TParent> => {
      const base = { operation_id: operation.operation_id, evidence_refs: operation.evidence_refs };
      if (operation.operation === "complete" || operation.operation === "withdraw") {
        return {
          ...base,
          kind: "status",
          operation: operation.operation,
          target_kind: operation.target.kind,
          ...(operation.target.kind === "existing" ? { target_gid: operation.target.gid } : {}),
          status_evidence: operation.status_evidence,
        };
      }
      if (operation.operation === "create_task" && operation.creation.kind === "split_child") {
        return {
          ...base,
          kind: "split",
          parent: operation.creation.parent,
          instruction_reference: operation.creation.instruction_reference,
        };
      }
      return { ...base, kind: "other" };
    }),
  }));
  return collectExternalAgentEvidence(prepared, evidenceGroups, createLocator);
}

/** 外部提案の各操作が提案原文の根拠を持つか検証します。 */
function collectExternalAgentEvidence<TParent>(
  prepared: { readonly proposal_context_id: string; readonly source_text: string },
  groups: readonly {
    readonly group_id: string;
    readonly operations: readonly ExternalEvidenceOperation<TParent>[];
  }[],
  createLocator: (proposalContextId: string, operationId: string) => string,
): {
  readonly split_references: readonly {
    readonly parent: TParent;
    readonly locator: string;
    readonly excerpt: string;
  }[];
  readonly trusted_status_evidence: readonly {
    readonly kind: "external_review";
    readonly locator: string;
    readonly target_task_gid: string;
    readonly allowed_operation: "complete" | "withdraw";
    readonly excerpt: string;
  }[];
  readonly issues: ExternalEvidenceIssue[];
} {
  const splitReferences: {
    readonly parent: TParent;
    readonly locator: string;
    readonly excerpt: string;
  }[] = [];
  const trustedStatusEvidence: {
    readonly kind: "external_review";
    readonly locator: string;
    readonly target_task_gid: string;
    readonly allowed_operation: "complete" | "withdraw";
    readonly excerpt: string;
  }[] = [];
  const issues: ExternalEvidenceIssue[] = [];
  for (const [groupIndex, group] of groups.entries()) {
    for (const [operationIndex, operation] of group.operations.entries()) {
      const pointer = `/groups/${groupIndex}/operations/${operationIndex}`;
      const locator = createLocator(prepared.proposal_context_id, operation.operation_id);
      const reference = operation.evidence_refs.find((candidate) =>
        candidate.kind === "external_review"
        && candidate.locator === locator
        && candidate.excerpt != null
        && candidate.excerpt.trim().length > 0
        && prepared.source_text.includes(candidate.excerpt));
      if (reference == null || reference.excerpt == null) {
        issues.push({
          code: "external_source_evidence_missing",
          json_pointer: `${pointer}/evidence_refs`,
          message: "操作に提案原文の根拠がありません。",
          group_id: group.group_id,
          operation_id: operation.operation_id,
        });
        continue;
      }
      if (operation.kind === "status") {
        if (
          operation.target_kind !== "existing"
          || operation.target_gid == null
          || operation.status_evidence.kind !== "external_review_explicit"
          || operation.status_evidence.reference.kind !== "external_review"
          || operation.status_evidence.reference.locator !== locator
          || operation.status_evidence.reference.excerpt !== reference.excerpt
        ) {
          issues.push({
            code: "external_status_evidence_invalid",
            json_pointer: `${pointer}/status_evidence`,
            message: "完了・取り下げ操作の外部根拠が一致しません。",
            group_id: group.group_id,
            operation_id: operation.operation_id,
          });
          continue;
        }
        trustedStatusEvidence.push({
          kind: "external_review",
          locator,
          target_task_gid: operation.target_gid,
          allowed_operation: operation.operation,
          excerpt: reference.excerpt,
        });
      }
      if (operation.kind === "split") {
        if (
          operation.instruction_reference.kind !== "external_review"
          || operation.instruction_reference.locator !== locator
          || operation.instruction_reference.excerpt !== reference.excerpt
        ) {
          issues.push({
            code: "external_split_evidence_invalid",
            json_pointer: `${pointer}/creation/instruction_reference`,
            message: "分割操作の外部根拠が一致しません。",
            group_id: group.group_id,
            operation_id: operation.operation_id,
          });
          continue;
        }
        splitReferences.push({
          parent: operation.parent,
          locator,
          excerpt: reference.excerpt,
        });
      }
    }
  }
  return {
    split_references: splitReferences,
    trusted_status_evidence: trustedStatusEvidence,
    issues,
  };
}

/** 承認対象として選んだ操作の外部根拠を検証します。 */
export function assertSelectedExternalAgentEvidence<
  TProposal extends { readonly groups: readonly { readonly operations: readonly { readonly operation_id: string }[] }[] },
  TEvidence extends { readonly issues: readonly unknown[] },
>(
  proposal: TProposal,
  operationIds: readonly string[],
  ports: {
    readonly parseProposal: (value: unknown) => TProposal;
    readonly collectEvidence: (proposal: TProposal) => TEvidence;
    readonly validateProposal: (proposal: TProposal, evidence: TEvidence) => readonly { readonly kind: string }[];
    readonly createError: () => Error;
  },
): TEvidence {
  const selected = new Set(operationIds);
  const selectedProposal = {
    ...proposal,
    groups: proposal.groups.map((group) => ({
      ...group,
      operations: group.operations.filter((operation) => selected.has(operation.operation_id)),
    })).filter((group) => group.operations.length > 0),
  };
  const validatedProposal = ports.parseProposal(selectedProposal);
  const evidence = ports.collectEvidence(validatedProposal);
  if (evidence.issues.length > 0) {
    throw ports.createError();
  }
  const operations = ports.validateProposal(validatedProposal, evidence);
  for (const operation of operations) {
    if (operation.kind === "invalid") {
      throw ports.createError();
    }
  }
  return evidence;
}
