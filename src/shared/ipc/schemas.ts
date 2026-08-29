import { z } from "zod";
import {
  areaSchema,
  cleanupItemsSchema,
  createUtf8ByteLimitedStringSchema,
  dateSchema,
  dependenciesSchema,
  gidSchema,
  identifierSchema,
  importanceSchema,
  isoDateTimeSchema,
  obsidianLinkSchema,
  parentWorkModeSchema,
  taskStatusSchema,
  vaultIdSchema,
} from "../domain";
import {
  setupAsanaAuthorizationBeginInputSchema,
  setupAsanaAuthorizationCancelInputSchema,
  setupAsanaAuthorizationCompleteInputSchema,
  setupExternalToolChoiceInputSchema,
  setupProjectSelectionInputSchema,
  setupStateSchema,
  setupVaultChoiceInputSchema,
  setupWorkspaceSelectionInputSchema,
  type SetupAsanaAuthorizationBeginInput,
  type SetupAsanaAuthorizationCancelInput,
  type SetupAsanaAuthorizationCompleteInput,
  type SetupExternalToolChoiceInput,
  type SetupProjectSelectionInput,
  type SetupState,
  type SetupVaultChoiceInput,
  type SetupWorkspaceSelectionInput,
} from "../setup";
import {
  aiWorkflowApprovalRequestSchema,
  aiWorkflowApprovalResultSchema,
  aiWorkflowOperationEditSchema,
  aiWorkflowProposalViewSchema,
  aiWorkflowSelectionRequestSchema,
  aiWorkflowTurnRequestSchema,
  aiWorkflowTurnResultSchema,
  type AiWorkflowApprovalRequest,
  type AiWorkflowOperationEdit,
  type AiWorkflowProposalView,
  type AiWorkflowSelectionRequest,
  type AiWorkflowTurnRequest,
  type AiWorkflowTurnResult,
} from "../ai-workflow";
import {
  viewModelOverviewSchema,
  viewModelTaskDetailSchema,
  type ViewModelOverview,
  type ViewModelTaskDetail,
} from "../view-model";

const maximumRequestTextBytes = 64 * 1024;
const maximumResponseMessageCharacters = 160;

const safeMessageSchema = createUtf8ByteLimitedStringSchema(
  maximumResponseMessageCharacters,
).min(1).refine((value) => value.trim().length > 0, {
  message: "IPCメッセージを空白だけにできません。",
});

const failureCodeSchema = z.enum([
  "invalid_request",
  "invalid_response",
  "sender_untrusted",
  "not_configured",
  "operation_failed",
  "oauth_invalid_client",
  "oauth_invalid_grant",
  "oauth_token_endpoint_rejected",
  "oauth_network_error",
  "oauth_session_error",
  "aborted",
  "conflict",
  "not_found",
  "authentication_required",
  "unavailable",
]);

const failureSchema = z
  .object({
    kind: z.literal("error"),
    code: failureCodeSchema,
    message: safeMessageSchema,
  })
  .strict();

function responseSchema<T extends z.ZodType>(valueSchema: T) {
  return z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("ok"), value: valueSchema }).strict(),
    failureSchema,
  ]);
}

const emptyRequestSchema = z.undefined();
const appVersionSchema = z.string().min(1).max(64);

const asanaAuthorizationIdSchema = z
  .string()
  .length(43)
  .regex(/^[A-Za-z0-9_-]+$/u, "OAuth取引の識別子が不正です。");
const asanaAuthenticationStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("idle") }).strict(),
  z
    .object({
      kind: z.literal("opening"),
      authorization_id: asanaAuthorizationIdSchema,
      expires_at: isoDateTimeSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("authorization_pending"),
      authorization_id: asanaAuthorizationIdSchema,
      expires_at: isoDateTimeSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("completing"),
      authorization_id: asanaAuthorizationIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("synchronizing"),
      authorization_id: asanaAuthorizationIdSchema,
    })
    .strict(),
]);

const readModelOverviewRequestSchema = z.undefined();
const readModelTaskDetailRequestSchema = z
  .object({ task_gid: gidSchema })
  .strict();

