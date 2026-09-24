import assert from "node:assert/strict";
import { test } from "node:test";
import { proposalOperationSchema, proposalSchema } from "../../shared/ai";
import { aiWorkflowSnapshotSchema } from "../../shared/ai-workflow";
import { getUtf8ByteLength, taskSchema, type Task } from "../../shared/domain";
import {
  externalAgentErrorResponseSchema,
  externalAgentInfoResponseSchema,
  externalAgentProposalApplyEditsResponseSchema,
  externalAgentProposalDiffResponseSchema,
  externalAgentProposalPrepareResponseSchema,
  externalAgentProposalReadResponseSchema,
  externalAgentProposalStatusResponseSchema,
  externalAgentProposalSubmitResponseSchema,
  externalAgentProposalValidateResponseSchema,
  maximumWorkspaceCliResponseBytes,
  type ExternalAgentProposalPrepareResponse,
} from "../../shared/external-agent";
import { taskctlSnapshotSchema } from "../codex/taskctl";
import { externalAgentMaxResponseBytes } from "./transport-schemas";
import { createBaselineSnapshot } from "../ai/workflow";
import { ExternalAgentService, type ExternalAgentServiceOptions } from "./service";

const instanceId = "instance-1";
const projectGid = "project-1";
const sourceText = "追加する。メモを変える。完了する。";

function createService(tasks: readonly Task[]): { service: ExternalAgentService; baselineCalls: () => number } {
  const snapshot = aiWorkflowSnapshotSchema.parse({
    app_version: "app-1",
    project_gid: projectGid,
    synced_at: "2026-09-25T00:00:00.000Z",
    as_of: "2026-09-25T00:00:00.000Z",
    tasks,
    areas: tasks.length === 0 ? [] : ["未分類"],
  });
  const baseline = createBaselineSnapshot(snapshot);
  const taskctl = taskctlSnapshotSchema.parse({
    sync: { kind: "synced", synced_at: snapshot.synced_at },
    tasks,
    ranking: { kind: "unavailable" },
  });
  let baselineCalls = 0;
  const options: ExternalAgentServiceOptions = {
    app_version: "app-1",
    instance_id: instanceId,
    lifecycle_signal: new AbortController().signal,
    now_provider: () => new Date("2026-09-25T00:00:00.000Z"),
    online_provider: () => true,
    get_taskctl_snapshot: () => taskctl,
    operation_queue: {
      enqueue: () => { throw new Error("承認前に適用してはいけません。"); },
      invalidatePendingMutations: () => {},
    },
    get_runtime_state: () => undefined,
    create_baseline: () => {
      baselineCalls += 1;
      return {
        snapshot,
        baseline_snapshot: baseline,
        baseline_external_data: [],
        taskctl_snapshot: taskctl,
      };
    },
    prepare_approval_input: () => { throw new Error("承認前に適用してはいけません。"); },
    apply_proposal: () => { throw new Error("承認前に適用してはいけません。"); },
    get_journal: () => undefined,
    assert_apply_ready: () => {},
    open_review: () => {},
    bridge: {
      getState: () => ({ kind: "running", enabled: true }),
      getRegistration: () => ({ symlinkCommand: "登録", allowExecutionCommand: "実行許可" }),
      setEnabled: () => Promise.resolve(),
      stop: () => Promise.resolve(),
    },
  };
  const service = new ExternalAgentService(options);
  service.configureContext({ project_gid: projectGid, source_key: "account-1" });
  return { service, baselineCalls: () => baselineCalls };
}

async function prepare(service: ExternalAgentService): Promise<{
  readonly prepared: ExternalAgentProposalPrepareResponse;
  readonly binding: {
    readonly instance_id: string;
    readonly context_id: string;
    readonly project_gid: string;
    readonly proposal_context_id: string;
    readonly workspace_id: string;
  };
}> {
  const signal = new AbortController().signal;
  const info = externalAgentInfoResponseSchema.parse(await service.handleRequest({ operation: "agent-info" }, signal));
  if (info.context.kind !== "ready") {
    throw new Error("Asana文脈が設定されていません。");
  }
  const prepared = externalAgentProposalPrepareResponseSchema.parse(await service.handleRequest({
    operation: "proposals.prepare",
    instance_id: instanceId,
    context_id: info.context.context_id,
    project_gid: projectGid,
    request_id: "prepare-1",
    source_text: sourceText,
  }, signal));
  return {
    prepared,
    binding: {
      instance_id: instanceId,
      context_id: info.context.context_id,
      project_gid: projectGid,
      proposal_context_id: prepared.proposal_context_id,
      workspace_id: prepared.workspace_id,
    },
  };
}

