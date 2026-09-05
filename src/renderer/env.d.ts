import type { TaskHubApi } from "../shared/task-hub-api";

declare module "*.vue" {
  import type { DefineComponent } from "vue";

  const component: DefineComponent;
  export default component;
}

declare global {
  interface Window {
    readonly taskHub?: TaskHubApi;
  }
}

export {};
