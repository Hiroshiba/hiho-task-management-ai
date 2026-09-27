export type AiSessionCleanupDisposition =
  | { readonly kind: "record" }
  | { readonly kind: "propagate_unrecorded" };

export type AiSessionPromiseResult =
  | { readonly kind: "completed" }
  | { readonly kind: "rejected"; readonly error: unknown };

export type AiSessionStartResult =
  | { readonly kind: "started"; readonly session_id: string }
  | { readonly kind: "authentication_required" };

export type AiSessionBaselineStore<ExternalData, Snapshot> = {
  readonly externalData: Map<string, ExternalData>;
  readonly proposalKeys: Map<string, string>;
  readonly currentTurnKeys: Set<string>;
  taskctlSnapshot: Snapshot | undefined;
};

export type AiSessionRecord<
  Workspace,
  Session,
  Workflow,
  Broker,
  ExternalData,
  Snapshot,
> = {
  readonly sessionId: string;
  readonly workspace: Workspace;
  readonly session: Session;
  readonly externalToolBroker: Broker | undefined;
  readonly workflow: Workflow;
  readonly baselineStore: AiSessionBaselineStore<ExternalData, Snapshot>;
  readonly lifecycleController: AbortController;
  readonly removeLifecycleListener: () => void;
  readonly removeDeltaListener: () => void;
  readonly operations: Map<AbortController, Promise<unknown>>;
  readonly proposalIds: Set<string>;
  closing: boolean;
  turnInFlight: boolean;
  approvalInFlight: boolean;
  closePromise: Promise<void> | undefined;
};

type AiSessionStartRequestStopState =
  | { readonly kind: "not_claimed" }
  | { readonly kind: "claimed"; readonly result: Promise<AiSessionPromiseResult> };

type AiSessionStartRecord<Workspace, Session, Broker> = {
  readonly sessionId: string;
  readonly workspaceUserDataPath: string;
  readonly lifecycleController: AbortController;
  readonly removeLifecycleListener: () => void;
  workspace: Workspace | undefined;
  session: Session | undefined;
  externalToolBroker: Broker | undefined;
  requestStopState: AiSessionStartRequestStopState;
  readonly completion: Promise<AiSessionStartResult>;
};

type AiSessionServicePort = {
  stop(disposition: AiSessionCleanupDisposition): Promise<void>;
};

type AiSessionBrokerPort = { stop(): Promise<void> };
type AiSessionWorkflowPort = { dispose(): void };
type AiSessionWorkspacePort = { readonly userDataPath: string };

type AiSessionRuntimeDependencies<
  Workspace,
  Session,
  Workflow,
  Broker,
  Collector,
  ExternalData,
  Snapshot,
  StartResult extends { readonly state: string },
> = {
  readonly lifecycleSignal: AbortSignal;
  readonly isStopped: () => boolean;
  readonly assertOperationalReady: () => void;
  readonly validateAbortSignal: (signal: AbortSignal) => void;
  readonly throwIfAborted: (signal: AbortSignal) => void;
  readonly createSessionId: () => string;
  readonly parseSessionId: (sessionId: string) => string;
  readonly workspaceUserDataPath: (sessionId: string) => string;
  readonly createWorkspace: (sessionId: string) => Workspace;
  readonly prepareExternalTools: (
    workspace: Workspace,
    signal: AbortSignal,
  ) => Promise<{ readonly broker: Broker | undefined; readonly collector: Collector; readonly endpoint: string | undefined }>;
  readonly createSession: (workspace: Workspace, endpoint: string | undefined) => Session;
  readonly startSession: (session: Session, signal: AbortSignal) => Promise<StartResult>;
  readonly createWorkflow: (
    session: Session,
    collector: Collector,
    baselineStore: AiSessionBaselineStore<ExternalData, Snapshot>,
    sessionId: string,
  ) => Workflow;
  readonly subscribeDelta: (workflow: Workflow, sessionId: string) => () => void;
  readonly onAuthenticationRequired: (result: StartResult) => void;
  readonly publishStatus: () => void;
  readonly createAbortedError: () => Error;
  readonly removeWorkspace: (userDataPath: string) => void;
  readonly combineFailures: (errors: readonly unknown[]) => Error;
  readonly isAbortError: (error: unknown) => boolean;
  readonly hasOperationOwner: (signal: AbortSignal) => boolean;
  readonly linkOwnedSignal: (signal: AbortSignal, owner: AbortSignal) => () => void;
};

