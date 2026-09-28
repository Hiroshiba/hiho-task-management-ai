type CodexHealthDependencies<Availability extends { readonly kind: string }, Authentication> = {
  readonly isDisabled: () => boolean;
  readonly detectCli: (signal: AbortSignal, capture: (error: unknown) => void) => Promise<unknown>;
  readonly getAuthenticationState: (signal: AbortSignal, capture: (error: unknown) => void) => Promise<unknown>;
  readonly completeAuthentication: (signal: AbortSignal, capture: (error: unknown) => void) => Promise<unknown>;
  readonly checkCapabilities: (signal: AbortSignal) => Promise<unknown>;
  readonly parseAvailability: (value: unknown) => Availability;
  readonly parseAuthentication: (value: unknown) => Authentication;
  readonly rethrowAbort: (error: unknown, signal: AbortSignal) => void;
  readonly recordFailure: (error: unknown, message: string) => void;
  readonly recordKnownFailure: (error: unknown, message: string) => void;
};

type KnownFailureCapture =
  | { readonly kind: "none" }
  | { readonly kind: "captured"; readonly error: unknown };

/** Codexの設定時検査と診断を同じ失敗契約で実行します。 */
export class CodexHealthWorkflow<Availability extends { readonly kind: string }, Authentication> {
  public constructor(private readonly dependencies: CodexHealthDependencies<Availability, Authentication>) {}

  private async runWithKnownFailure<Result>(
    signal: AbortSignal,
    operation: (signal: AbortSignal, capture: (error: unknown) => void) => Promise<unknown>,
    parse: (value: unknown) => Result,
    failureMessage: string,
    knownFailureMessage: string,
  ): Promise<Result> {
    if (this.dependencies.isDisabled()) {
      return parse({ kind: "unavailable", reason_code: "disabled" });
    }
    const knownFailureCapture: { value: KnownFailureCapture } = { value: { kind: "none" } };
    let result: Result;
    try {
      result = parse(await operation(signal, (error) => {
        knownFailureCapture.value = { kind: "captured", error };
      }));
    } catch (error: unknown) {
      this.dependencies.rethrowAbort(error, signal);
      this.dependencies.recordFailure(error, failureMessage);
      return parse({ kind: "unavailable", reason_code: "startup_failed" });
    }
    const knownFailure = knownFailureCapture.value;
    if (knownFailure.kind === "captured") {
      this.dependencies.recordKnownFailure(knownFailure.error, knownFailureMessage);
    }
    return result;
  }

  /** Codex CLIの利用可能性を診断付きで検査します。 */
  public detectCli(signal: AbortSignal): Promise<Availability> {
    return this.runWithKnownFailure(
      signal,
      this.dependencies.detectCli,
      this.dependencies.parseAvailability,
      "Codex CLIの検査に失敗したためAI機能を無効にしました。",
      "Codex CLIを利用できないためAI機能を無効にしました。",
    );
  }

  /** Codex認証状態を診断付きで検査します。 */
  public getAuthenticationState(signal: AbortSignal): Promise<Authentication> {
    return this.runWithKnownFailure(
      signal,
      this.dependencies.getAuthenticationState,
      this.dependencies.parseAuthentication,
      "Codex認証状態の検査に失敗したためAI機能を無効にしました。",
      "Codex認証状態を利用できないためAI機能を無効にしました。",
    );
  }

  /** Codex再認証を診断付きで完了します。 */
  public completeAuthentication(signal: AbortSignal): Promise<Authentication> {
    return this.runWithKnownFailure(
      signal,
      this.dependencies.completeAuthentication,
      this.dependencies.parseAuthentication,
      "Codex再認証に失敗したためAI機能を無効にしました。",
      "Codex再認証を完了できないためAI機能を無効にしました。",
    );
  }

  /** Codex能力を診断付きで検査します。 */
  public async checkCapabilities(signal: AbortSignal): Promise<Availability> {
    const { parseAvailability } = this.dependencies;
    if (this.dependencies.isDisabled()) {
      return parseAvailability({ kind: "unavailable", reason_code: "disabled" });
    }
    let availability: Availability;
    try {
      availability = parseAvailability(await this.dependencies.checkCapabilities(signal));
    } catch (error: unknown) {
      this.dependencies.rethrowAbort(error, signal);
      this.dependencies.recordFailure(error, "Codex能力検査に失敗したためAI機能を無効にしました。");
      return parseAvailability({ kind: "unavailable", reason_code: "startup_failed" });
    }
    if (availability.kind === "unavailable") {
      this.dependencies.recordFailure(
        availability,
        "Codex能力検査を完了できないためAI機能を無効にしました。",
      );
    }
    return availability;
  }
}
