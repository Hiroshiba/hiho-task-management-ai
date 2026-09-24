import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import {
  externalAgentErrorResponseSchema,
  externalAgentProposalApplyEditsInputSchema,
  externalAgentProposalDiffResponseSchema,
  externalAgentProposalPrepareResponseSchema,
  externalAgentProposalReadResponseSchema,
  externalAgentProposalStatusResponseSchema,
  externalAgentProposalSubmitInputSchema,
  externalAgentProposalSubmitResponseSchema,
  externalAgentProposalValidateResponseSchema,
  externalAgentProtocolVersion,
  externalAgentRequestInputSchema,
  externalAgentResponseSchema,
} from "../../shared/external-agent/schemas";

const binding = {
  instance_id: "instance-1",
  context_id: "context-1",
  project_gid: "project-1",
  proposal_context_id: "proposal-context-1",
  workspace_id: "workspace-1",
};

void test("版3の操作は固定した文脈とワークスペースを必須にする", () => {
  assert.equal(externalAgentProtocolVersion, 3);
  assert.equal(JSON.stringify(
    z.toJSONSchema(externalAgentRequestInputSchema, { target: "draft-07" }),
  ).includes("proposals.submit"), true);
  const read = {
    operation: "proposals.read",
    ...binding,
    revision: 0,
    target: { kind: "summary" },
    offset: 0,
  };
  assert.equal(externalAgentRequestInputSchema.safeParse(read).success, true);
  assert.equal(externalAgentRequestInputSchema.safeParse({
    ...read,
    workspace_id: undefined,
  }).success, false);
  assert.equal(externalAgentRequestInputSchema.safeParse({
    ...read,
    path: "/tmp/draft.json",
  }).success, false);
  assert.equal(externalAgentProposalSubmitInputSchema.safeParse({
    operation: "proposals.submit",
    ...binding,
    request_id: "submit-1",
    expected_revision: 1,
  }).success, true);
  assert.equal(externalAgentProposalSubmitInputSchema.safeParse({
    operation: "proposals.submit",
    ...binding,
    expected_revision: 1,
  }).success, false);
});

void test("編集バッチは改訂番号と冪等キーを必須にする", () => {
  const edit = {
    operation: "proposals.apply-edits",
    ...binding,
    edit_batch_id: "batch-1",
    expected_revision: 0,
    edits: [{ kind: "set_title", title: "変更案" }],
  };
  assert.equal(externalAgentProposalApplyEditsInputSchema.safeParse(edit).success, true);
  assert.equal(externalAgentProposalApplyEditsInputSchema.safeParse({
    ...edit,
    edit_batch_id: undefined,
  }).success, false);
  assert.equal(externalAgentProposalApplyEditsInputSchema.safeParse({
    ...edit,
    edits: [{ kind: "remove_operation", operation_id: "operation-1", path: "/tmp/draft.json" }],
  }).success, false);
});

void test("準備応答には最初のワークスペース版を含める", () => {
  const prepared = {
    operation: "proposals.prepare",
    request_id: "prepare-1",
    proposal_context_id: "proposal-context-1",
    workspace_id: "workspace-1",
    revision: 0,
    turn_context: {
      baseline_snapshot_hash: "a".repeat(64),
      app_version: "1.0.0",
      project_gid: "project-1",
      synced_at: "2026-09-25T00:00:00Z",
      as_of: "2026-09-25T00:00:00Z",
    },
    evidence_locator_prefix: "external-review:proposal-context-1",
  };
  assert.equal(externalAgentProposalPrepareResponseSchema.safeParse(prepared).success, true);
  assert.equal(externalAgentProposalPrepareResponseSchema.safeParse({
    ...prepared,
    revision: 1,
  }).success, false);
});

void test("読み取りと差分の続きは進む位置だけを受け付ける", () => {
  const read = {
    operation: "proposals.read",
    workspace_id: "workspace-1",
    revision: 2,
    target: { kind: "proposal" },
    offset: 0,
    content: "{\"title\":",
    next_offset: 9,
  };
  assert.equal(externalAgentProposalReadResponseSchema.safeParse(read).success, true);
  assert.equal(externalAgentProposalReadResponseSchema.safeParse({
    ...read,
    next_offset: 0,
  }).success, false);
  assert.equal(externalAgentProposalDiffResponseSchema.safeParse({
    operation: "proposals.diff",
    workspace_id: "workspace-1",
    revision: 2,
    from_revision: 1,
    offset: 0,
    content: "[]",
  }).success, true);
  assert.equal(externalAgentProposalDiffResponseSchema.safeParse({
    operation: "proposals.diff",
    workspace_id: "workspace-1",
    revision: 2,
    from_revision: 3,
    offset: 0,
    content: "[]",
  }).success, false);
  assert.equal(externalAgentProposalReadResponseSchema.safeParse({
    ...read,
    content: "\\".repeat(33_000),
    next_offset: undefined,
  }).success, false);
});

