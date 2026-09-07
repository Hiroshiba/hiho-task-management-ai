declare module "*.vue" {
  import type { DefineComponent } from "vue";

  const component: DefineComponent;
  export default component;
}

interface Window {
  readonly taskHub?: import("../shared/task-hub-api").TaskHubApi;
}
