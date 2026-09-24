import assert from "node:assert/strict";
import { test } from "node:test";
import {
  maximumProposalWorkspaceResponseBytes,
  proposalOperationSchema,
  proposalSchema,
  type ProposalOperation,
  type ProposalWorkspaceBatch,
  type ProposalWorkspaceRead,
} from "../../../shared/ai";
import {
  ProposalWorkspace,
  ProposalWorkspaceConflictError,
  type ProposalWorkspaceConflictCode,
} from "./service";

const baselineHash = "a".repeat(64);
const workspaceId = "workspace-1";

function createOperation(
  operationId: string,
  hash: string,
  after: string,
): ProposalOperation {
  return proposalOperationSchema.parse({
    operation: "update_notes",
    operation_id: operationId,
    baseline_snapshot_hash: hash,
    reason: "メモを更新する",
    basis: "inferred",
    confidence: 0.8,
    evidence_refs: [{ kind: "user_message", locator: "source:1" }],
    target: { kind: "existing", gid: "task-1" },
    before: "",
    after,
  });
}

function readAll(
  workspace: ProposalWorkspace,
  target: ProposalWorkspaceRead["target"],
): string {
  let offset = 0;
  let content = "";
  while (true) {
    const result = workspace.read({
      workspace_id: workspaceId,
      revision: workspace.getStatus().revision,
      target,
      offset,
    });
    assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= maximumProposalWorkspaceResponseBytes);
    content += result.content;
    if (result.next_offset == null) {
      return content;
    }
    assert.ok(result.next_offset > offset);
    offset = result.next_offset;
  }
}

function expectConflict(run: () => unknown, code: ProposalWorkspaceConflictCode): void {
  let caught: unknown;
  try {
    run();
  } catch (error: unknown) {
    caught = error;
  }
  assert.ok(caught instanceof ProposalWorkspaceConflictError);
  assert.equal(caught.code, code);
}

void test("分割編集で初回の大きな案を構築し、完成後に封印する", () => {
  const workspace = new ProposalWorkspace({
    workspace_id: workspaceId,
    baseline_snapshot_hash: baselineHash,
  });
  assert.equal(workspace.getStatus().completion, "incomplete");
  const first = workspace.applyBatch({
    workspace_id: workspaceId,
    edit_batch_id: "batch-1",
    expected_revision: 0,
    edits: [
      { kind: "set_title", title: "変更案" },
      { kind: "insert_group", group_id: "group-1", atomic: false },
    ],
  });
  assert.equal(first.completion, "incomplete");
  const largeNotes = "😀".repeat(16_384);
  workspace.applyBatch({
    workspace_id: workspaceId,
    edit_batch_id: "batch-2",
    expected_revision: 1,
    edits: [{
      kind: "insert_operation",
      group_id: "group-1",
      operation: createOperation("operation-1", baselineHash, largeNotes),
    }],
  });
  const ready = workspace.applyBatch({
    workspace_id: workspaceId,
    edit_batch_id: "batch-3",
    expected_revision: 2,
    edits: [{
      kind: "insert_operation",
      group_id: "group-1",
      operation: createOperation("operation-2", baselineHash, largeNotes),
    }],
  });
  assert.equal(ready.completion, "structurally_complete");
  const proposal = proposalSchema.parse(JSON.parse(readAll(workspace, { kind: "proposal" })));
  assert.deepEqual(proposal.groups[0]?.operations.map(
    (operation) => operation.operation_id,
  ), ["operation-1", "operation-2"]);
  const tooLarge: ProposalWorkspaceBatch = {
    workspace_id: workspaceId,
    edit_batch_id: "batch-4",
    expected_revision: 3,
    edits: [{
      kind: "replace_all",
      proposal: {
        title: "変更案",
        groups: [{
          group_id: "group-1",
          atomic: false,
          operations: [
            createOperation("operation-1", baselineHash, largeNotes),
            createOperation("operation-2", baselineHash, largeNotes),
          ],
        }],
      },
    }],
  };
  assert.throws(() => workspace.applyBatch(tooLarge), /128 KiB/);
  assert.equal(workspace.getStatus().revision, 3);
  const submitted = workspace.submit({
    workspace_id: workspaceId,
    expected_revision: 3,
  }, (proposal) => ({ kind: "valid", proposal, value: "検証済み" }));
  assert.equal(submitted.kind, "submitted");
  assert.equal(workspace.getStatus().state, "submitted");
  assert.throws(() => workspace.applyBatch({
    workspace_id: workspaceId,
    edit_batch_id: "batch-5",
    expected_revision: 3,
    edits: [{ kind: "set_title", title: "別案" }],
  }), /提出済み/);
});

