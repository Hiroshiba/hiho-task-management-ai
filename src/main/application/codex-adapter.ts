import {
  CodexExecutableNotFoundError,
  CodexProcessError,
  CodexVersionCommandError,
} from "../codex/app-server";
import { checkCodexExecutable } from "../codex/app-server/version";
import {
  CodexSessionCapabilityError,
  CodexSessionDisabledError,
  CodexSessionService,
  type CodexSessionStartResult,
} from "../codex/session";
import {
  setupCodexAvailabilitySchema,
  type SetupCodexAvailability,
} from "../../shared/setup";

type CodexAdapterOptions = {
  readonly session: CodexSessionService;
  readonly executable: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly openAuthorizationUrl: (
    authorizationUrl: string,
    signal: AbortSignal,
  ) => Promise<void> | void;
};

type CodexAuthenticationState =
  | { readonly kind: "authenticated" }
  | { readonly kind: "required" }
  | Extract<SetupCodexAvailability, { readonly kind: "unavailable" }>;

function knownAvailability(
  error: unknown,
): Extract<SetupCodexAvailability, { readonly kind: "unavailable" }> | undefined {
  if (error instanceof CodexExecutableNotFoundError) {
    return { kind: "unavailable", reason_code: "not_installed" };
  }
  if (error instanceof CodexSessionCapabilityError) {
    return { kind: "unavailable", reason_code: "incompatible" };
  }
  if (error instanceof CodexProcessError || error instanceof CodexVersionCommandError) {
    return { kind: "unavailable", reason_code: "startup_failed" };
  }
  if (error instanceof CodexSessionDisabledError) {
    return { kind: "unavailable", reason_code: "disabled" };
  }
  return undefined;
}

function parseAvailability(value: SetupCodexAvailability): SetupCodexAvailability {
  return setupCodexAvailabilitySchema.parse(value);
}

function isReady(result: CodexSessionStartResult): result is Extract<
  CodexSessionStartResult,
  { readonly state: "ready" }
> {
  return result.state === "ready";
}

/** Codexセッションを初回設定の安全な能力境界へ変換します。 */
export class CodexSetupAdapter {
  private readonly session: CodexSessionService;
  private readonly executable: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly openAuthorizationUrl: CodexAdapterOptions["openAuthorizationUrl"];
  private started = false;
  private startResult: CodexSessionStartResult | undefined;
  private loginOpened = false;
  private structuredOutputVerified = false;

  public constructor(options: CodexAdapterOptions) {
    if (typeof options?.session?.start !== "function") {
      throw new TypeError("Codexセッションが必要です。");
    }
    this.session = options.session;
    this.executable = options.executable;
    this.environment = options.environment;
    this.openAuthorizationUrl = options.openAuthorizationUrl;
  }

  /** Codex CLIの導入状態を検査します。 */
  public async detectCli(signal: AbortSignal): Promise<SetupCodexAvailability> {
    try {
      await checkCodexExecutable(
        this.executable,
        this.environment,
        signal,
      );
      return parseAvailability({ kind: "available" });
    } catch (error: unknown) {
      const availability = knownAvailability(error);
      if (availability == null) {
        throw error;
      }
      return parseAvailability(availability);
    }
  }

  /** Codexセッションの認証状態を検査します。 */
  public async getAuthenticationState(
    signal: AbortSignal,
  ): Promise<CodexAuthenticationState> {
    try {
      const result = await this.ensureStarted(signal);
      if (isReady(result)) {
        return { kind: "authenticated" };
      }
      if (!this.loginOpened) {
        const login = await this.session.startChatGptLogin(signal);
        try {
          await this.openAuthorizationUrl(login.authUrl, signal);
        } catch (error: unknown) {
          throw new CodexSessionCapabilityError(
            "ChatGPT認証画面を開けませんでした。",
            error,
          );
        }
        this.loginOpened = true;
      }
      return { kind: "required" };
    } catch (error: unknown) {
      const availability = knownAvailability(error);
      if (availability == null) {
        throw error;
      }
      return availability;
    }
  }

  /** ChatGPT認証後のCodexセッションを再開します。 */
  public async completeAuthentication(
    signal: AbortSignal,
  ): Promise<CodexAuthenticationState> {
    try {
      const sessionState = this.session.getState();
      if (sessionState === "created") {
        const started = await this.ensureStarted(signal);
        if (isReady(started)) {
          this.loginOpened = false;
          return { kind: "authenticated" };
        }
      } else if (sessionState === "ready") {
        const result = this.startResult;
        if (result == null || !isReady(result)) {
          throw new CodexSessionCapabilityError(
            "Codex認証済みセッションの起動結果が確定していません。",
          );
        }
        this.loginOpened = false;
        return { kind: "authenticated" };
      }
      const result = await this.session.completeAuthentication(signal);
      this.startResult = result;
      this.structuredOutputVerified = false;
      if (result.state === "authentication_required") {
        return { kind: "required" };
      }
      this.loginOpened = false;
      return { kind: "authenticated" };
    } catch (error: unknown) {
      const availability = knownAvailability(error);
      if (availability == null) {
        throw error;
      }
      return availability;
    }
  }

  /** Codexの利用可能状態を再検証します。 */
  public async checkCapabilities(
    signal: AbortSignal,
  ): Promise<SetupCodexAvailability> {
    if (signal.aborted) {
      throw new Error("Codex能力検査が中断されました。");
    }
    const result = this.startResult;
    if (result == null) {
      const state = this.session.getState();
      if (state === "disabled" || state === "stopped" || state === "failed") {
        return parseAvailability({ kind: "unavailable", reason_code: "disabled" });
      }
      throw new CodexSessionCapabilityError(
        "Codex能力検査の起動状態が確定していません。",
      );
    }
    if (isReady(result)) {
      if (this.structuredOutputVerified) {
        return parseAvailability({ kind: "available" });
      }
      const turn = await this.session.startTurn(
        [{
          type: "text",
          text: "構造化出力の能力検査です。変更案を作らず、no_proposalを返してください。",
        }],
        signal,
      );
      if (turn.response.kind !== "no_proposal" && turn.response.kind !== "proposal") {
        throw new CodexSessionCapabilityError(
          "Codexの構造化出力結果が不正です。",
        );
      }
      this.structuredOutputVerified = true;
      return parseAvailability({ kind: "available" });
    }
    return parseAvailability({ kind: "unavailable", reason_code: "disabled" });
  }

  /** 構造化出力検証済みのCodexモデルを取得します。 */
  public getReadyModel(): string | undefined {
    if (!this.structuredOutputVerified || this.startResult == null || !isReady(this.startResult)) {
      return undefined;
    }
    return this.startResult.model;
  }

  /** Codexセッションの最新起動結果を取得します。 */
  public getStartResult(): CodexSessionStartResult | undefined {
    return this.startResult;
  }

  private async ensureStarted(signal: AbortSignal): Promise<CodexSessionStartResult> {
    if (this.started) {
      const result = this.startResult;
      if (result == null) {
        throw new CodexSessionCapabilityError(
          "Codexセッション起動結果が確定していません。",
        );
      }
      return result;
    }
    const result = await this.session.start(signal);
    this.started = true;
    this.startResult = result;
    return result;
  }
}
