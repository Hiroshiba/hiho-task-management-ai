type Sources<TSource, TSummary> = {
  readonly user_message_source_id: string;
  readonly user_message_sources: readonly TSummary[];
  readonly withdraw_confirmation_source_id: string | undefined;
  readonly source_map: ReadonlyMap<string, TSource>;
};

/** 同期済み状態と会話原文からターンの固定基準値を準備します。 */
export async function prepareTurn<
  TSnapshot,
  TBaseline,
  TExternal,
  TTaskctl,
  TPending,
  TSource,
  TSummary,
  TTrusted,
  TStatusAlias,
  TSplitAlias,
>(
  input: {
    readonly signal: AbortSignal;
    readonly message: string;
    readonly logicalTurnId: string;
    readonly turnGeneration: number;
    readonly sessionGeneration: number;
    readonly pendingWithdrawConfirmation: TPending | undefined;
    readonly completedEvidenceSources: ReadonlyMap<string, TSource>;
  },
  dependencies: {
    readonly snapshotProvider: (signal: AbortSignal) => TSnapshot | PromiseLike<TSnapshot>;
    readonly parseSnapshot: (value: TSnapshot) => TSnapshot;
    readonly createBaselineSnapshot: (snapshot: TSnapshot) => TBaseline;
    readonly hashBaselineSnapshot: (baseline: TBaseline) => string;
    readonly baselineExternalDataProvider: (baseline: TBaseline, signal: AbortSignal) => TExternal | PromiseLike<TExternal>;
    readonly parseBaselineExternalData: (value: TExternal) => TExternal;
    readonly taskctlSnapshotProvider: (signal: AbortSignal) => TTaskctl | PromiseLike<TTaskctl>;
    readonly parseTaskctlSnapshot: (value: TTaskctl) => TTaskctl;
    readonly assertTaskctlSnapshotMatchesBaseline: (snapshot: TSnapshot, baseline: TBaseline, taskctl: TTaskctl) => void;
    readonly isPendingWithdrawConfirmationValid: (snapshot: TSnapshot, pending: TPending) => boolean;
    readonly createEvidenceSourceMap: (
      logicalTurnId: string, message: string, snapshot: TSnapshot,
      completedEvidenceSources: ReadonlyMap<string, TSource>, pending: TPending | undefined,
    ) => Sources<TSource, TSummary>;
    readonly createInheritedEvidenceAliases: (
      sourceMap: ReadonlyMap<string, TSource>, snapshot: TSnapshot, baseline: TBaseline,
    ) => { readonly status: readonly TStatusAlias[]; readonly split: readonly TSplitAlias[] };
    readonly createTrustedStatusEvidence: (snapshot: TSnapshot) => readonly TTrusted[];
  },
): Promise<{
  readonly snapshot: TSnapshot;
  readonly baseline: TBaseline;
  readonly baseline_snapshot_hash: string;
  readonly baseline_external_data: TExternal;
  readonly taskctl_snapshot: TTaskctl;
  readonly user_message_source_id: string;
  readonly user_message_sources: readonly TSummary[];
  readonly withdraw_confirmation_source_id: string | undefined;
  readonly source_map: ReadonlyMap<string, TSource>;
  readonly pending_withdraw_confirmation: TPending | undefined;
  readonly trusted_status_evidence: readonly TTrusted[];
  readonly inherited_status_evidence_aliases: readonly TStatusAlias[];
  readonly inherited_split_instruction_aliases: readonly TSplitAlias[];
}> {
  const rawSnapshot = await dependencies.snapshotProvider(input.signal);
  const snapshot = dependencies.parseSnapshot(rawSnapshot);
  const baseline = dependencies.createBaselineSnapshot(snapshot);
  const baselineSnapshotHash = dependencies.hashBaselineSnapshot(baseline);
  const baselineExternalData = await dependencies.baselineExternalDataProvider(
    baseline, input.signal,
  );
  const validatedBaselineExternalData = dependencies.parseBaselineExternalData(baselineExternalData);
  const rawTaskctlSnapshot = await dependencies.taskctlSnapshotProvider(input.signal);
  const taskctlSnapshot = dependencies.parseTaskctlSnapshot(rawTaskctlSnapshot);
  dependencies.assertTaskctlSnapshotMatchesBaseline(snapshot, baseline, taskctlSnapshot);
  const pendingForTurn = input.turnGeneration === input.sessionGeneration
    && input.pendingWithdrawConfirmation != null
    && dependencies.isPendingWithdrawConfirmationValid(
      snapshot, input.pendingWithdrawConfirmation,
    )
    ? input.pendingWithdrawConfirmation
    : undefined;
  const sources = dependencies.createEvidenceSourceMap(
    input.logicalTurnId,
    input.message,
    snapshot,
    input.completedEvidenceSources,
    pendingForTurn,
  );
  const inheritedAliases = dependencies.createInheritedEvidenceAliases(
    sources.source_map, snapshot, baseline,
  );
  return {
    snapshot,
    baseline,
    baseline_snapshot_hash: baselineSnapshotHash,
    baseline_external_data: validatedBaselineExternalData,
    taskctl_snapshot: taskctlSnapshot,
    user_message_source_id: sources.user_message_source_id,
    user_message_sources: sources.user_message_sources,
    withdraw_confirmation_source_id: sources.withdraw_confirmation_source_id,
    source_map: sources.source_map,
    pending_withdraw_confirmation: pendingForTurn,
    trusted_status_evidence: dependencies.createTrustedStatusEvidence(snapshot),
    inherited_status_evidence_aliases: inheritedAliases.status,
    inherited_split_instruction_aliases: inheritedAliases.split,
  };
}