void test("構造エラーはバッチ全体を戻し、同一内容の再送は同じ結果を返す", () => {
  const workspace = new ProposalWorkspace({
    workspace_id: workspaceId,
    baseline_snapshot_hash: baselineHash,
  });
  const batch: ProposalWorkspaceBatch = {
    workspace_id: workspaceId,
    edit_batch_id: "batch-1",
    expected_revision: 0,
    edits: [{ kind: "insert_group", group_id: "group-1", atomic: true }],
  };
  const accepted = workspace.applyBatch(batch);
  assert.deepEqual(workspace.applyBatch(batch), accepted);
  assert.equal(workspace.getStatus().revision, 1);
  assert.throws(() => workspace.applyBatch({
    ...batch,
    edits: [{ kind: "insert_group", group_id: "group-2", atomic: true }],
  }), /異なる編集内容/);
  assert.throws(() => workspace.applyBatch({
    workspace_id: workspaceId,
    edit_batch_id: "batch-2",
    expected_revision: 1,
    edits: [
      { kind: "insert_group", group_id: "group-2", atomic: true },
      { kind: "insert_group", group_id: "group-2", atomic: true },
    ],
  }), /重複/);
  assert.equal(workspace.getStatus().revision, 1);
  const summary = readAll(workspace, { kind: "summary" });
  assert.match(summary, /"group_id":"group-1"/u);
  assert.doesNotMatch(summary, /"group_id":"group-2"/u);
  workspace.applyBatch({
    workspace_id: workspaceId,
    edit_batch_id: "batch-3",
    expected_revision: 1,
    edits: [{
      kind: "insert_operation",
      group_id: "group-1",
      operation: createOperation("operation-1", baselineHash, "内容"),
    }],
  });
  assert.throws(() => workspace.applyBatch({
    workspace_id: workspaceId,
    edit_batch_id: "batch-4",
    expected_revision: 2,
    edits: [{
      kind: "replace_operation",
      operation_id: "operation-1",
      operation: createOperation("operation-2", baselineHash, "内容"),
    }],
  }), /operation_idを変更できません/);
  assert.equal(workspace.getStatus().revision, 2);
});

void test("基準不一致と意味検証エラーを保持し、同じdraftを修正できる", () => {
  const workspace = new ProposalWorkspace({
    workspace_id: workspaceId,
    baseline_snapshot_hash: baselineHash,
  });
  workspace.applyBatch({
    workspace_id: workspaceId,
    edit_batch_id: "batch-1",
    expected_revision: 0,
    edits: [
      { kind: "set_title", title: "変更案" },
      { kind: "insert_group", group_id: "group-1", atomic: false },
      {
        kind: "insert_operation",
        group_id: "group-1",
        operation: createOperation("operation-1", "b".repeat(64), "内容"),
      },
    ],
  });
  assert.equal(workspace.getStatus().completion, "incomplete");
  assert.equal(workspace.submit({ workspace_id: workspaceId, expected_revision: 1 },
    (proposal) => ({ kind: "valid", proposal, value: true })).kind, "invalid");
  assert.equal(workspace.getStatus().state, "draft");
  workspace.applyBatch({
    workspace_id: workspaceId,
    edit_batch_id: "batch-2",
    expected_revision: 1,
    edits: [{
      kind: "replace_operation",
      operation_id: "operation-1",
      operation: createOperation("operation-1", baselineHash, "内容"),
    }],
  });
  const rejected = workspace.submit({ workspace_id: workspaceId, expected_revision: 2 },
    (proposal) => {
      proposal.title = "別案";
      return {
        kind: "invalid",
        issues: [{ code: "meaning", json_pointer: "/groups/0", message: "意味を確認できません。" }],
      };
    });
  assert.equal(rejected.kind, "invalid");
  assert.equal(workspace.getStatus().state, "draft");
  assert.match(readAll(workspace, { kind: "summary" }), /"title":"変更案"/u);
  const accepted = workspace.submit({ workspace_id: workspaceId, expected_revision: 2 },
    (proposal) => ({ kind: "valid", proposal, value: true }));
  assert.equal(accepted.kind, "submitted");
});

