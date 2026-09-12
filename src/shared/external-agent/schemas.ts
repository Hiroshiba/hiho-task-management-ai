import { z } from "zod";
import {
  areaSchema,
  createUtf8ByteLimitedStringSchema,
  dateSchema,
  durationSchema,
  gidSchema,
  identifierSchema,
  importanceSchema,
  isoDateTimeSchema,
} from "../domain";
import {
  aiWorkflowApprovalResultSchema,
  aiWorkflowProposalViewSchema,
} from "../ai-workflow";
import { applicationJournalSchema } from "../storage";
import {
  viewModelRankingSchema,
  viewModelTaskRowSchema,
  viewModelTaskDetailSchema,
  taskFilterSchema,
  type TaskFilter,
} from "../view-model";

const maximumTitleBytes = 1_024;
const maximumNotesBytes = 64 * 1_024;
const maximumReasonBytes = 64 * 1_024;
const maximumMessageBytes = 4 * 1_024;
const maximumQueryBytes = 4 * 1_024;
const maximumRegistrationBytes = 4 * 1_024;
const maximumCapabilities = 16;
const maximumProposals = 100;
const maximumListLimit = 100;

/** 外部連携プロトコルの版を表す定数です。 */
export const externalAgentProtocolVersion = 1;

const nonBlankTitleSchema = createUtf8ByteLimitedStringSchema(
  maximumTitleBytes,
).refine((value) => value.trim().length > 0, {
  message: "タイトルを空白だけにできません。",
});

const nonBlankReasonSchema = createUtf8ByteLimitedStringSchema(
  maximumReasonBytes,
).refine((value) => value.trim().length > 0, {
  message: "提案理由を空白だけにできません。",
});

const nonBlankQuerySchema = createUtf8ByteLimitedStringSchema(
  maximumQueryBytes,
).refine((value) => value.trim().length > 0, {
  message: "検索条件を空白だけにできません。",
});

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

const dueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("due_on"), due_on: dateSchema }).strict(),
  z.object({ kind: z.literal("due_at"), due_at: isoDateTimeSchema }).strict(),
]);

const proposalTaskFieldsSchema = z
  .object({
    title: nonBlankTitleSchema,
    notes: createUtf8ByteLimitedStringSchema(maximumNotesBytes).optional(),
    status: z.enum(["not_started", "in_progress"]).optional(),
    importance: importanceSchema.optional(),
    area: areaSchema.optional(),
    due: dueSchema.optional(),
    duration: durationSchema.optional(),
  })
  .strict();

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
  "proposals.create",
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

/** 外部連携から提出する独立新規タスクの作成項目を検証するスキーマです。 */
export const externalAgentCreateProposalInputSchema = z
  .object({
    operation: z.literal("proposals.create"),
    instance_id: identifierSchema,
    context_id: identifierSchema,
    request_id: identifierSchema,
    project_gid: gidSchema,
    ...proposalTaskFieldsSchema.shape,
    reason: nonBlankReasonSchema,
    confidence: z.number().finite().min(0).max(1),
  })
  .strict();

/** 外部連携から取得するタスク一覧の要求を検証するスキーマです。 */
export const externalAgentTaskListInputSchema = z
  .object({
    operation: z.literal("tasks.list"),
    filter: taskFilterSchema.optional(),
    query: nonBlankQuerySchema.optional(),
    limit: z.number().int().positive().max(maximumListLimit).optional(),
  })
  .strict();

/** 外部連携から取得するタスク詳細の要求を検証するスキーマです。 */
export const externalAgentTaskDetailInputSchema = z
  .object({
    operation: z.literal("tasks.get"),
    task_gid: gidSchema,
  })
  .strict();

/** 外部連携から照会する提案の要求を検証するスキーマです。 */
export const externalAgentProposalStatusInputSchema = z
  .object({
    operation: z.literal("proposals.status"),
    proposal_id: identifierSchema,
    operation_id: identifierSchema,
  })
  .strict();

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
  externalAgentCreateProposalInputSchema,
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

/** 外部連携の読み取りスナップショットを検証するスキーマです。 */
export const externalAgentReadSnapshotSchema = z
  .object({
    context_id: identifierSchema,
    project_gid: gidSchema,
    observed_at: isoDateTimeSchema,
    sync_status: z.enum(["synced", "syncing", "offline"]),
    last_successful_sync_at: isoDateTimeSchema,
  })
  .strict();

