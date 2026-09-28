import { inject, type InjectionKey } from "vue";
import type { TaskHubApi } from "../../shared/task-hub-api";

export const taskHubApiInjectionKey: InjectionKey<TaskHubApi> = Symbol("taskHubApi");

const legacyMockFeatureNames = [
  "app",
  "appUpdate",
  "asana",
  "readModel",
  "sync",
  "proposalHistory",
  "setup",
  "gui",
  "externalAgent",
  "ai",
  "obsidian",
] satisfies readonly (keyof TaskHubApi)[];

type MockApiSelection =
  | {
      readonly kind: "none";
    }
  | {
      readonly kind: "selected";
      readonly features: ReadonlySet<string>;
      readonly api: TaskHubApi;
    };

function selectTaskHubNamespace<Name extends keyof TaskHubApi>(
  name: Name,
  mockSelection: MockApiSelection,
  nativeApi: TaskHubApi | undefined,
): TaskHubApi[Name] {
  if (mockSelection.kind === "selected" && mockSelection.features.has(name)) {
    return mockSelection.api[name];
  }
  if (nativeApi == null) {
    throw new Error(
      `Webフロントでは機能「${name}」のAPIを利用できません。mock=${name}またはmock=allを指定してください。`,
    );
  }
  return nativeApi[name];
}

/** 解析済みmock指定に応じた旧Renderer APIを作成します。 */
export async function createTaskHubApi(selectedFeatures: ReadonlySet<string>, nativeApi: TaskHubApi | undefined): Promise<TaskHubApi> {
  let mockSelection: MockApiSelection;
  if (!legacyMockFeatureNames.some((name) => selectedFeatures.has(name))) {
    mockSelection = { kind: "none" };
  } else {
    const { createMockTaskHubApi } = await import("./mocks/task-hub");
    mockSelection = {
      kind: "selected",
      features: selectedFeatures,
      api: createMockTaskHubApi(),
    };
  }
  return {
    get app() {
      return selectTaskHubNamespace("app", mockSelection, nativeApi);
    },
    get appUpdate() {
      return selectTaskHubNamespace("appUpdate", mockSelection, nativeApi);
    },
    get asana() {
      return selectTaskHubNamespace("asana", mockSelection, nativeApi);
    },
    get readModel() {
      return selectTaskHubNamespace("readModel", mockSelection, nativeApi);
    },
    get sync() {
      return selectTaskHubNamespace("sync", mockSelection, nativeApi);
    },
    get proposalHistory() {
      return selectTaskHubNamespace("proposalHistory", mockSelection, nativeApi);
    },
    get setup() {
      return selectTaskHubNamespace("setup", mockSelection, nativeApi);
    },
    get gui() {
      return selectTaskHubNamespace("gui", mockSelection, nativeApi);
    },
    get externalAgent() {
      return selectTaskHubNamespace("externalAgent", mockSelection, nativeApi);
    },
    get ai() {
      return selectTaskHubNamespace("ai", mockSelection, nativeApi);
    },
    get obsidian() {
      return selectTaskHubNamespace("obsidian", mockSelection, nativeApi);
    },
  };
}

/** VueからRenderer APIを取得します。 */
export function useTaskHub(): TaskHubApi {
  const taskHubApi = inject(taskHubApiInjectionKey);
  if (taskHubApi == null) {
    throw new Error("TaskHub APIが提供されていません。");
  }
  return taskHubApi;
}
