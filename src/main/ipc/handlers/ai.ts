type ProposalInput = { readonly session_id: string; readonly proposal_id: string };
type SelectionInput = ProposalInput & { readonly selection: unknown };
type EditInput = ProposalInput & {
  readonly operation_id: string;
  readonly after: unknown;
  readonly evidence_locator: string;
};

/** AI操作をセッション所有者へ配送し、IPCの表示値を検証します。 */
export function createAiIpcPort<
  TRecord,
  TStatus,
  TDelta,
  TSessionStart,
  TTurnInput,
  TTurnResult,
  TProposalInput extends ProposalInput,
  TSelectionInput extends SelectionInput,
  TEditInput extends EditInput,
  TRejectInput extends ProposalInput,
  TSelectionRequest,
  TEditRequest,
  TView,
  TApprovalInput,
  TApprovalResult,
>(
  dependencies: {
    readonly assertReady: () => void;
    readonly currentStatus: () => TStatus;
    readonly startNewSession: (signal: AbortSignal) => TSessionStart | PromiseLike<TSessionStart>;
    readonly startTurn: (input: TTurnInput, signal: AbortSignal) => TTurnResult | PromiseLike<TTurnResult>;
    readonly withProposalRecord: <TInput extends { readonly session_id: string }, TResult>(
      input: TInput,
      requireAvailable: boolean,
      run: (record: TRecord) => TResult,
    ) => TResult;
    readonly parseProposalId: (value: string) => string;
    readonly parseSelection: (value: { readonly proposal_id: string; readonly selection: TSelectionInput["selection"] }) => TSelectionRequest;
    readonly parseEdit: (value: {
      readonly proposal_id: string;
      readonly operation_id: string;
      readonly after: TEditInput["after"];
      readonly evidence_locator: string;
    }) => TEditRequest;
    readonly parseView: (value: TView) => TView;
    readonly getProposal: (record: TRecord, proposalId: string) => TView;
    readonly select: (record: TRecord, input: TSelectionRequest) => TView;
    readonly editOperation: (record: TRecord, input: TEditRequest) => TView;
    readonly rejectProposal: (record: TRecord, proposalId: string) => void;
    readonly forgetProposal: (record: TRecord, proposalId: string) => void;
    readonly approve: (input: TApprovalInput, signal: AbortSignal) => TApprovalResult | PromiseLike<TApprovalResult>;
    readonly closeSession: (sessionId: string) => Promise<void>;
    readonly onDelta: (listener: (delta: TDelta) => void) => () => void;
    readonly onStatus: (listener: (status: TStatus) => void) => () => void;
  },
): {
  readonly getStatus: () => TStatus;
  readonly startNewSession: (signal: AbortSignal) => TSessionStart | PromiseLike<TSessionStart>;
  readonly startTurn: (input: TTurnInput, signal: AbortSignal) => TTurnResult | PromiseLike<TTurnResult>;
  readonly getProposal: (input: TProposalInput) => TView;
  readonly select: (input: TSelectionInput) => TView;
  readonly editOperation: (input: TEditInput) => TView;
  readonly reject: (input: TRejectInput) => void;
  readonly approve: (input: TApprovalInput, signal: AbortSignal) => TApprovalResult | PromiseLike<TApprovalResult>;
  readonly closeSession: (sessionId: string) => Promise<{ readonly completed: true }>;
  readonly onDelta: (listener: (delta: TDelta) => void) => () => void;
  readonly onStatus: (listener: (status: TStatus) => void) => () => void;
} {
  return {
    getStatus: () => {
      dependencies.assertReady();
      return dependencies.currentStatus();
    },
    startNewSession: (signal) => dependencies.startNewSession(signal),
    startTurn: (input, signal) => dependencies.startTurn(input, signal),
    getProposal: (input) => dependencies.withProposalRecord(input, false, (record) =>
      dependencies.parseView(dependencies.getProposal(record,
        dependencies.parseProposalId(input.proposal_id)))),
    select: (input) => dependencies.withProposalRecord(input, true, (record) =>
      dependencies.parseView(dependencies.select(record, dependencies.parseSelection({
        proposal_id: input.proposal_id,
        selection: input.selection,
      })))),
    editOperation: (input) => dependencies.withProposalRecord(input, true, (record) =>
      dependencies.parseView(dependencies.editOperation(record, dependencies.parseEdit({
        proposal_id: input.proposal_id,
        operation_id: input.operation_id,
        after: input.after,
        evidence_locator: input.evidence_locator,
      })))),
    reject: (input) => {
      dependencies.withProposalRecord(input, true, (record) => {
        const proposalId = dependencies.parseProposalId(input.proposal_id);
        dependencies.rejectProposal(record, proposalId);
        dependencies.forgetProposal(record, proposalId);
      });
    },
    approve: (input, signal) => dependencies.approve(input, signal),
    closeSession: async (sessionId) => {
      await dependencies.closeSession(sessionId);
      return { completed: true };
    },
    onDelta: (listener) => dependencies.onDelta(listener),
    onStatus: (listener) => dependencies.onStatus(listener),
  };
}