/** 外部連携へ返す一覧行の配列を重複なく検証するスキーマです。 */
export const externalAgentTaskRowsSchema = z
  .array(viewModelTaskRowSchema)
  .max(maximumListLimit)
  .superRefine((rows, context) => {
    const seen = new Set<string>();
    rows.forEach((row, index) => {
      if (seen.has(row.gid)) {
        context.addIssue({
          code: "custom",
          path: [index, "gid"],
          message: "同じタスクGIDを重複して返せません。",
        });
      }
      seen.add(row.gid);
    });
  });

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
    operation_id: identifierSchema,
    request_id: identifierSchema,
    instance_id: identifierSchema,
    context_id: identifierSchema,
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
    const operations = proposal.view.proposal.groups.flatMap((group) => group.operations);
    if (operations.length !== 1) {
      context.addIssue({
        code: "custom",
        path: ["view", "proposal", "groups"],
        message: "外部提案は一つの操作だけを含めなければなりません。",
      });
    } else {
      const operation = operations[0];
      if (operation == null) {
        throw new Error("外部提案の操作を取得できません。");
      }
      if (operation.operation_id !== proposal.operation_id) {
        context.addIssue({
          code: "custom",
          path: ["view", "proposal", "groups", 0, "operations", 0, "operation_id"],
          message: "操作IDと表示用操作IDが一致しません。",
        });
      }
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
      kind: z.literal("journal"),
      journal: applicationJournalSchema,
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

/** 外部連携のタスク一覧応答を検証するスキーマです。 */
export const externalAgentTaskListResponseSchema = z
  .object({
    operation: z.literal("tasks.list"),
    snapshot: externalAgentReadSnapshotSchema,
    ranking: viewModelRankingSchema,
    rows: externalAgentTaskRowsSchema,
  })
  .strict();

/** 外部連携のタスク詳細応答を検証するスキーマです。 */
export const externalAgentTaskDetailResponseSchema = z
  .object({
    operation: z.literal("tasks.get"),
    snapshot: externalAgentReadSnapshotSchema,
    detail: viewModelTaskDetailSchema,
  })
  .strict();

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
    operation_id: identifierSchema,
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
      if (response.result.proposal.operation_id !== response.operation_id) {
        context.addIssue({
          code: "custom",
          path: ["result", "proposal", "operation_id"],
          message: "照会結果の操作IDが要求と一致しません。",
        });
      }
      return;
    }
    if (response.result.kind === "journal") {
      if (response.result.journal.proposal_id !== response.proposal_id) {
        context.addIssue({
          code: "custom",
          path: ["result", "journal", "proposal_id"],
          message: "ジャーナルの提案IDが要求と一致しません。",
        });
      }
      if (response.result.journal.operation_id !== response.operation_id) {
        context.addIssue({
          code: "custom",
          path: ["result", "journal", "operation_id"],
          message: "ジャーナルの操作IDが要求と一致しません。",
        });
      }
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
  externalAgentTaskListResponseSchema,
  externalAgentTaskDetailResponseSchema,
  externalAgentProposalCreateResponseSchema,
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

/** 外部GUIから提案を編集する入力を検証するスキーマです。 */
export const externalAgentGuiEditInputSchema = z
  .object({
    proposal_id: identifierSchema,
    operation_id: identifierSchema,
    revision: z.number().int().positive(),
    ...proposalTaskFieldsSchema.shape,
  })
  .strict();

/** 外部GUIから提案を承認する入力を検証するスキーマです。 */
export const externalAgentGuiApproveInputSchema = z
  .object({
    proposal_id: identifierSchema,
    revision: z.number().int().positive(),
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
export type ExternalAgentTaskFilter = TaskFilter;
export type ExternalAgentErrorCode = z.infer<typeof externalAgentErrorCodeSchema>;
export type ExternalAgentTaskListInput = z.infer<typeof externalAgentTaskListInputSchema>;
export type ExternalAgentTaskDetailInput = z.infer<
  typeof externalAgentTaskDetailInputSchema
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
export type ExternalAgentReadSnapshot = z.infer<typeof externalAgentReadSnapshotSchema>;
export type ExternalAgentTaskRows = z.infer<typeof externalAgentTaskRowsSchema>;
export type ExternalAgentInfoResponse = z.infer<typeof externalAgentInfoResponseSchema>;
export type ExternalAgentProposalStatus = z.infer<typeof externalAgentProposalStatusSchema>;
export type ExternalAgentProposal = z.infer<typeof externalAgentProposalSchema>;
export type ExternalAgentProposalStatusResult = z.infer<
  typeof externalAgentProposalStatusResultSchema
>;
export type ExternalAgentTaskListResponse = z.infer<
  typeof externalAgentTaskListResponseSchema
>;
export type ExternalAgentTaskDetailResponse = z.infer<
  typeof externalAgentTaskDetailResponseSchema
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