void test("前案を新しいターンの基準へ結び直せる", () => {
  const previous = proposalSchema.parse({
    title: "前案",
    groups: [{
      group_id: "group-1",
      atomic: false,
      operations: [createOperation("operation-1", baselineHash, "前案の内容")],
    }],
  });
  const newBaselineHash = "b".repeat(64);
  const workspace = new ProposalWorkspace({
    workspace_id: "new-turn",
    baseline_snapshot_hash: newBaselineHash,
    initial_proposal: previous,
  });
  assert.equal(workspace.getStatus().completion, "incomplete");
  assert.equal(workspace.getStatus().revision, 0);
  const status = workspace.applyBatch({
    workspace_id: "new-turn",
    edit_batch_id: "rebind",
    expected_revision: 0,
    edits: [{
      kind: "replace_operation",
      operation_id: "operation-1",
      operation: createOperation("operation-1", newBaselineHash, "新案の内容"),
    }],
  });
  assert.equal(status.completion, "structurally_complete");
  assert.equal(previous.groups[0]?.operations[0]?.baseline_snapshot_hash, baselineHash);
});

void test("読み取りと意味差分を改訂番号へ固定して64 KiB以内で分割する", () => {
  const workspace = new ProposalWorkspace({
    workspace_id: workspaceId,
    baseline_snapshot_hash: baselineHash,
  });
  workspace.applyBatch({
    workspace_id: workspaceId,
    edit_batch_id: "batch-1",
    expected_revision: 0,
    edits: [
      { kind: "set_title", title: "変更案" },
      { kind: "insert_group", group_id: "group-1", atomic: false },
      {
        kind: "insert_operation",
        group_id: "group-1",
        operation: createOperation("operation-1", baselineHash, "😀".repeat(16_384)),
      },
    ],
  });
  const operation = proposalOperationSchema.parse(JSON.parse(readAll(workspace, {
    kind: "operation",
    operation_id: "operation-1",
  })));
  assert.equal(operation.operation, "update_notes");
  if (operation.operation !== "update_notes") {
    throw new Error("更新操作を読み取れませんでした。");
  }
  assert.equal(operation.after, "😀".repeat(16_384));
  const firstRead = workspace.read({
    workspace_id: workspaceId,
    revision: 1,
    target: { kind: "operation", operation_id: "operation-1" },
  });
  assert.ok(firstRead.next_offset != null);
  let offset = 0;
  let diff = "";
  let diffChunkCount = 0;
  while (true) {
    const result = workspace.diff({
      workspace_id: workspaceId,
      from_revision: 0,
      revision: 1,
      offset,
    });
    assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= maximumProposalWorkspaceResponseBytes);
    diff += result.content;
    diffChunkCount += 1;
    if (result.next_offset == null) {
      break;
    }
    offset = result.next_offset;
  }
  assert.ok(diffChunkCount > 1);
  assert.doesNotThrow(() => JSON.parse(diff));
  assert.match(diff, /"kind":"operation"/u);
  assert.throws(() => workspace.read({
    workspace_id: workspaceId,
    revision: 0,
    target: { kind: "summary" },
  }), /改訂番号/);
});

