import { z } from "zod";
import {
  createUtf8ByteLimitedStringSchema,
  getUtf8ByteLength,
  gidSchema,
  identifierSchema,
  isoDateTimeSchema,
} from "../domain";
import {
  aiWorkflowApprovalResultSchema,
  aiWorkflowOperationEditSchema,
  aiWorkflowProposalViewSchema,
  aiWorkflowSelectionSchema,
  aiWorkflowTurnContextSchema,
} from "../ai-workflow";
import {
  maximumProposalOperations,
  maximumProposalWorkspaceResponseBytes,
  proposalSchema,
  proposalWorkspaceEditSchema,
  proposalWorkspaceReadTargetSchema,
} from "../ai";
import { applicationJournalReadableSchema } from "../storage";
import {
  taskctlResponseSchema,
  taskctlSearchQuerySchema,
} from "../taskctl";

const maximumMessageBytes = 4 * 1_024;
const maximumRegistrationBytes = 4 * 1_024;
const maximumCapabilities = 16;
const maximumProposals = 100;
const maximumWorkspaceCliResponseBytes = maximumProposalWorkspaceResponseBytes - 1_024;
const workspaceRevisionSchema = z.number().int().nonnegative().safe();
const workspaceOffsetSchema = z.number().int().nonnegative().safe();

/** 外部連携プロトコルの版を表す定数です。 */
export const externalAgentProtocolVersion = 3;

const nonBlankMessageSchema = createUtf8ByteLimitedStringSchema(
  maximumMessageBytes,
).refine((value) => value.trim().length > 0, {
  message: "メッセージを空白だけにできません。",
});

const registrationTextSchema = createUtf8ByteLimitedStringSchema(
  maximumRegistrationBytes,
).refine((value) => value.trim().length > 0, {
  message: "登録案内を空白だけにできません。",
});

const uniqueCapabilitiesSchema = z
  .array(z.string())
  .max(maximumCapabilities)
  .superRefine((capabilities, context) => {
    const seen = new Set<string>();
    capabilities.forEach((capability, index) => {
      if (seen.has(capability)) {
        context.addIssue({
          code: "custom",
          path: [index],
          message: "操作名を重複して返せません。",
        });
      }
      seen.add(capability);
    });
  });

const externalAgentCapabilitySchema = z.enum([
  "tasks.list",
  "tasks.get",
  "tasks.rank",
  "tasks.graph",
  "tasks.areas",
  "tasks.search-local",
  "proposals.prepare",
  "proposals.create",
  "proposals.read",
  "proposals.apply-edits",
  "proposals.diff",
  "proposals.validate",
  "proposals.submit",
  "proposals.status",
  "review.open",
]);

const bridgeUnavailableCodeSchema = z.enum([
  "startup_failed",
  "permission_denied",
  "protocol_mismatch",
  "unavailable",
]);

export const externalAgentErrorCodeSchema = z.enum([
  "invalid_request",
  "disabled",
  "context_mismatch",
  "stale_revision",
  "conflict",
  "unavailable",
  "unknown_result",
  "request_id_reused",
  "offline",
  "setup_required",
  "not_found",
  "capacity_exceeded",
  "context_changed",
]);

const proposalContextIdSchema = identifierSchema.optional();

/** 外部連携から取得するタスク一覧の要求を検証するスキーマです。 */
export const externalAgentTaskListInputSchema = z.object({
  operation: z.literal("tasks.list"),
  proposal_context_id: proposalContextIdSchema,
}).strict();

/** 外部連携から取得するタスク詳細の要求を検証するスキーマです。 */
export const externalAgentTaskDetailInputSchema = z.object({
  operation: z.literal("tasks.get"),
  gid: gidSchema,
  proposal_context_id: proposalContextIdSchema,
}).strict();

/** 外部連携から取得する順位情報の要求を検証するスキーマです。 */
export const externalAgentTaskRankInputSchema = z.object({
  operation: z.literal("tasks.rank"),
  proposal_context_id: proposalContextIdSchema,
}).strict();

/** 外部連携から取得するグラフ情報の要求を検証するスキーマです。 */
export const externalAgentTaskGraphInputSchema = z.object({
  operation: z.literal("tasks.graph"),
  proposal_context_id: proposalContextIdSchema,
}).strict();

