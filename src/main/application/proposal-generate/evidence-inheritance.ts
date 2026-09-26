import { isWithdrawConfirmationEvidenceValid } from "./evidence-binding";
import type { EvidenceSource } from "./evidence-sources";

type ProposalTarget =
  | { readonly kind: "existing"; readonly gid: string }
  | { readonly kind: "temporary"; readonly ref: string };

type StatusOperation = {
  readonly operation: "complete" | "withdraw";
  readonly target: ProposalTarget;
  readonly status_evidence: { readonly kind: "user_explicit"; readonly reference: { readonly kind: "user_message"; readonly locator: string; readonly excerpt?: string | undefined } };
};

type SplitCreation = {
  readonly kind: "split_child";
  readonly parent: ProposalTarget;
  readonly instruction_reference: { readonly kind: "user_message"; readonly locator: string; readonly excerpt?: string | undefined };
};

type TrustedReference = {
  readonly kind: string;
  readonly locator: string;
  readonly excerpt?: string | undefined;
  readonly target_task_gid?: string | undefined;
  readonly allowed_operation?: "complete" | "withdraw" | undefined;
};

type SplitReference = { readonly parent: ProposalTarget; readonly locator: string; readonly excerpt: string };

type Snapshot<TStatus extends string> = {
  readonly tasks: readonly { readonly gid: string; readonly notes: string; readonly status: TStatus; readonly completed: boolean }[];
};

type Baseline<TStatus extends string> = {
  readonly tasks: readonly { readonly gid: string; readonly status: TStatus; readonly completed: boolean }[];
};

type BaseProposal<TStatus extends string> = {
  readonly source_map: ReadonlyMap<string, EvidenceSource<TStatus>>;
  readonly snapshot: Snapshot<TStatus>;
  readonly baseline: Baseline<TStatus>;
  readonly trusted_status_evidence: readonly TrustedReference[];
  readonly explicit_split_request_references: readonly SplitReference[];
};

export type InheritedStatusEvidenceAlias = {
  readonly locator: string;
  readonly source_id: string;
  readonly excerpt: string;
  readonly target_task_gid: string;
  readonly allowed_operation: "complete" | "withdraw";
};

export type InheritedSplitInstructionAlias = {
  readonly locator: string;
  readonly source_id: string;
  readonly excerpt: string;
  readonly parent: ProposalTarget;
};

type EligibleEvidenceOperation =
  | { readonly kind: "status"; readonly operation: StatusOperation }
  | { readonly kind: "split"; readonly creation: SplitCreation };

/** 前案の利用者明示状態根拠に対応する現ターンの原文を探します。 */
function findInheritedStatusEvidenceAlias(
  operation: {
    readonly operation: "complete" | "withdraw";
    readonly target: ProposalTarget;
    readonly status_evidence: {
      readonly kind: string;
      readonly reference: { readonly kind: string; readonly locator: string; readonly excerpt?: string | undefined };
    };
  },
  aliases: readonly InheritedStatusEvidenceAlias[],
): InheritedStatusEvidenceAlias | undefined {
  const evidence = operation.status_evidence;
  if (evidence.kind !== "user_explicit" || evidence.reference.kind !== "user_message") {
    return undefined;
  }
  if (operation.target.kind !== "existing") {
    return undefined;
  }
  const targetTaskGid = operation.target.gid;
  return aliases.find((candidate) => candidate.locator === evidence.reference.locator
    && candidate.excerpt === evidence.reference.excerpt
    && candidate.target_task_gid === targetTaskGid
    && candidate.allowed_operation === operation.operation);
}

/** 継承できる利用者明示状態根拠を現ターンの引用位置へ更新します。 */
export function resolveInheritedStatusEvidenceAlias<TOperation extends {
  readonly operation: "complete" | "withdraw";
  readonly target: ProposalTarget;
  readonly status_evidence: {
    readonly kind: string;
    readonly reference: { readonly kind: string; readonly locator: string; readonly excerpt?: string | undefined };
  };
}>(operation: TOperation, aliases: readonly InheritedStatusEvidenceAlias[]): TOperation {
  const evidence = operation.status_evidence;
  if (evidence.kind !== "user_explicit" || evidence.reference.kind !== "user_message") {
    return operation;
  }
  const alias = findInheritedStatusEvidenceAlias(operation, aliases);
  if (alias == null) return operation;
  return {
    ...operation,
    status_evidence: {
      ...evidence,
      reference: { ...evidence.reference, locator: alias.source_id, excerpt: alias.excerpt },
    },
  };
}