function createOperation(
  prepared: ExternalAgentProposalPrepareResponse,
  operationId: string,
  excerpt: string,
  after: string,
): ReturnType<typeof proposalOperationSchema.parse> {
  return proposalOperationSchema.parse({
    operation: "create_task",
    operation_id: operationId,
    baseline_snapshot_hash: prepared.turn_context.baseline_snapshot_hash,
    reason: "依頼されたタスクを追加する",
    basis: "explicit",
    confidence: 1,
    evidence_refs: [{
      kind: "external_review",
      locator: `${prepared.evidence_locator_prefix}:${operationId}`,
      excerpt,
    }],
    temporary_ref: `task-${operationId}`,
    creation: { kind: "single_task" },
    before: { kind: "absent" },
    after: { title: after, duration: { value: 1, unit: "hour" } },
  });
}

void test("固定した基準の案を編集し、GUIへ部分採用として公開する", async () => {
  const { service, baselineCalls } = createService([]);
  const { prepared, binding } = await prepare(service);
  const signal = new AbortController().signal;
  const repeated = externalAgentProposalPrepareResponseSchema.parse(await service.handleRequest({
    operation: "proposals.prepare",
    instance_id: instanceId,
    context_id: binding.context_id,
    project_gid: projectGid,
    request_id: "prepare-1",
    source_text: sourceText,
  }, signal));
  assert.deepEqual(repeated, prepared);
  assert.equal(baselineCalls(), 1);
  const valid = createOperation(prepared, "operation-1", "追加する", "追加するタスク");
  const invalid = proposalOperationSchema.parse({
    operation: "update_notes",
    operation_id: "operation-2",
    baseline_snapshot_hash: prepared.turn_context.baseline_snapshot_hash,
    reason: "メモを変える",
    basis: "explicit",
    confidence: 1,
    evidence_refs: [{
      kind: "external_review",
      locator: `${prepared.evidence_locator_prefix}:operation-2`,
      excerpt: "メモを変える",
    }],
    target: { kind: "existing", gid: "missing-task" },
    before: "",
    after: "変更後",
  });
  const proposal = proposalSchema.parse({
    title: "変更案",
    groups: [{ group_id: "group-1", atomic: false, operations: [valid, invalid] }],
  });
  const edited = externalAgentProposalApplyEditsResponseSchema.parse(await service.handleRequest({
    operation: "proposals.apply-edits",
    ...binding,
    edit_batch_id: "batch-1",
    expected_revision: 0,
    edits: [{ kind: "replace_all", proposal }],
  }, signal));
  assert.equal(edited.revision, 1);
  const reviewed = externalAgentProposalValidateResponseSchema.parse(await service.handleRequest({
    operation: "proposals.validate",
    ...binding,
    expected_revision: 1,
  }, signal));
  assert.equal(reviewed.can_submit, true);
  assert.equal(reviewed.review.kind, "operations");
  if (reviewed.review.kind !== "operations") {
    throw new Error("操作別検証が返りませんでした。");
  }
  assert.deepEqual(reviewed.review.entries.filter((entry) => entry.kind === "operation")
    .map((entry) => entry.eligible), [true, false]);
  const submitted = externalAgentProposalSubmitResponseSchema.parse(await service.handleRequest({
    operation: "proposals.submit",
    ...binding,
    request_id: "submit-1",
    expected_revision: 1,
  }, signal));
  assert.equal(submitted.result.kind, "submitted");
  const state = service.getState();
  assert.equal(state.proposals.length, 1);
  assert.deepEqual(state.proposals[0]?.view.selected_operation_ids, ["operation-1"]);
  assert.equal(state.proposals[0]?.state.kind, "pending_approval");
  const current = state.proposals[0];
  if (current == null) {
    throw new Error("GUIの提案がありません。");
  }
  const status = externalAgentProposalStatusResponseSchema.parse(await service.handleRequest({
    operation: "proposals.status",
    proposal_id: current.proposal_id,
    operation_ids: current.operation_ids,
  }, signal));
  assert.equal(status.result.kind, "current");
  assert.deepEqual(externalAgentProposalSubmitResponseSchema.parse(await service.handleRequest({
    operation: "proposals.submit",
    ...binding,
    request_id: "submit-1",
    expected_revision: 1,
  }, signal)), submitted);
  const reused = externalAgentErrorResponseSchema.parse(await service.handleRequest({
    operation: "proposals.submit",
    ...binding,
    request_id: "submit-1",
    expected_revision: 2,
  }, signal));
  assert.equal(reused.code, "request_id_reused");
  const sealed = externalAgentErrorResponseSchema.parse(await service.handleRequest({
    operation: "proposals.apply-edits",
    ...binding,
    edit_batch_id: "batch-2",
    expected_revision: 1,
    edits: [{ kind: "set_title", title: "別案" }],
  }, signal));
  assert.equal(sealed.code, "conflict");
});

