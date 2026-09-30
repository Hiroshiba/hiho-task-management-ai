type RequestContext = {
  readonly instance_id: string;
  readonly context_id: string;
  readonly project_gid: string;
};

type CurrentContext = {
  readonly context_id: string;
  readonly project_gid: string;
};

/** 外部要求が現在のアプリとAsana文脈を指すことを確認します。 */
export function assertExternalAgentRequestContext(
  input: RequestContext,
  context: CurrentContext,
  instanceId: string,
  createError: (message: string) => Error,
): void {
  if (input.instance_id !== instanceId) {
    throw createError("TaskHubのinstance_idが一致しません。");
  }
  if (input.context_id !== context.context_id) {
    throw createError("Asanaのcontext_idが一致しません。");
  }
  if (input.project_gid !== context.project_gid) {
    throw createError("Asanaのproject_gidが一致しません。");
  }
}

/** 外部要求に対応するワークスペースの文脈を取得します。 */
export function requireExternalAgentWorkspace<TPrepared extends RequestContext & {
  readonly workspace: { readonly workspaceId: string };
}>(
  input: RequestContext & { readonly proposal_context_id: string; readonly workspace_id: string },
  ports: {
    readonly requireContext: () => CurrentContext;
    readonly instanceId: string;
    readonly requirePreparedContext: (proposalContextId: string) => TPrepared;
    readonly createError: (message: string) => Error;
  },
): TPrepared {
  const context = ports.requireContext();
  assertExternalAgentRequestContext(input, context, ports.instanceId, ports.createError);
  const prepared = ports.requirePreparedContext(input.proposal_context_id);
  if (
    prepared.instance_id !== input.instance_id
    || prepared.context_id !== input.context_id
    || prepared.project_gid !== input.project_gid
    || prepared.workspace.workspaceId !== input.workspace_id
  ) {
    throw ports.createError("提案基準とワークスペースの文脈が一致しません。");
  }
  return prepared;
}
