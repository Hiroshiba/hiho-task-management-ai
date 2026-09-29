import {
  aiWorkflowSnapshotSchema,
  asanaTaskResponseSchema,
  baselineSnapshotSchema,
  canonicalizeJson,
  ingestAsanaExternalData,
  isoDateTimeSchema,
  serializeCustomExternalData,
  taskSchema,
  type AiWorkflowSnapshot,
  type AsanaTaskResponse,
} from "../../domain";
import { AsanaOperationInvalidatedError, type AsanaOperationQueueInput } from "../common/ports/asana-operation-queue";
import type { ExternalAgentBaseline } from "../common/ports/external-agent-proposal";
import type {
  ProjectMetadataRecord,
  TaskCacheRecord,
  TaskReadRanking,
  TaskReadSyncState,
} from "../common/ports/task-read-repository";
import { createBaselineSnapshot } from "./baseline-snapshot";

type BaselineExternalData = ExternalAgentBaseline<unknown>["baseline_external_data"];
type BaselineStore<Snapshot> = {
  readonly externalData: Map<string, BaselineExternalData>;
  readonly currentTurnKeys: Set<string>;
  taskctlSnapshot: Snapshot | undefined;
};
type Context = { readonly project_gid: string };
type TaskctlSnapshotLike = {
  readonly sync: { readonly kind: string; readonly synced_at?: string };
  readonly tasks: readonly unknown[];
};
type Queue = {
  hasOwner(signal: AbortSignal): boolean;
  runOwned<T>(signal: AbortSignal, run: AsanaOperationQueueInput<T>["run"]): Promise<T>;
  enqueue<T>(input: AsanaOperationQueueInput<T>): Promise<T>;
};
type ProposalBaselineDependencies<OperationContext extends Context, Snapshot extends TaskctlSnapshotLike> = {
  readonly repository: {
    getTaskCache(): readonly TaskCacheRecord[];
    getProjectMetadataCache(projectGid: string): ProjectMetadataRecord | undefined;
    getRankingCache(): TaskReadRanking | undefined;
    getSyncState(projectGid: string): TaskReadSyncState | undefined;
  };
  readonly operationQueue: Queue;
  readonly getContext: () => OperationContext | undefined;
  readonly requireContext: () => OperationContext;
  readonly appVersion: string;
  readonly now: () => Date;
  readonly parseTaskctlSnapshot: (value: unknown) => Snapshot;
  readonly validateAbortSignal: (signal: AbortSignal) => void;
  readonly assertQueuedMutationReady: () => void;
  readonly assertOperationalReady: () => void;
  readonly assertReauthenticationIdle: () => void;
  readonly assertContextUnchanged: (expected: OperationContext) => void;
  readonly asanaContextKey: (context: OperationContext) => string;
  readonly isOnline: () => boolean;
};

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function parseTaskCache(entries: readonly TaskCacheRecord[]): readonly TaskCacheRecord[] {
  return entries.map((entry) => {
    asanaTaskResponseSchema.parse(entry.asana_response);
    taskSchema.parse(entry.task);
    return entry;
  });
}

function externalDataIsValid(task: AsanaTaskResponse): boolean {
  const ingestion = ingestAsanaExternalData(task);
  return task.external != null
    && ingestion.kind === "valid"
    && task.external.gid === `TaskHub:v1:task:${ingestion.data.id}`
    && task.external.data === serializeCustomExternalData(ingestion.data);
}

/** AIと外部提案が参照する同期済み基準値を同じ保存スナップショットから作ります。 */
export class ProposalBaselineWorkflow<OperationContext extends Context, Snapshot extends TaskctlSnapshotLike> {
  public constructor(private readonly dependencies: ProposalBaselineDependencies<OperationContext, Snapshot>) {}

  /** taskctlへ渡す保存済みタスクと順位を取得します。 */
  public createTaskctlSnapshot(): Snapshot {
    const context = this.dependencies.getContext();
    const entries = parseTaskCache(this.dependencies.repository.getTaskCache());
    const tasks = entries.map((entry) => taskSchema.parse(entry.task))
      .sort((left, right) => compareStrings(left.gid, right.gid));
    const syncState = context == null
      ? undefined
      : this.dependencies.repository.getSyncState(context.project_gid);
    const ranking = this.dependencies.repository.getRankingCache();
    return this.dependencies.parseTaskctlSnapshot({
      sync: syncState?.last_successful_sync_at == null
        ? { kind: "unavailable" }
        : { kind: "synced", synced_at: syncState.last_successful_sync_at },
      tasks,
      ranking: ranking == null
        ? { kind: "unavailable" }
        : { kind: "available", cache: ranking },
    });
  }

  /** AIターンの基準値を操作queue内で取得します。 */
  public createAiSnapshot(signal: AbortSignal, store: BaselineStore<Snapshot>): Promise<AiWorkflowSnapshot> {
    this.dependencies.validateAbortSignal(signal);
    signal.throwIfAborted();
    const expectedContext = this.dependencies.requireContext();
    if (this.dependencies.operationQueue.hasOwner(signal)) {
      return this.dependencies.operationQueue.runOwned(signal, (context) =>
        this.createAiSnapshotOwned(context.signal, store));
    }
    return this.dependencies.operationQueue.enqueue({
      priority: "user",
      kind: "ai_snapshot",
      signal,
      beforeStart: () => {
        this.dependencies.assertQueuedMutationReady();
        this.dependencies.assertContextUnchanged(expectedContext);
      },
      run: (context) => this.createAiSnapshotOwned(context.signal, store),
    });
  }

