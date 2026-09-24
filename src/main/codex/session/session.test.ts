import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { dynamicToolCallResponseSchema } from "../app-server";
import { ProposalWorkspace } from "../../ai/proposal-workspace";
import { CodexSessionService } from "./session";

function createSession(): CodexSessionService {
  return new CodexSessionService({
    codexExecutablePath: "/tmp/codex",
    workspacePath: "/tmp/taskhub-codex-workspace",
    agentsFilePath: "/tmp/taskhub-codex-workspace/AGENTS.md",
    tmpDirectoryPath: "/tmp/taskhub-codex-workspace/tmp",
    expectedCodexHomePathProvider: () => "/tmp/taskhub-codex-home",
    obsidianReader: {
      listVaults: () => Promise.resolve([]),
      listNotes: () => Promise.resolve([]),
      searchNotes: () => Promise.resolve([]),
      readNote: () => Promise.reject(new Error("ノートは試験しません。")),
      recentNotes: () => Promise.resolve([]),
    },
    readOnlyVaultPaths: [],
    connectionFactory: () => {
      throw new Error("接続は試験しません。");
    },
    onError: () => {},
    snapshotProvider: () => ({
      sync: { kind: "unavailable" },
      tasks: [],
      ranking: { kind: "unavailable" },
    }),
    syncBeforeTurn: () => {},
  });
}

function callWorkspaceTool(
  session: CodexSessionService,
  argumentsValue: unknown,
  turnId: string,
): z.infer<typeof dynamicToolCallResponseSchema> {
  const handler: unknown = Reflect.get(session, "handleProposalWorkspaceTool");
  if (typeof handler !== "function") {
    throw new Error("ワークスペースツールが見つかりません。");
  }
  return dynamicToolCallResponseSchema.parse(Reflect.apply(handler, session, [{
    threadId: "thread-1",
    turnId,
    callId: "call-1",
    namespace: null,
    tool: "proposal_workspace",
    arguments: argumentsValue,
  }, new AbortController().signal]));
}

function responseJson(response: z.infer<typeof dynamicToolCallResponseSchema>): unknown {
  const item = response.contentItems[0];
  if (item?.type !== "inputText") {
    throw new Error("ワークスペースツールの応答がありません。");
  }
  assert.ok(Buffer.byteLength(item.text, "utf8") <= 64 * 1024);
  return JSON.parse(item.text);
}

void test("現在ターンのdynamic toolで編集、検証、提出し、別ターンの要求を拒否する", () => {
  const session = createSession();
  const workspace = new ProposalWorkspace({
    workspace_id: "workspace-1",
    baseline_snapshot_hash: "a".repeat(64),
  });
  Reflect.set(session, "activeTurn", { phase: "starting" });
  session.activateProposalWorkspace(workspace, (proposal) => ({
    kind: "valid",
    proposal,
    value: null,
  }));
  Reflect.set(session, "activeTurn", {
    phase: "running",
    threadId: "thread-1",
    turnId: "turn-1",
    signal: new AbortController().signal,
    abortRequested: false,
  });
  Reflect.set(session, "threadId", "thread-1");
  const edit = callWorkspaceTool(session, {
    action: "edit",
    workspace_id: workspace.workspaceId,
    edit_batch_id: "batch-1",
    expected_revision: 0,
    edits: [{
      kind: "replace_all",
      proposal: {
        title: "変更案",
        groups: [{
          group_id: "group-1",
          atomic: false,
          operations: [{
            operation: "update_notes",
            operation_id: "operation-1",
            baseline_snapshot_hash: workspace.baselineSnapshotHash,
            reason: "本文を更新する",
            basis: "explicit",
            confidence: 1,
            evidence_refs: [{ kind: "user_message", locator: "user-message:request" }],
            target: { kind: "existing", gid: "task-1" },
            before: "",
            after: "更新後",
          }],
        }],
      },
    }],
  }, "turn-1");
  assert.equal(edit.success, true);
  assert.equal(workspace.getStatus().revision, 1);
  const read = callWorkspaceTool(session, {
    action: "read",
    workspace_id: workspace.workspaceId,
    revision: 1,
    target: { kind: "summary" },
  }, "turn-1");
  assert.equal(read.success, true);
  assert.ok(responseJson(read) != null);
  const validate = callWorkspaceTool(session, {
    action: "validate",
    workspace_id: workspace.workspaceId,
    expected_revision: 1,
  }, "turn-1");
  assert.equal(validate.success, true);
  assert.ok(responseJson(validate) != null);
  const submit = callWorkspaceTool(session, {
    action: "submit",
    workspace_id: workspace.workspaceId,
    expected_revision: 1,
  }, "turn-1");
  assert.equal(submit.success, true);
  assert.equal(workspace.getStatus().state, "submitted");
  assert.ok(responseJson(submit) != null);
  assert.throws(() => callWorkspaceTool(session, {
    action: "read",
    workspace_id: workspace.workspaceId,
    revision: 1,
    target: { kind: "summary" },
  }, "turn-old"), /ターンが不正/u);
  assert.throws(() => callWorkspaceTool(session, {
    action: "read",
    workspace_id: "workspace-old",
    revision: 1,
    target: { kind: "summary" },
  }, "turn-1"), /今回のターン以外/u);
  const oversized = callWorkspaceTool(session, {
    action: "read",
    workspace_id: workspace.workspaceId,
    revision: 1,
    target: { kind: "summary" },
    padding: "x".repeat(128 * 1024),
  }, "turn-1");
  assert.equal(oversized.success, false);
  assert.ok(responseJson(oversized) != null);
});