void test("不正編集を原子的に拒否し、版違いと文脈違いを区別する", async () => {
  const { service } = createService([]);
  const { binding } = await prepare(service);
  const signal = new AbortController().signal;
  const bad = externalAgentErrorResponseSchema.parse(await service.handleRequest({
    operation: "proposals.apply-edits",
    ...binding,
    edit_batch_id: "bad-batch",
    expected_revision: 0,
    edits: [
      { kind: "insert_group", group_id: "group-1", atomic: false },
      { kind: "insert_group", group_id: "group-1", atomic: true },
    ],
  }, signal));
  assert.equal(bad.code, "invalid_request");
  const first = externalAgentProposalApplyEditsResponseSchema.parse(await service.handleRequest({
    operation: "proposals.apply-edits",
    ...binding,
    edit_batch_id: "batch-1",
    expected_revision: 0,
    edits: [{ kind: "set_title", title: "変更案" }],
  }, signal));
  assert.equal(first.revision, 1);
  const stale = externalAgentErrorResponseSchema.parse(await service.handleRequest({
    operation: "proposals.apply-edits",
    ...binding,
    edit_batch_id: "batch-2",
    expected_revision: 0,
    edits: [{ kind: "set_title", title: "別案" }],
  }, signal));
  assert.equal(stale.code, "stale_revision");
  assert.equal(stale.current_revision, 1);
  const resynced = externalAgentProposalReadResponseSchema.parse(await service.handleRequest({
    operation: "proposals.read",
    ...binding,
    revision: stale.current_revision,
    target: { kind: "summary" },
  }, signal));
  assert.equal(resynced.revision, 1);
  const replay = externalAgentProposalApplyEditsResponseSchema.parse(await service.handleRequest({
    operation: "proposals.apply-edits",
    ...binding,
    edit_batch_id: "batch-1",
    expected_revision: 0,
    edits: [{ kind: "set_title", title: "変更案" }],
  }, signal));
  assert.deepEqual(replay, first);
  const changedBatch = externalAgentErrorResponseSchema.parse(await service.handleRequest({
    operation: "proposals.apply-edits",
    ...binding,
    edit_batch_id: "batch-1",
    expected_revision: 0,
    edits: [{ kind: "set_title", title: "別案" }],
  }, signal));
  assert.equal(changedBatch.code, "request_id_reused");
  const mismatch = externalAgentErrorResponseSchema.parse(await service.handleRequest({
    operation: "proposals.read",
    ...binding,
    workspace_id: "other-workspace",
    revision: 1,
    target: { kind: "summary" },
  }, signal));
  assert.equal(mismatch.code, "context_mismatch");
  const invalidOffset = externalAgentErrorResponseSchema.parse(await service.handleRequest({
    operation: "proposals.read",
    ...binding,
    revision: 1,
    target: { kind: "summary" },
    offset: 100_000,
  }, signal));
  assert.equal(invalidOffset.code, "invalid_request");
  const invalidDiff = externalAgentErrorResponseSchema.parse(await service.handleRequest({
    operation: "proposals.diff",
    ...binding,
    from_revision: 2,
    revision: 1,
  }, signal));
  assert.equal(invalidDiff.code, "invalid_request");
  const legacy = externalAgentErrorResponseSchema.parse(await service.handleRequest({
    operation: "proposals.create",
    ...binding,
    request_id: "old-submit",
    proposal: { title: "旧形式", groups: [] },
  }, signal));
  assert.equal(legacy.code, "invalid_request");
  service.expireForContextChange();
  const expired = externalAgentErrorResponseSchema.parse(await service.handleRequest({
    operation: "proposals.read",
    ...binding,
    revision: 1,
    target: { kind: "summary" },
  }, signal));
  assert.equal(expired.code, "context_mismatch");
});

