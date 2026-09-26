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

export type EligibleEvidenceOperation =
  | { readonly kind: "status"; readonly operation: StatusOperation }
  | { readonly kind: "split"; readonly creation: SplitCreation };

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
export function createInheritedEvidenceAliases<TStatus extends string>(
  baseProposal: BaseProposal<TStatus> | undefined,
  sourceMap: ReadonlyMap<string, EvidenceSource<TStatus>>,
  snapshot: Snapshot<TStatus>,
  baseline: Baseline<TStatus>,
  eligibleOperations: readonly EligibleEvidenceOperation[],
  dependencies: InheritanceDependencies<TStatus>,
): {
  readonly status: readonly InheritedStatusEvidenceAlias[];
  readonly split: readonly InheritedSplitInstructionAlias[];
} {
  if (baseProposal == null) {
    return { status: [], split: [] };
  }
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