function settleAiSessionPromise(promise: Promise<unknown>): Promise<AiSessionPromiseResult> {
  return promise.then(
    () => ({ kind: "completed" }),
    (error: unknown) => ({ kind: "rejected", error }),
  );
}

/** AIセッションの開始、操作、終了と資源解放を管理します。 */
export class AiSessionRuntime<
  Workspace extends AiSessionWorkspacePort,
  Session extends AiSessionServicePort,
  Workflow extends AiSessionWorkflowPort,
  Broker extends AiSessionBrokerPort,
  Collector,
  ExternalData,
  Snapshot,
  StartResult extends { readonly state: string },
> {
  private readonly sessions = new Map<string, AiSessionRecord<Workspace, Session, Workflow, Broker, ExternalData, Snapshot>>();
  private readonly starts = new Map<string, AiSessionStartRecord<Workspace, Session, Broker>>();

  public constructor(
    private readonly dependencies: AiSessionRuntimeDependencies<
      Workspace,
      Session,
      Workflow,
      Broker,
      Collector,
      ExternalData,
      Snapshot,
      StartResult
    >,
  ) {}

  /** 実行中のAIセッションを列挙します。 */
  public activeSessions(): Iterable<AiSessionRecord<Workspace, Session, Workflow, Broker, ExternalData, Snapshot>> {
    return this.sessions.values();
  }

  /** 開始中または実行中のAIセッションがあるかを返します。 */
  public hasActiveSessions(): boolean {
    return this.starts.size > 0 || this.sessions.size > 0;
  }

  /** 指定されたAIセッションを取得します。 */
  public requireSession(
    sessionId: string,
  ): AiSessionRecord<Workspace, Session, Workflow, Broker, ExternalData, Snapshot> {
    const parsedSessionId = this.dependencies.parseSessionId(sessionId);
    const record = this.sessions.get(parsedSessionId);
    if (record == null || record.closing) {
      throw new Error("指定されたAIセッションは終了しています。");
    }
    return record;
  }

  /** AI変更案の基準データとセッションとの対応を記録します。 */
  public rememberProposal(
    record: AiSessionRecord<Workspace, Session, Workflow, Broker, ExternalData, Snapshot>,
    proposalId: string,
  ): void {
    record.proposalIds.add(proposalId);
  }

  /** AI変更案の基準データを参照がなくなった時点で解放します。 */
  public forgetProposal(
    record: AiSessionRecord<Workspace, Session, Workflow, Broker, ExternalData, Snapshot>,
    proposalId: string,
  ): void {
    record.proposalIds.delete(proposalId);
    const baselineKey = record.baselineStore.proposalKeys.get(proposalId);
    if (baselineKey == null) {
      return;
    }
    record.baselineStore.proposalKeys.delete(proposalId);
    if (![...record.baselineStore.proposalKeys.values()].includes(baselineKey)) {
      record.baselineStore.externalData.delete(baselineKey);
    }
  }

  /** 現在ターンの基準データを解放します。 */
  public releaseCurrentTurnBaselines(
    record: AiSessionRecord<Workspace, Session, Workflow, Broker, ExternalData, Snapshot>,
  ): void {
    for (const baselineKey of record.baselineStore.currentTurnKeys) {
      if (![...record.baselineStore.proposalKeys.values()].includes(baselineKey)) {
        record.baselineStore.externalData.delete(baselineKey);
      }
    }
    record.baselineStore.currentTurnKeys.clear();
    record.baselineStore.taskctlSnapshot = undefined;
  }

  private createLifecycle(): { readonly controller: AbortController; readonly remove: () => void } {
    const controller = new AbortController();
    const abort = (): void => {
      controller.abort();
    };
    this.dependencies.lifecycleSignal.addEventListener("abort", abort, { once: true });
    if (this.dependencies.lifecycleSignal.aborted) {
      abort();
    }
    return {
      controller,
      remove: (): void => {
        this.dependencies.lifecycleSignal.removeEventListener("abort", abort);
      },
    };
  }

  private linkAbortSignal(source: AbortSignal, target: AbortController): () => void {
    const abort = (): void => {
      target.abort();
    };
    source.addEventListener("abort", abort, { once: true });
    if (source.aborted) {
      abort();
    }
    return (): void => {
      source.removeEventListener("abort", abort);
    };
  }

  /** セッションに紐付く操作の中断と完了待機を管理します。 */
  public runOperation<Result>(
    record: AiSessionRecord<Workspace, Session, Workflow, Broker, ExternalData, Snapshot>,
    signal: AbortSignal,
    operation: (operationSignal: AbortSignal) => Result | PromiseLike<Result>,
  ): Promise<Result> {
    this.dependencies.validateAbortSignal(signal);
    if (record.closing) {
      throw new Error("AIセッションは終了処理中です。");
    }
    const controller = new AbortController();
    const removeRequestAbort = this.linkAbortSignal(signal, controller);
    const removeSessionAbort = this.linkAbortSignal(record.lifecycleController.signal, controller);
    const removeQueueOwnedSignal = this.dependencies.hasOperationOwner(signal)
      ? this.dependencies.linkOwnedSignal(controller.signal, signal)
      : undefined;
    const completion = Promise.resolve().then(() => operation(controller.signal));
    record.operations.set(controller, completion);
    return completion.finally(() => {
      removeRequestAbort();
      removeSessionAbort();
      removeQueueOwnedSignal?.();
      record.operations.delete(controller);
    });
  }

  /** AIセッションを終了し、その操作と外部資源の結果を集約します。 */
  public async closeRecord(
    record: AiSessionRecord<Workspace, Session, Workflow, Broker, ExternalData, Snapshot>,
    reason: "explicit" | "application_stop",
  ): Promise<void> {
    if (record.closePromise != null) {
      return record.closePromise;
    }
    if (reason === "explicit" && record.approvalInFlight) {
      throw new Error("承認適用中のAIセッションは終了できません。");
    }
    const stopDisposition: AiSessionCleanupDisposition = reason === "explicit"
      ? { kind: "propagate_unrecorded" }
      : { kind: "record" };
    record.closing = true;
    const sessionStopPromise = record.session.stop(stopDisposition);
    record.lifecycleController.abort();
    for (const controller of record.operations.keys()) {
      controller.abort();
    }
    const closePromise = (async (): Promise<void> => {
      const stopPromises: Promise<void>[] = [sessionStopPromise];
      if (record.externalToolBroker != null) {
        stopPromises.push(record.externalToolBroker.stop());
      }
      const stopResultsPromise = Promise.all(
        stopPromises.map((promise) => settleAiSessionPromise(promise)),
      );
      const operationResultsPromise = Promise.all(
        [...record.operations.entries()].map(async ([controller, promise]) => ({
          controller,
          result: await settleAiSessionPromise(promise),
        })),
      );
      const operationResults = await operationResultsPromise;
      const stopResults = await stopResultsPromise;
      const errors: unknown[] = [
        ...operationResults
          .filter(({ controller, result }) =>
            result.kind === "rejected"
            && !this.dependencies.isAbortError(result.error)
            && !controller.signal.aborted)
          .map(({ result }) => {
            if (result.kind !== "rejected") {
              throw new Error("AIセッション操作の終了結果が不正です。");
            }
            return result.error;
          }),
        ...stopResults
          .filter((result) => result.kind === "rejected")
          .map((result) => result.error),
      ];
      try {
        record.workflow.dispose();
      } catch (error: unknown) {
        errors.push(error);
      }
      record.removeDeltaListener();
      record.removeLifecycleListener();
      for (const proposalId of record.proposalIds) {
        this.forgetProposal(record, proposalId);
      }
      record.baselineStore.currentTurnKeys.clear();
      record.baselineStore.proposalKeys.clear();
      record.baselineStore.externalData.clear();
      record.baselineStore.taskctlSnapshot = undefined;
      if (this.sessions.get(record.sessionId) === record) {
        this.sessions.delete(record.sessionId);
      }
      try {
        this.dependencies.removeWorkspace(record.workspace.userDataPath);
      } catch (error: unknown) {
        errors.push(error);
      }
      if (errors.length > 0) {
        throw this.dependencies.combineFailures(errors);
      }
    })();
    record.closePromise = closePromise;
    return closePromise;
  }

  private async closeStart(
    start: AiSessionStartRecord<Workspace, Session, Broker>,
    disposition: AiSessionCleanupDisposition,
  ): Promise<void> {
    const stopResultPromises: Promise<AiSessionPromiseResult>[] = [];
    if (start.session != null) {
      switch (start.requestStopState.kind) {
        case "not_claimed":
          stopResultPromises.push(settleAiSessionPromise(start.session.stop(disposition)));
          break;
        case "claimed":
          stopResultPromises.push(start.requestStopState.result);
          break;
      }
    }
    if (start.externalToolBroker != null) {
      stopResultPromises.push(settleAiSessionPromise(start.externalToolBroker.stop()));
    }
    const stopResults = await Promise.all(stopResultPromises);
    const errors = stopResults
      .filter((result) => result.kind === "rejected")
      .map((result) => result.error);
    try {
      this.dependencies.removeWorkspace(start.workspace?.userDataPath ?? start.workspaceUserDataPath);
    } catch (error: unknown) {
      errors.push(error);
    }
    if (errors.length > 0) {
      throw this.dependencies.combineFailures(errors);
    }
  }

  /** 開始中と実行中のすべてのAIセッションを終了します。 */
  public async closeAll(errors: unknown[]): Promise<void> {
    const starts = [...this.starts.values()];
    for (const start of starts) {
      start.lifecycleController.abort();
    }
    const startResults = await Promise.all(
      starts.map(async (start) => ({
        start,
        result: await settleAiSessionPromise(start.completion),
      })),
    );
    for (const { start, result } of startResults) {
      if (
        result.kind === "rejected"
        && !this.dependencies.isAbortError(result.error)
        && !start.lifecycleController.signal.aborted
      ) {
        errors.push(result.error);
      }
    }
    const records = [...this.sessions.values()];
    await Promise.all(records.map(async (record) => {
      try {
        await this.closeRecord(record, "application_stop");
      } catch (error: unknown) {
        errors.push(error);
      }
    }));
  }

  private async runStart(
    start: AiSessionStartRecord<Workspace, Session, Broker>,
    signal: AbortSignal,
  ): Promise<AiSessionStartResult> {
    const abortForRequest = (): void => {
      if (start.requestStopState.kind === "not_claimed" && start.session != null) {
        start.requestStopState = {
          kind: "claimed",
          result: settleAiSessionPromise(
            start.session.stop({ kind: "propagate_unrecorded" }),
          ),
        };
      }
      start.lifecycleController.abort();
    };
    signal.addEventListener("abort", abortForRequest, { once: true });
    if (signal.aborted) {
      abortForRequest();
    }
    const removeRequestAbort = (): void => {
      signal.removeEventListener("abort", abortForRequest);
    };
    let lifecycleTransferred = false;
    try {
      start.workspace = this.dependencies.createWorkspace(start.sessionId);
      const externalToolResources = await this.dependencies.prepareExternalTools(
        start.workspace,
        start.lifecycleController.signal,
      );
      start.externalToolBroker = externalToolResources.broker;
      start.session = this.dependencies.createSession(
        start.workspace,
        externalToolResources.endpoint,
      );
      const startResult = await this.dependencies.startSession(
        start.session,
        start.lifecycleController.signal,
      );
      if (startResult.state === "authentication_required") {
        this.dependencies.onAuthenticationRequired(startResult);
        this.dependencies.publishStatus();
        await this.closeStart(start, { kind: "propagate_unrecorded" });
        return { kind: "authentication_required" };
      }
      if (this.dependencies.isStopped() || start.lifecycleController.signal.aborted) {
        throw this.dependencies.createAbortedError();
      }
      const baselineStore: AiSessionBaselineStore<ExternalData, Snapshot> = {
        externalData: new Map(),
        proposalKeys: new Map(),
        currentTurnKeys: new Set(),
        taskctlSnapshot: undefined,
      };
      const workflow = this.dependencies.createWorkflow(
        start.session,
        externalToolResources.collector,
        baselineStore,
        start.sessionId,
      );
      const removeDeltaListener = this.dependencies.subscribeDelta(workflow, start.sessionId);
      const record: AiSessionRecord<Workspace, Session, Workflow, Broker, ExternalData, Snapshot> = {
        sessionId: start.sessionId,
        workspace: start.workspace,
        session: start.session,
        externalToolBroker: start.externalToolBroker,
        workflow,
        baselineStore,
        lifecycleController: start.lifecycleController,
        removeLifecycleListener: start.removeLifecycleListener,
        removeDeltaListener,
        operations: new Map(),
        proposalIds: new Set(),
        closing: false,
        turnInFlight: false,
        approvalInFlight: false,
        closePromise: undefined,
      };
      if (this.dependencies.isStopped() || start.lifecycleController.signal.aborted) {
        removeDeltaListener();
        workflow.dispose();
        throw this.dependencies.createAbortedError();
      }
      this.sessions.set(start.sessionId, record);
      lifecycleTransferred = true;
      return { kind: "started", session_id: start.sessionId };
    } catch (error: unknown) {
      try {
        await this.closeStart(start, this.dependencies.isStopped()
          ? { kind: "record" }
          : { kind: "propagate_unrecorded" });
      } catch (cleanupError: unknown) {
        throw this.dependencies.combineFailures([error, cleanupError]);
      }
      throw error;
    } finally {
      removeRequestAbort();
      if (!lifecycleTransferred) {
        start.removeLifecycleListener();
      }
      this.starts.delete(start.sessionId);
    }
  }

  /** 新しいAIセッションを開始し中断可能な開始記録を保持します。 */
  public startSession(signal: AbortSignal): Promise<AiSessionStartResult> {
    if (this.dependencies.isStopped()) {
      throw new Error("アプリケーションは停止済みです。");
    }
    this.dependencies.assertOperationalReady();
    this.dependencies.validateAbortSignal(signal);
    this.dependencies.throwIfAborted(signal);
    const sessionId = this.dependencies.createSessionId();
    const lifecycle = this.createLifecycle();
    const start: AiSessionStartRecord<Workspace, Session, Broker> = {
      sessionId,
      workspaceUserDataPath: this.dependencies.workspaceUserDataPath(sessionId),
      lifecycleController: lifecycle.controller,
      removeLifecycleListener: lifecycle.remove,
      workspace: undefined,
      session: undefined,
      externalToolBroker: undefined,
      requestStopState: { kind: "not_claimed" },
      completion: Promise.resolve().then<AiSessionStartResult>(() => this.runStart(start, signal)),
    };
    this.starts.set(sessionId, start);
    return start.completion;
  }
}