void test("大量の不備があっても編集結果と改訂番号を返し、不備を分割して取得できる", () => {
  const session = createSession();
  const workspace = new ProposalWorkspace({
    workspace_id: "workspace-1",
    baseline_snapshot_hash: "a".repeat(64),
  });
  Reflect.set(session, "activeTurn", { phase: "starting" });
  session.activateProposalWorkspace(workspace, (proposal) => ({
    kind: "valid",
    proposal,
    value: null,
  }));
  Reflect.set(session, "activeTurn", {
    phase: "running",
    threadId: "thread-1",
    turnId: "turn-1",
    signal: new AbortController().signal,
    abortRequested: false,
  });
  Reflect.set(session, "threadId", "thread-1");
  const groups = Array.from({ length: 4 }, (_, groupIndex) => ({
    group_id: `group-${groupIndex}`,
    atomic: false,
    operations: Array.from({ length: 64 }, (_, operationIndex) => ({
      operation: "update_notes",
      operation_id: `operation-${groupIndex}-${operationIndex}-${"x".repeat(120)}`,
      baseline_snapshot_hash: "b".repeat(64),
      reason: "本文を更新する",
      basis: "explicit",
      confidence: 1,
      evidence_refs: [{ kind: "user_message", locator: "user-message:request" }],
      target: { kind: "existing", gid: "task-1" },
      before: "",
      after: "更新後",
    })),
  }));
  const edit = callWorkspaceTool(session, {
    action: "edit",
    workspace_id: workspace.workspaceId,
    edit_batch_id: "batch-1",
    expected_revision: 0,
    edits: [{ kind: "replace_all", proposal: { title: "変更案", groups } }],
  }, "turn-1");
  assert.equal(edit.success, true);
  const result = z.object({
    workspace_id: z.string(),
    revision: z.number(),
    issues: z.array(z.unknown()),
    next_offset: z.number().optional(),
  }).parse(responseJson(edit));
  assert.equal(result.revision, 1);
  assert.equal(result.workspace_id, workspace.workspaceId);
  assert.ok(result.next_offset != null);
  let offset: number | undefined = result.next_offset;
  let issueCount = result.issues.length;
  while (offset != null) {
    const validate = callWorkspaceTool(session, {
      action: "validate",
      workspace_id: workspace.workspaceId,
      expected_revision: result.revision,
      offset,
    }, "turn-1");
    assert.equal(validate.success, false);
    const page = z.object({
      revision: z.number(),
      issues: z.array(z.unknown()),
      next_offset: z.number().optional(),
    }).parse(responseJson(validate));
    assert.equal(page.revision, 1);
    assert.ok(page.issues.length > 0);
    issueCount += page.issues.length;
    offset = page.next_offset;
  }
  assert.equal(issueCount, workspace.getStatus().issues.length);
});
