import { z } from "zod";
import {
  completedSchema,
  dateTimeSchema,
  displayTextSchema,
  emptyRequestSchema,
  errorIdSchema,
  gidSchema,
  identifierSchema,
  responseSchema,
  subscriptionEventSchema,
  subscriptionRequestSchema,
  type IpcResult,
  type IpcSubscription,
} from "./common";
import { executionDtoSchema, type ExecutionDto } from "./execution";
import { externalProposalStateSchema } from "./external-proposal-state";
import { proposalsChannels } from "./proposals-channels";
import {
  proposalEditValueSchema,
  proposalOperationKindSchema,
  proposalSelectionSchema,
  proposalViewSchema,
  type ProposalViewDto,
} from "./proposal-values";

const aiStatusSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ready"), model: identifierSchema }).strict(),
  z.object({ kind: z.literal("authentication_required") }).strict(),
  z.object({ kind: z.literal("starting") }).strict(),
  z
    .object({
      kind: z.literal("unavailable"),
      reason_code: z.enum([
        "not_installed",
        "incompatible",
        "permission_denied",
        "startup_failed",
        "disabled",
        "stopped",
      ]),
    })
    .strict(),
]);
const sessionStartSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("started"), session_id: identifierSchema }).strict(),
  z.object({ kind: z.literal("authentication_required") }).strict(),
]);
const turnRequestSchema = z
  .object({
    session_id: identifierSchema,
    message: z.string().min(1).max(65_536),
    target_task_gid: gidSchema.optional(),
    base_proposal_id: identifierSchema.optional(),
  })
  .strict();
const questionSchema = z
  .object({
    question_id: identifierSchema,
    text: displayTextSchema,
    options: z.array(displayTextSchema).min(2).max(8).optional(),
  })
  .strict();
const turnResultSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("proposal"),
      message: displayTextSchema,
      questions: z.array(questionSchema).max(8),
      proposal: proposalViewSchema,
      retry_count: z.number().int().nonnegative().max(2),
    })
    .strict(),
  z
    .object({
      kind: z.literal("no_proposal"),
      message: displayTextSchema,
      questions: z.array(questionSchema).max(8),
      pending_proposal_action: z.enum(["keep", "discard"]),
      retry_count: z.number().int().nonnegative().max(2),
    })
    .strict(),
]);
const proposalRequestSchema = z.object({ session_id: identifierSchema, proposal_id: identifierSchema }).strict();
const selectionRequestSchema = proposalRequestSchema.extend({ selection: proposalSelectionSchema }).strict();
const editLocatorSchema = z.string()
  .refine((value) => value.trim().length > 0, "根拠locatorを空にできません。")
  .refine((value) => new TextEncoder().encode(value).byteLength <= 4_096, "根拠locatorはUTF-8で4096バイト以下にしてください。");
const editRequestSchema = proposalRequestSchema
  .extend({
    operation_id: identifierSchema,
    operation: proposalOperationKindSchema,
    after: z.unknown(),
    evidence_locator: editLocatorSchema,
  })
  .strict()
  .transform((request, context) => {
    const value = proposalEditValueSchema.safeParse({ operation: request.operation, after: request.after });
    if (!value.success) {
      for (const issue of value.error.issues) {
        context.addIssue({ code: "custom", path: issue.path, message: issue.message });
      }
      return z.NEVER;
    }
    return { ...request, ...value.data };
  });
const externalSelectionRequestSchema = z
  .object({
    proposal_id: identifierSchema,
    revision: z.number().int().positive(),
    selection: proposalSelectionSchema,
  })
  .strict();
const externalEditRequestSchema = z
  .object({
    proposal_id: identifierSchema,
    revision: z.number().int().positive(),
    operation_id: identifierSchema,
    operation: proposalOperationKindSchema,
    after: z.unknown(),
    evidence_locator: editLocatorSchema,
  })
  .strict()
  .transform((request, context) => {
    const value = proposalEditValueSchema.safeParse({ operation: request.operation, after: request.after });
    if (!value.success) {
      for (const issue of value.error.issues) {
        context.addIssue({ code: "custom", path: issue.path, message: issue.message });
      }
      return z.NEVER;
    }
    return { ...request, ...value.data };
  });
const externalRejectRequestSchema = z
  .object({
    proposal_id: identifierSchema,
    revision: z.number().int().positive(),
  })
  .strict();
const historyEntrySchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("confirmation_required"),
      proposal_id: identifierSchema,
      operation_id: identifierSchema,
      target_id: identifierSchema,
      target_kind: z.enum(["task", "temporary", "new_task"]),
      source_stage: identifierSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("synchronization_required"),
      proposal_id: identifierSchema,
      operation_id: identifierSchema,
      target_id: identifierSchema,
      target_kind: z.enum(["task", "temporary", "new_task"]),
      confirmed_result: z.enum(["applied", "not_applied", "manually_adjusted"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("history_invalid"),
      proposal_id: identifierSchema,
      operation_id: identifierSchema,
      error_id: errorIdSchema,
    })
    .strict(),
]);
const historyStatusSchema = z.object({ entries: z.array(historyEntrySchema).max(10_000) }).strict();
const historyConfirmRequestSchema = z
  .object({
    proposal_id: identifierSchema,
    operation_id: identifierSchema,
    checked_target_id: identifierSchema,
    confirmed_result: z.enum(["applied", "not_applied", "manually_adjusted"]),
    asana_checked: z.literal(true),
  })
  .strict();
