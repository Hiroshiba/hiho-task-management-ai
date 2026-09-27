type Target =
  | { readonly kind: "existing"; readonly gid: string }
  | { readonly kind: "temporary"; readonly ref: string };
type ProposalOperation = {
  readonly operation: string;
  readonly operation_id: string;
  readonly temporary_ref?: string;
  readonly target?: Target;
  readonly before: unknown;
  readonly after: unknown;
};
type JournalOperation = {
  readonly operation: string;
  readonly operation_id: string;
  readonly temporary_ref?: string;
  readonly target?: Target | { readonly kind: "new_task"; readonly uuid: string };
  readonly expected_before: unknown;
  readonly expected_after: unknown;
};
type OperationContext<TOperation extends ProposalOperation> = {
  readonly operation: TOperation;
};
type BaselineExternal = { readonly gid: string; readonly data: string };
type BaselineSource<TData> =
  | { readonly kind: "not_used" }
  | { readonly kind: "stored"; readonly external_gid: string; readonly data: TData }
  | { readonly kind: "created_task"; readonly create_operation_id: string; readonly temporary_ref: string };

/** 提案操作を保存済み復旧計画の操作へ変換します。 */
export function journalOperationForProposalOperation<TOperation extends ProposalOperation, TJournalOperation>(
  operation: TOperation,
  uuids: ReadonlyMap<string, string>,
  parse: (value: unknown) => TJournalOperation,
): TJournalOperation {
  if (operation.operation === "create_task") {
    const uuid = uuids.get(operation.operation_id);
    if (uuid == null || operation.temporary_ref == null) {
      throw new Error("create_taskの事前発行UUIDがありません。");
    }
    return parse({
      operation: "create_task",
      operation_id: operation.operation_id,
      target: { kind: "new_task", uuid },
      temporary_ref: operation.temporary_ref,
      expected_before: operation.before,
      expected_after: operation.after,
    });
  }
  if (operation.target == null) {
    throw new Error("復旧計画の操作対象がありません。");
  }
  const operationTarget = operation.target.kind === "existing"
    ? { kind: "existing", gid: operation.target.gid }
    : { kind: "temporary", ref: operation.target.ref };
  return parse({
    operation: operation.operation,
    operation_id: operation.operation_id,
    target: operationTarget,
    expected_before: operation.before,
    expected_after: operation.after,
  });
}

/** 保存済み復旧計画の操作を検証可能な提案操作へ変換します。 */
export function proposalOperationForJournalOperation<TJournalOperation extends JournalOperation, TProposalOperation>(
  operation: TJournalOperation,
  parse: (value: unknown) => TProposalOperation,
): TProposalOperation {
  const common = {
    operation_id: operation.operation_id,
    baseline_snapshot_hash: "0".repeat(64),
    reason: "保存済み復旧計画",
    confidence: 1,
    evidence_refs: [{ kind: "user_message", locator: "recovery-plan" }],
  };
  if (operation.operation === "create_task") {
    if (operation.temporary_ref == null || typeof operation.expected_after !== "object" || operation.expected_after == null) {
      throw new Error("create_taskの復旧計画が不正です。");
    }
    const parent = "parent" in operation.expected_after ? operation.expected_after.parent : undefined;
    if (parent == null) {
      return parse({
        ...common,
        operation: "create_task",
        basis: "inferred",
        temporary_ref: operation.temporary_ref,
        creation: { kind: "single_task" },
        before: operation.expected_before,
        after: operation.expected_after,
      });
    }
    return parse({
      ...common,
      operation: "create_task",
      basis: "explicit",
      temporary_ref: operation.temporary_ref,
      creation: {
        kind: "split_child",
        parent,
        instruction_reference: { kind: "user_message", locator: "recovery-plan" },
      },
      before: operation.expected_before,
      after: operation.expected_after,
    });
  }
  if (operation.target == null) {
    throw new Error("復旧計画の操作対象がありません。");
  }
  if (operation.operation === "complete" || operation.operation === "withdraw") {
    return parse({
      ...common,
      operation: operation.operation,
      basis: "explicit",
      target: operation.target,
      before: operation.expected_before,
      after: operation.expected_after,
      status_evidence: {
        kind: "user_explicit",
        reference: { kind: "user_message", locator: "recovery-plan" },
      },
    });
  }
  return parse({
    ...common,
    operation: operation.operation,
    basis: "inferred",
    target: operation.target,
    before: operation.expected_before,
    after: operation.expected_after,
  });
}

type BaselineSourcePorts<TOperation extends ProposalOperation, TData> = {
  readonly getJournal: (proposalId: string, operationId: string) => { readonly plan?: unknown } | undefined;
  readonly hasPlan: (journal: { readonly plan?: unknown }) => boolean;
  readonly usesCustomExternalData: (operation: TOperation) => boolean;
  readonly targetGid: (operation: TOperation, mappings: ReadonlyMap<string, string>) => string | undefined;
  readonly parseStored: (baseline: BaselineExternal) => { readonly external_gid: string; readonly data: TData };
};

/** 書き込み前に保存するCustom external data基準の由来を確定します。 */
export function baselineSourceForOperation<TOperation extends ProposalOperation, TData>(
  proposalId: string,
  context: OperationContext<TOperation>,
  contexts: readonly OperationContext<TOperation>[],
  applicableOperationIds: ReadonlySet<string>,
  mappings: ReadonlyMap<string, string>,
  baselines: ReadonlyMap<string, BaselineExternal>,
  ports: BaselineSourcePorts<TOperation, TData>,
): BaselineSource<TData> {
  const operation = context.operation;
  if (!ports.usesCustomExternalData(operation)) {
    return { kind: "not_used" };
  }
  if (operation.operation === "create_task") {
    throw new Error("create_taskから既存タスクのbaseline sourceを構築できません。");
  }
  if (operation.target == null) {
    throw new Error("適用基準の対象がありません。");
  }
  if (operation.target.kind === "temporary") {
    const temporaryRef = operation.target.ref;
    const createContext = contexts.find(
      (candidate) => candidate.operation.operation === "create_task"
        && candidate.operation.temporary_ref === temporaryRef,
    );
    if (createContext != null) {
      const createJournal = ports.getJournal(proposalId, createContext.operation.operation_id);
      if (
        applicableOperationIds.has(createContext.operation.operation_id)
        || (createJournal != null && ports.hasPlan(createJournal))
      ) {
        return {
          kind: "created_task",
          create_operation_id: createContext.operation.operation_id,
          temporary_ref: temporaryRef,
        };
      }
    }
  }
  const taskGid = ports.targetGid(operation, mappings);
  if (taskGid == null) {
    throw new Error("適用基準の対象task GIDを解決できません。");
  }
  const baseline = baselines.get(taskGid);
  if (baseline == null) {
    throw new Error("選択操作の適用基準外部データがありません。");
  }
  const stored = ports.parseStored(baseline);
  return { kind: "stored", external_gid: stored.external_gid, data: stored.data };
}
