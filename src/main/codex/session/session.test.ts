import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { dynamicToolCallParamsSchema } from "../app-server/schemas";
import { ProposalWorkspace } from "../../ai/proposal-workspace";
import { initializeCodexWorkspace } from "../workspace/initializer";
import { CodexSessionService } from "./session";

const baselineSnapshotHash = "a".repeat(64);
const diagnosticResponseSchema = z.object({
  ok: z.literal(false),
  error: z.object({
    code: z.literal("invalid_request"),
    message: z.string(),
    issue_count: z.number().int(),
    issues_truncated: z.boolean(),
    issues: z.array(z.object({
      code: z.string(),
      json_pointer: z.string(),
      expected_type: z.string().nullable(),
    })),
  }),
});

function createSession(): {
  service: CodexSessionService;
  workspace: ProposalWorkspace;
  signal: AbortSignal;
} {
  const signal = new AbortController().signal;
  const workspacePath = join(tmpdir(), "taskhub-session-test");
  const workspace = new ProposalWorkspace({
    workspace_id: "workspace-1",
    baseline_snapshot_hash: baselineSnapshotHash,
  });
  const service = new CodexSessionService({
    codexExecutablePath: "codex",
    workspacePath,
    agentsFilePath: join(workspacePath, "AGENTS.md"),
    tmpDirectoryPath: join(workspacePath, "tmp"),
    expectedCodexHomePathProvider: () => "/tmp/taskhub-session-test-home",
    obsidianReader: {
      listVaults: () => { throw new Error("呼び出されません。"); },
      listNotes: () => { throw new Error("呼び出されません。"); },
      searchNotes: () => { throw new Error("呼び出されません。"); },
      readNote: () => { throw new Error("呼び出されません。"); },
      recentNotes: () => { throw new Error("呼び出されません。"); },
    },
    readOnlyVaultPaths: [],
    connectionFactory: () => { throw new Error("呼び出されません。"); },
    onError: () => { throw new Error("呼び出されません。"); },
    snapshotProvider: () => { throw new Error("呼び出されません。"); },
    syncBeforeTurn: () => { throw new Error("呼び出されません。"); },
  });
  Reflect.set(service, "threadId", "thread-1");
  Reflect.set(service, "activeTurn", {
    phase: "running",
    threadId: "thread-1",
    turnId: "turn-1",
    signal,
    abortRequested: false,
  });
  Reflect.set(service, "activeProposalWorkspace", {
    workspace,
    validate: (proposal: unknown) => ({ kind: "valid", proposal, value: null }),
  });
  return { service, workspace, signal };
}

function callWorkspaceTool(
  service: CodexSessionService,
  signal: AbortSignal,
  argumentsValue: unknown,
): { text: string; success: boolean } {
  const params = dynamicToolCallParamsSchema.parse({
    threadId: "thread-1",
    turnId: "turn-1",
    callId: "call-1",
    tool: "proposal_workspace",
    arguments: argumentsValue,
  });
  const response = service["handleProposalWorkspaceTool"](params, signal);
  const item = response.contentItems[0];
  if (item?.type !== "inputText") {
    throw new Error("テキスト応答がありません。");
  }
  return { text: item.text, success: response.success };
}

void test("不正なinsert_groupとreplace_allは位置と期待型を返し改訂番号を進めない", () => {
  const { service, workspace, signal } = createSession();
  const invalidGroup = callWorkspaceTool(service, signal, {
    action: "edit",
    workspace_id: "workspace-1",
    edit_batch_id: "invalid-group",
    expected_revision: 0,
    edits: [{
      kind: "insert_group",
      group_id: "group-1",
      operations: [{ secret: "INPUT_SECRET" }],
      arbitrary_secret_key: "HIDDEN_KEY",
    }],
  });
  const groupDiagnostic = diagnosticResponseSchema.parse(JSON.parse(invalidGroup.text));
  assert.equal(invalidGroup.success, false);
  assert.deepEqual(groupDiagnostic.error.issues, [
    { code: "invalid_type", json_pointer: "/edits/0/atomic", expected_type: "boolean" },
    { code: "unrecognized_keys", json_pointer: "/edits/0", expected_type: null },
  ]);
  assert.equal(groupDiagnostic.error.issue_count, 2);
  assert.equal(groupDiagnostic.error.issues_truncated, false);
  assert.equal(invalidGroup.text.includes("INPUT_SECRET"), false);
  assert.equal(invalidGroup.text.includes("arbitrary_secret_key"), false);
  assert.equal(invalidGroup.text.includes("operations"), false);
  assert.equal(workspace.getStatus().revision, 0);

  const invalidReplacement = callWorkspaceTool(service, signal, {
    action: "edit",
    workspace_id: "workspace-1",
    edit_batch_id: "invalid-replacement",
    expected_revision: 0,
    edits: [{ kind: "replace_all", proposal: { title: "未完成の案" } }],
  });
  const replacementDiagnostic = diagnosticResponseSchema.parse(JSON.parse(invalidReplacement.text));
  assert.equal(invalidReplacement.success, false);
  assert.deepEqual(replacementDiagnostic.error.issues, [
    { code: "invalid_type", json_pointer: "/edits/0/proposal/groups", expected_type: "array" },
  ]);
  assert.equal(workspace.getStatus().revision, 0);
});