const executionRequestSchema = z.object({ execution_id: identifierSchema }).strict();
const retryExecutionRequestSchema = z.object({ retry_of_execution_id: identifierSchema }).strict();
const proposalExecutionSchema = executionDtoSchema.refine((execution) => execution.origin === "proposal");
const approvalResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("execution"), execution: proposalExecutionSchema }).strict(),
  z.object({
    kind: z.literal("not_started"),
    proposal_id: identifierSchema,
    outcome: z.enum(["already_applied", "not_applied", "partially_applied"]),
    operation_results: z.array(z.object({
      group_id: identifierSchema,
      operation_id: identifierSchema,
      task_gid: gidSchema.optional(),
      outcome: z.enum(["already_applied", "not_applied"]),
      reason_code: identifierSchema,
    }).strict()).min(1),
    group_results: z.array(z.object({
      group_id: identifierSchema,
      atomic: z.boolean(),
      operation_ids: z.array(identifierSchema).min(1),
      outcome: z.enum(["already_applied", "not_applied", "partially_applied"]),
    }).strict()).min(1),
  }).strict(),
]);
const retryExecutionResponseSchema = responseSchema(
  proposalExecutionSchema.refine(
    (execution) => execution.retry_of_execution_id != null,
    "再試行元の実行IDがありません。",
  ),
);
const aiDeltaSchema = z
  .object({
    session_id: identifierSchema,
    thread_id: identifierSchema,
    turn_id: identifierSchema,
    item_id: identifierSchema,
    delta: z.string().max(200_000),
  })
  .strict();

export const proposalsContracts = {
  getAiStatus: {
    channel: proposalsChannels.getAiStatus,
    request: emptyRequestSchema,
    response: responseSchema(aiStatusSchema),
  },
  startSession: {
    channel: proposalsChannels.startSession,
    request: emptyRequestSchema,
    response: responseSchema(sessionStartSchema),
  },
  startTurn: {
    channel: proposalsChannels.startTurn,
    request: turnRequestSchema,
    response: responseSchema(turnResultSchema),
  },
  getProposal: {
    channel: proposalsChannels.getProposal,
    request: proposalRequestSchema,
    response: responseSchema(proposalViewSchema),
  },
  select: {
    channel: proposalsChannels.select,
    request: selectionRequestSchema,
    response: responseSchema(proposalViewSchema),
  },
  editOperation: {
    channel: proposalsChannels.editOperation,
    request: editRequestSchema,
    response: responseSchema(proposalViewSchema),
  },
  reject: {
    channel: proposalsChannels.reject,
    request: proposalRequestSchema,
    response: responseSchema(completedSchema),
  },
  approve: {
    channel: proposalsChannels.approve,
    request: selectionRequestSchema,
    response: responseSchema(approvalResultSchema),
  },
  closeSession: {
    channel: proposalsChannels.closeSession,
    request: z.object({ session_id: identifierSchema }).strict(),
    response: responseSchema(completedSchema),
  },
  getExternalState: {
    channel: proposalsChannels.getExternalState,
    request: emptyRequestSchema,
    response: responseSchema(externalProposalStateSchema),
  },
  setExternalEnabled: {
    channel: proposalsChannels.setExternalEnabled,
    request: z.object({ enabled: z.boolean() }).strict(),
    response: responseSchema(externalProposalStateSchema),
  },
  editExternalOperation: {
    channel: proposalsChannels.editExternalOperation,
    request: externalEditRequestSchema,
    response: responseSchema(externalProposalStateSchema),
  },
  selectExternal: {
    channel: proposalsChannels.selectExternal,
    request: externalSelectionRequestSchema,
    response: responseSchema(externalProposalStateSchema),
  },
  approveExternal: {
    channel: proposalsChannels.approveExternal,
    request: externalSelectionRequestSchema,
    response: responseSchema(approvalResultSchema),
  },
  rejectExternal: {
    channel: proposalsChannels.rejectExternal,
    request: externalRejectRequestSchema,
    response: responseSchema(externalProposalStateSchema),
  },
  getHistoryStatus: {
    channel: proposalsChannels.getHistoryStatus,
    request: emptyRequestSchema,
    response: responseSchema(historyStatusSchema),
  },
  confirmHistory: {
    channel: proposalsChannels.confirmHistory,
    request: historyConfirmRequestSchema,
    response: responseSchema(historyStatusSchema),
  },
  synchronizeHistory: {
    channel: proposalsChannels.synchronizeHistory,
    request: emptyRequestSchema,
    response: responseSchema(z.object({ status: historyStatusSchema, synced_at: dateTimeSchema }).strict()),
  },
  getExecution: {
    channel: proposalsChannels.getExecution,
    request: executionRequestSchema,
    response: responseSchema(proposalExecutionSchema),
  },
  retryExecution: {
    channel: proposalsChannels.retryExecution,
    request: retryExecutionRequestSchema,
    response: retryExecutionResponseSchema,
  },
  subscribeAiStatus: {
    channel: proposalsChannels.subscribeAiStatus,
    request: subscriptionRequestSchema,
  },
  unsubscribeAiStatus: {
    channel: proposalsChannels.unsubscribeAiStatus,
    request: subscriptionRequestSchema,
  },
  aiStatus: {
    channel: proposalsChannels.aiStatus,
    event: subscriptionEventSchema(aiStatusSchema),
  },
  subscribeAiDelta: {
    channel: proposalsChannels.subscribeAiDelta,
    request: subscriptionRequestSchema,
  },
  unsubscribeAiDelta: {
    channel: proposalsChannels.unsubscribeAiDelta,
    request: subscriptionRequestSchema,
  },
  aiDelta: {
    channel: proposalsChannels.aiDelta,
    event: subscriptionEventSchema(aiDeltaSchema),
  },
  subscribeExternalState: {
    channel: proposalsChannels.subscribeExternalState,
    request: subscriptionRequestSchema,
  },
  unsubscribeExternalState: {
    channel: proposalsChannels.unsubscribeExternalState,
    request: subscriptionRequestSchema,
  },
  externalState: {
    channel: proposalsChannels.externalState,
    event: subscriptionEventSchema(externalProposalStateSchema),
  },
  subscribeExecution: {
    channel: proposalsChannels.subscribeExecution,
    request: subscriptionRequestSchema,
  },
  unsubscribeExecution: {
    channel: proposalsChannels.unsubscribeExecution,
    request: subscriptionRequestSchema,
  },
  execution: {
    channel: proposalsChannels.execution,
    event: subscriptionEventSchema(proposalExecutionSchema),
  },
};