void test("validateはdraftを封印せず、操作別invalidを含む検証結果を返せる", () => {
  const workspace = new ProposalWorkspace({
    workspace_id: workspaceId,
    baseline_snapshot_hash: baselineHash,
  });
  const incomplete = workspace.validate({
    workspace_id: workspaceId,
    expected_revision: 0,
  }, () => {
    throw new Error("不完全な案を意味検証へ渡してはいけません。");
  });
  assert.equal(incomplete.kind, "invalid");
  workspace.applyBatch({
    workspace_id: workspaceId,
    edit_batch_id: "batch-1",
    expected_revision: 0,
    edits: [
      { kind: "set_title", title: "変更案" },
      { kind: "insert_group", group_id: "group-1", atomic: false },
      {
        kind: "insert_operation",
        group_id: "group-1",
        operation: createOperation("operation-1", baselineHash, "内容"),
      },
    ],
  });
  const operationResults = [{ operation_id: "operation-1", kind: "invalid" }];
  const validated = workspace.validate({
    workspace_id: workspaceId,
    expected_revision: 1,
  }, (proposal) => ({ kind: "valid", proposal, value: operationResults }));
  assert.equal(validated.kind, "valid");
  if (validated.kind !== "valid") {
    throw new Error("完成案を検証できませんでした。");
  }
  assert.deepEqual(validated.value, operationResults);
  assert.equal(workspace.getStatus().state, "draft");
  assert.equal(workspace.getStatus().revision, 1);
  const rejected = workspace.validate({
    workspace_id: workspaceId,
    expected_revision: 1,
  }, () => ({
    kind: "invalid",
    issues: [{ code: "evidence_invalid", json_pointer: "/groups/0/operations/0", message: "根拠を確認できません。" }],
  }));
  assert.equal(rejected.kind, "invalid");
  assert.equal(workspace.getStatus().state, "draft");
  const submitted = workspace.submit({
    workspace_id: workspaceId,
    expected_revision: 1,
  }, (proposal) => ({ kind: "valid", proposal, value: operationResults }));
  assert.equal(submitted.kind, "submitted");
});

void test("改訂番号、バッチID、ワークスペース状態の競合を型付きで判別できる", () => {
  const workspace = new ProposalWorkspace({
    workspace_id: workspaceId,
    baseline_snapshot_hash: baselineHash,
  });
  const batch: ProposalWorkspaceBatch = {
    workspace_id: workspaceId,
    edit_batch_id: "batch-1",
    expected_revision: 0,
    edits: [
      { kind: "set_title", title: "変更案" },
      { kind: "insert_group", group_id: "group-1", atomic: false },
      {
        kind: "insert_operation",
        group_id: "group-1",
        operation: createOperation("operation-1", baselineHash, "内容"),
      },
    ],
  };
  const accepted = workspace.applyBatch(batch);
  expectConflict(() => workspace.read({
    workspace_id: "different-workspace",
    revision: 1,
    target: { kind: "summary" },
  }), "workspace_mismatch");
  expectConflict(() => workspace.applyBatch({
    workspace_id: workspaceId,
    edit_batch_id: "batch-2",
    expected_revision: 0,
    edits: [{ kind: "set_title", title: "別案" }],
  }), "revision_mismatch");
  expectConflict(() => workspace.applyBatch({
    ...batch,
    edits: [{ kind: "set_title", title: "別案" }],
  }), "edit_batch_id_reused");
  assert.equal(workspace.getStatus().revision, 1);
  const submitted = workspace.submit({
    workspace_id: workspaceId,
    expected_revision: 1,
  }, (proposal) => ({ kind: "valid", proposal, value: null }));
  assert.equal(submitted.kind, "submitted");
  expectConflict(() => workspace.validate({
    workspace_id: workspaceId,
    expected_revision: 1,
  }, (proposal) => ({ kind: "valid", proposal, value: null })), "state_mismatch");
  assert.deepEqual(workspace.applyBatch(batch), accepted);
});
