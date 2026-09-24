import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import {
  externalAgentProposalApplyEditsInputSchema,
  externalAgentProposalDiffResponseSchema,
  externalAgentProposalPrepareResponseSchema,
  externalAgentProposalReadResponseSchema,
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
      operation_reviews: [{
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
  const incomplete = {
    operation: "proposals.validate",
    workspace_id: "workspace-1",
    revision: 2,
    can_submit: false,
    review: {
      kind: "issues",
      offset: 0,
      issue_count: 1,
      issues: [{ code: "proposal_schema_invalid", json_pointer: "/title", message: "タイトルが必要です。" }],
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
