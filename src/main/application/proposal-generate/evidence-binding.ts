import { isWithdrawConfirmationSourceCurrent } from "./evidence-sources";
import type { EvidenceSource } from "./evidence-sources";

type ProposalTarget =
  | { readonly kind: "existing"; readonly gid: string }
  | { readonly kind: "temporary"; readonly ref: string };

type EvidenceReference<TKind extends string> = {
  readonly kind: TKind;
  readonly locator: string;
  readonly excerpt?: string | undefined;
};

type StatusEvidence =
  | { readonly kind: "user_explicit"; readonly reference: EvidenceReference<"user_message"> }
  | { readonly kind: "task_or_note_explicit"; readonly reference: EvidenceReference<"task" | "obsidian"> }
  | { readonly kind: "external_structured_status"; readonly reference: EvidenceReference<"external_tool">; readonly status: "closed" | "completed" | "cancelled" }
  | { readonly kind: "external_review_explicit"; readonly reference: EvidenceReference<"external_review"> }
  | { readonly kind: "children_only_all_completed"; readonly reference: EvidenceReference<"task"> };

type StatusOperation = {
  readonly operation: "complete" | "withdraw";
  readonly target: ProposalTarget;
  readonly status_evidence: StatusEvidence;
};

type SplitTaskCreation = {
  readonly kind: "split_child";
  readonly parent: ProposalTarget;
  readonly instruction_reference: EvidenceReference<"user_message" | "external_review">;
};

type EvidencePrepared<TStatus extends string> = {
  readonly snapshot: { readonly tasks: readonly { readonly gid: string; readonly notes: string; readonly status: TStatus; readonly completed: boolean }[] };
  readonly baseline: { readonly tasks: readonly { readonly gid: string; readonly status: TStatus; readonly completed: boolean }[] };
  readonly source_map: ReadonlyMap<string, EvidenceSource<TStatus>>;
};

type TrustedReference =
  | { readonly kind: "user_message"; readonly locator: string; readonly target_task_gid: string; readonly allowed_operation: "complete" | "withdraw"; readonly excerpt: string }
  | { readonly kind: "task"; readonly locator: string; readonly target_task_gid: string; readonly allowed_operation: "complete" | "withdraw"; readonly validation_kind: "explicit_text"; readonly excerpt: string };

type BindingDependencies<TStatus extends string> = {
  readonly createStatusEvidenceLocator: (sourceId: string, operation: "complete" | "withdraw", taskGid: string) => string;
  readonly createSplitInstructionLocator: (sourceId: string, parent: ProposalTarget) => string;
  readonly verifiedSourceExcerpt: (source: EvidenceSource<TStatus>, excerpt: string | undefined) => string | undefined;
};

function stripStatusEvidenceExcerpt(
  operation: StatusOperation,
): StatusOperation["status_evidence"] {
  const evidence = operation.status_evidence;
  if (evidence.kind === "user_explicit") {
    return {
      kind: "user_explicit",
      reference: {
        kind: "user_message",
        locator: evidence.reference.locator,
      },
    };
  }
  if (evidence.kind === "task_or_note_explicit") {
    if (evidence.reference.kind === "task") {
      return {
        kind: "task_or_note_explicit",
        reference: {
          kind: "task",
          locator: evidence.reference.locator,
        },
      };
    }
    return {
      kind: "task_or_note_explicit",
      reference: {
        kind: "obsidian",
        locator: evidence.reference.locator,
      },
    };
  }
  if (evidence.kind === "external_structured_status") {
    return {
      ...evidence,
      reference: {
        kind: "external_tool",
        locator: evidence.reference.locator,
      },
    };
  }
  if (evidence.kind === "external_review_explicit") {
    return {
      kind: "external_review_explicit",
      reference: {
        kind: "external_review",
        locator: evidence.reference.locator,
      },
    };
  }
  return {
    kind: "children_only_all_completed",
    reference: {
      kind: "task",
      locator: evidence.reference.locator,
    },
  };
}

