type OperationalContextDependencies<
  State extends { readonly kind: string },
  Context extends { readonly project_gid: string },
  Settings extends { readonly client_id: string },
  Availability,
> = {
  readonly initialSettings: Settings | undefined;
  readonly parseState: (state: State) => State;
  readonly contextFromState: (state: State) => Context | undefined;
  readonly operationKey: (context: Context) => string;
  readonly availabilityFromState: (state: State) => Availability | undefined;
  readonly clientIdFromState: (state: State) => string | undefined;
  readonly readSettings: () => Settings | undefined;
  readonly parseSettings: (settings: Settings) => Settings;
  readonly contextMatchesSettings: (context: Context, settings: Settings) => boolean;
  readonly configureExternalAgent: (
    context: { readonly project_gid: string; readonly source_key: string } | undefined,
  ) => void;
  readonly invalidatePendingMutations: () => void;
  readonly setCodexAvailability: (availability: Availability | undefined) => void;
  readonly setTokenProvider: (clientId: string) => void;
  readonly updateCodexVaultPaths: () => void;
  readonly assertOperationalReady: () => void;
};

/** 設定済み文脈、端末設定、認証プロバイダーの切り替えを管理します。 */
export class OperationalContextRuntime<
  State extends { readonly kind: string },
  Context extends { readonly project_gid: string },
  Settings extends { readonly client_id: string },
  Availability,
> {
  private context: Context | undefined;
  private settings: Settings | undefined;

  public constructor(
    private readonly dependencies: OperationalContextDependencies<
      State,
      Context,
      Settings,
      Availability
    >,
  ) {
    this.settings = dependencies.initialSettings;
  }

  /** 現在の端末設定を返します。 */
  public getSettings(): Settings | undefined {
    return this.settings;
  }

  /** 現在の文脈を返します。 */
  public getContext(): Context | undefined {
    return this.context;
  }

  /** 設定済み文脈を要求します。 */
  public requireContext(): Context {
    const context = this.context;
    if (context == null) {
      throw new Error("Asana設定の文脈がありません。");
    }
    return context;
  }

  /** 運用可能な端末設定を要求します。 */
  public requireConfiguredSettings(): Settings {
    this.dependencies.assertOperationalReady();
    const storedSettings = this.dependencies.readSettings();
    if (storedSettings == null) {
      throw new Error("設定済みAsana OAuthの端末設定がありません。");
    }
    const settings = this.dependencies.parseSettings(storedSettings);
    if (!this.dependencies.contextMatchesSettings(this.requireContext(), settings)) {
      throw new Error("設定済み文脈と端末設定が一致しません。");
    }
    return settings;
  }

  /** 端末設定からAsana認証プロバイダーを構成します。 */
  public configureAsanaFromSettings(settings: Settings | undefined): void {
    if (settings == null) {
      this.settings = undefined;
      return;
    }
    const validatedSettings = this.dependencies.parseSettings(settings);
    this.settings = validatedSettings;
    this.dependencies.setTokenProvider(validatedSettings.client_id);
  }

  /** 初回設定の状態から文脈と依存サービスを更新します。 */
  public configureFromState(state: State): void {
    const validatedState = this.dependencies.parseState(state);
    const context = this.dependencies.contextFromState(validatedState);
    const previousContext = this.context;
    const previousContextKey = previousContext == null
      ? "unconfigured"
      : this.dependencies.operationKey(previousContext);
    const contextKey = context == null ? "unconfigured" : this.dependencies.operationKey(context);
    const contextChanged = previousContextKey !== contextKey;
    this.context = context;
    this.dependencies.configureExternalAgent(
      context == null
        ? undefined
        : {
            project_gid: context.project_gid,
            source_key: this.dependencies.operationKey(context),
          },
    );
    if (contextChanged && previousContext != null) {
      this.dependencies.invalidatePendingMutations();
    }
    this.dependencies.setCodexAvailability(
      this.dependencies.availabilityFromState(validatedState),
    );
    const settings = this.dependencies.readSettings();
    this.configureAsanaFromSettings(settings);
    if (settings == null) {
      const clientId = this.dependencies.clientIdFromState(validatedState);
      if (clientId != null) {
        this.dependencies.setTokenProvider(clientId);
      }
    }
    if (context != null && settings != null && validatedState.kind === "ready") {
      const validatedSettings = this.dependencies.parseSettings(settings);
      if (!this.dependencies.contextMatchesSettings(context, validatedSettings)) {
        throw new Error("設定済み文脈と端末設定が一致しません。");
      }
    }
    this.dependencies.updateCodexVaultPaths();
  }
}
