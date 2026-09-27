type SubmittedRequest =
  | {
      readonly kind: "submitted";
      readonly digest: string;
      readonly proposal_id: string;
    }
  | {
      readonly kind: "invalid";
      readonly digest: string;
      readonly workspace_id: string;
      readonly revision: number;
    };

type SubmissionErrorCode =
  | "request_id_reused"
  | "invalid_request"
  | "offline"
  | "capacity_exceeded";

/** 外部提案の提出要求とrequest IDの結果を所有します。 */
export class ExternalAgentSubmission {
  private readonly requests = new Map<string, SubmittedRequest>();

  /** 提出を検証し、同じrequest IDへ同じ結果を返します。 */
  public submit<
    TInput extends { readonly request_id: string; readonly workspace_id: string; readonly expected_revision: number },
    TPrepared extends { readonly request_id: string },
    TProposal,
    TValidation,
    TRecord extends { readonly proposal_id: string },
    TResponse,
  >(
    input: TInput,
    ports: {
      readonly digest: (input: TInput) => string;
      readonly requireProposal: (proposalId: string) => TRecord;
      readonly requireWorkspace: (input: TInput) => TPrepared;
      readonly assertApplyReady: () => void;
      readonly online: () => boolean;
      readonly maximumRequests: number;
      readonly validate: (prepared: TPrepared, input: TInput) =>
        | { readonly kind: "invalid"; readonly revision: number }
        | { readonly kind: "valid"; readonly proposal: TProposal; readonly value: TValidation };
      readonly createProposalId: () => string;
      readonly createRecord: (input: TInput, prepared: TPrepared, proposal: TProposal, value: TValidation, id: string) => TRecord;
      readonly seal: (prepared: TPrepared, input: TInput) => { readonly kind: string; readonly revision: number };
      readonly registerProposal: (record: TRecord) => void;
      readonly emitChanged: () => void;
      readonly createInvalidResponse: (workspaceId: string, revision: number) => TResponse;
      readonly createSubmitResponse: (workspaceId: string, revision: number, record: TRecord) => TResponse;
      readonly createError: (code: SubmissionErrorCode, message: string) => Error;
    },
  ): TResponse {
    const digest = ports.digest(input);
    const existing = this.requests.get(input.request_id);
    if (existing != null) {
      if (existing.digest !== digest) {
        throw ports.createError("request_id_reused", "同じrequest_idへ別の内容を指定できません。");
      }
      if (existing.kind === "invalid") {
        return ports.createInvalidResponse(existing.workspace_id, existing.revision);
      }
      const record = ports.requireProposal(existing.proposal_id);
      return ports.createSubmitResponse(input.workspace_id, input.expected_revision, record);
    }
    const prepared = ports.requireWorkspace(input);
    if (input.request_id === prepared.request_id) {
      throw ports.createError("invalid_request", "提出には準備と別のrequest_idを指定してください。");
    }
    ports.assertApplyReady();
    if (ports.online() !== true) {
      throw ports.createError("offline", "オフライン中は提案を提出できません。");
    }
    if (this.requests.size >= ports.maximumRequests) {
      throw ports.createError("capacity_exceeded", "外部提案の受付上限に達しています。");
    }
    const validation = ports.validate(prepared, input);
    if (validation.kind === "invalid") {
      this.requests.set(input.request_id, {
        kind: "invalid",
        digest,
        workspace_id: input.workspace_id,
        revision: validation.revision,
      });
      return ports.createInvalidResponse(input.workspace_id, validation.revision);
    }
    const proposalId = ports.createProposalId();
    const record = ports.createRecord(input, prepared, validation.proposal, validation.value, proposalId);
    const sealed = ports.seal(prepared, input);
    if (sealed.kind !== "submitted") {
      throw new Error("提出直前の検証結果が変化しました。");
    }
    ports.registerProposal(record);
    this.requests.set(input.request_id, { kind: "submitted", digest, proposal_id: proposalId });
    ports.emitChanged();
    return ports.createSubmitResponse(input.workspace_id, sealed.revision, record);
  }
}