const synchronizationModeSchema = z.enum(["full", "delta"]);
const syncRequestSchema = z
  .object({ mode: synchronizationModeSchema })
  .strict();

const activeTaskStatusSchema = z.enum(["not_started", "in_progress"]);
const taskTitleSchema = createUtf8ByteLimitedStringSchema(1_024).refine(
  (value) => value.trim().length > 0,
  { message: "タスク名を空にできません。" },
);
const taskNotesSchema = createUtf8ByteLimitedStringSchema(maximumRequestTextBytes);
const dueValueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("due_on"), due_on: dateSchema }).strict(),
  z.object({ kind: z.literal("due_at"), due_at: isoDateTimeSchema }).strict(),
]);
const parentValueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("absent") }).strict(),
  z.object({ kind: z.literal("existing"), gid: gidSchema }).strict(),
]);
const guiOperationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("update_title"), value: taskTitleSchema }).strict(),
  z.object({ kind: z.literal("update_notes"), value: taskNotesSchema }).strict(),
  z.object({ kind: z.literal("set_status"), value: taskStatusSchema }).strict(),
  z.object({ kind: z.literal("complete") }).strict(),
  z.object({ kind: z.literal("withdraw") }).strict(),
  z.object({ kind: z.literal("restore"), value: activeTaskStatusSchema }).strict(),
  z.object({ kind: z.literal("mark_activity") }).strict(),
  z.object({ kind: z.literal("set_importance"), value: importanceSchema }).strict(),
  z.object({ kind: z.literal("set_due"), value: dueValueSchema }).strict(),
  z.object({ kind: z.literal("clear_due") }).strict(),
  z.object({ kind: z.literal("set_area"), value: areaSchema }).strict(),
  z.object({ kind: z.literal("set_dependencies"), value: dependenciesSchema }).strict(),
  z.object({ kind: z.literal("set_parent"), value: parentValueSchema }).strict(),
  z.object({ kind: z.literal("set_parent_work_mode"), value: parentWorkModeSchema }).strict(),
  z.object({ kind: z.literal("link_obsidian"), value: obsidianLinkSchema }).strict(),
  z.object({ kind: z.literal("unlink_obsidian"), value: obsidianLinkSchema }).strict(),
]);
const guiRequestSchema = z
  .object({
    task_gid: gidSchema,
    expected_sync_at: isoDateTimeSchema,
    operation: guiOperationSchema,
  })
  .strict();
const guiResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      operation_id: identifierSchema,
      task_gid: gidSchema,
      outcome: z.literal("applied"),
      reason_code: z.literal("applied"),
    })
    .strict(),
  z
    .object({
      operation_id: identifierSchema,
      task_gid: gidSchema,
      outcome: z.literal("already_applied"),
      reason_code: z.literal("already_applied"),
    })
    .strict(),
  z
    .object({
      operation_id: identifierSchema,
      task_gid: gidSchema,
      outcome: z.literal("conflict"),
      reason_code: z.enum([
        "baseline_changed",
        "relationship_cycle",
        "read_back_mismatch",
        "external_unreadable",
        "external_identity_mismatch",
        "merge_conflict",
        "external_capacity_exceeded",
      ]),
      side_effect: z.enum(["none", "possible"]),
    })
    .strict(),
  z
    .object({
      operation_id: identifierSchema,
      task_gid: gidSchema,
      outcome: z.literal("rejected"),
      reason_code: z.literal("offline"),
    })
    .strict(),
  z
    .object({
      operation_id: identifierSchema,
      task_gid: gidSchema,
      outcome: z.literal("recovery_required"),
      reason_code: z.literal("local_resync_required"),
      write_outcome: z.enum(["applied", "already_applied", "unknown"]),
      sync_error_code: z.enum([
        "authentication_required",
        "offline",
        "aborted",
        "stopped",
        "payment_required",
        "rate_limited",
        "http_error",
        "transport_error",
        "response_error",
        "events_reset",
        "request_aborted",
        "sync_in_progress",
      ]),
    })
    .strict(),
]);

