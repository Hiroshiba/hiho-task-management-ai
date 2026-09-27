/** 再取得した承認入力を検証し、変更案を一度だけ適用します。 */
export async function approveStoredProposal<
  TStored extends { readonly proposal_id: string },
  TRequest extends { readonly proposal_id: string; readonly selection: unknown },
  TSelection,
  TPreparation,
  TInput,
  TApplication extends { readonly proposal_id: string },
  TResult,
>(
  input: unknown,
  signal: AbortSignal,
  dependencies: {
    readonly parseRequest: (value: unknown) => TRequest;
    readonly throwIfAborted: (signal: AbortSignal) => void;
    readonly getStoredProposal: (proposalId: string) => TStored;
    readonly resolveSelection: (stored: TStored, selection: TRequest["selection"]) => TSelection;
    readonly loadSavedApplication: (stored: TStored, selected: TSelection, signal: AbortSignal) =>
      TApplication | undefined | PromiseLike<TApplication | undefined>;
    readonly assertGraphSafe: (stored: TStored, selected: TSelection) => void;
    readonly isOnline: () => boolean;
    readonly OfflineError: new () => Error;
    readonly createPreparationInput: (stored: TStored, selected: TSelection) => TPreparation;
    readonly prepareApprovalInput: (input: TPreparation, signal: AbortSignal) => TInput | PromiseLike<TInput>;
    readonly parseApprovalInput: (value: TInput) => TInput;
    readonly assertApprovalInputMatchesStored: (input: TInput, stored: TStored, selected: TSelection) => void;
    readonly apply: (input: TInput, signal: AbortSignal) => TApplication | PromiseLike<TApplication>;
    readonly parseApplication: (value: TApplication) => TApplication;
    readonly createResult: (stored: TStored, application: TApplication) => TResult;
    readonly forgetProposal: (proposalId: string) => void;
    readonly WorkflowError: new (message: string) => Error;
  },
): Promise<TResult> {
  const request = dependencies.parseRequest(input);
  dependencies.throwIfAborted(signal);
  const stored = dependencies.getStoredProposal(request.proposal_id);
  const selected = dependencies.resolveSelection(stored, request.selection);
  const savedApplication = await dependencies.loadSavedApplication(stored, selected, signal);
  let application: TApplication;
  if (savedApplication != null) {
    application = dependencies.parseApplication(savedApplication);
  } else {
    dependencies.assertGraphSafe(stored, selected);
    if (dependencies.isOnline() !== true) {
      throw new dependencies.OfflineError();
    }
    const approvalInput = await dependencies.prepareApprovalInput(
      dependencies.createPreparationInput(stored, selected), signal,
    );
    const validatedInput = dependencies.parseApprovalInput(approvalInput);
    dependencies.assertApprovalInputMatchesStored(validatedInput, stored, selected);
    if (dependencies.isOnline() !== true) {
      throw new dependencies.OfflineError();
    }
    application = dependencies.parseApplication(
      await dependencies.apply(validatedInput, signal),
    );
  }
  if (application.proposal_id !== stored.proposal_id) {
    throw new dependencies.WorkflowError("適用結果の変更案IDが一致しません。");
  }
  const result = dependencies.createResult(stored, application);
  dependencies.forgetProposal(stored.proposal_id);
  return result;
}
