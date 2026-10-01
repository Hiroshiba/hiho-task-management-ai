import type { CodexSessionStartResult } from "../infrastructure/ai";
import { deriveAiStatus } from "./ai-event-runtime";
import { isReadyCodexResult } from "./codex-runtime-utilities";
import type { SetupCodexAvailability } from "./setup-contracts";

type LaunchState =
  | { readonly kind: "pending" }
  | { readonly kind: "running"; readonly operation: Promise<void> }
  | { readonly kind: "settled" };

type AuthenticationState =
  | { readonly kind: "authenticated" }
  | { readonly kind: "required" }
  | { readonly kind: "unavailable"; readonly reason_code: Extract<SetupCodexAvailability, { kind: "unavailable" }>["reason_code"] };

type ConfiguredCodexDependencies<Status> = {
  readonly validateAbortSignal: (signal: AbortSignal) => void;
  readonly throwIfAborted: (signal: AbortSignal) => void;
  readonly isSessionUnstarted: () => boolean;
  readonly detectCli: (signal: AbortSignal) => Promise<SetupCodexAvailability>;
  readonly getAuthenticationState: (signal: AbortSignal) => Promise<AuthenticationState>;
  readonly getStartResult: () => CodexSessionStartResult | undefined;
  readonly checkCapabilities: (signal: AbortSignal) => Promise<SetupCodexAvailability>;
  readonly rethrowFeatureAbort: (error: unknown, signal: AbortSignal) => void;
  readonly recordStartFailure: (error: unknown) => void;
  readonly publishStatus: () => void;
  readonly isStopped: () => boolean;
  readonly getSessionState: () => string;
  readonly getModel: () => string | undefined;
  readonly parseStatus: (value: unknown) => Status;
  readonly startNewSession: (signal: AbortSignal) => Promise<CodexSessionStartResult>;
  readonly resetWithdrawConfirmations: () => void;
};

/** 設定済みCodexの起動試行とAsana同期後の再確認を管理します。 */
export class ConfiguredCodexRuntime<Status> {
  private launchState: LaunchState = { kind: "pending" };
  private synchronizationPromise: Promise<void> | undefined;
  private startResult: CodexSessionStartResult | undefined;
  private availability: SetupCodexAvailability | undefined;
  private authenticationRequired = false;

  public constructor(private readonly dependencies: ConfiguredCodexDependencies<Status>) {}

  /** 設定と再検査で得たCodex利用可否を保持します。 */
  public setAvailability(availability: SetupCodexAvailability | undefined): void {
    this.availability = availability;
  }

  /** 最新のCodex利用可否を返します。 */
  public getAvailability(): SetupCodexAvailability | undefined {
    return this.availability;
  }

  /** 保存済みCodex状態を再検査して起動結果を設定へ反映します。 */
  public async restorePersistedSession<State extends { readonly kind: string }>(
    signal: AbortSignal,
    dependencies: {
      readonly recheck: (signal: AbortSignal) => Promise<State>;
      readonly parseState: (value: unknown) => State;
      readonly availabilityFromState: (state: State) => SetupCodexAvailability | undefined;
      readonly updateAvailability: (availability: SetupCodexAvailability) => State;
    },
  ): Promise<State> {
    const recheckedState = dependencies.parseState(await dependencies.recheck(signal));
    const availability = dependencies.availabilityFromState(recheckedState);
    this.availability = availability;
    if (availability == null) {
      return recheckedState;
    }
    if (recheckedState.kind !== "ready" && availability.kind === "unavailable") {
      return recheckedState;
    }
    await this.ensureLaunchAttempt(signal);
    const currentAvailability = this.availability;
    if (currentAvailability == null) {
      return recheckedState;
    }
    if (
      currentAvailability.kind === "unavailable"
      || (availability.kind === "unavailable" && currentAvailability.kind === "available")
    ) {
      return dependencies.parseState(dependencies.updateAvailability(currentAvailability));
    }
    return recheckedState;
  }

  /** AIセッションの認証要求を公開状態へ反映します。 */
  public requireAuthentication(result: CodexSessionStartResult): void {
    this.startResult = result;
    this.authenticationRequired = true;
  }

  /** 設定状態の変化に合わせてCodexの認証状態を更新します。 */
  public afterSetupTransition(authenticationRequired: boolean): void {
    this.startResult = this.dependencies.getStartResult() ?? this.startResult;
    this.authenticationRequired = authenticationRequired
      || this.startResult?.state === "authentication_required";
    this.dependencies.publishStatus();
  }