void test("原文根拠不足を修正して提出し、検証結果を50件単位で読む", async () => {
  const { service } = createService([]);
  const { prepared, binding } = await prepare(service);
  const signal = new AbortController().signal;
  const operations = Array.from({ length: 55 }, (_, index) =>
    createOperation(prepared, `operation-${index}`, "追加する", `タスク${index}`));
  operations[0] = proposalOperationSchema.parse({
    ...operations[0],
    evidence_refs: [{ kind: "user_message", locator: "source:1" }],
  });
  const proposal = proposalSchema.parse({
    title: "多数の変更案",
    groups: [{ group_id: "group-1", atomic: false, operations }],
  });
  externalAgentProposalApplyEditsResponseSchema.parse(await service.handleRequest({
    operation: "proposals.apply-edits",
    ...binding,
    edit_batch_id: "batch-1",
    expected_revision: 0,
    edits: [{ kind: "replace_all", proposal }],
  }, signal));
  const incomplete = externalAgentProposalValidateResponseSchema.parse(await service.handleRequest({
    operation: "proposals.validate",
    ...binding,
    expected_revision: 1,
  }, signal));
  assert.equal(incomplete.can_submit, false);
  assert.equal(incomplete.review.kind, "issues");
  const refused = externalAgentProposalSubmitResponseSchema.parse(await service.handleRequest({
    operation: "proposals.submit",
    ...binding,
    request_id: "submit-invalid",
    expected_revision: 1,
  }, signal));
  assert.equal(refused.result.kind, "invalid");
  const fixed = externalAgentProposalApplyEditsResponseSchema.parse(await service.handleRequest({
    operation: "proposals.apply-edits",
    ...binding,
    edit_batch_id: "batch-2",
    expected_revision: 1,
    edits: [{ kind: "replace_operation", operation_id: "operation-0",
      operation: createOperation(prepared, "operation-0", "追加する", "タスク0") }],
  }, signal));
  assert.equal(fixed.revision, 2);
  const first = externalAgentProposalValidateResponseSchema.parse(await service.handleRequest({
    operation: "proposals.validate",
    ...binding,
    expected_revision: 2,
  }, signal));
  assert.equal(first.can_submit, true);
  assert.equal(first.review.kind, "operations");
  if (first.review.kind !== "operations") {
    throw new Error("操作別検証が返りませんでした。");
  }
  assert.equal(first.review.entries.length, 50);
  assert.equal(first.review.next_offset, 50);
  const second = externalAgentProposalValidateResponseSchema.parse(await service.handleRequest({
    operation: "proposals.validate",
    ...binding,
    expected_revision: 2,
    offset: first.review.next_offset,
  }, signal));
  assert.equal(second.review.kind, "operations");
  if (second.review.kind !== "operations") {
    throw new Error("操作別検証が返りませんでした。");
  }
  assert.equal(second.review.entries.length, 5);
  const submitted = externalAgentProposalSubmitResponseSchema.parse(await service.handleRequest({
    operation: "proposals.submit",
    ...binding,
    request_id: "submit-valid",
    expected_revision: 2,
  }, signal));
  assert.equal(submitted.result.kind, "submitted");
});