/** 前案の分割指示根拠に対応する現ターンの原文を探します。 */
function findInheritedSplitInstructionAlias(
  operation: {
    readonly creation:
      | { readonly kind: "single_task" }
      | {
          readonly kind: "split_child";
          readonly parent: ProposalTarget;
          readonly instruction_reference: { readonly locator: string; readonly excerpt?: string | undefined };
        };
  },
  aliases: readonly InheritedSplitInstructionAlias[],
  canonicalizeJson: (value: unknown) => string,
): InheritedSplitInstructionAlias | undefined {
  if (operation.creation.kind !== "split_child") {
    return undefined;
  }
  const parent = operation.creation.parent;
  const reference = operation.creation.instruction_reference;
  return aliases.find((candidate) => candidate.locator === reference.locator
    && candidate.excerpt === reference.excerpt
    && canonicalizeJson(candidate.parent) === canonicalizeJson(parent));
}

/** 継承できる分割指示根拠を現ターンの引用位置へ更新します。 */
export function resolveInheritedSplitInstructionAlias<TOperation extends {
  readonly creation:
    | { readonly kind: "single_task" }
    | {
        readonly kind: "split_child";
        readonly parent: ProposalTarget;
        readonly instruction_reference: { readonly locator: string; readonly excerpt?: string | undefined };
      };
}>(
  operation: TOperation,
  aliases: readonly InheritedSplitInstructionAlias[],
  canonicalizeJson: (value: unknown) => string,
): TOperation {
  const alias = findInheritedSplitInstructionAlias(operation, aliases, canonicalizeJson);
  if (alias == null || operation.creation.kind !== "split_child") return operation;
  return {
    ...operation,
    creation: {
      ...operation.creation,
      instruction_reference: {
        ...operation.creation.instruction_reference,
        locator: alias.source_id,
        excerpt: alias.excerpt,
      },
    },
  };
}

type CandidateOperation = {
  readonly operation_id: string;
  readonly operation: string;
  readonly target?: ProposalTarget;
  readonly status_evidence?: {
    readonly kind: string;
    readonly reference: { readonly kind: string; readonly locator: string; readonly excerpt?: string | undefined };
  };
  readonly creation?:
    | { readonly kind: "single_task" }
    | {
        readonly kind: "split_child";
        readonly parent: ProposalTarget;
        readonly instruction_reference: { readonly kind: string; readonly locator: string; readonly excerpt?: string | undefined };
      };
};

/** 前案で選択可能だった操作から継承可能な根拠だけを抽出します。 */
export function selectEligibleEvidenceOperations(
  proposal: { readonly groups: readonly { readonly operations: readonly CandidateOperation[] }[] },
  eligibleIds: ReadonlySet<string>,
): EligibleEvidenceOperation[] {
  const eligibleOperations: EligibleEvidenceOperation[] = [];
  for (const group of proposal.groups) {
    for (const operation of group.operations) {
      if (!eligibleIds.has(operation.operation_id)) continue;
      if ((operation.operation === "complete" || operation.operation === "withdraw")
        && operation.status_evidence?.kind === "user_explicit"
        && operation.status_evidence.reference.kind === "user_message"
        && operation.target?.kind === "existing") {
        eligibleOperations.push({ kind: "status", operation: {
          operation: operation.operation,
          target: operation.target,
          status_evidence: {
            kind: "user_explicit",
            reference: {
              kind: "user_message",
              locator: operation.status_evidence.reference.locator,
              ...(operation.status_evidence.reference.excerpt == null
                ? {} : { excerpt: operation.status_evidence.reference.excerpt }),
            },
          },
        } });
      }
      if (operation.operation === "create_task"
        && operation.creation?.kind === "split_child"
        && operation.creation.instruction_reference.kind === "user_message") {
        eligibleOperations.push({ kind: "split", creation: {
          kind: "split_child",
          parent: operation.creation.parent,
          instruction_reference: {
            kind: "user_message",
            locator: operation.creation.instruction_reference.locator,
            ...(operation.creation.instruction_reference.excerpt == null
              ? {} : { excerpt: operation.creation.instruction_reference.excerpt }),
          },
        } });
      }
    }
  }
  return eligibleOperations;
}

type InheritanceDependencies<TStatus extends string> = {
  readonly canonicalizeJson: (value: unknown) => string;
  readonly createStatusEvidenceLocator: (sourceId: string, operation: "complete" | "withdraw", taskGid: string) => string;
  readonly createSplitInstructionLocator: (sourceId: string, parent: ProposalTarget) => string;
  readonly verifiedSourceExcerpt: (source: EvidenceSource<TStatus>, excerpt: string | undefined) => string | undefined;
  readonly WorkflowError: new (message: string) => Error;
};

