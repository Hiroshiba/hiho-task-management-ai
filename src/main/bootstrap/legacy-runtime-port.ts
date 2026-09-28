import { TaskHubApplication } from "../application/service";
import type { PersistenceRuntime } from "../infrastructure/persistence";
import type { SqliteProposalApplicationHistoryRepository } from "../infrastructure/persistence";

export type LegacyRuntimeOptions = ConstructorParameters<typeof TaskHubApplication>[0];

export type LegacyRuntimePort = Pick<
  TaskHubApplication,
  | "applyGuiEdit"
  | "getGuiEditExecution"
  | "retryGuiEditExecution"
  | "onAiStatus"
  | "onAiDelta"
  | "onExternalAgentChanged"
  | "getSettingsCompositionDependencies"
  | "getTaskReadCompositionDependencies"
  | "getSynchronizationCompositionDependencies"
  | "getObsidianCompositionDependencies"
  | "getDiagnosticCompositionDependencies"
  | "attachSettingsRuntime"
  | "attachTaskReadRuntime"
  | "attachSynchronizationRuntime"
  | "attachDiagnosticRuntime"
  | "getProposalsHandlerWorkflows"
  | "getState"
  | "getTaskWriteAsanaBridge"
  | "setTaskWriteExecution"
  | "recordDiagnostic"
  | "start"
  | "stop"
>;

/** 未移行のMain機能を一つのランタイムとして組み立てます。 */
export function createLegacyRuntime(
  options: LegacyRuntimeOptions,
  persistence: PersistenceRuntime,
  files: ConstructorParameters<typeof TaskHubApplication>[2],
  historyRepository: SqliteProposalApplicationHistoryRepository,
  bindings: ConstructorParameters<typeof TaskHubApplication>[4],
): LegacyRuntimePort {
  return new TaskHubApplication(options, persistence, files, historyRepository, bindings);
}
