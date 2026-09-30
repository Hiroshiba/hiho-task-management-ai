export type ExternalToolsDisabledReason =
  | "no_registered_tools"
  | "safe_execution_boundary_unavailable"
  | "unsupported_platform"
  | "credential_storage_unavailable"
  | "startup_failed";

export type ExternalToolUnavailableReason = Exclude<
  ExternalToolsDisabledReason,
  "no_registered_tools"
>;

export type ExternalToolRecoveryBrokerState<Broker> =
  | { readonly kind: "none" }
  | { readonly kind: "retained"; readonly value: Broker };

export type ExternalToolLifecycleState<Broker> =
  | { readonly kind: "uninitialized" }
  | { readonly kind: "starting"; readonly broker: Broker }
  | { readonly kind: "ready"; readonly broker: Broker; readonly endpoint: string }
  | { readonly kind: "disabled"; readonly reason: ExternalToolsDisabledReason }
  | {
      readonly kind: "recovery_required";
      readonly reason: ExternalToolUnavailableReason;
      readonly broker: ExternalToolRecoveryBrokerState<Broker>;
      readonly errors: readonly unknown[];
    }
  | { readonly kind: "stopped" };

type ExternalToolDefinitionPort = { readonly allowed_channel_ids: readonly string[] };

type ExternalToolBrokerPort = {
  start(signal: AbortSignal): Promise<
    | {
        readonly kind: "ready";
        readonly endpoint: string;
        readonly connection_info_path: string;
      }
    | {
        readonly kind: "disabled";
        readonly reason: "unsupported_platform" | "ipc_unavailable" | "permission_denied";
      }
  >;
  stop(): Promise<void>;
};

type ConfiguredExternalToolSelection = {
  readonly kind: "configured";
  readonly tool_id: "discord-context";
  readonly allowed_channel_ids: readonly string[];
};

type ExternalToolConfiguration = {
  readonly allowed_channel_ids: readonly string[];
  readonly bot_token: string;
};

type ExternalToolConfigurationResult =
  | {
      readonly kind: "configured";
      readonly tool_id: "discord-context";
      readonly allowed_channel_ids: readonly string[];
    }
  | {
      readonly kind: "unavailable";
      readonly reason_code: ExternalToolUnavailableReason;
    };

type ExternalToolDeactivationResult =
  | { readonly kind: "deactivated" }
  | { readonly kind: "unavailable"; readonly reason_code: ExternalToolUnavailableReason };

export type ExternalToolPersistenceResult =
  | { readonly kind: "saved" }
  | { readonly kind: "credential_storage_unavailable"; readonly error: unknown }
  | { readonly kind: "startup_failed"; readonly error: unknown }
  | { readonly kind: "recovery_required"; readonly error: unknown };

type ExternalToolConfigurationOperationState =
  | { readonly kind: "idle" }
  | {
      readonly kind: "running";
      readonly controller: AbortController;
      readonly operation: Promise<unknown>;
    };

type ExternalToolRuntimeDependencies<Broker, Registry, Definition> = {
  readonly lifecycleSignal: AbortSignal;
  readonly isStopped: () => boolean;
  readonly platform: string;
  readonly validateAbortSignal: (signal: AbortSignal) => void;
  readonly throwIfAborted: (signal: AbortSignal) => void;
  readonly installDisabledSkill: (
    reason: ExternalToolsDisabledReason,
  ) => { readonly kind: "ready" } | {
    readonly kind: "disabled";
    readonly reason: ExternalToolsDisabledReason;
  };
  readonly installClient: (
    registry: Registry,
    connectionInfoPath: string,
  ) => { readonly kind: "ready" } | { readonly kind: "disabled" };
  readonly setCodexSocketPaths: (paths: readonly string[]) => void;
  readonly recordStatus: () => void;
  readonly recordFeatureFailure: (error: unknown, message: string) => void;
  readonly recordRecoveryDiagnostic: (message: string, cause: unknown) => void;
  readonly combineFailures: (errors: readonly unknown[]) => {
    readonly disposition:
      | { readonly kind: "recorded_only" }
      | { readonly kind: "unrecorded_only"; readonly unrecorded_error: unknown }
      | { readonly kind: "recorded_and_unrecorded"; readonly unrecorded_error: unknown };
  };
  readonly disableCodexForSafety: (errors: unknown[]) => Promise<void>;
  readonly createDefinition: (allowedChannelIds: readonly string[]) => Definition;
  readonly createRegistry: (definition: Definition) => Registry;
  readonly assertPersistedDefinition: (definition: Definition) => void;
  readonly hasBotToken: () => boolean;
  readonly createBroker: (registry: Registry) => Broker;
  readonly persistConfiguration: (
    definition: Definition,
    botToken: string,
  ) => ExternalToolPersistenceResult;
  readonly getSelection: () =>
    | ConfiguredExternalToolSelection
    | { readonly kind: "skipped" }
    | { readonly kind: "unavailable" }
    | undefined;
  readonly markUnavailable: (reason: ExternalToolUnavailableReason) => void;
  readonly rethrowFeatureAbort: (error: unknown, signal: AbortSignal) => void;
};