void test("検証応答は提出可否と操作ごとのレビューを分けて返す", () => {
  const reviewed = {
    operation: "proposals.validate",
    workspace_id: "workspace-1",
    revision: 2,
    can_submit: true,
    review: {
      kind: "operations",
      offset: 0,
      operation_count: 2,
      entry_count: 3,
      entries: [{
        kind: "operation",
        group_id: "group-1",
        operation_id: "operation-1",
        basic: { kind: "valid" },
        graph: { kind: "valid" },
        eligible: true,
      }],
      next_offset: 1,
    },
  };
  assert.equal(externalAgentProposalValidateResponseSchema.safeParse(reviewed).success, true);
  assert.equal(externalAgentResponseSchema.safeParse(reviewed).success, true);
  assert.equal(externalAgentProposalValidateResponseSchema.safeParse({
    ...reviewed,
    review: { ...reviewed.review, next_offset: 2 },
  }).success, false);
  assert.equal(externalAgentProposalValidateResponseSchema.safeParse({
    ...reviewed,
    review: { ...reviewed.review, entries: [], next_offset: 0 },
  }).success, false);
  const incomplete = {
    operation: "proposals.validate",
    workspace_id: "workspace-1",
    revision: 2,
    can_submit: false,
    review: {
      kind: "issues",
      offset: 0,
      issue_count: 1,
      issues: [{ code: "proposal_schema_invalid", json_pointer: "/title", message: "タイトルが必要です。", message_truncated: false }],
    },
  };
  assert.equal(externalAgentProposalValidateResponseSchema.safeParse(incomplete).success, true);
  assert.equal(externalAgentProposalValidateResponseSchema.safeParse({
    ...incomplete,
    can_submit: true,
  }).success, false);
});

void test("提出応答は受付結果だけを返し、完全な変更案を含めない", () => {
  const submitted = {
    operation: "proposals.submit",
    workspace_id: "workspace-1",
    revision: 2,
    result: {
      kind: "submitted",
      proposal_id: "proposal-1",
      request_id: "submit-1",
      operation_count: 1,
      state_kind: "pending_approval",
    },
  };
  assert.equal(externalAgentProposalSubmitResponseSchema.safeParse(submitted).success, true);
  assert.equal(externalAgentResponseSchema.safeParse(submitted).success, true);
  assert.equal(externalAgentProposalSubmitResponseSchema.safeParse({
    ...submitted,
    proposal: { title: "変更案", groups: [] },
  }).success, false);
  assert.equal(externalAgentProposalSubmitResponseSchema.safeParse({
    ...submitted,
    result: { kind: "invalid" },
  }).success, true);
});

void test("提案状態は表示用の変更案を含まず、操作IDと適用状態を返す", () => {
  const current = {
    operation: "proposals.status",
    proposal_id: "proposal-1",
    operation_ids: ["operation-1"],
    result: {
      kind: "current",
      proposal: {
        proposal_id: "proposal-1",
        request_id: "submit-1",
        instance_id: "instance-1",
        context_id: "context-1",
        proposal_context_id: "proposal-context-1",
        operation_ids: ["operation-1"],
        revision: 1,
        source: "external_tool",
        state: { kind: "pending_approval" },
      },
    },
  };
  assert.equal(externalAgentProposalStatusResponseSchema.safeParse(current).success, true);
  assert.equal(externalAgentProposalStatusResponseSchema.safeParse({
    ...current,
    result: {
      ...current.result,
      proposal: { ...current.result.proposal, view: { proposal_id: "proposal-1" } },
    },
  }).success, false);
  const finished = externalAgentProposalStatusResponseSchema.parse({
    ...current,
    result: {
      ...current.result,
      proposal: {
        ...current.result.proposal,
        state: {
          kind: "finished",
          result: {
            proposal_id: "proposal-1",
            application: {
              outcome: "applied",
              operations: [{
                group_id: "group-1",
                operation_id: "operation-1",
                outcome: "applied",
                reason_code: "applied",
              }],
              groups: [{
                group_id: "group-1",
                atomic: false,
                outcome: "applied",
                operation_ids: ["operation-1"],
              }],
            },
          },
        },
      },
    },
  });
  assert.equal(finished.result.kind, "current");
  if (finished.result.kind !== "current") {
    throw new Error("現在の提案が返りませんでした。");
  }
  assert.equal(finished.result.proposal.state.kind, "finished");
  if (finished.result.proposal.state.kind !== "finished") {
    throw new Error("適用結果が返りませんでした。");
  }
  assert.equal(finished.result.proposal.state.result.application.operations[0]?.outcome, "applied");
});

void test("版競合だけが現在の改訂番号を返す", () => {
  const stale = {
    kind: "error",
    code: "stale_revision",
    message: "改訂番号が古くなりました。",
    current_revision: 3,
  };
  assert.equal(externalAgentErrorResponseSchema.safeParse(stale).success, true);
  assert.equal(externalAgentErrorResponseSchema.safeParse({
    ...stale,
    current_revision: undefined,
  }).success, false);
  assert.equal(externalAgentErrorResponseSchema.safeParse({
    ...stale,
    code: "invalid_request",
  }).success, false);
});
