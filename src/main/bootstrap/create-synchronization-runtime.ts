import {
  SynchronizationOperations,
  type PostWriteResult,
  type SynchronizationDependencies,
  type SynchronizationResult,
} from "./synchronization-operations";

export type SynchronizationCompositionPort<
  Result extends SynchronizationResult,
  PostResult extends PostWriteResult,
  FailureCode extends string,
  Context,
> = Omit<SynchronizationDependencies<Result, PostResult, FailureCode>, "prepareRecoveredSynchronization"> & {
  readonly requireContext: () => Context;
  readonly coordinateRecovered: (
    context: Context,
    requiredTaskGids: readonly string[],
    signal: AbortSignal,
  ) => Promise<unknown>;
};

/** 同期競合状態と保存済み書き込みの復旧同期を組み立てます。 */
export function createSynchronizationRuntime<
  Result extends SynchronizationResult,
  PostResult extends PostWriteResult,
  FailureCode extends string,
  Context,
>(
  host: SynchronizationCompositionPort<Result, PostResult, FailureCode, Context>,
): SynchronizationOperations<Result, PostResult, FailureCode> {
  const { requireContext, coordinateRecovered, ...dependencies } = host;
  return new SynchronizationOperations<Result, PostResult, FailureCode>({
    ...dependencies,
    prepareRecoveredSynchronization: (requiredTaskGids, signal) => {
      const context = requireContext();
      return () => coordinateRecovered(context, requiredTaskGids, signal);
    },
  });
}