/** 外部連携から取得する領域一覧の要求を検証するスキーマです。 */
export const externalAgentTaskAreasInputSchema = z.object({
  operation: z.literal("tasks.areas"),
  proposal_context_id: proposalContextIdSchema,
}).strict();

/** 外部連携から取得するローカル検索の要求を検証するスキーマです。 */
export const externalAgentTaskSearchLocalInputSchema = z.object({
  operation: z.literal("tasks.search-local"),
  query: taskctlSearchQuerySchema,
  proposal_context_id: proposalContextIdSchema,
}).strict();

/** 外部連携から提案基準を準備する要求を検証するスキーマです。 */
export const externalAgentProposalPrepareInputSchema = z.object({
  operation: z.literal("proposals.prepare"),
  instance_id: identifierSchema,
  context_id: identifierSchema,
  project_gid: gidSchema,
  request_id: identifierSchema,
  source_text: nonBlankMessageSchema,
}).strict();

/** 外部連携から完全な変更案を提出する要求を検証するスキーマです。 */
export const externalAgentCreateProposalInputSchema = z.object({
  operation: z.literal("proposals.create"),
  instance_id: identifierSchema,
  context_id: identifierSchema,
  project_gid: gidSchema,
  request_id: identifierSchema,
  proposal_context_id: identifierSchema,
  proposal: proposalSchema,
}).strict();

const workspaceBindingSchema = z.object({
  instance_id: identifierSchema,
  context_id: identifierSchema,
  project_gid: gidSchema,
  proposal_context_id: identifierSchema,
  workspace_id: identifierSchema,
}).strict();

/** 外部連携から変更案ワークスペースを部分読み取りする要求を検証するスキーマです。 */
export const externalAgentProposalReadInputSchema = workspaceBindingSchema.safeExtend({
  operation: z.literal("proposals.read"),
  revision: workspaceRevisionSchema,
  target: proposalWorkspaceReadTargetSchema,
  offset: workspaceOffsetSchema.optional(),
}).strict();

/** 外部連携から変更案ワークスペースを編集する要求を検証するスキーマです。 */
export const externalAgentProposalApplyEditsInputSchema = workspaceBindingSchema.safeExtend({
  operation: z.literal("proposals.apply-edits"),
  edit_batch_id: identifierSchema,
  expected_revision: workspaceRevisionSchema,
  edits: z.array(proposalWorkspaceEditSchema).min(1).max(maximumProposalOperations),
}).strict();

/** 外部連携から変更案ワークスペースの差分を読む要求を検証するスキーマです。 */
export const externalAgentProposalDiffInputSchema = workspaceBindingSchema.safeExtend({
  operation: z.literal("proposals.diff"),
  from_revision: workspaceRevisionSchema,
  revision: workspaceRevisionSchema,
  offset: workspaceOffsetSchema.optional(),
}).strict();

/** 外部連携から変更案ワークスペースを検証する要求を検証するスキーマです。 */
export const externalAgentProposalValidateInputSchema = workspaceBindingSchema.safeExtend({
  operation: z.literal("proposals.validate"),
  expected_revision: workspaceRevisionSchema,
  offset: workspaceOffsetSchema.optional(),
}).strict();

/** 外部連携から変更案ワークスペースを提出する要求を検証するスキーマです。 */
export const externalAgentProposalSubmitInputSchema = workspaceBindingSchema.safeExtend({
  operation: z.literal("proposals.submit"),
  request_id: identifierSchema,
  expected_revision: workspaceRevisionSchema,
}).strict();

const uniqueOperationIdsSchema = z.array(identifierSchema).min(1).max(maximumProposalOperations)
  .superRefine((values, context) => {
    const seen = new Set<string>();
    values.forEach((value, index) => {
      if (seen.has(value)) {
        context.addIssue({ code: "custom", path: [index], message: "operation_idを重複指定できません。" });
      }
      seen.add(value);
    });
  });

/** 外部連携から照会する提案の要求を検証するスキーマです。 */
export const externalAgentProposalStatusInputSchema = z.object({
  operation: z.literal("proposals.status"),
  proposal_id: identifierSchema,
  operation_ids: uniqueOperationIdsSchema,
}).strict();