/** 固定基準値をワークスペースへ接続してCodexへ渡す入力を作ります。 */
export function createTurnInput<
  TSnapshot,
  TTaskctl,
  TTrusted,
  TPrepared extends {
    readonly snapshot: TSnapshot;
    readonly taskctl_snapshot: TTaskctl;
    readonly baseline_snapshot_hash: string;
    readonly trusted_status_evidence: readonly TTrusted[];
  },
  TProposal,
  TWorkspace,
  TExternal,
  TValidation,
  TRequest,
  TRetryContext,
>(
  input: {
    readonly prepared: TPrepared;
    readonly proposal: TProposal | undefined;
    readonly request: TRequest;
    readonly retryPromptContext: TRetryContext;
    readonly attemptId: string;
    readonly signal: AbortSignal;
    readonly markPrepared: (prepared: TPrepared, workspace: TWorkspace) => void;
    readonly updateResources: (state: {
      readonly kind: "collector_active_snapshot_frozen";
      readonly attemptId: string;
    }) => void;
  },
  dependencies: {
    readonly rebindInitialProposal: (proposal: TProposal | undefined, prepared: TPrepared) => TProposal | undefined;
    readonly createWorkspace: (baselineHash: string, initialProposal: TProposal | undefined) => TWorkspace;
    readonly freezeTaskctlSnapshot: (snapshot: TTaskctl) => void;
    readonly activateProposalWorkspace: (workspace: TWorkspace, validate: (proposal: TProposal) => TValidation) => void;
    readonly snapshotExternalEvidence: (attemptId: string, signal: AbortSignal) => readonly TExternal[];
    readonly parseExternalEvidence: (value: readonly TExternal[]) => readonly TExternal[];
    readonly createTrustedStatusEvidence: (snapshot: TSnapshot, external: readonly TExternal[]) => readonly TTrusted[];
    readonly validateWorkspaceProposal: (proposal: TProposal, prepared: TPrepared) => TValidation;
    readonly createTurnPrompt: (request: TRequest, prepared: TPrepared, workspace: TWorkspace, context: TRetryContext) => string;
  },
): { readonly type: "text"; readonly text: string }[] {
  const prepared = input.prepared;
  const initialProposal = dependencies.rebindInitialProposal(input.proposal, prepared);
  const workspace = dependencies.createWorkspace(
    prepared.baseline_snapshot_hash, initialProposal,
  );
  dependencies.freezeTaskctlSnapshot(prepared.taskctl_snapshot);
  input.updateResources({
    kind: "collector_active_snapshot_frozen",
    attemptId: input.attemptId,
  });
  input.markPrepared(prepared, workspace);
  dependencies.activateProposalWorkspace(workspace, (proposal) => {
    const externalEvidence = dependencies.parseExternalEvidence(
      dependencies.snapshotExternalEvidence(input.attemptId, input.signal),
    );
    return dependencies.validateWorkspaceProposal(proposal, {
      ...prepared,
      trusted_status_evidence: dependencies.createTrustedStatusEvidence(
        prepared.snapshot, externalEvidence,
      ),
    });
  });
  return [{
    type: "text",
    text: dependencies.createTurnPrompt(
      input.request, prepared, workspace, input.retryPromptContext,
    ),
  }];
}
