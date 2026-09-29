type RuntimeState = {
  readonly kind: string;
  readonly last_successful_sync_at?: string | undefined;
  readonly last_error_code?: string | undefined;
};

type BridgeState = { readonly kind: string; readonly enabled: boolean };

/** 外部連携で利用できる操作を現在の状態から列挙します。 */
function externalAgentCapabilities(
  contextConfigured: boolean,
  runtime: RuntimeState | undefined,
  bridge: BridgeState,
  onlineProvider: () => boolean,
  preparedContextCount: number,
  proposalCount: number,
): readonly string[] {
  if (bridge.kind !== "running" || bridge.enabled !== true) {
    return [];
  }
  const capabilities: string[] = ["proposals.status"];
  if (contextConfigured && runtime?.last_successful_sync_at != null) {
    capabilities.push(
      "tasks.list",
      "tasks.get",
      "tasks.rank",
      "tasks.graph",
      "tasks.areas",
      "tasks.search-local",
    );
  }
  const runtimeCanAcceptProposal = runtime != null
    && (runtime.kind === "online" || runtime.kind === "syncing")
    && runtime.last_successful_sync_at != null
    && runtime.last_error_code == null;
  const canAcceptProposal = contextConfigured
    && runtimeCanAcceptProposal
    && onlineProvider() === true;
  if (canAcceptProposal) {
    capabilities.push("proposals.prepare");
  }
  if (preparedContextCount > 0) {
    capabilities.push(
      "proposals.read",
      "proposals.apply-edits",
      "proposals.diff",
      "proposals.validate",
    );
    if (canAcceptProposal) {
      capabilities.push("proposals.submit");
    }
  }
  if (proposalCount > 0) {
    capabilities.push("review.open");
  }
  return capabilities;
}

/** Asana同期状態を外部連携の表示状態へ変換します。 */
function externalAgentSyncStatus(runtime: RuntimeState | undefined):
  | "synced"
  | "syncing"
  | "offline"
  | "never_synced" {
  if (runtime == null || runtime.last_successful_sync_at == null) {
    return "never_synced";
  }
  if (runtime.kind === "syncing") {
    return "syncing";
  }
  if (runtime.kind === "offline" || runtime.kind === "authentication_required" || runtime.kind === "error") {
    return "offline";
  }
  return "synced";
}

/** 接続状態をGUIの外部連携状態へ変換します。 */
function externalAgentBridgeState(state: BridgeState):
  | { readonly kind: "unavailable"; readonly code: "unavailable"; readonly message: string }
  | { readonly kind: string } {
  if (state.kind === "unavailable") {
    return {
      kind: "unavailable",
      code: "unavailable",
      message: "外部連携ブリッジを利用できません。",
    };
  }
  return { kind: state.kind };
}

/** 外部連携の登録案内をGUIへ渡す形に変換します。 */
function externalAgentRegistration(registration: {
  readonly symlinkCommand: string;
  readonly allowExecutionCommand: string;
}): {
  readonly command: string;
  readonly allow_execution_command: string;
  readonly instructions: string;
} {
  return {
    command: registration.symlinkCommand,
    allow_execution_command: registration.allowExecutionCommand,
    instructions: "TaskHubで外部連携を有効にし、使用するWSLまたはMacのターミナルで登録コマンドを実行してください。実行許可を登録した場合はCodexを再起動してください。",
  };
}

/** 外部連携のGUI状態を組み立てます。 */
export function externalAgentGuiState<TProposal>(
  bridgeState: BridgeState,
  registration: { readonly symlinkCommand: string; readonly allowExecutionCommand: string },
  proposals: readonly TProposal[],
  proposalId: (proposal: TProposal) => string,
  parseProposal: (proposal: TProposal) => unknown,
  reviewTarget: { readonly proposal_id: string; readonly request_id: string } | undefined,
): object {
  return {
    enabled: bridgeState.enabled,
    bridge: externalAgentBridgeState(bridgeState),
    registration: externalAgentRegistration(registration),
    proposals: [...proposals]
      .sort((left, right) => {
        const leftId = proposalId(left);
        const rightId = proposalId(right);
        if (leftId < rightId) return -1;
        if (leftId > rightId) return 1;
        return 0;
      })
      .map(parseProposal),
    ...(reviewTarget == null ? {} : { review_target: reviewTarget }),
  };
}

/** 外部連携のCLI情報応答を組み立てます。 */
export function externalAgentInfoResponse(
  input: {
    readonly appVersion: string;
    readonly protocolVersion: number;
    readonly instanceId: string;
    readonly context: { readonly context_id: string; readonly project_gid: string } | undefined;
    readonly observedAt: string;
    readonly timeZone: string;
    readonly bridgeState: BridgeState;
    readonly runtime: RuntimeState | undefined;
    readonly onlineProvider: () => boolean;
    readonly preparedContextCount: number;
    readonly proposalCount: number;
    readonly inputSchema: () => unknown;
  },
): object {
  return {
    app_version: input.appVersion,
    protocol_version: input.protocolVersion,
    instance_id: input.instanceId,
    context: input.context == null
      ? { kind: "unconfigured" }
      : {
          kind: "ready",
          context_id: input.context.context_id,
          project_gid: input.context.project_gid,
        },
    observed_at: input.observedAt,
    time_zone: input.timeZone,
    bridge: externalAgentBridgeState(input.bridgeState),
    sync_status: externalAgentSyncStatus(input.runtime),
    ...(input.runtime?.last_successful_sync_at == null
      ? {}
      : { last_successful_sync_at: input.runtime.last_successful_sync_at }),
    capabilities: externalAgentCapabilities(
      input.context != null,
      input.runtime,
      input.bridgeState,
      input.onlineProvider,
      input.preparedContextCount,
      input.proposalCount,
    ),
    input_schema: input.inputSchema(),
  };
}