/** 外部連携から確認画面を開く要求を検証するスキーマです。 */
export const externalAgentReviewOpenInputSchema = z
  .object({
    operation: z.literal("review.open"),
    proposal_id: identifierSchema,
  })
  .strict();

/** 外部連携の要求を操作種別ごとに検証するスキーマです。 */
export const externalAgentRequestInputSchema = z.discriminatedUnion("operation", [
  externalAgentTaskListInputSchema,
  externalAgentTaskDetailInputSchema,
  externalAgentTaskRankInputSchema,
  externalAgentTaskGraphInputSchema,
  externalAgentTaskAreasInputSchema,
  externalAgentTaskSearchLocalInputSchema,
  externalAgentProposalPrepareInputSchema,
  externalAgentCreateProposalInputSchema,
  externalAgentProposalReadInputSchema,
  externalAgentProposalApplyEditsInputSchema,
  externalAgentProposalDiffInputSchema,
  externalAgentProposalValidateInputSchema,
  externalAgentProposalSubmitInputSchema,
  externalAgentProposalStatusInputSchema,
  externalAgentReviewOpenInputSchema,
]);

/** CLIのagent-infoまたはrequest入力を検証するスキーマです。 */
export const externalAgentCliInputSchema = z.union([
  z.object({ operation: z.literal("agent-info") }).strict(),
  externalAgentRequestInputSchema,
]);

/** 外部連携の起動状態を検証するスキーマです。 */
export const externalAgentBridgeStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("stopped") }).strict(),
  z.object({ kind: z.literal("running") }).strict(),
  z
    .object({
      kind: z.literal("unavailable"),
      code: bridgeUnavailableCodeSchema,
      message: nonBlankMessageSchema,
    })
    .strict(),
]);

/** 外部連携の同期状態を検証するスキーマです。 */
export const externalAgentSyncStatusSchema = z.enum([
  "synced",
  "syncing",
  "offline",
  "never_synced",
]);

const externalAgentContextSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unconfigured") }).strict(),
  z
    .object({
      kind: z.literal("ready"),
      context_id: identifierSchema,
      project_gid: gidSchema,
    })
    .strict(),
]);

/** 外部連携のagent-info応答を検証するスキーマです。 */
export const externalAgentInfoResponseSchema = z
  .object({
    app_version: identifierSchema,
    protocol_version: z.literal(externalAgentProtocolVersion),
    instance_id: identifierSchema,
    context: externalAgentContextSchema,
    observed_at: isoDateTimeSchema,
    time_zone: registrationTextSchema,
    bridge: externalAgentBridgeStateSchema,
    sync_status: externalAgentSyncStatusSchema,
    last_successful_sync_at: isoDateTimeSchema.optional(),
    capabilities: uniqueCapabilitiesSchema.pipe(
      z.array(externalAgentCapabilitySchema).max(maximumCapabilities),
    ),
    input_schema: z.object({}).passthrough(),
  })
  .strict();

/** 外部連携の提案状態を検証するスキーマです。 */
export const externalAgentProposalStatusSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pending_approval") }).strict(),
  z.object({ kind: z.literal("approving") }).strict(),
  z
    .object({
      kind: z.literal("finished"),
      result: aiWorkflowApprovalResultSchema,
    })
    .strict(),
  z.object({ kind: z.literal("rejected") }).strict(),
  z
    .object({
      kind: z.literal("expired"),
      reason_code: z.enum(["context_changed", "instance_restarted", "superseded"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("failed"),
      reason_code: externalAgentErrorCodeSchema,
      message: nonBlankMessageSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("unknown"),
      reason_code: z.enum([
        "journal_not_found",
        "journal_result_unknown",
        "proposal_not_reconstructed",
      ]),
      message: nonBlankMessageSchema,
    })
    .strict(),
]);

const externalAgentProposalMetadataSchema = z
  .object({
    proposal_id: identifierSchema,
    request_id: identifierSchema,
    instance_id: identifierSchema,
    context_id: identifierSchema,
    proposal_context_id: identifierSchema,
    operation_ids: uniqueOperationIdsSchema,
    revision: z.number().int().positive(),
    source: z.literal("external_tool"),
    state: externalAgentProposalStatusSchema,
  })
  .strict();