type ExternalToolConfigurationStopReason = {
  readonly kind: "application_stop";
};

function errorHasCause(error: unknown, expectedCause: unknown): boolean {
  let current = error;
  const seen = new Set<unknown>();
  while (true) {
    if (current === expectedCause) {
      return true;
    }
    if (!(current instanceof Error) || seen.has(current)) {
      return false;
    }
    seen.add(current);
    current = current.cause;
  }
}

function setupReasonFromBrokerDisabledReason(
  reason: "unsupported_platform" | "ipc_unavailable" | "permission_denied",
): ExternalToolUnavailableReason {
  switch (reason) {
    case "unsupported_platform":
      return "unsupported_platform";
    case "ipc_unavailable":
    case "permission_denied":
      return "safe_execution_boundary_unavailable";
  }
}

function externalToolsDisabledReasonFromSetupReason(
  reason: ExternalToolUnavailableReason,
): ExternalToolsDisabledReason {
  switch (reason) {
    case "unsupported_platform":
    case "safe_execution_boundary_unavailable":
    case "credential_storage_unavailable":
    case "startup_failed":
      return reason;
  }
}

function throwConfigurationIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) {
    return;
  }
  if (signal.reason instanceof Error) {
    throw signal.reason;
  }
  throw new Error("外部ツール設定が中断されました。", {
    cause: signal.reason,
  });
}

/** 外部ツール設定の状態、停止補償、Codexの安全境界を管理します。 */
export class ExternalToolRuntime<
  Broker extends ExternalToolBrokerPort,
  Registry,
  Definition extends ExternalToolDefinitionPort,
