import { createHash } from "node:crypto";
import { z } from "zod";
import { redactSensitiveText } from "../infrastructure/logging";
import { CodexSessionOutputValidationError, CodexSessionSyncError } from "../infrastructure/ai";
import { canonicalizeJson, taskSchema, aiWorkflowApprovalRequestSchema, aiWorkflowApprovalResultSchema } from "../domain";
import {
  AiWorkflowService,
  AiWorkflowError,
  AiWorkflowOfflineError,
  AiWorkflowRetryLogEventError,
  assertSelectedProposalGraphIsSafe,
  aiWorkflowRetryLogEventSchema,
  resolveSelectedOperationIds,
  createBaselineTaskSnapshots,
  type AiWorkflowOptions,
  type AiWorkflowRetryLogEvent,
  type ApprovalPreparationInput,
} from "../application/proposal-generate";
import {
  applyExistingStoredProposal,
  approveStoredProposal,
  assertApprovalInputMatchesStored,
  createApplicationSummary,
  createApprovalPreparationInput,
  type StoredProposalExecutionPort,
} from "../application/proposal-apply";
import {
  asanaProposalApplicationInputSchema,
  asanaProposalApplicationResultSchema,
  type AsanaProposalApplicationInput,
  type AsanaProposalApplicationResult,
} from "../application/common/proposal-application-schemas";
import { throwIfAborted } from "../application/common/abort-signal";

type DynamicAiWorkflowOptions = Omit<AiWorkflowOptions,
  | "hashCanonicalJson"
  | "redactSensitiveText"
  | "isSessionOutputValidationError"
  | "isSessionSyncError"
  | "executeApproval"
  | "logRetryEvent"
> & {
  readonly proposalPort: StoredProposalExecutionPort;
  readonly isOnline: () => boolean;
  readonly prepareApprovalInput: (input: ApprovalPreparationInput, signal: AbortSignal) => Promise<AsanaProposalApplicationInput>;
  readonly applyProposal: (input: AsanaProposalApplicationInput, signal: AbortSignal) => Promise<AsanaProposalApplicationResult>;
  readonly diagnostic: (error: unknown, severity: "warning" | "error") => void;
};

/** AI変更案の承認と診断を結線したworkflowを生成します。 */
export function createAiWorkflow(options: DynamicAiWorkflowOptions): AiWorkflowService {
  return new AiWorkflowService({
    ...options,
    hashCanonicalJson: (value) => createHash("sha256")
      .update(canonicalizeJson(value)).digest("hex"),
    redactSensitiveText,
    isSessionOutputValidationError: (error): error is CodexSessionOutputValidationError =>
      error instanceof CodexSessionOutputValidationError,
    isSessionSyncError: (error) => error instanceof CodexSessionSyncError,
    executeApproval: (input, signal, store) => approveStoredProposal(input, signal, {
      parseRequest: (value) => aiWorkflowApprovalRequestSchema.parse(value),
      throwIfAborted,
      getStoredProposal: store.getStoredProposal,
      resolveSelection: (stored, selection: z.infer<typeof aiWorkflowApprovalRequestSchema>["selection"]) =>
        resolveSelectedOperationIds(stored, selection),
      loadSavedApplication: async (stored, selected, currentSignal) => {
        const existing = await applyExistingStoredProposal(
          stored.proposal_id,
          stored.proposal,
          selected,
          options.proposalPort,
          currentSignal,
        );
        return existing == null ? undefined : asanaProposalApplicationResultSchema.parse(existing);
      },
      assertGraphSafe: assertSelectedProposalGraphIsSafe,
      isOnline: options.isOnline,
      OfflineError: AiWorkflowOfflineError,
      createPreparationInput: (stored, selected): ApprovalPreparationInput =>
        createApprovalPreparationInput(stored, selected),
      prepareApprovalInput: options.prepareApprovalInput,
      parseApprovalInput: (value) => asanaProposalApplicationInputSchema.parse(value),
      assertApprovalInputMatchesStored: (validated, stored, selected) =>
        assertApprovalInputMatchesStored(validated, stored, selected, {
          canonicalizeJson,
          createBaselineTaskSnapshots: (tasks) => createBaselineTaskSnapshots(z.array(taskSchema).parse(tasks)),
          WorkflowError: AiWorkflowError,
        }),
      apply: options.applyProposal,
      parseApplication: (value) => asanaProposalApplicationResultSchema.parse(value),
      createResult: (stored, application) => aiWorkflowApprovalResultSchema.parse({
        proposal_id: stored.proposal_id,
        ...(application.execution_id == null ? {} : { execution_id: application.execution_id }),
        application: createApplicationSummary(application),
      }),
      forgetProposal: store.forgetProposal,
      WorkflowError: AiWorkflowError,
    }),
    logRetryEvent: (event: AiWorkflowRetryLogEvent) => {
      const validatedEvent = aiWorkflowRetryLogEventSchema.parse(event);
      options.diagnostic(
        new AiWorkflowRetryLogEventError(validatedEvent),
        validatedEvent.severity === "warning" ? "warning" : "error",
      );
    },
  });
}