const syncFallbackReasonSchema = z.enum([
  "sync_token_missing",
  "metadata_missing",
  "events_reset",
  "unsafe_structure",
]);
const syncCriticalErrorCodeSchema = z.enum([
  "project_membership_missing",
  "project_membership_multiple",
  "unknown_status_section",
  "custom_external_data_broken",
  "custom_external_data_unknown_schema",
  "custom_external_data_identity_mismatch",
  "dependency_cycle",
  "parent_cycle",
]);
const normalizationOperationOutcomeSchema = z.enum([
  "applied",
  "already_applied",
  "conflict",
]);
const normalizationOperationReasonCodeSchema = z.enum([
  "applied",
  "already_applied",
  "already_initialized",
  "baseline_changed",
  "read_back_mismatch",
  "external_unreadable",
  "external_identity_mismatch",
  "merge_conflict",
]);
const normalizationOperationCommonShape = {
  task_gid: gidSchema,
  outcome: normalizationOperationOutcomeSchema,
  reason_code: normalizationOperationReasonCodeSchema,
};
const normalizationOperationResultSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("move_section"),
      ...normalizationOperationCommonShape,
      section_gid: gidSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal("set_completed"),
      ...normalizationOperationCommonShape,
      completed: z.boolean(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("initialize_external_data"),
      ...normalizationOperationCommonShape,
    })
    .strict(),
  z
    .object({
      operation: z.literal("update_last_active_status"),
      ...normalizationOperationCommonShape,
      value: activeTaskStatusSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal("update_activity_anchor_on"),
      ...normalizationOperationCommonShape,
      value: dateSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal("add_tag"),
      ...normalizationOperationCommonShape,
      tag_gid: gidSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal("remove_tag"),
      ...normalizationOperationCommonShape,
      tag_gid: gidSchema,
    })
    .strict(),
]);
const normalizationApplicationResultSchema = z
  .object({
    affected_gids: z.array(gidSchema),
    operations: z.array(normalizationOperationResultSchema),
  })
  .strict();
const syncRemainingPlanSchema = z
  .object({
    status_write_task_gids: z.array(gidSchema),
    external_write_task_gids: z.array(gidSchema),
    tag_write_task_gids: z.array(gidSchema),
  })
  .strict();
const syncNormalizationNotificationSchema = z
  .object({
    kind: z.literal("status_reconciled"),
    task_gid: gidSchema,
    status: taskStatusSchema,
    message: safeMessageSchema,
  })
  .strict();
const syncNormalizationNotificationsSchema = z
  .array(syncNormalizationNotificationSchema)
  .max(10_000)
  .superRefine((notifications, context) => {
    let previousTaskGid: string | undefined;
    for (const [index, notification] of notifications.entries()) {
      if (
        previousTaskGid != null
        && previousTaskGid >= notification.task_gid
      ) {
        context.addIssue({
          code: "custom",
          path: [index, "task_gid"],
          message: "正規化通知は重複させずタスクGID順に指定してください。",
        });
      }
      previousTaskGid = notification.task_gid;
    }
  });
const syncResultSchema = z
  .object({
    requested_mode: synchronizationModeSchema,
    performed_mode: synchronizationModeSchema,
    fallback_reason: syncFallbackReasonSchema.optional(),
    synced_at: isoDateTimeSchema,
    application_result: normalizationApplicationResultSchema,
    normalization_notifications: syncNormalizationNotificationsSchema,
    remaining_plan: syncRemainingPlanSchema,
    critical_errors: z.array(
      z.object({ task_gid: gidSchema, code: syncCriticalErrorCodeSchema }).strict(),
    ),
    cleanup_items: cleanupItemsSchema,
  })
  .strict();

