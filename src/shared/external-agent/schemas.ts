import { z } from "zod";
import {
  createUtf8ByteLimitedStringSchema,
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
import { proposalSchema } from "../ai";
import { applicationJournalSchema } from "../storage";
import {
  taskctlResponseSchema,
  taskctlSearchQuerySchema,
} from "../taskctl";

const maximumMessageBytes = 4 * 1_024;
const maximumRegistrationBytes = 4 * 1_024;
const maximumCapabilities = 16;
const maximumProposals = 100;
const maximumProposalOperations = 256;

/** 外部連携プロトコルの版を表す定数です。 */
export const externalAgentProtocolVersion = 2;

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
          z.object({ kind: z.literal("journal"), journal: applicationJournalSchema }).strict(),
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
  turn_context: aiWorkflowTurnContextSchema,
  evidence_locator_prefix: nonBlankMessageSchema,
}).strict();

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
