export type ExternalAgentContext = {
  readonly context_id: string;
  readonly project_gid: string;
  readonly source_key: string;
};

type ExpirationReason = "context_changed" | "instance_restarted" | "superseded";

type LifecycleErrorCode = "unavailable" | "disabled" | "setup_required" | "offline";

type LifecyclePorts<TState> = {
  readonly parseProjectGid: (value: string) => string;
  readonly createId: () => string;
  readonly clearPrepared: () => void;
  readonly expireProposals: (reason: ExpirationReason) => void;
  readonly validateSignal: (signal: AbortSignal) => void;
  readonly setBridgeEnabled: (enabled: boolean) => PromiseLike<void> | void;
  readonly getBridgeState: () => { readonly kind: string; readonly enabled?: boolean | undefined };
  readonly getRuntimeState: () => { readonly last_successful_sync_at?: string | undefined } | undefined;
  readonly emitChanged: () => void;
  readonly getState: () => TState;
  readonly clearListeners: () => void;
  readonly createError: (code: LifecycleErrorCode, message: string) => Error;
};

/** 外部連携のAsana文脈と停止状態を所有します。 */
export class ExternalAgentLifecycle<TState> {
  private currentContext: ExternalAgentContext | undefined;
  private stoppedState = false;

  public constructor(private readonly ports: LifecyclePorts<TState>) {}

  /** 現在のAsana文脈を返します。 */
  public get context(): ExternalAgentContext | undefined {
    return this.currentContext;
  }

  /** サービスが停止済みか返します。 */
  public get stopped(): boolean {
    return this.stoppedState;
  }

  /** 実行中の外部連携を有効または無効にします。 */
  public async setEnabled(enabled: boolean, signal: AbortSignal): Promise<TState> {
    this.ports.validateSignal(signal);
    signal.throwIfAborted();
    if (this.stoppedState) {
      throw this.ports.createError("unavailable", "外部連携サービスは停止済みです。");
    }
    await this.ports.setBridgeEnabled(enabled);
    if (!enabled) {
      this.rotate();
      this.ports.expireProposals("superseded");
    }
    this.ports.emitChanged();
    return this.ports.getState();
  }

  /** 外部連携ブリッジが要求を受け付けられることを確認します。 */
  public assertEnabled(): void {
    const bridge = this.ports.getBridgeState();
    if (bridge.kind === "unavailable") {
      throw this.ports.createError("unavailable", "外部連携ブリッジを利用できません。");
    }
    if (bridge.enabled !== true || bridge.kind !== "running") {
      throw this.ports.createError("disabled", "外部連携が無効です。");
    }
  }

  /** 設定済みのAsana文脈を要求します。 */
  public requireContext(): ExternalAgentContext {
    if (this.currentContext == null) {
      throw this.ports.createError("setup_required", "Asanaの初回設定が完了していません。");
    }
    return this.currentContext;
  }

  /** 同期済みキャッシュを読めるAsana文脈を要求します。 */
  public assertReadReady(): ExternalAgentContext {
    const context = this.requireContext();
    const runtime = this.ports.getRuntimeState();
    if (runtime == null || runtime.last_successful_sync_at == null) {
      throw this.ports.createError("offline", "一覧を取得できる同期済みキャッシュがありません。");
    }
    return context;
  }

  /** 設定済みAsana文脈を反映して世代を更新します。 */
  public configure(
    contextInput: { readonly project_gid: string; readonly source_key: string } | undefined,
  ): void {
    if (contextInput == null) {
      if (this.currentContext != null) {
        this.currentContext = undefined;
        this.ports.clearPrepared();
        this.ports.expireProposals("context_changed");
      }
      return;
    }
    const validatedProjectGid = this.ports.parseProjectGid(contextInput.project_gid);
    if (
      this.currentContext?.project_gid === validatedProjectGid
      && this.currentContext.source_key === contextInput.source_key
    ) {
      return;
    }
    this.currentContext = {
      context_id: this.ports.createId(),
      project_gid: validatedProjectGid,
      source_key: contextInput.source_key,
    };
    this.ports.clearPrepared();
    this.ports.expireProposals("context_changed");
  }

  /** 現行Asana文脈の世代を更新します。 */
  public rotate(): void {
    if (this.currentContext != null) {
      this.currentContext = { ...this.currentContext, context_id: this.ports.createId() };
      this.ports.clearPrepared();
    }
  }

  /** 外部連携を停止し、購読と準備済み文脈を破棄します。 */
  public stop(): Promise<void> {
    if (this.stoppedState) {
      return Promise.resolve();
    }
    this.stoppedState = true;
    this.ports.clearPrepared();
    this.ports.expireProposals("instance_restarted");
    this.ports.clearListeners();
    return Promise.resolve();
  }
}

/** 未承認の外部提案を指定理由で失効させます。 */
export function expireExternalAgentProposals(
  proposals: Iterable<{ revision: number; state: { readonly kind: string; readonly reason_code?: string } }>,
  reasonCode: ExpirationReason,
  emitChanged: () => void,
): void {
  let changed = false;
  for (const record of proposals) {
    if (record.state.kind === "pending_approval") {
      record.revision += 1;
      record.state = { kind: "expired", reason_code: reasonCode };
      changed = true;
    }
  }
  if (changed) {
    emitChanged();
  }
}
