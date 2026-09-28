import {
  TaskReadIndex,
  SyncStateRuntime,
  TaskReadWorkflow,
  type TaskReadContracts,
  type SyncStateDependencies,
  type TaskReadRuntimeState,
  type TaskReadSyncResult,
} from "../application/task-read";
import { AsanaTaskReadAdapter } from "../infrastructure/asana";

class UnreachableError extends Error {}

type SyncRuntime<Result, State> = {
  getState(): State;
  manualFullSync(signal: AbortSignal): Promise<Result>;
  manualSync(signal: AbortSignal): Promise<Result>;
  onForeground(signal: AbortSignal): Promise<Result>;
  onOnline(signal: AbortSignal): Promise<Result>;
  setOnline(online: boolean): void;
  subscribe(listener: (state: State, cause?: unknown) => void): () => void;
};

export type TaskReadCompositionPort<
  Overview,
  Detail,
  Result extends TaskReadSyncResult<Details>,
  Details extends { readonly performed_mode: "full" | "delta" },
  State extends TaskReadRuntimeState,
  Context,
  SetupInput,
  Runtime extends SyncRuntime<Result, State>,
> = {
  readonly repository: ConstructorParameters<typeof TaskReadIndex<Overview, Detail>>[0];
  readonly contracts: TaskReadContracts<Overview, Detail>;
  readonly syncStateDependencies: SyncStateDependencies<State, State>;
  readonly projectGid: () => string;
  readonly assertReady: () => void;
  readonly assertReauthenticationIdle: () => void;
  readonly requireRuntime: () => Runtime;
  readonly getRuntime: () => Runtime | undefined;
  readonly createSyncRuntime: (context: Context, online: boolean) => Runtime;
  readonly parseSyncInput: (value: unknown) => { readonly mode: "full" | "delta" };
  readonly parseSetupInput: (value: unknown) => SetupInput;
  readonly configureContextFromSetup: () => void;
  readonly enqueueSynchronization: (
    signal: AbortSignal,
    run: (operationSignal: AbortSignal) => Promise<Details>,
  ) => Promise<Details>;
  readonly coordinateFull: (input: SetupInput, signal: AbortSignal) => Promise<Details>;
  readonly recordDiagnostic: (code: "sync.started" | "sync.completed") => void;
  readonly afterLocalStateRefresh: (signal: AbortSignal) => Promise<void>;
  readonly requireSynchronizedResult: (
    result: Promise<Result>,
  ) => Promise<Extract<Result, { kind: "synchronized" }>>;
  readonly afterSynchronizedState: (
    result: Extract<Result, { kind: "synchronized" }>,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly isSynchronizedResult: (result: Result) => result is Extract<Result, { kind: "synchronized" }>;
  readonly validateAbortSignal: (signal: AbortSignal) => void;
  readonly lifecycleSignal: AbortSignal;
};

/** タスク読取、同期状態、起動時と復帰時の同期を組み立てます。 */
export function createTaskReadRuntime<
  Overview,
  Detail,
  Result extends TaskReadSyncResult<Details>,
  Details extends { readonly performed_mode: "full" | "delta" },
  State extends TaskReadRuntimeState,
  Context,
  SetupInput,
  Runtime extends SyncRuntime<Result, State>,
>(
  host: TaskReadCompositionPort<Overview, Detail, Result, Details, State, Context, SetupInput, Runtime>,
): {
  readonly workflow: TaskReadWorkflow<Overview, Detail, Result, Details, State, State, Details>;
  readonly createSyncRuntime: (context: Context, online: boolean) => Runtime;
  readonly runSetupFullSync: (input: SetupInput, signal: AbortSignal) => Promise<void>;
  readonly synchronizeReauthentication: (signal: AbortSignal) => Promise<Details>;
  readonly onForeground: (signal: AbortSignal) => Promise<void>;
  readonly onOnline: () => Promise<void>;
  readonly setOnline: (online: boolean) => void;
  readonly subscribeRuntime: (runtime: Runtime) => void;
  readonly stop: () => void;
} {
  const index = new TaskReadIndex(host.repository, host.contracts);
  const stateRuntime = new SyncStateRuntime(host.syncStateDependencies);
  const workflow = new TaskReadWorkflow<Overview, Detail, Result, Details, State, State, Details>(
    index,
    stateRuntime,
    {
      projectGid: host.projectGid,
      assertReady: host.assertReady,
      assertReauthenticationIdle: host.assertReauthenticationIdle,
      asana: new AsanaTaskReadAdapter(host.requireRuntime),
      parseSyncInput: host.parseSyncInput,
      toSyncState: (state) => state,
      toSyncResult: (details) => details,
      requireSynchronizedResult: host.requireSynchronizedResult,
      afterSynchronizedState: host.afterSynchronizedState,
    },
  );
  const runSetupFullSync = async (input: SetupInput, signal: AbortSignal): Promise<void> => {
    host.validateAbortSignal(signal);
    const validatedInput = host.parseSetupInput(input);
    host.configureContextFromSetup();
    host.recordDiagnostic("sync.started");
    const result = await host.enqueueSynchronization(signal, (operationSignal) =>
      host.coordinateFull(validatedInput, operationSignal));
    if (result.performed_mode !== "full") {
      throw new Error("初回設定のフル同期が完全同期を返しませんでした。");
    }
    await host.afterLocalStateRefresh(signal);
    host.recordDiagnostic("sync.completed");
  };
  const synchronizeReauthentication = async (signal: AbortSignal): Promise<Details> => {
    const synchronized = await host.requireSynchronizedResult(host.requireRuntime().onOnline(signal));
    await host.afterSynchronizedState(synchronized, signal);
    return synchronized.result;
  };
  const onForeground = async (signal: AbortSignal): Promise<void> => {
    host.validateAbortSignal(signal);
    host.assertReady();
    host.assertReauthenticationIdle();
    const result = await host.requireSynchronizedResult(host.requireRuntime().onForeground(signal));
    await host.afterSynchronizedState(result, signal);
  };
  const onOnline = async (): Promise<void> => {
    host.assertReady();
    host.assertReauthenticationIdle();
    const result = await host.requireRuntime().onOnline(host.lifecycleSignal);
    if (host.isSynchronizedResult(result)) {
      await host.afterSynchronizedState(result, host.lifecycleSignal);
      return;
    }
    if (result.kind === "failed") {
      return;
    }
    if (result.kind === "aborted") {
      throw new Error("Asana同期が中断されました。");
    }
    if (result.kind === "rejected") {
      throw new Error(
        result.reason === "offline"
          ? "オフライン中はAsana同期を実行できません。"
          : "停止済みのAsana同期ランタイムは実行できません。",
      );
    }
    throw new UnreachableError("Asana同期結果が不正です。");
  };
  const setOnline = (online: boolean): void => {
    if (typeof online !== "boolean") {
      throw new TypeError("オンライン状態は真偽値で指定してください。");
    }
    host.getRuntime()?.setOnline(online);
  };
  return {
    workflow,
    createSyncRuntime: host.createSyncRuntime,
    runSetupFullSync,
    synchronizeReauthentication,
    onForeground,
    onOnline,
    setOnline,
    subscribeRuntime: (runtime) => workflow.subscribeRuntime(runtime),
    stop: () => workflow.stop(),
  };
}