function stripSplitInstructionExcerpt(
  creation: SplitTaskCreation,
): SplitTaskCreation["instruction_reference"] {
  return {
    kind: creation.instruction_reference.kind,
    locator: creation.instruction_reference.locator,
  };
}

/** 取り下げ確認の根拠が操作と基準状態に対応するか判定します。 */
export function isWithdrawConfirmationEvidenceValid<TStatus extends string>(
  operation: StatusOperation,
  source: Extract<EvidenceSource<TStatus>, { readonly kind: "withdraw_confirmation" }>,
  snapshot: EvidencePrepared<TStatus>["snapshot"],
  baseline: EvidencePrepared<TStatus>["baseline"],
): boolean {
  const target = operation.target;
  if (
    operation.operation !== "withdraw"
    || target.kind !== "existing"
  ) {
    return false;
  }
  const baselineTask = baseline.tasks.find((task) => task.gid === target.gid);
  return isWithdrawConfirmationSourceCurrent(source, snapshot)
    && target.gid === source.target_task_gid
    && baselineTask != null
    && baselineTask.status === source.baseline_status
    && baselineTask.completed === source.baseline_completed;
}

/** 状態変更の引用を現在の原文へ結び付けます。 */
export function bindStatusEvidence<TStatus extends string>(
  operation: StatusOperation,
  prepared: EvidencePrepared<TStatus>,
  dependencies: BindingDependencies<TStatus>,
): {
  readonly evidence: StatusOperation["status_evidence"];
  readonly trusted_reference: TrustedReference | undefined;
} {
  const evidence = operation.status_evidence;
  const invalid = {
    evidence: stripStatusEvidenceExcerpt(operation),
    trusted_reference: undefined,
  };
  if (evidence.kind === "user_explicit") {
    const target = operation.target;
    if (
      target.kind !== "existing"
      || !prepared.snapshot.tasks.some((task) => task.gid === target.gid)
    ) {
      return invalid;
    }
    const source = prepared.source_map.get(evidence.reference.locator);
    if (
      source == null
      || (source.kind !== "user_message" && source.kind !== "withdraw_confirmation")
      || (
        source.kind === "withdraw_confirmation"
        && !isWithdrawConfirmationEvidenceValid(
          operation,
          source,
          prepared.snapshot,
          prepared.baseline,
        )
      )
    ) {
      return invalid;
    }
    const excerpt = dependencies.verifiedSourceExcerpt(source, evidence.reference.excerpt);
    if (excerpt == null) {
      return invalid;
    }
    const locator = dependencies.createStatusEvidenceLocator(
      source.source_id,
      operation.operation,
      target.gid,
    );
    const reference: EvidenceReference<"user_message"> = {
      kind: "user_message",
      locator,
      excerpt,
    };
    return {
      evidence: { ...evidence, reference },
      trusted_reference: {
        kind: "user_message",
        locator,
        target_task_gid: target.gid,
        allowed_operation: operation.operation,
        excerpt,
      },
    };
  }
  if (evidence.kind === "task_or_note_explicit") {
    const target = operation.target;
    if (
      target.kind !== "existing"
      || evidence.reference.kind !== "task"
      || !prepared.snapshot.tasks.some((task) => task.gid === target.gid)
    ) {
      return invalid;
    }
    const source = prepared.source_map.get(evidence.reference.locator);
    if (
      source == null
      || source.kind !== "task_notes"
      || source.task_gid !== target.gid
    ) {
      return invalid;
    }
    const excerpt = dependencies.verifiedSourceExcerpt(source, evidence.reference.excerpt);
    if (excerpt == null) {
      return invalid;
    }
    const locator = dependencies.createStatusEvidenceLocator(
      source.source_id,
      operation.operation,
      target.gid,
    );
    const reference: EvidenceReference<"task"> = {
      kind: "task",
      locator,
      excerpt,
    };
    return {
      evidence: { ...evidence, reference },
      trusted_reference: {
        kind: "task",
        locator,
        target_task_gid: target.gid,
        allowed_operation: operation.operation,
        validation_kind: "explicit_text",
        excerpt,
      },
    };
  }
  return invalid;
}

