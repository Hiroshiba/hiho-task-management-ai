/** 同期後のAIターンと提案ワークスペースを操作する境界です。 */
export interface ProposalGenerationSessionPort<
  TTurnInput,
  TTurnResult,
  TSnapshot,
  TWorkspace,
  TProposal,
  TValidation,
  TDelta,
> {
  startTurnWithPreparation(
    prepareInput: (signal: AbortSignal) => TTurnInput | PromiseLike<TTurnInput>,
    signal: AbortSignal,
  ): Promise<TTurnResult>;
  freezeTaskctlSnapshot(snapshot: TSnapshot): void;
  releaseTaskctlSnapshot(): void;
  activateProposalWorkspace(
    workspace: TWorkspace,
    validate: (proposal: TProposal) => TValidation,
  ): void;
  onDelta(listener: (delta: TDelta) => void | PromiseLike<void>): () => void;
}