function findInheritedStatusSource<TStatus extends string>(
  baseProposal: BaseProposal<TStatus>,
  sourceMap: ReadonlyMap<string, EvidenceSource<TStatus>>,
  snapshot: Snapshot<TStatus>,
  baseline: Baseline<TStatus>,
  operation: StatusOperation,
  reference: TrustedReference,
  dependencies: InheritanceDependencies<TStatus>,
): InheritedStatusEvidenceAlias | undefined {
  const operationEvidence = operation.status_evidence;
  if (
    reference.kind !== "user_message"
    || operationEvidence.kind !== "user_explicit"
    || operationEvidence.reference.kind !== "user_message"
    || reference.excerpt == null
    || operationEvidence.reference.excerpt == null
  ) {
    throw new dependencies.WorkflowError("前案の利用者明示根拠の対応が壊れています。");
  }
  const target = operation.target;
  if (
    target.kind !== "existing"
    || reference.target_task_gid !== target.gid
    || reference.allowed_operation !== operation.operation
    || reference.locator !== operationEvidence.reference.locator
    || reference.excerpt !== operationEvidence.reference.excerpt
  ) {
    throw new dependencies.WorkflowError("前案の利用者明示根拠の対応が壊れています。");
  }
  const targetTaskGid = target.gid;
  const candidates = [...baseProposal.source_map.values()].filter(
    (source): source is Extract<
      EvidenceSource<TStatus>,
      { readonly kind: "user_message" | "withdraw_confirmation" }
    > => source.kind === "user_message" || source.kind === "withdraw_confirmation",
  );
  const matches = candidates.filter(
    (source) => dependencies.createStatusEvidenceLocator(
      source.source_id,
      operation.operation,
      targetTaskGid,
    ) === reference.locator,
  );
  if (matches.length !== 1) {
    throw new dependencies.WorkflowError("前案の利用者明示根拠の原文を特定できません。");
  }
  const baseSource = matches[0];
  if (baseSource == null || dependencies.verifiedSourceExcerpt(baseSource, reference.excerpt) == null) {
    throw new dependencies.WorkflowError("前案の利用者明示根拠の引用が原文にありません。");
  }
  if (
    baseSource.kind === "withdraw_confirmation"
    && !isWithdrawConfirmationEvidenceValid(
      operation,
      baseSource,
      baseProposal.snapshot,
      baseProposal.baseline,
    )
  ) {
    throw new dependencies.WorkflowError("前案の取り下げ確認根拠が基準状態へ対応していません。");
  }
  const currentSource = sourceMap.get(baseSource.source_id);
  if (currentSource == null) {
    if (baseSource.kind === "withdraw_confirmation") {
      return undefined;
    }
    throw new dependencies.WorkflowError("前案の利用者原文が現在のsource mapにありません。");
  }
  if (dependencies.canonicalizeJson(currentSource) !== dependencies.canonicalizeJson(baseSource)) {
    throw new dependencies.WorkflowError("前案の利用者原文が現在のsource mapと一致しません。");
  }
  if (
    currentSource.kind === "withdraw_confirmation"
    && !isWithdrawConfirmationEvidenceValid(operation, currentSource, snapshot, baseline)
  ) {
    return undefined;
  }
  if (dependencies.verifiedSourceExcerpt(currentSource, reference.excerpt) == null) {
    throw new dependencies.WorkflowError("前案の利用者明示根拠の引用が現在の原文にありません。");
  }
  return {
    locator: reference.locator,
    source_id: currentSource.source_id,
    excerpt: reference.excerpt,
    target_task_gid: targetTaskGid,
    allowed_operation: operation.operation,
  };
}

function findInheritedSplitSource<TStatus extends string>(
  baseProposal: BaseProposal<TStatus>,
  sourceMap: ReadonlyMap<string, EvidenceSource<TStatus>>,
  creation: SplitCreation,
  reference: SplitReference,
  dependencies: InheritanceDependencies<TStatus>,
): InheritedSplitInstructionAlias {
    if (creation.kind !== "split_child") {
    throw new dependencies.WorkflowError("前案の分割依頼根拠を通常作成へ適用できません。");
  }
  const parent = creation.parent;
  const operationReference = creation.instruction_reference;
  if (
    operationReference.kind !== "user_message"
    || operationReference.excerpt == null
    || dependencies.canonicalizeJson(reference.parent) !== dependencies.canonicalizeJson(parent)
    || reference.locator !== operationReference.locator
    || reference.excerpt !== operationReference.excerpt
  ) {
    throw new dependencies.WorkflowError("前案の分割依頼根拠の対応が壊れています。");
  }
  const candidates = [...baseProposal.source_map.values()].filter(
    (source): source is Extract<EvidenceSource<TStatus>, { readonly kind: "user_message" }> =>
      source.kind === "user_message",
  );
  const matches = candidates.filter(
    (source) => dependencies.createSplitInstructionLocator(
      source.source_id,
      parent,
    ) === reference.locator,
  );
  if (matches.length !== 1) {
    throw new dependencies.WorkflowError("前案の分割依頼根拠の原文を特定できません。");
  }
  const baseSource = matches[0];
  if (baseSource == null || dependencies.verifiedSourceExcerpt(baseSource, reference.excerpt) == null) {
    throw new dependencies.WorkflowError("前案の分割依頼根拠の引用が原文にありません。");
  }
  const currentSource = sourceMap.get(baseSource.source_id);
  if (currentSource == null || currentSource.kind !== "user_message") {
    throw new dependencies.WorkflowError("前案の分割依頼の利用者原文が現在のsource mapにありません。");
  }
  if (dependencies.canonicalizeJson(currentSource) !== dependencies.canonicalizeJson(baseSource)) {
    throw new dependencies.WorkflowError("前案の分割依頼の利用者原文が現在のsource mapと一致しません。");
  }
  if (dependencies.verifiedSourceExcerpt(currentSource, reference.excerpt) == null) {
    throw new dependencies.WorkflowError("前案の分割依頼根拠の引用が現在の原文にありません。");
  }
  return {
    locator: reference.locator,
    source_id: currentSource.source_id,
    excerpt: reference.excerpt,
    parent,
  };
}

