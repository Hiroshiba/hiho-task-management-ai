import type { AsanaTaskReadPort } from "../common/ports/asana-task-read";
import { TaskReadIndex } from "./task-read-index";
import { SyncStateRuntime } from "./sync-state-runtime";

type SynchronizedResult<Details> = { readonly kind: "synchronized"; readonly result: Details };
export type TaskReadSyncResult<Details> =
  | SynchronizedResult<Details>
  | { readonly kind: "rejected"; readonly reason: "offline" | "stopped" }
  | { readonly kind: "aborted" }
  | { readonly kind: "failed"; readonly error_code: string; readonly cause: unknown };

export type TaskReadRuntimeState =
  | { readonly kind: "syncing"; readonly last_successful_sync_at?: string | undefined }
  | { readonly kind: "online"; readonly last_successful_sync_at?: string | undefined }
  | { readonly kind: "offline"; readonly last_successful_sync_at?: string | undefined }
  | { readonly kind: "authentication_required"; readonly last_successful_sync_at?: string | undefined }
  | { readonly kind: "error"; readonly error_code: string; readonly last_successful_sync_at?: string | undefined };

type TaskReadSyncRuntime<State> = {
  subscribe(listener: (state: State, cause?: unknown) => void): () => void;
};

export type TaskReadWorkflowDependencies<
  Result extends TaskReadSyncResult<Details>,
  Details,
  State extends TaskReadRuntimeState,
  Event,
  RenderedResult,
> = {
  readonly projectGid: () => string;
  readonly assertReady: () => void;
  readonly assertReauthenticationIdle: () => void;
  readonly asana: AsanaTaskReadPort<Result, State>;
  readonly parseSyncInput: (value: unknown) => { readonly mode: "full" | "delta" };
  readonly toSyncState: (state: State) => Event;
  readonly toSyncResult: (details: Details) => RenderedResult;
  readonly requireSynchronizedResult: (
    result: Promise<Result>,
  ) => Promise<Extract<Result, { readonly kind: "synchronized" }>>;
  readonly afterSynchronizedState: (
    result: Extract<Result, { readonly kind: "synchronized" }>,
    signal: AbortSignal,
  ) => Promise<void>;
};

/** タスク読取とAsana同期の公開入口です。 */
export class TaskReadWorkflow<
  Overview,
  Detail,
  Result extends TaskReadSyncResult<Details>,
  Details,
  State extends TaskReadRuntimeState,
  Event,
  RenderedResult,
> {
  public constructor(
    private readonly index: TaskReadIndex<Overview, Detail>,
    private readonly stateRuntime: SyncStateRuntime<State, Event>,
    private readonly dependencies: TaskReadWorkflowDependencies<
      Result,
      Details,
      State,
      Event,
      RenderedResult
    >,
  ) {}

  /** プロジェクト概要を取得します。 */
  public getOverview(): Overview {
    return this.index.getOverview(this.dependencies.projectGid());
  }

  /** タスク詳細を取得します。 */
  public getTaskDetail(taskGid: string): Detail {
    return this.index.getTaskDetail(this.dependencies.projectGid(), taskGid);
  }

  /** 同期状態を取得します。 */
  public getState(): Event {
    this.dependencies.assertReady();
    return this.dependencies.toSyncState(this.dependencies.asana.getSyncState());
  }

  /** 手動の通常同期または完全同期を実行します。 */
  public async run(input: unknown, signal: AbortSignal): Promise<RenderedResult> {
    this.dependencies.assertReady();
    this.dependencies.assertReauthenticationIdle();
    const request = this.dependencies.parseSyncInput(input);
    const result = await this.dependencies.requireSynchronizedResult(
      request.mode === "full"
        ? this.dependencies.asana.synchronizeFull(signal)
        : this.dependencies.asana.synchronizeDelta(signal),
    );
    await this.dependencies.afterSynchronizedState(result, signal);
    return this.dependencies.toSyncResult(result.result);
  }

  /** 同期状態イベントの購読を登録します。 */
  public onState(listener: (state: Event) => void): () => void {
    return this.stateRuntime.onState(listener);
  }

  /** 同期ランタイムの状態変更を購読します。 */
  public subscribeRuntime(runtime: TaskReadSyncRuntime<State>): void {
    this.stateRuntime.subscribeRuntime(runtime);
  }

  /** 同期状態の購読を終了します。 */
  public stop(): void {
    this.stateRuntime.stop();
  }
}
