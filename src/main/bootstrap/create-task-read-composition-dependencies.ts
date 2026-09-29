import { z } from "zod";
import {
  AsanaSyncCoordinator,
  AsanaSyncRuntime,
  type AsanaCommunicationRuntime,
  type AsanaSyncCoordinatorResult,
  type AsanaSyncRuntimeInternalResult,
  type AsanaSyncRuntimeState,
} from "../infrastructure/asana";
import { asanaTaskResponseSchema } from "../domain";
import type { SnapshotHasher } from "../application/common/ports/snapshot-hasher";
import { validateAbortSignal } from "../application/common/abort-signal";
import type { TaskReadEntry } from "../application/common/ports/task-read-repository";
import type { OperationalContext, SetupFullSyncInput } from "../application/settings";
import { overviewSchema, detailSchema } from "../../shared/ipc-contracts/task-view";
import { tasksContracts } from "../../shared/ipc-contracts/tasks";
import { setupFullSyncInputSchema } from "./setup-contracts";
import { createTaskReadPersistenceContracts } from "./task-read-storage-contracts";
import type { TaskReadCompositionPort } from "./create-task-read-runtime";

export type TaskReadCompositionDependencies = TaskReadCompositionPort<
  z.output<typeof overviewSchema>,
  z.output<typeof detailSchema>,
  AsanaSyncRuntimeInternalResult,
  AsanaSyncCoordinatorResult,
  AsanaSyncRuntimeState,
  OperationalContext,
  SetupFullSyncInput,
  AsanaSyncRuntime
>;

export type AsanaSyncRuntimeFactory = (
  context: OperationalContext,
  online: boolean,
  beforeSynchronization: ConstructorParameters<typeof AsanaSyncRuntime>[4],
  reportUnexpectedError: ConstructorParameters<typeof AsanaSyncRuntime>[5],
) => AsanaSyncRuntime;

type TaskReadCompositionHost = {
  readonly repository: TaskReadCompositionDependencies["repository"];
  readonly persistenceContracts: ReturnType<typeof createTaskReadPersistenceContracts>;
  readonly syncCoordinator: AsanaSyncCoordinator;
  readonly operationQueue: AsanaCommunicationRuntime["operationQueue"];
  readonly lifecycleSignal: AbortSignal;
  readonly appVersion: string;
  readonly snapshotHasher: SnapshotHasher;
  readonly createSyncRuntime: AsanaSyncRuntimeFactory;
  readonly diagnostic: (error: unknown, channel: string) => void;
  readonly recordDiagnostic: (code: "sync.started" | "sync.completed") => void;
  readonly shouldReportKnownFailure: () => boolean;
  readonly afterLocalStateRefresh: (signal: AbortSignal) => Promise<void>;
  readonly isReadyActivated: () => boolean;
  readonly synchronizeCodex: (signal: AbortSignal) => Promise<void>;
  readonly reportUnexpectedError: (error: unknown, feature: string) => void;
  readonly requireContext: () => OperationalContext;
  readonly assertReady: () => void;
  readonly assertReauthenticationIdle: () => void;
  readonly requireRuntime: () => AsanaSyncRuntime;
  readonly getRuntime: () => AsanaSyncRuntime | undefined;
  readonly beforeSynchronization: (signal: AbortSignal, executionId: string | undefined) => Promise<void>;
  readonly configureContextFromSetup: () => void;
  readonly requireSynchronizedResult: TaskReadCompositionDependencies["requireSynchronizedResult"];
  readonly afterSynchronizedState: TaskReadCompositionDependencies["afterSynchronizedState"];
};

/** タスク読取と同期状態へ渡す保存・接続portを組み立てます。 */
export function createTaskReadCompositionDependencies(
  host: TaskReadCompositionHost,
): TaskReadCompositionDependencies {
    return {
      repository: host.repository,
      contracts: {
        ...host.persistenceContracts,
        parseOverview: (value: unknown) => overviewSchema.parse(value),
        parseDetail: (value: unknown) => detailSchema.parse(value),
        hashBaseline: (entry: TaskReadEntry) => host.snapshotHasher.hashGuiEditBaseline(
          asanaTaskResponseSchema.parse(entry.asana_response),
        ),
      },
      syncStateDependencies: {
        toEvent: (state) => state,
        recordDiagnostic: (code) => host.recordDiagnostic(code),
        shouldReportKnownFailure: () => host.shouldReportKnownFailure(),
        reportKnownFailure: (cause) => host.diagnostic(
          cause == null
            ? new Error("Asana同期で認証または既知のエラーが発生しました。")
            : cause,
          "sync",
        ),
        reportListenerFailure: (error) =>
          host.diagnostic(error, "sync_state_listener"),
        lifecycleSignal: host.lifecycleSignal,
        afterLocalStateRefresh: (signal) => host.afterLocalStateRefresh(signal),
        isReadyActivated: () => host.isReadyActivated(),
        synchronizeCodex: (signal) => host.synchronizeCodex(signal),
        reportUnexpectedError: (error, feature) => host.reportUnexpectedError(error, feature),
      },
      lifecycleSignal: host.lifecycleSignal,
      projectGid: () => host.requireContext().project_gid,
      assertReady: () => host.assertReady(),
      assertReauthenticationIdle: () => host.assertReauthenticationIdle(),
      requireRuntime: () => host.requireRuntime(),
      getRuntime: () => host.getRuntime(),
      createSyncRuntime: (context, online) => host.createSyncRuntime(
        context,
        online,
        (signal, executionId) => host.beforeSynchronization(signal, executionId),
        (error) => host.reportUnexpectedError(error, "sync"),
      ),
      parseSyncInput: (value) => tasksContracts.runSync.request.parse(value),
      parseSetupInput: (value) => setupFullSyncInputSchema.parse(value),
      validateAbortSignal,
      configureContextFromSetup: () => host.configureContextFromSetup(),
      enqueueSynchronization: (signal, run) => host.operationQueue.enqueue({
        priority: "user",
        kind: "synchronization",
        signal,
        run: (context) => run(context.signal),
      }),
      coordinateFull: (input, signal) => host.syncCoordinator.coordinate(
        {
          mode: "full",
          project_gid: input.project_gid,
          section_gids: input.section_gids,
          device_id: input.device_id,
          app_version: host.appVersion,
          required_task_gids: [],
        },
        signal,
      ),
      recordDiagnostic: (code: "sync.started" | "sync.completed") => host.recordDiagnostic(code),
      afterLocalStateRefresh: (signal: AbortSignal) => host.afterLocalStateRefresh(signal),
      requireSynchronizedResult: (result) => host.requireSynchronizedResult(result),
      afterSynchronizedState: (result, signal) =>
        host.afterSynchronizedState(result, signal),
      isSynchronizedResult: (
        result,
      ): result is Extract<AsanaSyncRuntimeInternalResult, { kind: "synchronized" }> =>
        result.kind === "synchronized",
    };
}
