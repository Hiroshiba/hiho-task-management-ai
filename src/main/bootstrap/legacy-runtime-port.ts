import { TaskHubApplication, migrateLegacyStorage } from "../application/service";
import type { LegacyProposalExecutionRepository } from "../application/common/ports/proposal-execution-repository";
import type { PersistenceRuntime } from "../infrastructure/persistence";

export type LegacyRuntimeOptions = ConstructorParameters<typeof TaskHubApplication>[0];

export type LegacyRuntimePort = Pick<
  TaskHubApplication,
  | "taskRead"
  | "getIpcPorts"
  | "getState"
  | "getTaskWriteAsanaBridge"
  | "setTaskWriteExecution"
  | "onForeground"
  | "onOnline"
  | "recordDiagnostic"
  | "setOnline"
  | "start"
  | "stop"
>;

/** 未移行の保存形式を現行SQLite接続へ移行します。 */
export const migrateLegacyPersistence = migrateLegacyStorage;

/** 未移行のMain機能を一つのランタイムとして組み立てます。 */
export function createLegacyRuntime(
  options: LegacyRuntimeOptions,
  persistence: PersistenceRuntime,
  files: ConstructorParameters<typeof TaskHubApplication>[2],
  legacyRepository: LegacyProposalExecutionRepository,
): LegacyRuntimePort {
  return new TaskHubApplication(options, persistence, files, legacyRepository);
}
