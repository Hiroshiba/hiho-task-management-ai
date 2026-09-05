import { createApp } from "vue";
import App from "./App.vue";
import "./styles.css";
import { createTaskHubApi, taskHubApiInjectionKey } from "./task-hub";

const taskHubApi = createTaskHubApi(window.location.search, window.taskHub);

createApp(App).provide(taskHubApiInjectionKey, taskHubApi).mount("#app");