const setupEmptyInputSchema = z.undefined();
const setupWorkspaceInputSchema = setupWorkspaceSelectionInputSchema;
const setupProjectInputSchema = setupProjectSelectionInputSchema;
const setupAsanaAuthorizationBeginInput = setupAsanaAuthorizationBeginInputSchema;
const setupAsanaAuthorizationCompleteInput = setupAsanaAuthorizationCompleteInputSchema;
const setupAsanaAuthorizationCancelInput = setupAsanaAuthorizationCancelInputSchema;
const setupVaultInputSchema = setupVaultChoiceInputSchema;
const setupExternalToolInputSchema = setupExternalToolChoiceInputSchema;

const codexDeltaSchema = z.object({
  thread_id: z.string().min(1).max(200),
  turn_id: z.string().min(1).max(200),
  item_id: z.string().min(1).max(200),
  delta: createUtf8ByteLimitedStringSchema(200_000),
}).strict();

const ipcAiDeltaEventSchema = codexDeltaSchema;
const aiNewSessionResultSchema = z.object({
  kind: z.literal("started"),
}).strict();

const relativeMarkdownPathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine((value) => !value.includes("\0"), "ノートパスにNUL文字を指定できません。")
  .refine(
    (value) => ![...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint != null && (codePoint <= 31 || (codePoint >= 127 && codePoint <= 159));
    }),
    "ノートパスに制御文字を指定できません。",
  )
  .refine((value) => !value.startsWith("/"), "ノートパスは相対パスで指定してください。")
  .refine((value) => !value.includes("\\"), "ノートパスにバックスラッシュを指定できません。")
  .refine((value) => !/^[A-Za-z]:[\\/]/u.test(value), "ノートパスにドライブ指定を含められません。")
  .refine(
    (value) => value.split("/").every((part) => part.length > 0 && part !== "." && part !== ".."),
    "ノートパスの要素が不正です。",
  )
  .refine((value) => value.endsWith(".md"), "Markdownノートだけを指定できます。");
const obsidianVaultResultSchema = z.object({ vault_id: vaultIdSchema, kind: z.literal("valid") }).strict();
const obsidianVaultListResultSchema = z
  .object({
    vault_ids: z.array(vaultIdSchema).max(1_000).superRefine((vaultIds, context) => {
      if (new Set(vaultIds).size !== vaultIds.length) {
        context.addIssue({
          code: "custom",
          message: "Vault IDを重複して返せません。",
        });
      }
    }),
  })
  .strict();
const obsidianPathResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("resolved"), vault_id: vaultIdSchema, relative_path: relativeMarkdownPathSchema }).strict(),
  z.object({ kind: z.literal("missing"), vault_id: vaultIdSchema, relative_path: relativeMarkdownPathSchema }).strict(),
]);
const obsidianNoteSummarySchema = z.object({
  relative_path: relativeMarkdownPathSchema,
  title: safeMessageSchema,
  headings: z.array(safeMessageSchema).max(1_000),
}).strict();
const obsidianSearchResultSchema = obsidianNoteSummarySchema.extend({ excerpt: safeMessageSchema }).strict();
const completedResultSchema = z.object({ completed: z.literal(true) }).strict();
const syncRuntimeErrorCodeSchema = z.enum([
  "authentication_required",
  "payment_required",
  "rate_limited",
  "http_error",
  "transport_error",
  "response_error",
  "events_reset",
  "request_aborted",
  "sync_in_progress",
  "unexpected_error",
]);
const syncStateBaseShape = {
  last_successful_sync_at: isoDateTimeSchema.optional(),
  last_error_code: syncRuntimeErrorCodeSchema.optional(),
};
const syncStateEventSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("online"),
    normalization_notifications: syncNormalizationNotificationsSchema.optional(),
    ...syncStateBaseShape,
  }).strict(),
  z.object({ kind: z.literal("offline"), ...syncStateBaseShape }).strict(),
  z.object({
    kind: z.literal("syncing"),
    requested_mode: synchronizationModeSchema,
    ...syncStateBaseShape,
  }).strict(),
  z.object({
    kind: z.literal("authentication_required"),
    error_code: z.literal("authentication_required"),
    last_successful_sync_at: isoDateTimeSchema.optional(),
  }).strict(),
  z.object({
    kind: z.literal("error"),
    error_code: syncRuntimeErrorCodeSchema,
    last_successful_sync_at: isoDateTimeSchema.optional(),
  }).strict(),
]);
const aiStatusSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ready"),
    codex_version: identifierSchema,
    model: identifierSchema,
  }).strict(),
  z.object({
    kind: z.literal("authentication_required"),
    codex_version: identifierSchema,
  }).strict(),
  z.object({ kind: z.literal("starting") }).strict(),
  z.object({
    kind: z.literal("unavailable"),
    reason_code: z.enum([
      "not_installed",
      "incompatible",
      "permission_denied",
      "startup_failed",
      "disabled",
      "stopped",
    ]),
  }).strict(),
]);

