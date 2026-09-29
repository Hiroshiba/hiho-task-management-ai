import { systemContracts, systemUpdateStateSchema, type SystemApi } from "../../../shared/ipc-contracts/system";

/** 画面確認用のsystem API mockを作成します。 */
export function createMockSystemApi(): SystemApi {
  const updateState = systemUpdateStateSchema.parse({ kind: "current" });
  const listeners = new Set<Parameters<SystemApi["onUpdateState"]>[0]>();
  return {
    getVersion: () => Promise.resolve().then(() => systemContracts.getVersion.response.parse({
      kind: "ok",
      value: "0.1.0-mock",
    })),
    waitForStartup: () => Promise.resolve().then(() => systemContracts.waitForStartup.response.parse({
      kind: "ok",
      value: { completed: true },
    })),
    getUpdateState: () => Promise.resolve().then(() => systemContracts.getUpdateState.response.parse({
      kind: "ok",
      value: updateState,
    })),
    onUpdateState: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