  /** 現在のCodex状態からIPCのAI状態を導出します。 */
  public currentStatus(): Status {
    return deriveAiStatus({
      stopped: this.dependencies.isStopped(),
      getSessionState: this.dependencies.getSessionState,
      unavailableReason: this.availability?.kind === "unavailable"
        ? this.availability.reason_code
        : undefined,
      authenticationRequired: this.authenticationRequired
        || this.startResult?.state === "authentication_required",
      isReadySession: () => isReadyCodexResult(this.startResult),
      getModel: this.dependencies.getModel,
    }, this.dependencies.parseStatus);
  }

  /** Codexセッションの起動結果を持つか確認します。 */
  public hasStartResult(): boolean {
    return this.startResult != null;
  }

  /** 準備済みのCodexスレッドを作り直します。 */
  public async refreshThreadIfReady(signal: AbortSignal): Promise<void> {
    if (this.dependencies.getSessionState() !== "ready") {
      return;
    }
    this.startResult = await this.dependencies.startNewSession(signal);
    this.dependencies.resetWithdrawConfirmations();
    this.authenticationRequired = false;
    this.dependencies.publishStatus();
  }

  private disable(reasonCode: Extract<SetupCodexAvailability, { kind: "unavailable" }>["reason_code"]): void {
    this.availability = { kind: "unavailable", reason_code: reasonCode };
    this.startResult = undefined;
    this.authenticationRequired = false;
  }

  private async startConfigured(signal: AbortSignal): Promise<void> {
    this.dependencies.publishStatus();
    const detected = await this.dependencies.detectCli(signal);
    this.availability = detected;
    if (detected.kind === "unavailable") {
      this.startResult = undefined;
      this.authenticationRequired = false;
      this.dependencies.publishStatus();
      return;
    }
    const authentication = await this.dependencies.getAuthenticationState(signal);
    if (authentication.kind === "unavailable") {
      this.availability = authentication;
      this.startResult = undefined;
      this.authenticationRequired = false;
      this.dependencies.publishStatus();
      return;
    }
    this.authenticationRequired = authentication.kind === "required";
    this.startResult = this.dependencies.getStartResult();
    this.dependencies.publishStatus();
  }

  private async verifyCapabilities(signal: AbortSignal): Promise<void> {
    if (!isReadyCodexResult(this.startResult) || this.authenticationRequired) {
      return;
    }
    this.availability = await this.dependencies.checkCapabilities(signal);
    this.dependencies.publishStatus();
  }

  private async startUnstartedSafely(signal: AbortSignal): Promise<void> {
    if (!this.dependencies.isSessionUnstarted()) {
      return;
    }
    if (this.hasStartResult()) {
      throw new Error("未開始のCodexセッションに起動済み結果が設定されています。");
    }
    try {
      await this.startConfigured(signal);
    } catch (error: unknown) {
      this.dependencies.rethrowFeatureAbort(error, signal);
      this.dependencies.recordStartFailure(error);
      this.disable("startup_failed");
      this.dependencies.publishStatus();
    }
  }

  /** 設定済みCodexの起動試行を一度だけ実行します。 */
  public async ensureLaunchAttempt(signal: AbortSignal): Promise<void> {
    this.dependencies.validateAbortSignal(signal);
    this.dependencies.throwIfAborted(signal);
    const launchState = this.launchState;
    if (launchState.kind === "settled") {
      return;
    }
    if (launchState.kind === "running") {
      await launchState.operation;
      this.dependencies.throwIfAborted(signal);
      return;
    }
    const operation = this.startUnstartedSafely(signal);
    this.launchState = { kind: "running", operation };
    try {
      await operation;
    } finally {
      const currentState = this.launchState;
      if (currentState.kind === "running" && currentState.operation === operation) {
        this.launchState = { kind: "settled" };
      }
    }
  }

  /** Asana同期後のCodex確認を一つの実行へまとめます。 */
  public async synchronizeAfterAsana(signal: AbortSignal): Promise<void> {
    this.dependencies.validateAbortSignal(signal);
    const runningSynchronization = this.synchronizationPromise;
    if (runningSynchronization != null) {
      await runningSynchronization;
      this.dependencies.throwIfAborted(signal);
      return;
    }
    const synchronization = this.performSynchronization(signal);
    this.synchronizationPromise = synchronization;
    try {
      await synchronization;
    } finally {
      if (this.synchronizationPromise === synchronization) {
        this.synchronizationPromise = undefined;
      }
    }
  }

  private async performSynchronization(signal: AbortSignal): Promise<void> {
    await this.ensureLaunchAttempt(signal);
    await this.verifyCapabilities(signal);
  }

  /** 設定済みCodexの機能を再検査します。 */
  public async verifyConfiguredCapabilities(signal: AbortSignal): Promise<void> {
    await this.verifyCapabilities(signal);
  }
}