void test("完了操作の明示根拠を操作単位で検証する", async () => {
  const task = taskSchema.parse({
    gid: "task-1",
    title: "対象タスク",
    notes: "",
    status: "not_started",
    importance: 3,
    area: "未分類",
    block_state: "none",
    parent_work_mode: "unknown",
    section_gid: "section-1",
    completed: false,
    tags: [],
    child_gids: [],
    dependencies: [],
    obsidian_links: [],
    activity_anchor_on: "2026-09-25",
  });
  const { service } = createService([task]);
  const { prepared, binding } = await prepare(service);
  const signal = new AbortController().signal;
  const locator = `${prepared.evidence_locator_prefix}:operation-1`;
  const reference = { kind: "external_review", locator, excerpt: "完了する" };
  const operation = proposalOperationSchema.parse({
    operation: "complete",
    operation_id: "operation-1",
    baseline_snapshot_hash: prepared.turn_context.baseline_snapshot_hash,
    reason: "完了を依頼された",
    basis: "explicit",
    confidence: 1,
    evidence_refs: [reference],
    target: { kind: "existing", gid: task.gid },
    before: task.status,
    after: "completed",
    status_evidence: {
      kind: "external_review_explicit",
      reference: { ...reference, excerpt: "追加する" },
    },
  });
  const proposal = proposalSchema.parse({
    title: "完了案",
    groups: [{ group_id: "group-1", atomic: false, operations: [operation] }],
  });
  externalAgentProposalApplyEditsResponseSchema.parse(await service.handleRequest({
    operation: "proposals.apply-edits",
    ...binding,
    edit_batch_id: "batch-1",
    expected_revision: 0,
    edits: [{ kind: "replace_all", proposal }],
  }, signal));
  const invalid = externalAgentProposalValidateResponseSchema.parse(await service.handleRequest({
    operation: "proposals.validate",
    ...binding,
    expected_revision: 1,
  }, signal));
  assert.equal(invalid.can_submit, false);
  assert.equal(invalid.review.kind, "issues");
  if (invalid.review.kind !== "issues") {
    throw new Error("根拠検証結果が返りませんでした。");
  }
  assert.equal(invalid.review.issues[0]?.code, "external_status_evidence_invalid");
  externalAgentProposalApplyEditsResponseSchema.parse(await service.handleRequest({
    operation: "proposals.apply-edits",
    ...binding,
    edit_batch_id: "batch-2",
    expected_revision: 1,
    edits: [{
      kind: "replace_operation",
      operation_id: "operation-1",
      operation: proposalOperationSchema.parse({
        ...operation,
        status_evidence: { kind: "external_review_explicit", reference },
      }),
    }],
  }, signal));
  const valid = externalAgentProposalValidateResponseSchema.parse(await service.handleRequest({
    operation: "proposals.validate",
    ...binding,
    expected_revision: 2,
  }, signal));
  assert.equal(valid.can_submit, true);
  assert.equal(valid.review.kind, "operations");
  const submitted = externalAgentProposalSubmitResponseSchema.parse(await service.handleRequest({
    operation: "proposals.submit",
    ...binding,
    request_id: "submit-1",
    expected_revision: 2,
  }, signal));
  assert.equal(submitted.result.kind, "submitted");
});

void test("大きな変更案と差分を応答上限内で読み切る", async () => {
  const { service } = createService([]);
  const { prepared, binding } = await prepare(service);
  const signal = new AbortController().signal;
  const large = createOperation(prepared, "operation-1", "追加する", "大きなタスク");
  if (large.operation !== "create_task") {
    throw new Error("作成操作が返りませんでした。");
  }
  const proposal = proposalSchema.parse({
    title: "大きな変更案",
    groups: [{
      group_id: "group-1",
      atomic: false,
      operations: [proposalOperationSchema.parse({
        ...large,
        after: { ...large.after, notes: "😀".repeat(16_384) },
      })],
    }],
  });
  externalAgentProposalApplyEditsResponseSchema.parse(await service.handleRequest({
    operation: "proposals.apply-edits",
    ...binding,
    edit_batch_id: "batch-large",
    expected_revision: 0,
    edits: [{ kind: "replace_all", proposal }],
  }, signal));
  let offset = 0;
  let content = "";
  let pageCount = 0;
  while (true) {
    const page = externalAgentProposalReadResponseSchema.parse(await service.handleRequest({
      operation: "proposals.read",
      ...binding,
      revision: 1,
      target: { kind: "proposal" },
      offset,
    }, signal));
    assert.ok(getUtf8ByteLength(JSON.stringify(page)) <= maximumWorkspaceCliResponseBytes);
    content += page.content;
    pageCount += 1;
    if (page.next_offset == null) {
      break;
    }
    assert.ok(page.next_offset > offset);
    offset = page.next_offset;
  }
  assert.ok(pageCount > 1);
  assert.deepEqual(proposalSchema.parse(JSON.parse(content)), proposal);
  offset = 0;
  content = "";
  pageCount = 0;
  while (true) {
    const page = externalAgentProposalDiffResponseSchema.parse(await service.handleRequest({
      operation: "proposals.diff",
      ...binding,
      from_revision: 0,
      revision: 1,
      offset,
    }, signal));
    assert.ok(getUtf8ByteLength(JSON.stringify(page)) <= maximumWorkspaceCliResponseBytes);
    content += page.content;
    pageCount += 1;
    if (page.next_offset == null) {
      break;
    }
    offset = page.next_offset;
  }
  assert.ok(pageCount > 1);
  assert.equal(Array.isArray(JSON.parse(content)), true);
});