export const ipcFailureSchema = failureSchema;
export const ipcAppVersionSchema = appVersionSchema;
export const ipcChannelSchema = z.enum([
  "app:get-version",
  "asana:get-authentication-state",
  "asana:begin-reauthentication",
  "asana:complete-reauthentication",
  "asana:cancel-reauthentication",
  "read-model:get-overview",
  "read-model:get-task-detail",
  "sync:run",
  "sync:get-state",
  "sync:state:subscribe",
  "sync:state:unsubscribe",
  "sync:state",
  "setup:get-state",
  "setup:start",
  "setup:complete-codex-authentication",
  "setup:begin-asana-authorization",
  "setup:complete-asana-authorization",
  "setup:cancel-asana-authorization",
  "setup:list-workspaces",
  "setup:select-workspace",
  "setup:select-project",
  "setup:retry-resources",
  "setup:run-capability",
  "setup:choose-vault",
  "setup:choose-external-tool",
  "setup:run-full-sync",
  "setup:run-codex-capability",
  "gui:apply",
  "ai:start-turn",
  "ai:start-new-session",
  "ai:get-status",
  "ai:get-proposal",
  "ai:select",
  "ai:edit-operation",
  "ai:reject",
  "ai:approve",
  "ai:delta:subscribe",
  "ai:delta:unsubscribe",
  "ai:delta",
  "ai:status:subscribe",
  "ai:status:unsubscribe",
  "ai:status",
  "obsidian:validate-vault",
  "obsidian:list-vaults",
  "obsidian:list-notes",
  "obsidian:resolve-path",
  "obsidian:note-exists",
  "obsidian:search",
  "obsidian:open-note",
]);