type ProposalViewResult = Promise<IpcResult<ProposalViewDto>>;
type ExternalStateResult = Promise<IpcResult<z.infer<typeof externalProposalStateSchema>>>;
type ExecutionResult = Promise<IpcResult<ExecutionDto>>;
type ApprovalResult = Promise<IpcResult<z.infer<typeof approvalResultSchema>>>;

export type ProposalsApi = {
  readonly getAiStatus: () => Promise<IpcResult<z.infer<typeof aiStatusSchema>>>;
  readonly startSession: () => Promise<IpcResult<z.infer<typeof sessionStartSchema>>>;
  readonly startTurn: (
    input: z.infer<typeof turnRequestSchema>,
  ) => Promise<IpcResult<z.infer<typeof turnResultSchema>>>;
  readonly getProposal: (input: z.infer<typeof proposalRequestSchema>) => ProposalViewResult;
  readonly select: (input: z.infer<typeof selectionRequestSchema>) => ProposalViewResult;
  readonly editOperation: (input: z.infer<typeof editRequestSchema>) => ProposalViewResult;
  readonly reject: (
    input: z.infer<typeof proposalRequestSchema>,
  ) => Promise<IpcResult<z.infer<typeof completedSchema>>>;
  readonly approve: (input: z.infer<typeof selectionRequestSchema>) => ApprovalResult;
  readonly closeSession: (sessionId: string) => Promise<IpcResult<z.infer<typeof completedSchema>>>;
  readonly getExternalState: () => ExternalStateResult;
  readonly setExternalEnabled: (enabled: boolean) => ExternalStateResult;
  readonly editExternalOperation: (input: z.infer<typeof externalEditRequestSchema>) => ExternalStateResult;
  readonly selectExternal: (input: z.infer<typeof externalSelectionRequestSchema>) => ExternalStateResult;
  readonly approveExternal: (input: z.infer<typeof externalSelectionRequestSchema>) => ApprovalResult;
  readonly rejectExternal: (input: z.infer<typeof externalRejectRequestSchema>) => ExternalStateResult;
  readonly getHistoryStatus: () => Promise<IpcResult<z.infer<typeof historyStatusSchema>>>;
  readonly confirmHistory: (
    input: z.infer<typeof historyConfirmRequestSchema>,
  ) => Promise<IpcResult<z.infer<typeof historyStatusSchema>>>;
  readonly synchronizeHistory: () => Promise<
    IpcResult<{
      readonly status: z.infer<typeof historyStatusSchema>;
      readonly synced_at: string;
    }>
  >;
  readonly getExecution: (executionId: string) => ExecutionResult;
  readonly retryExecution: (retryOfExecutionId: string) => ExecutionResult;
  readonly onAiStatus: IpcSubscription<z.infer<typeof aiStatusSchema>>;
  readonly onAiDelta: IpcSubscription<z.infer<typeof aiDeltaSchema>>;
  readonly onExternalState: IpcSubscription<z.infer<typeof externalProposalStateSchema>>;
  readonly onExecution: IpcSubscription<ExecutionDto>;
};