/** 外部から提出された提案と既存検証結果を検証するスキーマです。 */
export const externalAgentProposalSchema = z
  .object({
    ...externalAgentProposalMetadataSchema.shape,
    view: aiWorkflowProposalViewSchema,
  })
  .strict()
  .superRefine((proposal, context) => {
    if (proposal.view.proposal_id !== proposal.proposal_id) {
      context.addIssue({
        code: "custom",
        path: ["view", "proposal_id"],
        message: "提案IDと表示用提案IDが一致しません。",
      });
    }
    const operationIds = proposal.view.proposal.groups.flatMap((group) =>
      group.operations.map((operation) => operation.operation_id));
    if (operationIds.length !== proposal.operation_ids.length
      || operationIds.some((operationId, index) => operationId !== proposal.operation_ids[index])) {
      context.addIssue({
        code: "custom",
        path: ["operation_ids"],
        message: "操作IDと表示用提案の操作順が一致しません。",
      });
    }
    if (proposal.state.kind === "finished"
      && proposal.state.result.proposal_id !== proposal.proposal_id) {
      context.addIssue({
        code: "custom",
        path: ["state", "result", "proposal_id"],
        message: "適用結果の提案IDが一致しません。",
      });
    }
  });

/** 外部連携の提案一覧状態を検証するスキーマです。 */
export const externalAgentProposalStatusResultSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("current"),
      proposal: externalAgentProposalSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("journals"),
      results: z.array(z.object({
        operation_id: identifierSchema,
        result: z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("journal"), journal: applicationJournalReadableSchema }).strict(),
          z.object({
            kind: z.literal("unknown"),
            reason_code: z.enum([
              "journal_not_found",
              "journal_result_unknown",
              "proposal_not_reconstructed",
            ]),
            message: nonBlankMessageSchema,
          }).strict(),
        ]),
      }).strict()).max(maximumProposalOperations),
    })
    .strict(),
  z
    .object({
      kind: z.literal("unknown"),
      reason_code: z.enum([
        "journal_not_found",
        "journal_result_unknown",
        "proposal_not_reconstructed",
      ]),
      message: nonBlankMessageSchema,
    })
    .strict(),
]);

/** 外部連携のtaskctl読み取り応答を検証するスキーマです。 */
export const externalAgentTaskQueryResponseSchema = z.object({
  operation: z.enum([
    "tasks.list",
    "tasks.get",
    "tasks.rank",
    "tasks.graph",
    "tasks.areas",
    "tasks.search-local",
  ]),
  proposal_context_id: identifierSchema.optional(),
  result: taskctlResponseSchema,
}).strict();

/** 外部連携の提案基準準備応答を検証するスキーマです。 */
export const externalAgentProposalPrepareResponseSchema = z.object({
  operation: z.literal("proposals.prepare"),
  request_id: identifierSchema,
  proposal_context_id: identifierSchema,
  workspace_id: identifierSchema,
  revision: z.literal(0),
  turn_context: aiWorkflowTurnContextSchema,
  evidence_locator_prefix: nonBlankMessageSchema,
}).strict();

function assertWorkspaceCliResponseSize(value: unknown, context: z.RefinementCtx): void {
  const serialized = JSON.stringify(value);
  if (serialized == null || getUtf8ByteLength(serialized) > maximumWorkspaceCliResponseBytes) {
    context.addIssue({
      code: "custom",
      message: "変更案ワークスペースの応答がサイズ上限を超えています。",
    });
  }
}

const workspaceChunkSchema = z.object({
  workspace_id: identifierSchema,
  revision: workspaceRevisionSchema,
  offset: workspaceOffsetSchema,
  content: createUtf8ByteLimitedStringSchema(maximumWorkspaceCliResponseBytes),
  next_offset: workspaceOffsetSchema.optional(),
}).strict();

/** 外部連携の変更案ワークスペース部分読み取り応答を検証するスキーマです。 */
export const externalAgentProposalReadResponseSchema = workspaceChunkSchema.safeExtend({
  operation: z.literal("proposals.read"),
  target: proposalWorkspaceReadTargetSchema,
}).strict().superRefine((response, context) => {
  if (response.next_offset != null && response.next_offset !== response.offset + response.content.length) {
    context.addIssue({ code: "custom", path: ["next_offset"], message: "次の読み取り位置が内容の末尾と一致しません。" });
  }
  assertWorkspaceCliResponseSize(response, context);
});