export const ipcAppVersionResponseSchema = responseSchema(appVersionSchema);
export const ipcReadModelOverviewInputSchema = readModelOverviewRequestSchema;
export const ipcReadModelTaskDetailInputSchema = readModelTaskDetailRequestSchema;
export const ipcReadModelOverviewResponseSchema = responseSchema(viewModelOverviewSchema);
export const ipcReadModelTaskDetailResponseSchema = responseSchema(viewModelTaskDetailSchema);
export const ipcSyncInputSchema = syncRequestSchema;
export const ipcSyncResultSchema = syncResultSchema;
export const ipcSyncResponseSchema = responseSchema(syncResultSchema);
export const ipcSyncStateEventSchema = syncStateEventSchema;
export const ipcSyncGetStateInputSchema = emptyRequestSchema;
export const ipcSyncGetStateResponseSchema = responseSchema(syncStateEventSchema);
export const ipcAsanaAuthenticationStateSchema = asanaAuthenticationStateSchema;
export const ipcAsanaAuthenticationStateResponseSchema = responseSchema(
  asanaAuthenticationStateSchema,
);
export const ipcAsanaGetAuthenticationStateInputSchema = emptyRequestSchema;
export const ipcAsanaBeginReauthenticationInputSchema = emptyRequestSchema;
export const ipcAsanaCompleteReauthenticationInputSchema = setupAsanaAuthorizationCompleteInputSchema;
export const ipcAsanaCompleteReauthenticationResponseSchema = responseSchema(syncResultSchema);
export const ipcAsanaCancelReauthenticationInputSchema = setupAsanaAuthorizationCancelInputSchema;
export const ipcAsanaCancelReauthenticationResponseSchema = responseSchema(
  asanaAuthenticationStateSchema,
);
export const ipcSetupStateResponseSchema = responseSchema(setupStateSchema);
export const ipcSetupStartInputSchema = setupEmptyInputSchema;
export const ipcSetupCompleteCodexAuthenticationInputSchema = setupEmptyInputSchema;
export const ipcSetupBeginAsanaAuthorizationInputSchema = setupAsanaAuthorizationBeginInput;
export const ipcSetupCompleteAsanaAuthorizationInputSchema = setupAsanaAuthorizationCompleteInput;
export const ipcSetupCancelAsanaAuthorizationInputSchema = setupAsanaAuthorizationCancelInput;
export const ipcSetupListWorkspacesInputSchema = setupEmptyInputSchema;
export const ipcSetupSelectWorkspaceInputSchema = setupWorkspaceInputSchema;
export const ipcSetupSelectProjectInputSchema = setupProjectInputSchema;
export const ipcSetupRetryResourcesInputSchema = setupEmptyInputSchema;
export const ipcSetupRunCapabilityInputSchema = setupEmptyInputSchema;
export const ipcSetupChooseVaultInputSchema = setupVaultInputSchema;
export const ipcSetupChooseExternalToolInputSchema = setupExternalToolInputSchema;
export const ipcSetupRunFullSyncInputSchema = setupEmptyInputSchema;
export const ipcSetupRunCodexCapabilityInputSchema = setupEmptyInputSchema;
export const ipcSetupStateSchema = setupStateSchema;
export const ipcGuiEditInputSchema = guiRequestSchema;
export const ipcGuiEditResultSchema = guiResultSchema;
export const ipcGuiEditResponseSchema = responseSchema(guiResultSchema);
export const ipcAiTurnInputSchema = aiWorkflowTurnRequestSchema;
export const ipcAiTurnResponseSchema = responseSchema(aiWorkflowTurnResultSchema);
export const ipcAiStartNewSessionInputSchema = emptyRequestSchema;
export const ipcAiStartNewSessionResponseSchema = responseSchema(aiNewSessionResultSchema);
export const ipcAiGetStatusInputSchema = emptyRequestSchema;
export const ipcAiGetStatusResponseSchema = responseSchema(aiStatusSchema);
export const ipcAiStatusEventSchema = aiStatusSchema;
export const ipcAiProposalInputSchema = z.object({ proposal_id: identifierSchema }).strict();
export const ipcAiProposalResponseSchema = responseSchema(aiWorkflowProposalViewSchema);
export const ipcAiSelectionInputSchema = aiWorkflowSelectionRequestSchema;
export const ipcAiSelectionResponseSchema = responseSchema(aiWorkflowProposalViewSchema);
export const ipcAiEditInputSchema = aiWorkflowOperationEditSchema;
export const ipcAiEditResponseSchema = responseSchema(aiWorkflowProposalViewSchema);
export const ipcAiRejectInputSchema = z.object({ proposal_id: identifierSchema }).strict();
export const ipcAiRejectResponseSchema = responseSchema(completedResultSchema);
export const ipcAiApprovalInputSchema = aiWorkflowApprovalRequestSchema;
export const ipcAiApprovalResponseSchema = responseSchema(aiWorkflowApprovalResultSchema);
export { ipcAiDeltaEventSchema };
export const ipcObsidianValidateInputSchema = z.object({ vault_id: vaultIdSchema }).strict();
export const ipcObsidianValidateResponseSchema = responseSchema(obsidianVaultResultSchema);
export const ipcObsidianListVaultsInputSchema = emptyRequestSchema;
export const ipcObsidianListVaultsResponseSchema = responseSchema(obsidianVaultListResultSchema);
export const ipcObsidianListInputSchema = ipcObsidianValidateInputSchema;
export const ipcObsidianListResponseSchema = responseSchema(z.array(obsidianNoteSummarySchema).max(1_000));
export const ipcObsidianPathInputSchema = z.object({ vault_id: vaultIdSchema, relative_path: relativeMarkdownPathSchema }).strict();
export const ipcObsidianPathResponseSchema = responseSchema(obsidianPathResultSchema);
export const ipcObsidianSearchInputSchema = z.object({ vault_id: vaultIdSchema, query: safeMessageSchema }).strict();
export const ipcObsidianSearchResponseSchema = responseSchema(z.array(obsidianSearchResultSchema).max(1_000));
export const ipcObsidianOpenNoteInputSchema = ipcObsidianPathInputSchema;
export const ipcObsidianOpenNoteResponseSchema = responseSchema(completedResultSchema);
export const ipcEmptyRequestSchema = emptyRequestSchema;