/** 前案の根拠を現在の会話へ引き継げる場合の別名を求めます。 */
export function createInheritedEvidenceAliases<
  TStatus extends string,
  TBase extends BaseProposal<TStatus>,
>(
  baseProposal: TBase | undefined,
  sourceMap: ReadonlyMap<string, EvidenceSource<TStatus>>,
  snapshot: Snapshot<TStatus>,
  baseline: Baseline<TStatus>,
  dependencies: InheritanceDependencies<TStatus> & {
    readonly eligibleOperations: (baseProposal: TBase) => readonly EligibleEvidenceOperation[];
  },
): {
  readonly status: readonly InheritedStatusEvidenceAlias[];
  readonly split: readonly InheritedSplitInstructionAlias[];
} {
  if (baseProposal == null) {
    return { status: [], split: [] };
  }
  const eligibleOperations = dependencies.eligibleOperations(baseProposal);
  const trustedByLocator = new Map<string, TrustedReference>();
  for (const reference of baseProposal.trusted_status_evidence) {
    const key = `${reference.kind}\u0000${reference.locator}`;
    if (trustedByLocator.has(key)) {
      throw new dependencies.WorkflowError("前案の信頼済み根拠locatorが重複しています。");
    }
    trustedByLocator.set(key, reference);
  }
  const splitByKey = new Map<string, SplitReference>();
  for (const reference of baseProposal.explicit_split_request_references) {
    const key = `${dependencies.canonicalizeJson(reference.parent)}\u0000${reference.locator}\u0000${reference.excerpt}`;
    if (splitByKey.has(key)) {
      throw new dependencies.WorkflowError("前案の分割依頼根拠が重複しています。");
    }
    splitByKey.set(key, reference);
  }
  const statusAliases = new Map<string, InheritedStatusEvidenceAlias>();
  const splitAliases = new Map<string, InheritedSplitInstructionAlias>();
  for (const entry of eligibleOperations) {
    if (entry.kind === "status") {
      const operation = entry.operation;
      const trusted = trustedByLocator.get(
        `user_message\u0000${operation.status_evidence.reference.locator}`,
      );
      if (trusted == null) {
        throw new dependencies.WorkflowError("前案の利用者明示根拠が信頼済み一覧にありません。");
      }
      const alias = findInheritedStatusSource(
        baseProposal, sourceMap, snapshot, baseline, operation, trusted, dependencies,
      );
      if (alias != null) {
        const key = `${alias.locator}\u0000${alias.source_id}\u0000${alias.excerpt}\u0000${alias.target_task_gid}\u0000${alias.allowed_operation}`;
        if (!statusAliases.has(key)) statusAliases.set(key, alias);
      }
      continue;
    }
    const creation = entry.creation;
    const operationReference = creation.instruction_reference;
    if (operationReference.excerpt == null) {
      throw new dependencies.WorkflowError("前案の分割依頼根拠の引用がありません。");
    }
    const key = `${dependencies.canonicalizeJson(creation.parent)}\u0000${operationReference.locator}\u0000${operationReference.excerpt}`;
    const reference = splitByKey.get(key);
    if (reference == null) {
      throw new dependencies.WorkflowError("前案の分割依頼根拠が信頼済み一覧にありません。");
    }
    const alias = findInheritedSplitSource(baseProposal, sourceMap, creation, reference, dependencies);
    const aliasKey = `${alias.locator}\u0000${alias.source_id}\u0000${alias.excerpt}\u0000${dependencies.canonicalizeJson(alias.parent)}`;
    if (!splitAliases.has(aliasKey)) splitAliases.set(aliasKey, alias);
  }
  return { status: [...statusAliases.values()], split: [...splitAliases.values()] };
}