void test("大きな提出済み案も操作IDと適用状態を照会できる", async () => {
  const { service } = createService([]);
  const { prepared, binding } = await prepare(service);
  const signal = new AbortController().signal;
  externalAgentProposalApplyEditsResponseSchema.parse(await service.handleRequest({
    operation: "proposals.apply-edits",
    ...binding,
    edit_batch_id: "batch-initialize",
    expected_revision: 0,
    edits: [
      { kind: "set_title", title: "大きな変更案" },
      { kind: "insert_group", group_id: "group-1", atomic: false },
    ],
  }, signal));
  for (let index = 0; index < 40; index += 1) {
    const operation = createOperation(prepared, `operation-${index}`, "追加する", `タスク${index}`);
    if (operation.operation !== "create_task") {
      throw new Error("作成操作が返りませんでした。");
    }
    const edited = externalAgentProposalApplyEditsResponseSchema.parse(await service.handleRequest({
      operation: "proposals.apply-edits",
      ...binding,
      edit_batch_id: `batch-${index}`,
      expected_revision: index + 1,
      edits: [{
        kind: "insert_operation",
        group_id: "group-1",
        operation: proposalOperationSchema.parse({
          ...operation,
          after: { ...operation.after, notes: "😀".repeat(16_000) },
        }),
      }],
    }, signal));
    assert.equal(edited.revision, index + 2);
  }
  const submitted = externalAgentProposalSubmitResponseSchema.parse(await service.handleRequest({
    operation: "proposals.submit",
    ...binding,
    request_id: "submit-large",
    expected_revision: 41,
  }, signal));
  if (submitted.result.kind !== "submitted") {
    throw new Error("提案が提出されませんでした。");
  }
  const status = externalAgentProposalStatusResponseSchema.parse(await service.handleRequest({
    operation: "proposals.status",
    proposal_id: submitted.result.proposal_id,
    operation_ids: Array.from({ length: 40 }, (_, index) => `operation-${index}`),
  }, signal));
  assert.ok(getUtf8ByteLength(JSON.stringify(status)) < externalAgentMaxResponseBytes);
  assert.equal(status.result.kind, "current");
  if (status.result.kind !== "current") {
    throw new Error("提案状態が返りませんでした。");
  }
  assert.equal("view" in status.result.proposal, false);
  assert.equal(status.result.proposal.state.kind, "pending_approval");
  assert.equal(status.result.proposal.operation_ids.length, 40);
});