/** 外部連携の変更案ワークスペース編集応答を検証するスキーマです。 */
export const externalAgentProposalApplyEditsResponseSchema = z.object({
  operation: z.literal("proposals.apply-edits"),
  workspace_id: identifierSchema,
  revision: workspaceRevisionSchema,
  state: z.literal("draft"),
  completion: z.enum(["incomplete", "structurally_complete"]),
  issue_count: z.number().int().nonnegative().safe(),
}).strict().superRefine(assertWorkspaceCliResponseSize);

/** 外部連携の変更案ワークスペース差分読み取り応答を検証するスキーマです。 */
export const externalAgentProposalDiffResponseSchema = workspaceChunkSchema.safeExtend({
  operation: z.literal("proposals.diff"),
  from_revision: workspaceRevisionSchema,
}).strict().superRefine((response, context) => {
  if (response.from_revision > response.revision) {
    context.addIssue({ code: "custom", path: ["from_revision"], message: "差分の開始改訂番号が現在の改訂番号を超えています。" });
  }
  if (response.next_offset != null && response.next_offset !== response.offset + response.content.length) {
    context.addIssue({ code: "custom", path: ["next_offset"], message: "次の読み取り位置が内容の末尾と一致しません。" });
  }
  assertWorkspaceCliResponseSize(response, context);
});

const workspaceIssueSchema = z.object({
  code: identifierSchema,
  json_pointer: z.string(),
  message: nonBlankMessageSchema,
  group_id: identifierSchema.optional(),
  operation_id: identifierSchema.optional(),
}).strict();

const workspaceReviewErrorSchema = z.object({
  code: identifierSchema,
  message: nonBlankMessageSchema,
}).strict();

const workspaceReviewDecisionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("valid") }).strict(),
  z.object({
    kind: z.literal("invalid"),
    errors: z.array(workspaceReviewErrorSchema).min(1),
  }).strict(),
]);

const workspaceOperationReviewSchema = z.object({
  group_id: identifierSchema,
  operation_id: identifierSchema,
  basic: workspaceReviewDecisionSchema,
  graph: workspaceReviewDecisionSchema,
  eligible: z.boolean(),
}).strict();

const workspaceValidationPageSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("issues"),
    offset: workspaceOffsetSchema,
    issue_count: z.number().int().positive().safe(),
    issues: z.array(workspaceIssueSchema).max(50),
    next_offset: workspaceOffsetSchema.optional(),
  }).strict(),
  z.object({
    kind: z.literal("operations"),
    offset: workspaceOffsetSchema,
    operation_count: z.number().int().positive().safe(),
    operation_reviews: z.array(workspaceOperationReviewSchema).max(50),
    next_offset: workspaceOffsetSchema.optional(),
  }).strict(),
]);

/** 外部連携の変更案ワークスペース検証応答を検証するスキーマです。 */
export const externalAgentProposalValidateResponseSchema = z.object({
  operation: z.literal("proposals.validate"),
  workspace_id: identifierSchema,
  revision: workspaceRevisionSchema,
  can_submit: z.boolean(),
  review: workspaceValidationPageSchema,
}).strict().superRefine((response, context) => {
  if (response.review.kind === "issues" && response.can_submit) {
    context.addIssue({ code: "custom", path: ["can_submit"], message: "未完成の変更案は提出できません。" });
  }
  const count = response.review.kind === "issues"
    ? response.review.issue_count
    : response.review.operation_count;
  const pageLength = response.review.kind === "issues"
    ? response.review.issues.length
    : response.review.operation_reviews.length;
  if (response.review.offset + pageLength > count) {
    context.addIssue({ code: "custom", path: ["review", "offset"], message: "検証結果の位置が件数を超えています。" });
  }
  if (response.review.next_offset == null && response.review.offset + pageLength !== count) {
    context.addIssue({ code: "custom", path: ["review", "next_offset"], message: "検証結果に続きの位置がありません。" });
  }
  if (
    response.review.next_offset != null
    && (
      response.review.next_offset !== response.review.offset + pageLength
      || response.review.next_offset >= count
    )
  ) {
    context.addIssue({ code: "custom", path: ["review", "next_offset"], message: "次の検証結果の位置が一致しません。" });
  }
  assertWorkspaceCliResponseSize(response, context);
});

