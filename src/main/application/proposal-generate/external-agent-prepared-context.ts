type PreparationInput = {
  readonly request_id: string;
  readonly instance_id: string;
  readonly context_id: string;
  readonly project_gid: string;
  readonly source_text: string;
};

type AsanaContext = { readonly context_id: string; readonly project_gid: string };

type PreparationSnapshot = {
  readonly app_version: string;
  readonly project_gid: string;
  readonly synced_at: string;
  readonly as_of: string;
  readonly tasks: unknown;
};

/** 外部提案の準備基準とワークスペースを組み立てます。 */
export function createExternalAgentPreparedContext<
  TSnapshot extends PreparationSnapshot,
  TExternalData,
  TBaseline extends { readonly project_gid?: string | undefined },
  TTaskctl,
  TTurnContext,
  TWorkspace,
>(
  input: PreparationInput,
  context: AsanaContext,
  baseline: {
    readonly snapshot: TSnapshot;
    readonly baseline_snapshot: unknown;
    readonly baseline_external_data: TExternalData;
    readonly taskctl_snapshot: unknown;
  },
  ports: {
    readonly stopped: () => boolean;
    readonly currentContextId: () => string | undefined;
    readonly parseBaseline: (value: unknown) => TBaseline;
    readonly parseTaskctl: (value: unknown) => TTaskctl;
    readonly taskctlSummary: (taskctl: TTaskctl) => {
      readonly sync_kind: string;
      readonly synced_at?: string | undefined;
      readonly tasks: unknown;
    };
    readonly canonicalize: (value: unknown) => string;
    readonly createId: () => string;
    readonly hashBaseline: (baseline: TBaseline) => string;
    readonly parseTurnContext: (value: unknown) => TTurnContext;
    readonly createWorkspace: (workspaceId: string, baselineSnapshotHash: string) => TWorkspace;
    readonly createError: (code: "context_changed" | "conflict", message: string) => Error;
  },
): {
  readonly request_id: string;
  readonly instance_id: string;
  readonly context_id: string;
  readonly project_gid: string;
  readonly proposal_context_id: string;
  readonly source_text: string;
  readonly evidence_locator_prefix: string;
  readonly snapshot: TSnapshot;
  readonly baseline_snapshot: TBaseline;
  readonly baseline_external_data: TExternalData;
  readonly taskctl_snapshot: TTaskctl;
  readonly turn_context: TTurnContext;
  readonly workspace: TWorkspace;
} {
  if (ports.stopped() || ports.currentContextId() !== context.context_id) {
    throw ports.createError("context_changed", "提案準備中にAsana文脈が変更されました。");
  }
  const validatedBaseline = ports.parseBaseline(baseline.baseline_snapshot);
  const validatedTaskctlSnapshot = ports.parseTaskctl(baseline.taskctl_snapshot);
  const taskctl = ports.taskctlSummary(validatedTaskctlSnapshot);
  if (
    baseline.snapshot.project_gid !== context.project_gid
    || validatedBaseline.project_gid !== context.project_gid
    || taskctl.sync_kind !== "synced"
    || taskctl.synced_at !== baseline.snapshot.synced_at
    || ports.canonicalize(taskctl.tasks) !== ports.canonicalize(baseline.snapshot.tasks)
  ) {
    throw ports.createError("conflict", "提案基準とtaskctl基準が一致しません。");
  }
  const proposalContextId = ports.createId();
  const workspaceId = ports.createId();
  const baselineSnapshotHash = ports.hashBaseline(validatedBaseline);
  const turnContext = ports.parseTurnContext({
    baseline_snapshot_hash: baselineSnapshotHash,
    app_version: baseline.snapshot.app_version,
    project_gid: baseline.snapshot.project_gid,
    synced_at: baseline.snapshot.synced_at,
    as_of: baseline.snapshot.as_of,
  });
  return {
    request_id: input.request_id,
    instance_id: input.instance_id,
    context_id: input.context_id,
    project_gid: input.project_gid,
    proposal_context_id: proposalContextId,
    source_text: input.source_text,
    evidence_locator_prefix: `external-review:${proposalContextId}`,
    snapshot: baseline.snapshot,
    baseline_snapshot: validatedBaseline,
    baseline_external_data: baseline.baseline_external_data,
    taskctl_snapshot: validatedTaskctlSnapshot,
    turn_context: turnContext,
    workspace: ports.createWorkspace(workspaceId, baselineSnapshotHash),
  };
}