  /** 外部提案の基準値を操作queue内で取得します。 */
  public createExternalBaseline(signal: AbortSignal): Promise<ExternalAgentBaseline<Snapshot>> {
    this.dependencies.validateAbortSignal(signal);
    signal.throwIfAborted();
    const expectedContext = this.dependencies.requireContext();
    if (this.dependencies.operationQueue.hasOwner(signal)) {
      return this.dependencies.operationQueue.runOwned(signal, (context) =>
        this.createExternalBaselineOwned(context.signal));
    }
    return this.dependencies.operationQueue.enqueue({
      priority: "user",
      kind: "external_snapshot",
      signal,
      beforeStart: () => {
        this.dependencies.assertOperationalReady();
        this.dependencies.assertReauthenticationIdle();
        if (!this.dependencies.isOnline()) {
          throw new Error("オフライン中は外部提案の基準値を取得できません。");
        }
        const currentContext = this.dependencies.requireContext();
        if (this.dependencies.asanaContextKey(currentContext)
          !== this.dependencies.asanaContextKey(expectedContext)) {
          throw new AsanaOperationInvalidatedError("context_changed");
        }
      },
      run: (context) => this.createExternalBaselineOwned(context.signal),
    });
  }

  private createExternalBaselineOwned(signal: AbortSignal): ExternalAgentBaseline<Snapshot> {
    const baseline = this.captureProposalBaselineOwned(signal, "external");
    signal.throwIfAborted();
    const taskctlSnapshot = this.createTaskctlSnapshot();
    signal.throwIfAborted();
    if (taskctlSnapshot.sync.kind !== "synced"
      || taskctlSnapshot.sync.synced_at !== baseline.snapshot.synced_at
      || canonicalizeJson(taskctlSnapshot.tasks) !== canonicalizeJson(baseline.snapshot.tasks)) {
      throw new Error("外部提案の基準値とtaskctl基準値が一致しません。");
    }
    return { ...baseline, taskctl_snapshot: taskctlSnapshot };
  }

  private createAiSnapshotOwned(signal: AbortSignal, store: BaselineStore<Snapshot>): AiWorkflowSnapshot {
    const baseline = this.captureProposalBaselineOwned(signal, "ai");
    signal.throwIfAborted();
    store.taskctlSnapshot = this.createTaskctlSnapshot();
    const baselineKey = canonicalizeJson(baseline.baseline_snapshot);
    store.externalData.set(baselineKey, baseline.baseline_external_data);
    store.currentTurnKeys.add(baselineKey);
    return baseline.snapshot;
  }

  private captureProposalBaselineOwned(
    signal: AbortSignal,
    purpose: "ai" | "external",
  ): Omit<ExternalAgentBaseline<Snapshot>, "taskctl_snapshot"> {
    this.dependencies.validateAbortSignal(signal);
    signal.throwIfAborted();
    const context = this.dependencies.requireContext();
    const syncState = this.dependencies.repository.getSyncState(context.project_gid);
    if (syncState?.last_successful_sync_at == null) {
      throw new Error(purpose === "ai"
        ? "AIターンに必要な同期済み時刻がありません。"
        : "外部提案に必要な同期済み時刻がありません。");
    }
    const metadata = this.dependencies.repository.getProjectMetadataCache(context.project_gid);
    if (metadata == null) {
      throw new Error(purpose === "ai"
        ? "AIターンに必要なAsanaメタデータがありません。"
        : "外部提案に必要なAsanaメタデータがありません。");
    }
    const entries = parseTaskCache(this.dependencies.repository.getTaskCache());
    const tasks = entries.map((entry) => taskSchema.parse(entry.task))
      .sort((left, right) => compareStrings(left.gid, right.gid));
    const areas = new Set<string>(["未分類"]);
    for (const tag of metadata.tags) {
      if (!tag.name.startsWith("TaskHub/領域/")) continue;
      const area = tag.name.slice("TaskHub/領域/".length);
      if (area.trim().length > 0) areas.add(area);
    }
    const now = this.dependencies.now();
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
      throw new Error("現在時刻が不正です。");
    }
    const snapshot = aiWorkflowSnapshotSchema.parse({
      app_version: this.dependencies.appVersion,
      project_gid: context.project_gid,
      synced_at: syncState.last_successful_sync_at,
      as_of: isoDateTimeSchema.parse(now.toISOString()),
      tasks,
      areas: [...areas].sort(compareStrings),
    });
    const baselineExternalData: BaselineExternalData = entries
      .filter((entry) => externalDataIsValid(entry.asana_response))
      .map((entry) => {
        const external = entry.asana_response.external;
        if (external == null) throw new Error("検証済みのCustom external dataを取得できません。");
        return {
          task_gid: entry.gid,
          external: { gid: external.gid, data: external.data },
        };
      })
      .sort((left, right) => compareStrings(left.task_gid, right.task_gid));
    signal.throwIfAborted();
    return {
      snapshot,
      baseline_snapshot: createBaselineSnapshot(snapshot, {
        parseSnapshot: (value) => aiWorkflowSnapshotSchema.parse(value),
        parseBaseline: (value) => baselineSnapshotSchema.parse(value),
      }),
      baseline_external_data: baselineExternalData,
    };
  }
}
