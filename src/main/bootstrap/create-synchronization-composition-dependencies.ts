import {
  AsanaSyncCoordinator,
  AsanaSyncRuntime,
  type AsanaSyncRuntimeInternalResult,
} from "../infrastructure/asana";
import { DiagnosticFailureDispositionError } from "../application/common/errors/diagnostic-failure";
import {
  asanaPostWriteSynchronizationResultSchema,
  type PostWriteSynchronizationFailureCode,
  type PostWriteSynchronizationResultWithCause,
} from "../application/common/proposal-application-schemas";
import type { OperationalContext } from "../application/settings";
import { validateAbortSignal, throwIfAborted } from "../application/common/abort-signal";
import {
  classifyPostWriteSynchronizationError,
  postWriteRecoveryRequired,
  postWriteRecoveryRequiredWithCause,
  postWriteSynchronizationFromRuntimeResult,
} from "./post-write-synchronization";
import type { SynchronizationCompositionPort } from "./create-synchronization-runtime";

export type SynchronizationCompositionDependencies = SynchronizationCompositionPort<
  AsanaSyncRuntimeInternalResult,
  PostWriteSynchronizationResultWithCause,
  PostWriteSynchronizationFailureCode,
  OperationalContext
>;

type SynchronizationCompositionHost = {
  readonly hasOperationOwner: (signal: AbortSignal) => boolean;
  readonly hasPendingJournal: () => boolean;
  readonly hasIncompleteJournal: () => boolean;
  readonly isJournalRecoveryRunning: () => boolean;
  readonly assertPostWriteSynchronizationReady: (executionId: string) => void;
  readonly recoverJournal: (signal: AbortSignal) => Promise<void>;
  readonly afterLocalStateRefresh: (signal: AbortSignal) => Promise<void>;
  readonly synchronizeCodexAfterAsana: (signal: AbortSignal) => Promise<void>;
  readonly requireRuntime: () => AsanaSyncRuntime;
  readonly requireContext: () => OperationalContext;
  readonly syncCoordinator: AsanaSyncCoordinator;
  readonly appVersion: string;
  readonly recordLocalRefreshFailure: (error: unknown) => void;
};

/** 同期runtimeへ渡す競合判定と復旧portを結線します。 */
export function createSynchronizationCompositionDependencies(
  host: SynchronizationCompositionHost,
): SynchronizationCompositionDependencies {
    return {
      validateAbortSignal,
      throwIfAborted,
      hasOperationOwner: (signal) => host.hasOperationOwner(signal),
      hasPendingJournal: () => host.hasPendingJournal(),
      hasIncompleteJournal: () => host.hasIncompleteJournal(),
      isJournalRecoveryRunning: () => host.isJournalRecoveryRunning(),
      assertPostWriteSynchronizationReady: (executionId) =>
        host.assertPostWriteSynchronizationReady(executionId),
      recoverJournal: (signal) => host.recoverJournal(signal),
      afterLocalStateRefresh: (signal) => host.afterLocalStateRefresh(signal),
      synchronizeCodexAfterAsana: (signal) =>
        host.synchronizeCodexAfterAsana(signal),
      afterGuiEdit: (requiredTaskGids, executionId, signal) =>
        host.requireRuntime().afterGuiEdit(requiredTaskGids, executionId, signal),
      afterAiApply: (requiredTaskGids, executionId, signal) =>
        host.requireRuntime().afterAiApply(requiredTaskGids, executionId, signal),
      beforeAiTurn: (signal) => host.requireRuntime().beforeAiTurn(signal),
      requireContext: () => host.requireContext(),
      coordinateRecovered: (context, requiredTaskGids, signal) => host.syncCoordinator.coordinate(
        {
          mode: "delta",
          project_gid: context.project_gid,
          section_gids: context.section_gids,
          device_id: context.device_id,
          app_version: host.appVersion,
          required_task_gids: [...requiredTaskGids],
        },
        signal,
      ),
      isSynchronizedResult: (
        result,
      ): result is Extract<AsanaSyncRuntimeInternalResult, { kind: "synchronized" }> =>
        result.kind === "synchronized",
      abortedCode: "aborted",
      classifyError: classifyPostWriteSynchronizationError,
      isDiagnosticFailure: (error) => error instanceof DiagnosticFailureDispositionError,
      recoveryRequired: postWriteRecoveryRequired,
      recoveryRequiredWithCause: postWriteRecoveryRequiredWithCause,
      synchronizedPostWrite: () => asanaPostWriteSynchronizationResultSchema.parse({
        kind: "synchronized",
      }),
      fromRuntimeResult: postWriteSynchronizationFromRuntimeResult,
      recordLocalRefreshFailure: (error) => host.recordLocalRefreshFailure(error),
    };
}
