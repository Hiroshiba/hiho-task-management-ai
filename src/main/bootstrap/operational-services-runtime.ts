type OperationalServicesDependencies<Context, Settings, Runtime, DisplayOrder> = {
  readonly assertSetupReady: () => void;
  readonly requireContext: () => Context;
  readonly getSettings: () => Settings | undefined;
  readonly contextMatchesSettings: (context: Context, settings: Settings) => boolean;
  readonly onlineProvider: () => unknown;
  readonly createRuntime: (context: Context, online: boolean) => Runtime;
  readonly subscribeRuntime: (runtime: Runtime) => void;
  readonly createDisplayOrder: () => DisplayOrder;
};

/** 運用サービスを一括構成し、構成状態の整合性を管理します。 */
export class OperationalServicesRuntime<
  Context,
  Settings,
  Runtime,
  DisplayOrder,
> {
  private runtime: Runtime | undefined;
  private displayOrder: DisplayOrder | undefined;
  private aiSessionsConfigured = false;

  public constructor(
    private readonly dependencies: OperationalServicesDependencies<
      Context,
      Settings,
      Runtime,
      DisplayOrder
    >,
  ) {}

  /** 運用サービスが揃っていない場合にまとめて構成します。 */
  public configure(): void {
    this.dependencies.assertSetupReady();
    const context = this.dependencies.requireContext();
    const settings = this.dependencies.getSettings();
    if (settings == null || !this.dependencies.contextMatchesSettings(context, settings)) {
      throw new Error("設定済み文脈と端末設定が一致しません。");
    }
    const fullyConfigured = this.runtime != null
      && this.displayOrder != null
      && this.aiSessionsConfigured;
    if (fullyConfigured) {
      return;
    }
    if (
      this.runtime != null
      || this.displayOrder != null
      || this.aiSessionsConfigured
    ) {
      throw new Error("運用サービスの構成状態が一貫していません。");
    }
    const online = this.dependencies.onlineProvider();
    if (typeof online !== "boolean") {
      throw new TypeError("オンライン状態関数は真偽値を返してください。");
    }
    const runtime = this.dependencies.createRuntime(context, online);
    this.dependencies.subscribeRuntime(runtime);
    const displayOrder = this.dependencies.createDisplayOrder();
    this.runtime = runtime;
    this.displayOrder = displayOrder;
    this.aiSessionsConfigured = true;
  }

  /** 同期ランタイムを返します。 */
  public getRuntime(): Runtime | undefined {
    return this.runtime;
  }

  /** 表示順サービスを返します。 */
  public getDisplayOrder(): DisplayOrder | undefined {
    return this.displayOrder;
  }

  /** 同期ランタイムを要求します。 */
  public requireRuntime(): Runtime {
    const runtime = this.runtime;
    if (runtime == null) {
      throw new Error("Asana同期ランタイムが設定されていません。");
    }
    return runtime;
  }

}