type BindableOperation =
  | { readonly operation: "create_task"; readonly creation: { readonly kind: "single_task" } | SplitTaskCreation }
  | StatusOperation
  | { readonly operation:
      | "update_title" | "update_notes" | "set_status" | "set_importance" | "set_due"
      | "clear_due" | "set_duration" | "clear_duration" | "set_area" | "set_dependencies"
      | "set_parent" | "set_parent_work_mode" | "link_obsidian" | "unlink_obsidian" };

/** 単一操作の根拠を現在の会話と状態根拠へ結び付けます。 */
export function bindProposalOperationEvidence<
  TStatus extends string,
  TOperation extends BindableOperation,
>(
  operation: TOperation,
  prepared: EvidencePrepared<TStatus>,
  dependencies: BindingDependencies<TStatus> & {
    readonly resolveSplit: (operation: TOperation) => TOperation;
    readonly resolveStatus: (operation: TOperation) => TOperation;
    readonly parseOperation: (value: unknown) => TOperation;
  },
): {
  readonly operation: TOperation;
  readonly split_reference: { readonly parent: ProposalTarget; readonly locator: string; readonly excerpt: string } | undefined;
  readonly trusted_reference: TrustedReference | undefined;
} {
  if (operation.operation === "create_task") {
    const resolved = dependencies.resolveSplit(operation);
    if (resolved.operation !== "create_task") {
      throw new Error("根拠継承後の操作種別が変わりました。");
    }
    if (resolved.creation.kind !== "split_child") {
      return {
        operation,
        split_reference: undefined,
        trusted_reference: undefined,
      };
    }
    const bound = bindSplitInstructionReference(resolved.creation, prepared, dependencies);
    return {
      operation: dependencies.parseOperation({
        ...resolved,
        creation: {
          ...resolved.creation,
          instruction_reference: bound.reference,
        },
      }),
      split_reference: bound.split_reference,
      trusted_reference: undefined,
    };
  }
  if (operation.operation !== "complete" && operation.operation !== "withdraw") {
    return {
      operation,
      split_reference: undefined,
      trusted_reference: undefined,
    };
  }
  const resolved = dependencies.resolveStatus(operation);
  if (resolved.operation !== "complete" && resolved.operation !== "withdraw") {
    throw new Error("根拠継承後の操作種別が変わりました。");
  }
  const bound = bindStatusEvidence(resolved, prepared, dependencies);
  return {
    operation: dependencies.parseOperation({
      ...resolved,
      status_evidence: bound.evidence,
    }),
    split_reference: undefined,
    trusted_reference: bound.trusted_reference,
  };
}

/** 分割依頼の引用を現在の原文へ結び付けます。 */
export function bindSplitInstructionReference<TStatus extends string>(
  creation: SplitTaskCreation,
  prepared: EvidencePrepared<TStatus>,
  dependencies: BindingDependencies<TStatus>,
): {
  readonly reference: SplitTaskCreation["instruction_reference"];
  readonly split_reference: { readonly parent: ProposalTarget; readonly locator: string; readonly excerpt: string } | undefined;
} {
  const reference = creation.instruction_reference;
  const invalid = {
    reference: stripSplitInstructionExcerpt(creation),
    split_reference: undefined,
  };
  const parent = creation.parent;
  if (
    parent.kind === "existing"
    && !prepared.snapshot.tasks.some((task) => task.gid === parent.gid)
  ) {
    return invalid;
  }
  const source = prepared.source_map.get(reference.locator);
  if (source == null || source.kind !== "user_message") {
    return invalid;
  }
  const excerpt = dependencies.verifiedSourceExcerpt(source, reference.excerpt);
  if (excerpt == null) {
    return invalid;
  }
  const locator = dependencies.createSplitInstructionLocator(
    source.source_id,
    creation.parent,
  );
  return {
    reference: {
      kind: "user_message",
      locator,
      excerpt,
    },
    split_reference: {
      parent: creation.parent,
      locator,
      excerpt,
    },
  };
}
