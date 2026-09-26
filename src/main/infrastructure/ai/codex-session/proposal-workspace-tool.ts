import { z } from "zod";
import type { DynamicToolCallParams, DynamicToolCallResponse } from "../codex-app-server";
import { validateAbortSignal } from "../codex-app-server/rpc-endpoint";
import { CodexSessionError, CodexSessionStateError } from "./errors";

type ProposalToolInput<Edit, Target> =
  | { readonly action: "read"; readonly workspace_id: string; readonly revision: number; readonly target: Target; readonly offset?: number | undefined }
  | { readonly action: "diff"; readonly workspace_id: string; readonly from_revision: number; readonly revision: number; readonly offset?: number | undefined }
  | { readonly action: "edit"; readonly workspace_id: string; readonly edit_batch_id: string; readonly expected_revision: number; readonly edits: Edit[] }
  | { readonly action: "validate"; readonly workspace_id: string; readonly expected_revision: number; readonly offset?: number | undefined }
  | { readonly action: "submit"; readonly workspace_id: string; readonly expected_revision: number };

type ProposalStatus<Issue> = {
  readonly workspace_id: string;
  readonly baseline_snapshot_hash: string;
  readonly revision: number;
  readonly state: string;
  readonly completion: string;
  readonly issues: Issue[];
};

type ProposalValidation<Proposal, Issue> =
  | { readonly kind: "valid"; readonly proposal: Proposal; readonly value: null }
  | { readonly kind: "invalid"; readonly issues: Issue[] };

type ProposalWorkspacePort<Proposal, Edit, Target, Issue> = {
  readonly workspaceId: string;
  getStatus(): ProposalStatus<Issue>;
  read(input: { workspace_id: string; revision: number; target: Target; offset?: number }): unknown;
  diff(input: { workspace_id: string; from_revision: number; revision: number; offset?: number }): unknown;
  applyBatch(input: { workspace_id: string; edit_batch_id: string; expected_revision: number; edits: Edit[] }): ProposalStatus<Issue>;
  submit(input: { workspace_id: string; expected_revision: number }, validate: (proposal: Proposal) => ProposalValidation<Proposal, Issue>):
    | { kind: "submitted"; revision: number }
    | { kind: "invalid"; revision: number; issues: Issue[] };
};

type ActiveWorkspace<Proposal, Issue, Workspace> = {
  readonly workspace: Workspace;
  readonly validate: (proposal: Proposal) => ProposalValidation<Proposal, Issue>;
};

type ActiveTurn =
  | { readonly phase: "starting"; readonly threadId: string; readonly signal: AbortSignal; readonly abortRequested: boolean }
  | { readonly phase: "running"; readonly threadId: string; readonly turnId: string; readonly signal: AbortSignal; readonly abortRequested: boolean };

type ProposalResponseSerializer = {
  serializeProposalWorkspaceToolResponse(value: unknown, success: boolean): DynamicToolCallResponse;
  serializeProposalWorkspaceInvalidRequest(error: z.ZodError): DynamicToolCallResponse;
  serializeProposalWorkspaceIssuesResponse<Result extends object, Issue>(result: Result, issues: readonly Issue[], offset: number, success: boolean): DynamicToolCallResponse;
};

type ProposalWorkspaceToolOptions<Proposal, Edit, Target, Issue, Workspace> = {
  readonly inputSchema: z.ZodType<ProposalToolInput<Edit, Target>>;
  readonly getActiveTurn: () => ActiveTurn | undefined;
  readonly getActiveWorkspace: () => ActiveWorkspace<Proposal, Issue, Workspace> | undefined;
  readonly getThreadId: () => string | undefined;
  readonly responseSerializer: ProposalResponseSerializer;
  readonly maximumArgumentBytes: number;
  readonly readDraft: (workspace: Workspace) => Proposal;
  readonly createAbortError: () => Error;
};

type DraftReadPort = {
  getStatus(): { readonly workspace_id: string; readonly revision: number };
  read(input: {
    readonly workspace_id: string;
    readonly revision: number;
    readonly target: { readonly kind: "proposal" };
    readonly offset: number;
  }): { readonly content: string; readonly next_offset?: number | undefined };
};

/** AI変更案ワークスペースの全草稿を読み取ります。 */
export function readProposalWorkspaceDraft<Proposal>(workspace: DraftReadPort, schema: z.ZodType<Proposal>): Proposal {
  const status = workspace.getStatus();
  let offset = 0;
  let content = "";
  while (true) {
    const chunk = workspace.read({
      workspace_id: status.workspace_id,
      revision: status.revision,
      target: { kind: "proposal" },
      offset,
    });
    content += chunk.content;
    if (chunk.next_offset == null) {
      return schema.parse(JSON.parse(content));
    }
    offset = chunk.next_offset;
  }
}

function createIncompleteValidation<Issue>(issues: Issue[]): { kind: "invalid"; issues: Issue[] } {
  return { kind: "invalid", issues };
}