/** 外部連携の変更案ワークスペース提出応答を検証するスキーマです。 */
export const externalAgentProposalSubmitResponseSchema = z.object({
  operation: z.literal("proposals.submit"),
  workspace_id: identifierSchema,
  revision: workspaceRevisionSchema,
  result: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("submitted"),
      proposal_id: identifierSchema,
      request_id: identifierSchema,
      operation_count: z.number().int().positive().safe(),
      state_kind: z.enum([
        "pending_approval", "approving", "finished", "rejected", "expired", "failed", "unknown",
      ]),
    }).strict(),
    z.object({ kind: z.literal("invalid") }).strict(),
  ]),
}).strict().superRefine(assertWorkspaceCliResponseSize);

/** 外部連携の提案受付応答を検証するスキーマです。 */
export const externalAgentProposalCreateResponseSchema = z
  .object({
    operation: z.literal("proposals.create"),
    proposal: externalAgentProposalSchema,
  })
  .strict();

/** 外部連携の提案状態応答を検証するスキーマです。 */
export const externalAgentProposalStatusResponseSchema = z
  .object({
    operation: z.literal("proposals.status"),
    proposal_id: identifierSchema,
    operation_ids: uniqueOperationIdsSchema,
    result: externalAgentProposalStatusResultSchema,
  })
  .strict()
  .superRefine((response, context) => {
    if (response.result.kind === "current") {
      if (response.result.proposal.proposal_id !== response.proposal_id) {
        context.addIssue({
          code: "custom",
          path: ["result", "proposal", "proposal_id"],
          message: "照会結果の提案IDが要求と一致しません。",
        });
      }
      if (response.result.proposal.operation_ids.length !== response.operation_ids.length
        || response.result.proposal.operation_ids.some((operationId, index) =>
          operationId !== response.operation_ids[index])) {
        context.addIssue({
          code: "custom",
          path: ["result", "proposal", "operation_ids"],
          message: "照会結果の操作ID集合が要求と一致しません。",
        });
      }
      return;
    }
    if (response.result.kind === "journals") {
      const resultIds = response.result.results.map((result) => result.operation_id);
      if (resultIds.length !== response.operation_ids.length
        || resultIds.some((operationId, index) => operationId !== response.operation_ids[index])) {
        context.addIssue({
          code: "custom",
          path: ["result", "results"],
          message: "照会結果の操作ID順が要求と一致しません。",
        });
      }
      response.result.results.forEach((entry, index) => {
        if (entry.result.kind !== "journal") {
          return;
        }
        if (entry.result.journal.proposal_id !== response.proposal_id) {
          context.addIssue({
            code: "custom",
            path: ["result", "results", index, "result", "journal", "proposal_id"],
            message: "ジャーナルの提案IDが照会要求と一致しません。",
          });
        }
        if (entry.result.journal.operation_id !== entry.operation_id) {
          context.addIssue({
            code: "custom",
            path: ["result", "results", index, "result", "journal", "operation_id"],
            message: "ジャーナルの操作IDが照会結果と一致しません。",
          });
        }
      });
    }
  });

/** 外部連携の確認画面要求応答を検証するスキーマです。 */
export const externalAgentReviewOpenResponseSchema = z
  .object({
    operation: z.literal("review.open"),
    proposal_id: identifierSchema,
    request_id: identifierSchema,
    opened: z.literal(true),
  })
  .strict();

/** 外部連携の要求応答を操作種別ごとに検証するスキーマです。 */
export const externalAgentResponseSchema = z.discriminatedUnion("operation", [
  externalAgentTaskQueryResponseSchema,
  externalAgentProposalPrepareResponseSchema,
  externalAgentProposalCreateResponseSchema,
  externalAgentProposalReadResponseSchema,
  externalAgentProposalApplyEditsResponseSchema,
  externalAgentProposalDiffResponseSchema,
  externalAgentProposalValidateResponseSchema,
  externalAgentProposalSubmitResponseSchema,
  externalAgentProposalStatusResponseSchema,
  externalAgentReviewOpenResponseSchema,
]);