> {
  private currentRegistry: Registry | undefined;
  private lifecycle: ExternalToolLifecycleState<Broker> = {
    kind: "disabled",
    reason: "no_registered_tools",
  };
  private configurationOperation: ExternalToolConfigurationOperationState = {
    kind: "idle",
  };

  public constructor(
    private readonly dependencies: ExternalToolRuntimeDependencies<Broker, Registry, Definition>,
  ) {}

  private throwConfigurationIfAborted(signal: AbortSignal): void {
    this.dependencies.validateAbortSignal(signal);
    throwConfigurationIfAborted(signal);
  }

  /** 起動済み外部ツールのレジストリを取得します。 */
  public readyRegistry(): Registry | undefined {
    if (this.lifecycle.kind !== "ready") {
      return undefined;
    }
    if (this.currentRegistry == null) {
      throw new Error("外部ツールレジストリが設定されていません。");
    }
    return this.currentRegistry;
  }

  /** アプリケーション停止後の外部ツール状態を確定します。 */
  public markStopped(): void {
    this.lifecycle = { kind: "stopped" };
  }

  /** 停止対象のブローカーを取得します。 */
  public brokerForStop(): Broker | undefined {
    switch (this.lifecycle.kind) {
      case "starting":
      case "ready":
        return this.lifecycle.broker;
      case "recovery_required":
        return this.lifecycle.broker.kind === "retained"
          ? this.lifecycle.broker.value
          : undefined;
      case "uninitialized":
      case "disabled":
      case "stopped":
        return undefined;
    }
  }

  /** 外部ツール安全停止によってCodexを利用できないかを返します。 */
  public codexDisabledBySafety(): boolean {
    return this.lifecycle.kind === "recovery_required";
  }

  /** 復旧待ちブローカーを取得します。 */
  public currentRecoveryBroker(): ExternalToolRecoveryBrokerState<Broker> {
    return this.lifecycle.kind === "recovery_required"
      ? this.lifecycle.broker
      : { kind: "none" };
  }

  /** 外部ツール設定処理が実行中かを返します。 */
  public isConfigurationRunning(): boolean {
    return this.configurationOperation.kind === "running";
  }

  /** 外部ツール設定の排他実行と停止時の中断を管理します。 */
  public async runConfigurationOperation<Result>(
    signal: AbortSignal,
    execute: (operationSignal: AbortSignal) => Promise<Result>,
  ): Promise<Result> {
    this.dependencies.validateAbortSignal(signal);
    this.dependencies.throwIfAborted(signal);
    this.dependencies.throwIfAborted(this.dependencies.lifecycleSignal);
    if (this.dependencies.isStopped()) {
      throw new Error("停止中は外部ツール設定を変更できません。");
    }
    if (this.configurationOperation.kind === "running") {
      throw new Error("別の外部ツール設定処理が進行中です。");
    }
    const controller = new AbortController();
    const operationSignal = AbortSignal.any([
      signal,
      this.dependencies.lifecycleSignal,
      controller.signal,
    ]);
    const operation = Promise.resolve().then(() => execute(operationSignal));
    this.configurationOperation = {
      kind: "running",
      controller,
      operation,
    };
    try {
      return await operation;
    } finally {
      const current = this.configurationOperation;
      if (current.kind === "running" && current.operation === operation) {
        this.configurationOperation = { kind: "idle" };
      }
    }
  }

  private stopCompensationCompleted(): boolean {
    switch (this.lifecycle.kind) {
      case "uninitialized":
      case "disabled":
      case "stopped":
        return true;
      case "starting":
      case "ready":
      case "recovery_required":
        return false;
    }
  }

  /** 進行中の外部ツール設定を中断し補償結果を確認します。 */
  public async stopConfiguration(errors: unknown[]): Promise<void> {
    const operationState = this.configurationOperation;
    if (operationState.kind === "idle") {
      return;
    }
    const stopReason: ExternalToolConfigurationStopReason = {
      kind: "application_stop",
    };
    operationState.controller.abort(stopReason);
    try {
      await operationState.operation;
    } catch (error: unknown) {
      if (
        !errorHasCause(error, stopReason)
        || !this.stopCompensationCompleted()
      ) {
        errors.push(error);
      }
    }
    if (this.lifecycle.kind === "recovery_required") {
      errors.push(new AggregateError(
        this.lifecycle.errors,
        "外部ツール設定の停止補償が完了していません。",
        { cause: this.lifecycle.errors[0] },
      ));
    }
  }

  /** 外部ツール設定を無効にしCodexの接続許可を取り消します。 */
  public setDisabled(): void {
    this.currentRegistry = undefined;
    this.lifecycle = {
      kind: "disabled",
      reason: "no_registered_tools",
    };
    this.dependencies.setCodexSocketPaths([]);
  }

  /** 無効な外部ツールSkillを導入しCodexの接続許可を取り消します。 */
  public applyDisabledBoundary(reason: ExternalToolsDisabledReason): void {
    const result = this.dependencies.installDisabledSkill(reason);
    if (result.kind !== "disabled" || result.reason !== reason) {
      throw new Error("外部ツール無効Skillの導入結果が一致しません。");
    }
    this.currentRegistry = undefined;
    this.dependencies.setCodexSocketPaths([]);
  }

  /** 起動済みブローカーをCodexの接続先として有効化します。 */
  public activate(
    broker: Broker,
    registry: Registry,
    endpoint: string,
    connectionInfoPath: string,
  ): void {
    const installation = this.dependencies.installClient(registry, connectionInfoPath);
    if (installation.kind !== "ready") {
      throw new Error("起動済み外部ツールのCodex連携を有効化できませんでした。");
    }
    this.dependencies.setCodexSocketPaths([endpoint]);
    this.currentRegistry = registry;
    this.dependencies.recordStatus();
    this.lifecycle = {
      kind: "ready",
      broker,
      endpoint,
    };
  }

  /** 外部ツールとCodexを安全停止状態へ移します。 */
  public async enterRecovery(
    reason: ExternalToolUnavailableReason,
    broker: ExternalToolRecoveryBrokerState<Broker>,
    sourceErrors: readonly unknown[],
    message: string,
  ): Promise<void> {
    const errors = [...sourceErrors];
    this.lifecycle = {
      kind: "recovery_required",
      reason,
      broker,
      errors,
    };
    try {
      const disposition = this.dependencies.combineFailures(sourceErrors).disposition;
      switch (disposition.kind) {
        case "recorded_only":
          break;
        case "unrecorded_only":
        case "recorded_and_unrecorded":
          this.dependencies.recordRecoveryDiagnostic(message, disposition.unrecorded_error);
          break;
      }
    } catch (error: unknown) {
      errors.push(error);
    }
    await this.dependencies.disableCodexForSafety(errors);
    this.lifecycle = {
      kind: "recovery_required",
      reason,
      broker,
      errors,
    };
  }

  /** 外部ツール失敗の記録不可時に安全停止へ移します。 */
  public async recordFailure(error: unknown, message: string): Promise<void> {
    try {
      this.dependencies.recordFeatureFailure(error, message);
    } catch (diagnosticError: unknown) {
      await this.enterRecovery(
        "startup_failed",
        this.currentRecoveryBroker(),
        [error, diagnosticError],
        "外部ツール失敗の診断記録を完了できませんでした。",
      );
    }
  }

  /** 起動失敗後にブローカーとCodexの許可を取り消します。 */
  public async rollbackActivation(
    broker: Broker & { stop(): PromiseLike<void> },
    reason: ExternalToolsDisabledReason,
    error: unknown,
  ): Promise<boolean> {
    const cleanupErrors: unknown[] = [];
    let brokerState: ExternalToolRecoveryBrokerState<Broker> = {
      kind: "retained",
      value: broker,
    };
    try {
      await broker.stop();
      brokerState = { kind: "none" };
    } catch (stopError: unknown) {
      cleanupErrors.push(stopError);
    }
    try {
      this.applyDisabledBoundary(reason);
    } catch (disableError: unknown) {
      cleanupErrors.push(disableError);
    }
    if (cleanupErrors.length > 0) {
      await this.enterRecovery(
        reason === "credential_storage_unavailable"
          ? "credential_storage_unavailable"
          : "startup_failed",
        brokerState,
        [error, ...cleanupErrors],
        "外部ツール有効化の失敗後に安全な状態へ復元できませんでした。",
      );
      return false;
    }
    this.lifecycle = { kind: "disabled", reason };
    return true;
  }

  /** Discord外部ツールを無効化します。 */
  public async deactivate(
    signal: AbortSignal,
  ): Promise<ExternalToolDeactivationResult> {
    return this.deactivateInternal(
      "no_registered_tools",
      signal,
    );
  }

  /** 指定理由で外部ツールを安全に無効化します。 */
  public async deactivateInternal(
    reason: ExternalToolsDisabledReason,
    signal: AbortSignal,
  ): Promise<ExternalToolDeactivationResult> {
    this.dependencies.validateAbortSignal(signal);
    this.throwConfigurationIfAborted(signal);
    const errors: unknown[] = [];
    let brokerState: ExternalToolRecoveryBrokerState<Broker> = { kind: "none" };
    const broker = this.brokerForStop();
    if (broker != null) {
      brokerState = { kind: "retained", value: broker };
      try {
        await broker.stop();
        brokerState = { kind: "none" };
      } catch (error: unknown) {
        errors.push(error);
      }
    }
    try {
      this.applyDisabledBoundary(reason);
    } catch (error: unknown) {
      errors.push(error);
    }
    if (errors.length > 0) {
      await this.enterRecovery(
        "safe_execution_boundary_unavailable",
        brokerState,
        errors,
        "Discord外部ツール連携を安全に無効化できませんでした。",
      );
      return {
        kind: "unavailable",
        reason_code: "safe_execution_boundary_unavailable",
      };
    }
    this.lifecycle = {
      kind: "disabled",
      reason,
    };
    try {
      this.dependencies.recordStatus();
    } catch (error: unknown) {
      await this.enterRecovery(
        "startup_failed",
        { kind: "none" },
        [error],
        "外部ツール無効状態の診断記録を完了できませんでした。",
      );
      return { kind: "unavailable", reason_code: "startup_failed" };
    }
    this.throwConfigurationIfAborted(signal);
    return { kind: "deactivated" };
  }

  /** 保存済み外部ツールを起動時に再照合します。 */
  public async reconcileAtStartup(
    signal: AbortSignal,
  ): Promise<void> {
    const selection = this.dependencies.getSelection();
    if (
      selection == null
      || selection.kind === "skipped"
      || selection.kind === "unavailable"
    ) {
      this.setDisabled();
      return;
    }
    const result = await this.runConfigurationOperation(
      signal,
      (operationSignal) =>
        this.initialize(selection, operationSignal),
    );
    if (result.kind === "configured") {
      return;
    }
    const deactivation = await this.runConfigurationOperation(
      signal,
      (operationSignal) =>
        this.deactivateInternal(
          externalToolsDisabledReasonFromSetupReason(result.reason_code),
          operationSignal,
        ),
    );
    const reason = deactivation.kind === "unavailable"
      ? deactivation.reason_code
      : result.reason_code;
    await this.markUnavailableSafely(
      reason,
      new Error("保存済み固定Discord連携を起動できませんでした。"),
    );
  }

  /** 外部ツール利用不可のcheckpoint保存を試みます。 */
  public async markUnavailableSafely(
    reason: ExternalToolUnavailableReason,
    error: unknown,
  ): Promise<void> {
    try {
      this.dependencies.markUnavailable(reason);
    } catch (checkpointError: unknown) {
      await this.enterRecovery(
        reason,
        this.currentRecoveryBroker(),
        [error, checkpointError],
        "外部ツール安全停止状態を初回設定checkpointへ保存できませんでした。",
      );
    }
  }

  /** 確定済み外部ツール選択を起動してCodexへ反映します。 */
  public async afterCommittedChoice<State>(
    state: State,
    signal: AbortSignal,
    ports: {
      readonly selectionFromState: (state: State) => ConfiguredExternalToolSelection | undefined;
      readonly commitCurrentState: () => State;
      readonly refreshCodexThread: (signal: AbortSignal) => Promise<void>;
    },
  ): Promise<State> {
    const selection = ports.selectionFromState(state);
    if (selection == null) {
      return state;
    }
    const activation = await this.initialize(selection, signal);
    if (activation.kind === "unavailable") {
      await this.markUnavailableSafely(
        activation.reason_code,
        new Error("確定済み固定Discord連携を有効化できませんでした。"),
      );
      return ports.commitCurrentState();
    }
    await this.refreshCodexThreadAfterCommit(signal, ports.refreshCodexThread);
    return state;
  }

  private async refreshCodexThreadAfterCommit(
    signal: AbortSignal,
    refreshCodexThread: (signal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    try {
      await refreshCodexThread(signal);
    } catch (error: unknown) {
      const errors: unknown[] = [error];
      try {
        const deactivation = await this.deactivateInternal(
          "startup_failed",
          new AbortController().signal,
        );
        if (deactivation.kind === "unavailable") {
          return;
        }
      } catch (deactivationError: unknown) {
        errors.push(deactivationError);
      }
      await this.enterRecovery(
        "startup_failed",
        this.currentRecoveryBroker(),
        errors,
        "確定済み外部ツール設定のCodex反映に失敗したためAI機能を無効にしました。",
      );
    }
  }

  /** 保存済みDiscord外部ツールを起動します。 */
  public async initialize(
    selection: ConfiguredExternalToolSelection,
    signal: AbortSignal,
  ): Promise<ExternalToolConfigurationResult> {
    this.dependencies.validateAbortSignal(signal);
    this.throwConfigurationIfAborted(signal);
    switch (this.lifecycle.kind) {
      case "ready":
        return {
          kind: "configured",
          tool_id: selection.tool_id,
          allowed_channel_ids: selection.allowed_channel_ids,
        };
      case "starting":
        throw new Error("外部ツールブローカーは起動処理中です。");
      case "stopped":
        throw new Error("停止済みの外部ツールブローカーは起動できません。");
      case "recovery_required": {
        const deactivation = await this.deactivateInternal(
          externalToolsDisabledReasonFromSetupReason(
            this.lifecycle.reason,
          ),
          signal,
        );
        if (deactivation.kind === "unavailable") {
          return deactivation;
        }
        break;
      }
      case "uninitialized":
      case "disabled":
        break;
    }
    if (this.dependencies.platform === "win32") {
      const deactivation = await this.deactivateInternal(
        "unsupported_platform",
        signal,
      );
      if (deactivation.kind === "unavailable") {
        return deactivation;
      }
      return { kind: "unavailable", reason_code: "unsupported_platform" };
    }

    const expectedDefinition = this.dependencies.createDefinition(
      selection.allowed_channel_ids,
    );
    try {
      this.dependencies.assertPersistedDefinition(expectedDefinition);
    } catch (error: unknown) {
      await this.recordFailure(
        error,
        "保存済み固定Discord設定を確認できないため連携を無効にしました。",
      );
      return { kind: "unavailable", reason_code: "startup_failed" };
    }

    try {
      if (!this.dependencies.hasBotToken()) {
        return {
          kind: "unavailable",
          reason_code: "credential_storage_unavailable",
        };
      }
    } catch (error: unknown) {
      await this.recordFailure(
        error,
        "Discord資格情報を安全に確認できないため連携を無効にしました。",
      );
      return {
        kind: "unavailable",
        reason_code: "credential_storage_unavailable",
      };
    }

    let registry: Registry;
    let broker: Broker;
    try {
      registry = this.dependencies.createRegistry(expectedDefinition);
      broker = this.dependencies.createBroker(registry);
    } catch (error: unknown) {
      await this.recordFailure(
        error,
        "外部ツールブローカーを構築できないため連携を無効にしました。",
      );
      return { kind: "unavailable", reason_code: "startup_failed" };
    }
    this.lifecycle = { kind: "starting", broker };
    let startResult;
    try {
      startResult = await broker.start(signal);
    } catch (error: unknown) {
      await this.rollbackActivation(
        broker,
        "startup_failed",
        error,
      );
      this.dependencies.rethrowFeatureAbort(error, signal);
      await this.recordFailure(
        error,
        "外部ツールブローカーを起動できないため連携を無効にしました。",
      );
      return { kind: "unavailable", reason_code: "startup_failed" };
    }
    if (startResult.kind === "disabled") {
      const reason = setupReasonFromBrokerDisabledReason(startResult.reason);
      await this.rollbackActivation(
        broker,
        reason === "unsupported_platform"
          ? "unsupported_platform"
          : "safe_execution_boundary_unavailable",
        new Error("外部ツールブローカーの安全な起動境界を利用できません。"),
      );
      return { kind: "unavailable", reason_code: reason };
    }
    try {
      this.throwConfigurationIfAborted(signal);
      this.activate(
        broker,
        registry,
        startResult.endpoint,
        startResult.connection_info_path,
      );
    } catch (error: unknown) {
      await this.rollbackActivation(
        broker,
        "startup_failed",
        error,
      );
      this.dependencies.rethrowFeatureAbort(error, signal);
      await this.recordFailure(
        error,
        "外部ツールのCodex連携を有効化できないため無効にしました。",
      );
      return { kind: "unavailable", reason_code: "startup_failed" };
    }
    return {
      kind: "configured",
      tool_id: selection.tool_id,
      allowed_channel_ids: selection.allowed_channel_ids,
    };
  }

  /** Discord外部ツール設定を保存待機状態まで進めます。 */
  public async configureDiscord(
    configuration: ExternalToolConfiguration,
    signal: AbortSignal,
  ): Promise<ExternalToolConfigurationResult> {
    switch (this.lifecycle.kind) {
      case "uninitialized":
      case "disabled":
        break;
      case "recovery_required": {
        const deactivation = await this.deactivateInternal(
          externalToolsDisabledReasonFromSetupReason(
            this.lifecycle.reason,
          ),
          signal,
        );
        if (deactivation.kind === "unavailable") {
          return deactivation;
        }
        break;
      }
      case "starting":
        throw new Error("外部ツールブローカーは起動処理中です。");
      case "ready":
        throw new Error("外部ツールは設定済みです。");
      case "stopped":
        throw new Error("停止済みの外部ツールブローカーは設定できません。");
    }
    if (this.dependencies.platform === "win32") {
      const deactivation = await this.deactivateInternal(
        "unsupported_platform",
        signal,
      );
      if (deactivation.kind === "unavailable") {
        return deactivation;
      }
      return { kind: "unavailable", reason_code: "unsupported_platform" };
    }

    let definition: Definition;
    let registry: Registry;
    let broker: Broker;
    try {
      definition = this.dependencies.createDefinition(
        configuration.allowed_channel_ids,
      );
      registry = this.dependencies.createRegistry(definition);
      broker = this.dependencies.createBroker(registry);
    } catch (error: unknown) {
      await this.recordFailure(
        error,
        "固定Discord連携を構築できないため無効にしました。",
      );
      return { kind: "unavailable", reason_code: "startup_failed" };
    }
    this.lifecycle = { kind: "starting", broker };
    let startResult;
    try {
      startResult = await broker.start(signal);
    } catch (error: unknown) {
      await this.rollbackActivation(
        broker,
        "startup_failed",
        error,
      );
      this.dependencies.rethrowFeatureAbort(error, signal);
      await this.recordFailure(
        error,
        "外部ツールブローカーを起動できないためDiscord連携を無効にしました。",
      );
      return { kind: "unavailable", reason_code: "startup_failed" };
    }
    if (startResult.kind === "disabled") {
      const reason = setupReasonFromBrokerDisabledReason(startResult.reason);
      await this.rollbackActivation(
        broker,
        reason === "unsupported_platform"
          ? "unsupported_platform"
          : "safe_execution_boundary_unavailable",
        new Error("外部ツールブローカーの安全な起動境界を利用できません。"),
      );
      return { kind: "unavailable", reason_code: reason };
    }

    const persistence = this.dependencies.persistConfiguration(
      definition,
      configuration.bot_token,
    );
    if (persistence.kind !== "saved") {
      const unavailableReason = persistence.kind === "credential_storage_unavailable"
        ? "credential_storage_unavailable"
        : "startup_failed";
      const rollbackCompleted = await this.rollbackActivation(
        broker,
        unavailableReason,
        persistence.error,
      );
      if (persistence.kind === "recovery_required") {
        if (rollbackCompleted) {
          await this.enterRecovery(
            "startup_failed",
            { kind: "none" },
            [persistence.error],
            "既存Discord Tokenの復元に失敗したため外部ツール連携を停止しました。",
          );
        }
        this.throwConfigurationIfAborted(signal);
        return { kind: "unavailable", reason_code: "startup_failed" };
      }
      this.throwConfigurationIfAborted(signal);
      await this.recordFailure(
        persistence.error,
        persistence.kind === "credential_storage_unavailable"
          ? "Discord資格情報を安全に保存できないため連携を無効にしました。"
          : "固定Discord設定を保存できないため連携を無効にしました。",
      );
      return { kind: "unavailable", reason_code: unavailableReason };
    }
    const staged = await this.rollbackActivation(
      broker,
      "no_registered_tools",
      new Error("固定Discord設定をcheckpoint確定まで待機状態へ移します。"),
    );
    if (!staged) {
      return { kind: "unavailable", reason_code: "startup_failed" };
    }
    this.throwConfigurationIfAborted(signal);
    return {
      kind: "configured",
      tool_id: "discord-context",
      allowed_channel_ids: definition.allowed_channel_ids,
    };
  }
}
