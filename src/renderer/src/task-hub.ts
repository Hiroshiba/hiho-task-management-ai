import { inject, type InjectionKey } from "vue";
import { z } from "zod";
import type { TaskHubApi } from "../../shared/task-hub-api";
import { createMockTaskHubApi } from "./mocks/task-hub";

export const taskHubApiInjectionKey: InjectionKey<TaskHubApi> = Symbol("taskHubApi");

const mockFeatureNameSchema = z.enum([
  "app",
  "asana",
  "readModel",
  "sync",
  "setup",
  "gui",
  "ai",
  "obsidian",
]);

type MockFeatureName = z.infer<typeof mockFeatureNameSchema>;

function parseMockFeatureNames(search: string): ReadonlySet<MockFeatureName> {
  const values = new URLSearchParams(search).getAll("mock");
  if (values.length === 0) {
    return new Set();
  }
  if (values.length !== 1) {
    throw new Error("mockクエリパラメータは1つだけ指定してください。");
  }

  const value = values[0];
  if (value == null || value.length === 0) {
    throw new Error("mockクエリパラメータに値を指定してください。");
  }

  const names = value.split(",");
  if (names.some((name) => name.length === 0)) {
    throw new Error("mockクエリパラメータに空の機能名を指定できません。");
  }
  if (names.includes("all")) {
    if (names.length > 1) {
      throw new Error("mock=allには他の機能名を指定できません。");
    }
    return new Set(mockFeatureNameSchema.options);
  }

  const parsedNames = names.map((name) => {
    const parsed = mockFeatureNameSchema.safeParse(name);
    if (!parsed.success) {
      throw new Error(
        `mockクエリパラメータの機能名「${name}」は未対応です。`,
        { cause: parsed.error },
      );
    }
    return parsed.data;
  });
  return new Set(parsedNames);
}

type MockApiSelection =
  | {
      readonly kind: "none";
    }
  | {
      readonly kind: "selected";
      readonly features: ReadonlySet<MockFeatureName>;
      readonly api: TaskHubApi;
    };

function selectTaskHubNamespace<Name extends MockFeatureName>(
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

/** URLのmock指定に応じたRenderer APIを作成します。 */
export function createTaskHubApi(search: string, nativeApi: TaskHubApi | undefined): TaskHubApi {
  const selectedFeatures = parseMockFeatureNames(search);
  const mockSelection: MockApiSelection = selectedFeatures.size === 0
    ? { kind: "none" }
    : { kind: "selected", features: selectedFeatures, api: createMockTaskHubApi() };
  return {
    get app() {
      return selectTaskHubNamespace("app", mockSelection, nativeApi);
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
    get setup() {
      return selectTaskHubNamespace("setup", mockSelection, nativeApi);
    },
    get gui() {
      return selectTaskHubNamespace("gui", mockSelection, nativeApi);
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