void test("大量の入力不備は64 KiB以内で総件数と省略を返す", () => {
  const { service, workspace, signal } = createSession();
  const response = callWorkspaceTool(service, signal, {
    action: "edit",
    workspace_id: "workspace-1",
    edit_batch_id: "many-invalid-edits",
    expected_revision: 0,
    edits: Array.from({ length: 256 }, (_, index) => ({
      kind: "insert_group",
      group_id: `group-${index}`,
      arbitrary_secret_key: `HIDDEN_${index}`,
    })),
  });
  const diagnostic = diagnosticResponseSchema.parse(JSON.parse(response.text));
  assert.equal(response.success, false);
  assert.equal(Buffer.byteLength(response.text, "utf8") <= 64 * 1024, true);
  assert.equal(diagnostic.error.issue_count, 512);
  assert.equal(diagnostic.error.issues_truncated, true);
  assert.equal(diagnostic.error.issues.length, 50);
  assert.equal(response.text.includes("arbitrary_secret_key"), false);
  assert.equal(response.text.includes("HIDDEN_"), false);
  assert.equal(workspace.getStatus().revision, 0);
});

void test("拒否後に分割編集して検証と提出を完了できる", () => {
  const { service, workspace, signal } = createSession();
  const invalid = callWorkspaceTool(service, signal, {
    action: "edit",
    workspace_id: "workspace-1",
    edit_batch_id: "missing-atomic",
    expected_revision: 0,
    edits: [
      { kind: "set_title", title: "適用しないタイトル" },
      { kind: "insert_group", group_id: "group-1" },
    ],
  });
  assert.equal(invalid.success, false);
  assert.equal(workspace.getStatus().revision, 0);
  assert.equal(workspace.read({
    workspace_id: "workspace-1",
    revision: 0,
    target: { kind: "proposal" },
  }).content, '{"groups":[]}');
  const operation = {
    operation: "create_task",
    operation_id: "operation-1",
    baseline_snapshot_hash: baselineSnapshotHash,
    reason: "利用者が新規作成を依頼したため。",
    basis: "explicit",
    confidence: 1,
    evidence_refs: [{ kind: "user_message", locator: "message-1", excerpt: "新しいタスク" }],
    temporary_ref: "new-task-1",
    creation: { kind: "single_task" },
    before: { kind: "absent" },
    after: { title: "新しいタスク", duration: { value: 1, unit: "hour" } },
  };
  const edit = callWorkspaceTool(service, signal, {
    action: "edit",
    workspace_id: "workspace-1",
    edit_batch_id: "valid-edit",
    expected_revision: 0,
    edits: [
      { kind: "set_title", title: "タスクを作成する" },
      { kind: "insert_group", group_id: "group-1", atomic: true },
      { kind: "insert_operation", group_id: "group-1", operation },
    ],
  });
  assert.equal(edit.success, true);
  assert.equal(workspace.getStatus().revision, 1);
  assert.equal(workspace.getStatus().completion, "structurally_complete");
  const validation = callWorkspaceTool(service, signal, {
    action: "validate",
    workspace_id: "workspace-1",
    expected_revision: 1,
  });
  assert.equal(validation.success, true);
  assert.deepEqual(JSON.parse(validation.text), {
    workspace_id: "workspace-1",
    revision: 1,
    valid: true,
  });
  const submission = callWorkspaceTool(service, signal, {
    action: "submit",
    workspace_id: "workspace-1",
    expected_revision: 1,
  });
  assert.equal(submission.success, true);
  assert.deepEqual(JSON.parse(submission.text), {
    kind: "submitted",
    workspace_id: "workspace-1",
    revision: 1,
  });
  assert.equal(workspace.getStatus().state, "submitted");
});

void test("生成AGENTSは入力診断と編集操作の使い分けを案内する", () => {
  const userDataPath = mkdtempSync(join(tmpdir(), "taskhub-workspace-test-"));
  try {
    const result = initializeCodexWorkspace({ userDataPath });
    const content = readFileSync(result.agentsFilePath, "utf8");
    assert.equal(content.includes("issuesのcode、json_pointer、expected_type"), true);
    assert.equal(content.includes("operationsは含めず、各操作をinsert_operation"), true);
    assert.equal(content.includes("replace_allはtitle、groups"), true);
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
  }
});