/** 外部連携の失敗応答を検証するスキーマです。 */
export const externalAgentErrorResponseSchema = z
  .object({
    kind: z.literal("error"),
    code: externalAgentErrorCodeSchema,
    message: nonBlankMessageSchema,
  })
  .strict();

/** 外部GUIから提案を選択する入力を検証するスキーマです。 */
export const externalAgentGuiSelectInputSchema = z.object({
  proposal_id: identifierSchema,
  revision: z.number().int().positive(),
  selection: aiWorkflowSelectionSchema,
}).strict();

/** 外部GUIから提案を編集する入力を検証するスキーマです。 */
export const externalAgentGuiEditInputSchema = aiWorkflowOperationEditSchema
  .extend({ revision: z.number().int().positive() })
  .strict();

/** 外部GUIから提案を承認する入力を検証するスキーマです。 */
export const externalAgentGuiApproveInputSchema = z
  .object({
    proposal_id: identifierSchema,
    revision: z.number().int().positive(),
    selection: aiWorkflowSelectionSchema,
  })
  .strict();

/** 外部GUIから提案を却下する入力を検証するスキーマです。 */
export const externalAgentGuiRejectInputSchema = z
  .object({
    proposal_id: identifierSchema,
    revision: z.number().int().positive(),
  })
  .strict();

/** 外部連携の有効化を変更する入力を検証するスキーマです。 */
export const externalAgentGuiSetEnabledInputSchema = z
  .object({
    enabled: z.boolean(),
  })
  .strict();

/** 外部GUIの現在状態を取得する入力を検証するスキーマです。 */
export const externalAgentGuiGetStateInputSchema = z.object({}).strict();

const externalAgentRegistrationSchema = z
  .object({
    command: registrationTextSchema,
    allow_execution_command: registrationTextSchema,
    instructions: registrationTextSchema,
  })
  .strict();

const externalAgentReviewTargetSchema = z
  .object({
    proposal_id: identifierSchema,
    request_id: identifierSchema,
  })
  .strict();

const uniqueProposalArraySchema = z
  .array(externalAgentProposalSchema)
  .max(maximumProposals)
  .superRefine((proposals, context) => {
    const seen = new Set<string>();
    proposals.forEach((proposal, index) => {
      if (seen.has(proposal.proposal_id)) {
        context.addIssue({
          code: "custom",
          path: [index, "proposal_id"],
          message: "提案IDを重複して返せません。",
        });
      }
      seen.add(proposal.proposal_id);
    });
  });

/** 外部提案を含むGUIの状態スナップショットを検証するスキーマです。 */
export const externalAgentGuiStateSchema = z
  .object({
    enabled: z.boolean(),
    bridge: externalAgentBridgeStateSchema,
    registration: externalAgentRegistrationSchema,
    proposals: uniqueProposalArraySchema,
    review_target: externalAgentReviewTargetSchema.optional(),
  })
  .strict();

/** 外部GUIへ通知する状態変更スナップショットを検証するスキーマです。 */
export const externalAgentGuiChangedStateSchema = externalAgentGuiStateSchema;

export type ExternalAgentCreateProposalInput = z.infer<
  typeof externalAgentCreateProposalInputSchema
>;
export type ExternalAgentErrorCode = z.infer<typeof externalAgentErrorCodeSchema>;
export type ExternalAgentTaskListInput = z.infer<typeof externalAgentTaskListInputSchema>;
export type ExternalAgentTaskDetailInput = z.infer<
  typeof externalAgentTaskDetailInputSchema
>;
export type ExternalAgentTaskRankInput = z.infer<typeof externalAgentTaskRankInputSchema>;
export type ExternalAgentTaskGraphInput = z.infer<typeof externalAgentTaskGraphInputSchema>;
export type ExternalAgentTaskAreasInput = z.infer<typeof externalAgentTaskAreasInputSchema>;
export type ExternalAgentTaskSearchLocalInput = z.infer<
  typeof externalAgentTaskSearchLocalInputSchema
>;
export type ExternalAgentProposalPrepareInput = z.infer<
  typeof externalAgentProposalPrepareInputSchema
