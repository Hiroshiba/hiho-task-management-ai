/** Codexの状態からIPCへ公開するAI状態を導出します。 */
export function deriveAiStatus<TStatus>(
  input: {
    readonly stopped: boolean;
    readonly getSessionState: () => string;
    readonly unavailableReason: string | undefined;
    readonly authenticationRequired: boolean;
    readonly isReadySession: () => boolean;
    readonly getModel: () => string | undefined;
  },
  parseStatus: (value: unknown) => TStatus,
): TStatus {
  if (input.stopped || input.getSessionState() === "stopped") {
    return parseStatus({ kind: "unavailable", reason_code: "stopped" });
  }
  if (input.unavailableReason != null) {
    return parseStatus({ kind: "unavailable", reason_code: input.unavailableReason });
  }
  if (input.authenticationRequired) {
    return parseStatus({ kind: "authentication_required" });
  }
  const model = input.getModel();
  if (model != null && input.isReadySession()) {
    return parseStatus({ kind: "ready", model });
  }
  const sessionState = input.getSessionState();
  if (sessionState === "disabled" || sessionState === "failed") {
    return parseStatus({ kind: "unavailable", reason_code: "disabled" });
  }
  return parseStatus({ kind: "starting" });
}

/** AI接続状態と差分の購読をMainの生存期間だけ管理します。 */
export class AiEventRuntime<TStatus, TDelta> {
  private readonly statusListeners = new Set<(status: TStatus) => void>();
  private readonly deltaListeners = new Set<(delta: TDelta) => void>();

  public constructor(
    private readonly dependencies: {
      readonly currentStatus: () => TStatus;
      readonly reportListenerError: (error: unknown, channel: "ai_status_listener" | "ai_delta_listener") => void;
    },
  ) {}

  /** AI状態の購読関数を登録します。 */
  public onStatus(listener: (status: TStatus) => void): () => void {
    if (typeof listener !== "function") {
      throw new TypeError("AI状態の購読関数が必要です。");
    }
    this.statusListeners.add(listener);
    return (): void => {
      this.statusListeners.delete(listener);
    };
  }

  /** AI差分の購読関数を登録します。 */
  public onDelta(listener: (delta: TDelta) => void): () => void {
    if (typeof listener !== "function") {
      throw new TypeError("AI差分の購読関数が必要です。");
    }
    this.deltaListeners.add(listener);
    return (): void => {
      this.deltaListeners.delete(listener);
    };
  }

  /** 現在のAI状態を購読元へ通知します。 */
  public publishStatus(): void {
    const status = this.dependencies.currentStatus();
    for (const listener of this.statusListeners) {
      try {
        listener(status);
      } catch (error: unknown) {
        this.dependencies.reportListenerError(error, "ai_status_listener");
      }
    }
  }

  /** Codexから受け取った差分を購読元へ通知します。 */
  public publishDelta(delta: TDelta): void {
    for (const listener of this.deltaListeners) {
      try {
        listener(delta);
      } catch (error: unknown) {
        this.dependencies.reportListenerError(error, "ai_delta_listener");
      }
    }
  }

  /** Main終了時にAIの購読を解除します。 */
  public dispose(): void {
    this.statusListeners.clear();
    this.deltaListeners.clear();
  }
}
