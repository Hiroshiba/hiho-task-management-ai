import { proposalOperationKindSchema, proposalOperationSchema, proposalViewSchema, type ProposalViewDto } from "../../../shared/ipc-contracts/proposal-values";

type ProposalOperation = ProposalViewDto["groups"][number]["operations"][number];

const baselineHash = "0".repeat(64);
const target = { kind: "existing", gid: "mock-task-1" };
const absent = { kind: "absent" };
const note = { vault_id: "mock-vault", path: "notes/focus.md", title: "集中タスク", confidence: 1 };
const dependency = { target: { kind: "existing", gid: "mock-task-2" }, scope: "full", source: "mock-source" };

function mockOperation(kind: ProposalOperation["operation"], prefix: string): ProposalOperation {
  const operation_id = `${prefix}-${kind}`;
  const evidence = { kind: "user_message", locator: `${prefix}-request`, excerpt: "画面確認用の変更依頼です。" };
  const common = {
    operation_id,
    baseline_snapshot_hash: baselineHash,
    reason: "画面確認用の変更案です。",
    basis: "explicit",
    confidence: 1,
    evidence_refs: [evidence],
  };
  switch (kind) {
    case "create_task":
      return proposalOperationSchema.parse({ ...common, operation: kind, temporary_ref: `${prefix}-created`, creation: { kind: "single_task" }, before: absent, after: { title: "新しいタスク" } });
    case "update_title":
      return proposalOperationSchema.parse({ ...common, operation: kind, target, before: "集中タスク", after: "集中タスクを整理" });
    case "update_notes":
      return proposalOperationSchema.parse({ ...common, operation: kind, target, before: "変更前のメモ", after: "変更後のメモ" });
    case "set_status":
      return proposalOperationSchema.parse({ ...common, operation: kind, target, before: "not_started", after: "in_progress" });
    case "set_importance":
      return proposalOperationSchema.parse({ ...common, operation: kind, target, before: 3, after: 4 });
    case "set_due":
      return proposalOperationSchema.parse({ ...common, operation: kind, target, before: absent, after: { kind: "due_on", due_on: "2026-10-01" } });
    case "clear_due":
      return proposalOperationSchema.parse({ ...common, operation: kind, target, before: { kind: "due_on", due_on: "2026-10-01" }, after: absent });
    case "set_duration":
      return proposalOperationSchema.parse({ ...common, operation: kind, target, before: absent, after: { value: 2, unit: "hour" } });
    case "clear_duration":
      return proposalOperationSchema.parse({ ...common, operation: kind, target, before: { value: 2, unit: "hour" }, after: absent });
    case "set_area":
      return proposalOperationSchema.parse({ ...common, operation: kind, target, before: "開発", after: "調査" });
    case "set_dependencies":
      return proposalOperationSchema.parse({ ...common, operation: kind, target, before: [], after: [dependency] });
    case "set_parent":
      return proposalOperationSchema.parse({ ...common, operation: kind, target, before: absent, after: { kind: "existing", gid: "mock-task-2" } });
    case "set_parent_work_mode":
      return proposalOperationSchema.parse({ ...common, operation: kind, target, before: "unknown", after: "has_own_work" });
    case "link_obsidian":
      return proposalOperationSchema.parse({ ...common, operation: kind, target, before: absent, after: note });
    case "unlink_obsidian":
      return proposalOperationSchema.parse({ ...common, operation: kind, target, before: note, after: absent });
    case "complete":
      return proposalOperationSchema.parse({ ...common, operation: kind, target, before: "in_progress", after: "completed", status_evidence: { kind: "user_explicit", reference: evidence } });
    case "withdraw":
      return proposalOperationSchema.parse({ ...common, operation: kind, target, before: "not_started", after: "withdrawn", status_evidence: { kind: "user_explicit", reference: evidence } });
  }
}

/** 17操作を含む画面確認用の変更案を作成します。 */
export function createMockProposalView(proposalId: string, revision: number | undefined): ProposalViewDto {
  const operations = proposalOperationKindSchema.options.map((kind) => mockOperation(kind, proposalId));
  const groupId = `${proposalId}-group`;
  const validation = {
    operations: operations.map((operation) => ({ kind: "valid", group_id: groupId, operation_id: operation.operation_id })),
    groups: [{ group_id: groupId, atomic: false, applicable: true, operation_ids: operations.map((operation) => operation.operation_id) }],
  };
  return proposalViewSchema.parse({
    proposal_id: proposalId,
    ...(revision == null ? {} : { revision }),
    baseline_snapshot_hash: baselineHash,
    title: "画面確認用の変更案",
    groups: [{ group_id: groupId, atomic: false, operations }],
    basic_validation: validation,
    graph_validation: validation,
    selected_operation_ids: [operations[1]?.operation_id, operations[7]?.operation_id].filter((value) => value != null),
    impact: { impacted_task_count: 0, impacted_task_gids: [], rank_changes: [] },
  });
}

/** 編集後の操作値を公開表示契約で検証します。 */
export function editMockProposalView(
  view: ProposalViewDto,
  operationId: string,
  operationKind: ProposalOperation["operation"],
  after: unknown,
  evidenceLocator: string,
  evidenceKind: "user_message" | "external_review",
): ProposalViewDto {
  let found = false;
  const groups = view.groups.map((group) => ({
    ...group,
    operations: group.operations.map((operation) => {
      if (operation.operation_id !== operationId) return operation;
      if (operation.operation !== operationKind) throw new Error("編集対象の操作種別が一致しません。");
      found = true;
      return proposalOperationSchema.parse({
        ...operation,
        after,
        basis: "explicit",
        confidence: 1,
        evidence_refs: [...operation.evidence_refs, { kind: evidenceKind, locator: evidenceLocator }],
      });
    }),
  }));
  if (!found) throw new Error("編集対象の操作がありません。");
  return proposalViewSchema.parse({ ...view, groups });
}