>;
export type ExternalAgentProposalReadInput = z.infer<
  typeof externalAgentProposalReadInputSchema
>;
export type ExternalAgentProposalApplyEditsInput = z.infer<
  typeof externalAgentProposalApplyEditsInputSchema
>;
export type ExternalAgentProposalDiffInput = z.infer<
  typeof externalAgentProposalDiffInputSchema
>;
export type ExternalAgentProposalValidateInput = z.infer<
  typeof externalAgentProposalValidateInputSchema
>;
export type ExternalAgentProposalSubmitInput = z.infer<
  typeof externalAgentProposalSubmitInputSchema
>;
export type ExternalAgentProposalStatusInput = z.infer<
  typeof externalAgentProposalStatusInputSchema
>;
export type ExternalAgentReviewOpenInput = z.infer<
  typeof externalAgentReviewOpenInputSchema
>;
export type ExternalAgentRequestInput = z.infer<typeof externalAgentRequestInputSchema>;
export type ExternalAgentCliInput = z.infer<typeof externalAgentCliInputSchema>;
export type ExternalAgentBridgeState = z.infer<typeof externalAgentBridgeStateSchema>;
export type ExternalAgentSyncStatus = z.infer<typeof externalAgentSyncStatusSchema>;
export type ExternalAgentInfoResponse = z.infer<typeof externalAgentInfoResponseSchema>;
export type ExternalAgentProposalStatus = z.infer<typeof externalAgentProposalStatusSchema>;
export type ExternalAgentProposal = z.infer<typeof externalAgentProposalSchema>;
export type ExternalAgentProposalStatusResult = z.infer<
  typeof externalAgentProposalStatusResultSchema
>;
export type ExternalAgentTaskQueryResponse = z.infer<
  typeof externalAgentTaskQueryResponseSchema
>;
export type ExternalAgentProposalPrepareResponse = z.infer<
  typeof externalAgentProposalPrepareResponseSchema
>;
export type ExternalAgentProposalReadResponse = z.infer<
  typeof externalAgentProposalReadResponseSchema
>;
export type ExternalAgentProposalApplyEditsResponse = z.infer<
  typeof externalAgentProposalApplyEditsResponseSchema
>;
export type ExternalAgentProposalDiffResponse = z.infer<
  typeof externalAgentProposalDiffResponseSchema
>;
export type ExternalAgentProposalValidateResponse = z.infer<
  typeof externalAgentProposalValidateResponseSchema
>;
export type ExternalAgentProposalSubmitResponse = z.infer<
  typeof externalAgentProposalSubmitResponseSchema
>;
export type ExternalAgentProposalCreateResponse = z.infer<
  typeof externalAgentProposalCreateResponseSchema
>;
export type ExternalAgentProposalStatusResponse = z.infer<
  typeof externalAgentProposalStatusResponseSchema
>;
export type ExternalAgentReviewOpenResponse = z.infer<
  typeof externalAgentReviewOpenResponseSchema
>;
export type ExternalAgentReviewTarget = z.infer<typeof externalAgentReviewTargetSchema>;
export type ExternalAgentResponse = z.infer<typeof externalAgentResponseSchema>;
export type ExternalAgentErrorResponse = z.infer<typeof externalAgentErrorResponseSchema>;
export type ExternalAgentGuiEditInput = z.infer<typeof externalAgentGuiEditInputSchema>;
export type ExternalAgentGuiApproveInput = z.infer<
  typeof externalAgentGuiApproveInputSchema
>;
export type ExternalAgentGuiRejectInput = z.infer<typeof externalAgentGuiRejectInputSchema>;
export type ExternalAgentGuiSelectInput = z.infer<typeof externalAgentGuiSelectInputSchema>;
export type ExternalAgentGuiSetEnabledInput = z.infer<
  typeof externalAgentGuiSetEnabledInputSchema
>;
export type ExternalAgentGuiGetStateInput = z.infer<
  typeof externalAgentGuiGetStateInputSchema
>;
export type ExternalAgentGuiState = z.infer<typeof externalAgentGuiStateSchema>;
export type ExternalAgentGuiChangedState = z.infer<
  typeof externalAgentGuiChangedStateSchema
>;