void test("単一操作の大量診断を必ず前進するページで読み切る", async () => {
  const { service } = createService([]);
  const { prepared, binding } = await prepare(service);
  const signal = new AbortController().signal;
  const operation = createOperation(prepared, "operation-1", "追加する", "依存先のあるタスク");
  if (operation.operation !== "create_task") {
    throw new Error("作成操作が返りませんでした。");
  }
  const proposal = proposalSchema.parse({
    title: "依存先の変更案",
    groups: [{
      group_id: "group-1",
      atomic: false,
      operations: [proposalOperationSchema.parse({
        ...operation,
        after: {
          ...operation.after,
          dependencies: Array.from({ length: 64 }, (_, index) => ({
            target: { kind: "existing", gid: `dependency-${index}-${"x".repeat(1_100)}` },
            scope: "full",
            source: "test",
          })),
        },
      })],
    }],
  });
  externalAgentProposalApplyEditsResponseSchema.parse(await service.handleRequest({
    operation: "proposals.apply-edits",
    ...binding,
    edit_batch_id: "batch-1",
    expected_revision: 0,
    edits: [{ kind: "replace_all", proposal }],
  }, signal));
  let offset = 0;
  let pageCount = 0;
  const entries: Array<{ kind: string; code?: string; phase?: string }> = [];
  while (true) {
    const page = externalAgentProposalValidateResponseSchema.parse(await service.handleRequest({
      operation: "proposals.validate",
      ...binding,
      expected_revision: 1,
      offset,
    }, signal));
    assert.ok(getUtf8ByteLength(JSON.stringify(page)) <= maximumWorkspaceCliResponseBytes);
    assert.equal(page.review.kind, "operations");
    if (page.review.kind !== "operations") {
      throw new Error("操作別検証が返りませんでした。");
    }
    entries.push(...page.review.entries);
    pageCount += 1;
    if (page.review.next_offset == null) {
      assert.equal(page.review.entry_count, entries.length);
      break;
    }
    assert.ok(page.review.next_offset > offset);
    offset = page.review.next_offset;
  }
  assert.ok(pageCount > 1);
  assert.equal(entries.filter((entry) => entry.kind === "operation").length, 1);
  assert.equal(entries.filter((entry) => entry.kind === "diagnostic" && entry.code === "dependency_not_managed").length, 128);
  assert.equal(entries.filter((entry) => entry.kind === "diagnostic" && entry.phase === "basic").length, 64);
  assert.equal(entries.filter((entry) => entry.kind === "diagnostic" && entry.phase === "graph").length, 64);
});

void test("長い診断を省略表示してcodeと操作位置を保持する", async () => {
  const { service } = createService([]);
  const { prepared, binding } = await prepare(service);
  const signal = new AbortController().signal;
  const operation = createOperation(prepared, "operation-1", "追加する", "依存先のあるタスク");
  if (operation.operation !== "create_task") {
    throw new Error("作成操作が返りませんでした。");
  }
  const proposal = proposalSchema.parse({
    title: "長い診断の変更案",
    groups: [{
      group_id: "group-1",
      atomic: false,
      operations: [proposalOperationSchema.parse({
        ...operation,
        after: {
          ...operation.after,
          dependencies: [{
            target: { kind: "existing", gid: `dependency-${"x".repeat(5_000)}` },
            scope: "full",
            source: "test",
          }],
        },
      })],
    }],
  });
  externalAgentProposalApplyEditsResponseSchema.parse(await service.handleRequest({
    operation: "proposals.apply-edits",
    ...binding,
    edit_batch_id: "batch-1",
    expected_revision: 0,
    edits: [{ kind: "replace_all", proposal }],
  }, signal));
  const reviewed = externalAgentProposalValidateResponseSchema.parse(await service.handleRequest({
    operation: "proposals.validate",
    ...binding,
    expected_revision: 1,
  }, signal));
  assert.equal(reviewed.review.kind, "operations");
  if (reviewed.review.kind !== "operations") {
    throw new Error("操作別検証が返りませんでした。");
  }
  const decision = reviewed.review.entries.find((entry) => entry.kind === "operation");
  assert.equal(decision?.kind, "operation");
  if (decision?.kind !== "operation") {
    throw new Error("操作の検証判定が返りませんでした。");
  }
  assert.equal(decision.basic.kind, "invalid");
  assert.equal(decision.eligible, false);
  const diagnostic = reviewed.review.entries.find((entry) =>
    entry.kind === "diagnostic" && entry.code === "dependency_not_managed");
  assert.equal(diagnostic?.kind, "diagnostic");
  if (diagnostic?.kind !== "diagnostic") {
    throw new Error("依存先の診断が返りませんでした。");
  }
  assert.equal(diagnostic.group_id, "group-1");
  assert.equal(diagnostic.operation_id, "operation-1");
  assert.equal(diagnostic.message_truncated, true);
  assert.ok(diagnostic.message.endsWith("…"));
  assert.ok(getUtf8ByteLength(diagnostic.message) <= 4 * 1_024);
});