/** AI変更案ワークスペースのdynamic tool要求を処理します。 */
export function handleCodexProposalWorkspaceTool<Proposal, Edit, Target, Issue, Workspace extends ProposalWorkspacePort<Proposal, Edit, Target, Issue>>(
  params: DynamicToolCallParams,
  signal: AbortSignal,
  options: ProposalWorkspaceToolOptions<Proposal, Edit, Target, Issue, Workspace>,
): DynamicToolCallResponse {
  validateAbortSignal(signal);
  if (params.namespace != null || params.tool !== "proposal_workspace") {
    throw new CodexSessionError("AI変更案ワークスペースのdynamic tool名が不正です。");
  }
  const activeTurn = options.getActiveTurn();
  const activeWorkspace = options.getActiveWorkspace();
  if (activeTurn == null || activeTurn.phase !== "running" || activeWorkspace == null) {
    throw new CodexSessionStateError();
  }
  if (
    params.threadId !== activeTurn.threadId
    || params.turnId !== activeTurn.turnId
    || params.threadId !== options.getThreadId()
  ) {
    throw new CodexSessionError("AI変更案ワークスペースのターンが不正です。");
  }
  if (signal.aborted || activeTurn.signal.aborted || activeTurn.abortRequested) {
    throw options.createAbortError();
  }
  const serializedArguments = JSON.stringify(params.arguments);
  if (
    serializedArguments == null
    || Buffer.byteLength(serializedArguments, "utf8") > options.maximumArgumentBytes
  ) {
    return options.responseSerializer.serializeProposalWorkspaceToolResponse({
      ok: false,
      error: { code: "argument_too_large", message: "引数が128 KiBの上限を超えています。" },
    }, false);
  }
  const parsed = options.inputSchema.safeParse(params.arguments);
  if (!parsed.success) {
    return options.responseSerializer.serializeProposalWorkspaceInvalidRequest(parsed.error);
  }
  if (parsed.data.workspace_id !== activeWorkspace.workspace.workspaceId) {
    throw new CodexSessionError("今回のターン以外のAI変更案ワークスペースは操作できません。");
  }
  const { workspace, validate } = activeWorkspace;
  let response: DynamicToolCallResponse;
  switch (parsed.data.action) {
    case "read":
      response = options.responseSerializer.serializeProposalWorkspaceToolResponse(workspace.read({
        workspace_id: parsed.data.workspace_id,
        revision: parsed.data.revision,
        target: parsed.data.target,
        ...(parsed.data.offset == null ? {} : { offset: parsed.data.offset }),
      }), true);
      break;
    case "diff":
      response = options.responseSerializer.serializeProposalWorkspaceToolResponse(workspace.diff({
        workspace_id: parsed.data.workspace_id,
        from_revision: parsed.data.from_revision,
        revision: parsed.data.revision,
        ...(parsed.data.offset == null ? {} : { offset: parsed.data.offset }),
      }), true);
      break;
    case "edit": {
      const status = workspace.applyBatch({
        workspace_id: parsed.data.workspace_id,
        edit_batch_id: parsed.data.edit_batch_id,
        expected_revision: parsed.data.expected_revision,
        edits: parsed.data.edits,
      });
      response = options.responseSerializer.serializeProposalWorkspaceIssuesResponse({
        workspace_id: status.workspace_id,
        baseline_snapshot_hash: status.baseline_snapshot_hash,
        revision: status.revision,
        state: status.state,
        completion: status.completion,
      }, status.issues, 0, true);
      break;
    }
    case "validate": {
      const status = workspace.getStatus();
      if (status.revision !== parsed.data.expected_revision) {
        throw new CodexSessionError("AI変更案ワークスペースの改訂番号が一致しません。");
      }
      const validation = status.completion === "structurally_complete"
        ? validate(options.readDraft(workspace))
        : createIncompleteValidation(status.issues);
      const offset = parsed.data.offset ?? 0;
      response = validation.kind === "valid"
        ? options.responseSerializer.serializeProposalWorkspaceToolResponse({
          workspace_id: status.workspace_id,
          revision: status.revision,
          valid: true,
        }, true)
        : options.responseSerializer.serializeProposalWorkspaceIssuesResponse({
          workspace_id: status.workspace_id,
          revision: status.revision,
          valid: false,
        }, validation.issues, offset, false);
      break;
    }
    case "submit": {
      const submitted = workspace.submit({
        workspace_id: parsed.data.workspace_id,
        expected_revision: parsed.data.expected_revision,
      }, validate);
      response = submitted.kind === "submitted"
        ? options.responseSerializer.serializeProposalWorkspaceToolResponse({
          kind: "submitted",
          workspace_id: workspace.workspaceId,
          revision: submitted.revision,
        }, true)
        : options.responseSerializer.serializeProposalWorkspaceIssuesResponse({
          kind: "invalid",
          workspace_id: workspace.workspaceId,
          revision: submitted.revision,
        }, submitted.issues, 0, false);
      break;
    }
  }
  if (signal.aborted || activeTurn.signal.aborted || activeTurn.abortRequested) {
    throw options.createAbortError();
  }
  return response;
}