export type IpcFailure = z.infer<typeof failureSchema>;
export type IpcResponse<T> = { readonly kind: "ok"; readonly value: T } | IpcFailure;
export type IpcSyncInput = z.infer<typeof syncRequestSchema>;
export type IpcSyncResult = z.infer<typeof syncResultSchema>;
export type IpcAsanaAuthenticationState = z.infer<typeof asanaAuthenticationStateSchema>;
export type IpcAsanaReauthenticationCompleteInput = z.infer<
  typeof ipcAsanaCompleteReauthenticationInputSchema
>;
export type IpcAsanaReauthenticationCancelInput = z.infer<
  typeof ipcAsanaCancelReauthenticationInputSchema
>;
export type IpcSetupState = SetupState;
export type IpcSetupAsanaAuthorizationBeginInput = SetupAsanaAuthorizationBeginInput;
export type IpcSetupAsanaAuthorizationCompleteInput = SetupAsanaAuthorizationCompleteInput;
export type IpcSetupAsanaAuthorizationCancelInput = SetupAsanaAuthorizationCancelInput;
export type IpcSetupExternalToolChoiceInput = SetupExternalToolChoiceInput;
export type IpcSetupProjectSelectionInput = SetupProjectSelectionInput;
export type IpcSetupVaultChoiceInput = SetupVaultChoiceInput;
export type IpcSetupWorkspaceSelectionInput = SetupWorkspaceSelectionInput;
export type IpcGuiEditInput = z.infer<typeof guiRequestSchema>;
export type IpcGuiEditResult = z.infer<typeof guiResultSchema>;
export type IpcCodexDelta = z.infer<typeof codexDeltaSchema>;
export type IpcAiNewSessionResult = z.infer<typeof aiNewSessionResultSchema>;
export type IpcAiTurnInput = AiWorkflowTurnRequest;
export type IpcAiTurnResult = AiWorkflowTurnResult;
export type IpcAiProposalView = AiWorkflowProposalView;
export type IpcAiSelectionInput = AiWorkflowSelectionRequest;
export type IpcAiEditInput = AiWorkflowOperationEdit;
export type IpcAiApprovalInput = AiWorkflowApprovalRequest;
export type IpcAiApprovalResult = z.infer<typeof aiWorkflowApprovalResultSchema>;
export type IpcObsidianVaultResult = z.infer<typeof obsidianVaultResultSchema>;
export type IpcObsidianVaultList = z.infer<typeof obsidianVaultListResultSchema>;
export type IpcObsidianPathResult = z.infer<typeof obsidianPathResultSchema>;
export type IpcObsidianNoteSummary = z.infer<typeof obsidianNoteSummarySchema>;
export type IpcObsidianSearchResult = z.infer<typeof obsidianSearchResultSchema>;
export type IpcSyncStateEvent = z.infer<typeof syncStateEventSchema>;
export type IpcAiStatus = z.infer<typeof aiStatusSchema>;
export type IpcEmptyRequest = undefined;
export type IpcAppVersion = string;
export type IpcReadModelOverview = ViewModelOverview;
export type IpcReadModelTaskDetail = ViewModelTaskDetail;

export {
  aiWorkflowApprovalRequestSchema,
  aiWorkflowApprovalResultSchema,
  aiWorkflowOperationEditSchema,
  aiWorkflowProposalViewSchema,
  aiWorkflowSelectionRequestSchema,
  aiWorkflowTurnRequestSchema,
  aiWorkflowTurnResultSchema,
};
