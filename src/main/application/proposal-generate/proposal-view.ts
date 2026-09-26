type EvidenceReference = { readonly kind: string; readonly locator: string; readonly excerpt?: string | undefined };

type RendererOperation =
  | { readonly operation: "create_task"; readonly evidence_refs: readonly EvidenceReference[];
      readonly creation: { readonly kind: "single_task" } | { readonly kind: "split_child"; readonly instruction_reference: EvidenceReference } }
  | { readonly operation: "complete" | "withdraw"; readonly evidence_refs: readonly EvidenceReference[];
      readonly status_evidence: { readonly kind: string; readonly reference: EvidenceReference } }
  | { readonly operation:
      | "update_title" | "update_notes" | "set_status" | "set_importance" | "set_due"
      | "clear_due" | "set_duration" | "clear_duration" | "set_area" | "set_dependencies"
      | "set_parent" | "set_parent_work_mode" | "link_obsidian" | "unlink_obsidian";
      readonly evidence_refs: readonly EvidenceReference[] };

type ValidationResult = {
  readonly operations: readonly (
    | { readonly kind: "valid"; readonly group_id: string; readonly operation_id: string }
    | { readonly kind: "invalid"; readonly group_id: string; readonly operation_id: string; readonly errors: readonly { readonly code: string; readonly message: string }[] }
  )[];
  readonly groups: readonly { readonly group_id: string; readonly atomic: boolean; readonly applicable: boolean; readonly operation_ids: readonly string[] }[];
};

export type WorkflowValidation = {
  readonly operations: readonly {
    readonly kind: "valid" | "invalid";
    readonly group_id: string;
    readonly operation_id: string;
    readonly errors?: readonly { readonly code: string; readonly message: string }[];
  }[];
  readonly groups: readonly {
    readonly group_id: string;
    readonly atomic: boolean;
    readonly applicable: boolean;
    readonly operation_ids: readonly string[];
  }[];
};

/** 基本・グラフ検証結果を表示契約へ変換します。 */
export function toWorkflowValidation(result: ValidationResult): WorkflowValidation {
  return {
    operations: result.operations.map((operation) => {
      if (operation.kind === "valid") {
        return {
          kind: "valid",
          group_id: operation.group_id,
          operation_id: operation.operation_id,
        };
      }
      return {
        kind: "invalid",
        group_id: operation.group_id,
        operation_id: operation.operation_id,
        errors: operation.errors.map((error) => ({
          code: error.code,
          message: error.message,
        })),
      };
    }),
    groups: result.groups.map((group) => ({
      group_id: group.group_id,
      atomic: group.atomic,
      applicable: group.applicable,
      operation_ids: [...group.operation_ids],
    })),
  };
}

function sanitizeEvidenceReference(reference: {
  readonly kind: string;
  readonly locator: string;
  readonly excerpt?: string | undefined;
}, includeExcerpt: boolean): Record<string, string> {
  const base = { kind: reference.kind, locator: reference.locator };
  if (!includeExcerpt || reference.excerpt == null) {
    return base;
  }
  return { ...base, excerpt: reference.excerpt };
}

function sanitizeProposalOperation<TOperation extends RendererOperation>(
  operation: TOperation,
  parseOperation: (value: unknown) => TOperation,
): TOperation {
  const candidate: Record<string, unknown> = {
    ...operation,
    evidence_refs: operation.evidence_refs.map((reference) =>
      sanitizeEvidenceReference(reference, reference.kind === "external_review")),
  };
  if (operation.operation === "create_task" && operation.creation.kind === "split_child") {
    candidate.creation = {
      ...operation.creation,
      instruction_reference: sanitizeEvidenceReference(
        operation.creation.instruction_reference,
        true,
      ),
    };
  }
  if (operation.operation === "complete" || operation.operation === "withdraw") {
    candidate.status_evidence = {
      ...operation.status_evidence,
      reference: sanitizeEvidenceReference(
        operation.status_evidence.reference,
        operation.status_evidence.kind === "user_explicit"
          || (
            operation.status_evidence.kind === "task_or_note_explicit"
            && operation.status_evidence.reference.kind === "task"
          )
          || operation.status_evidence.kind === "external_review_explicit",
      ),
    };
  }
  return parseOperation(candidate);
}

/** 変更案の参照引用を表示に必要な内容へ限定します。 */
export function sanitizeProposalForRenderer<TOperation extends RendererOperation, TProposal extends {
  readonly groups: readonly { readonly operations: readonly TOperation[] }[];
}>(
  proposal: TProposal,
  parseProposal: (value: unknown) => TProposal,
  parseOperation: (value: unknown) => TOperation,
): TProposal {
  return parseProposal({
    ...proposal,
    groups: proposal.groups.map((group) => ({
      ...group,
      operations: group.operations.map((operation) => sanitizeProposalOperation(operation, parseOperation)),
    })),
  });
}

/** 保持中の提案と検証結果をRenderer向け表示値へ変換します。 */
export function createWorkflowProposalView<
  TOperation extends RendererOperation,
  TProposal extends { readonly groups: readonly { readonly operations: readonly TOperation[] }[] },
  TSnapshot,
  TView,
>(
  input: {
    readonly proposal_id: string;
    readonly proposal: TProposal;
    readonly snapshot: TSnapshot;
    readonly baseline_snapshot_hash: string;
    readonly basic_validation: ValidationResult;
    readonly graph_validation: ValidationResult;
    readonly selected_operation_ids: readonly string[];
  },
  dependencies: {
    readonly parseIdentifier: (value: string) => string;
    readonly parseProposal: (value: unknown) => TProposal;
    readonly parseOperation: (value: unknown) => TOperation;
    readonly calculateImpact: (snapshot: TSnapshot, proposal: TProposal, selected: readonly string[]) => unknown;
    readonly parseView: (value: unknown) => TView;
  },
): TView {
  const selected = [...input.selected_operation_ids];
  return dependencies.parseView({
    proposal_id: dependencies.parseIdentifier(input.proposal_id),
    baseline_snapshot_hash: input.baseline_snapshot_hash,
    proposal: sanitizeProposalForRenderer(
      input.proposal, dependencies.parseProposal, dependencies.parseOperation,
    ),
    basic_validation: toWorkflowValidation(input.basic_validation),
    graph_validation: toWorkflowValidation(input.graph_validation),
    selected_operation_ids: selected,
    impact: dependencies.calculateImpact(input.snapshot, input.proposal, selected),
  });
}
