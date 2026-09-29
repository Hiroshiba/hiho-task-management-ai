import { taskSchema } from "../../domain";
import type { TaskCacheRecord, TaskReadRanking } from "../common/ports/task-read-repository";
import { buildDisplayOrderInput } from "./display-order-input";

type DisplayOrderInput = ReturnType<typeof buildDisplayOrderInput>;
type DisplayOrderContext = Parameters<typeof buildDisplayOrderInput>[0];
type ProjectTasks = Parameters<typeof buildDisplayOrderInput>[1];
type DisplayOrderService<Input> = {
  requestLatest(inputProvider: (signal: AbortSignal) => Input | PromiseLike<Input>, signal: AbortSignal): Promise<unknown>;
};
type LocalStateRefreshDependencies<Context extends DisplayOrderContext, Input> = {
  readonly repository: {
    getTaskCache(): readonly TaskCacheRecord[];
    getRankingCache(): TaskReadRanking | undefined;
  };
  readonly replaceBrokenVaultLinksFromTasks: (tasks: readonly TaskCacheRecord["task"][], signal: AbortSignal) => Promise<unknown>;
  readonly getDisplayOrder: () => DisplayOrderService<Input> | undefined;
  readonly requireContext: () => Context;
  readonly readProjectTasks: (projectGid: string, signal: AbortSignal) => Promise<ProjectTasks>;
  readonly parseDisplayOrderInput: (value: DisplayOrderInput) => Input;
  readonly assertQueuedMutationReady: () => void;
  readonly assertContextUnchanged: (context: Context) => void;
  readonly ignoreDisplayOrderError: (error: unknown) => boolean;
  readonly recordUnexpectedError: (error: unknown) => void;
};

/** 同期後のVaultリンク検査とAsana表示順の更新を実行します。 */
export class LocalStateRefreshWorkflow<Context extends DisplayOrderContext, Input> {
  public constructor(private readonly dependencies: LocalStateRefreshDependencies<Context, Input>) {}

  /** 保存済みタスクのVaultリンクを再検査します。 */
  public async refreshLocalTaskState(signal: AbortSignal): Promise<void> {
    const tasks = this.dependencies.repository.getTaskCache().map((entry) => taskSchema.parse(entry.task));
    await this.dependencies.replaceBrokenVaultLinksFromTasks(tasks, signal);
    signal.throwIfAborted();
  }

  /** ローカル状態を更新し、最新の順位をAsana表示順へ反映します。 */
  public async afterLocalStateRefresh(signal: AbortSignal): Promise<void> {
    await this.refreshLocalTaskState(signal);
    const displayOrder = this.dependencies.getDisplayOrder();
    if (displayOrder == null) return;
    const expectedContext = this.dependencies.requireContext();
    void displayOrder.requestLatest(async (operationSignal) => {
      this.dependencies.assertQueuedMutationReady();
      this.dependencies.assertContextUnchanged(expectedContext);
      const input = await this.createDisplayOrderInput(operationSignal);
      this.dependencies.assertContextUnchanged(expectedContext);
      return input;
    }, signal).catch((error: unknown) => {
      if (!this.dependencies.ignoreDisplayOrderError(error)) {
        this.dependencies.recordUnexpectedError(error);
      }
    });
  }

  private async createDisplayOrderInput(signal: AbortSignal): Promise<Input> {
    const context = this.dependencies.requireContext();
    const tasks = await this.dependencies.readProjectTasks(context.project_gid, signal);
    const ranking = this.dependencies.repository.getRankingCache()?.ranked_tasks
      .map((task) => task.gid) ?? [];
    return this.dependencies.parseDisplayOrderInput(buildDisplayOrderInput(context, tasks, ranking));
  }
}
