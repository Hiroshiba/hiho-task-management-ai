import { AsanaOperationInvalidatedError, type AsanaOperationQueueInput } from "../common/ports/asana-operation-queue";
import { asanaTaskResponseSchema, identifierSchema } from "../../domain";
import type { SnapshotHasher } from "../common/ports/snapshot-hasher";
import { applyGuiTaskWriteExecution, type GuiEditDependencies, type GuiEditExecutionPort, type GuiEditStartResult } from "./apply";
import type { GuiEditExecution } from "./execution-workflow";
import type { GuiEditInput } from "./write-plan";
import { normalizeGuiDueOperation } from "./normalize-due-operation";

type GuiEditRequest = Pick<GuiEditInput, "task_gid" | "operation"> & {
  readonly expected_task_hash: string;
};

type GuiRejectedResult = {
  readonly operation_id: string;
  readonly task_gid: string;
  readonly outcome: "rejected";
  readonly reason_code: "offline" | "baseline_changed" | "task_missing" | "synchronization_failed" | "context_changed";
};

export type GuiEditWorkflowResult = GuiEditStartResult | {
  readonly kind: "not_started";
  readonly result: GuiRejectedResult;
};

type GuiEditContext = Pick<GuiEditInput,
  "project_gid" | "workspace_gid" | "section_gids" | "device_id">;

type GuiEditRequestWorkflowDependencies<Context extends GuiEditContext> = {
  readonly assertOperationalReady: () => void;
  readonly assertReauthenticationIdle: () => void;
  readonly assertMutationRequestAccepted: () => void;
  readonly assertQueuedMutationReady: () => void;
  readonly assertContextUnchanged: (expected: Context) => void;
  readonly isOnline: () => boolean;
  readonly requireContext: () => Context;
  readonly getTaskCacheEntry: (taskGid: string) => { readonly asana_response: unknown } | undefined;
  readonly today: () => string;
  readonly createId: () => unknown;
  readonly queue: { enqueue<T>(input: AsanaOperationQueueInput<T>): Promise<T> };
  readonly getExecutionPort: () => GuiEditExecutionPort;
  readonly getExecution: (executionId: string) => GuiEditExecution;
  readonly retryExecution: (executionId: string, signal: AbortSignal) => Promise<GuiEditExecution>;
  readonly readTask: GuiEditDependencies["readTask"];
  readonly validateRelation: GuiEditDependencies["validateRelation"];
  readonly parseRequest: (value: unknown) => GuiEditRequest;
  readonly hashGuiEditBaseline: SnapshotHasher["hashGuiEditBaseline"];
};

/** GUI編集の受付、実行、明示再試行を扱います。 */
export class GuiEditRequestWorkflow<Context extends GuiEditContext> {
  public constructor(private readonly dependencies: GuiEditRequestWorkflowDependencies<Context>) {}

  /** GUI編集を受け付けて保存済みplanを実行します。 */
  public async apply(input: GuiEditRequest, signal: AbortSignal): Promise<GuiEditWorkflowResult> {
    const request = this.dependencies.parseRequest(input);
    const operation = request.operation.kind === "set_due"
      ? normalizeGuiDueOperation(request.operation.value)
      : request.operation;
    this.dependencies.assertOperationalReady();
    this.dependencies.assertReauthenticationIdle();
    if (!this.dependencies.isOnline()) {
      return { kind: "not_started", result: this.createRejectedResult(request.task_gid, "offline") };
    }
    this.dependencies.assertMutationRequestAccepted();
    const context = this.dependencies.requireContext();
    try {
      return await this.dependencies.queue.enqueue<GuiEditWorkflowResult>({
        priority: "user",
        kind: "gui_edit",
        signal,
        beforeStart: () => {
          if (!this.dependencies.isOnline()) {
            throw new AsanaOperationInvalidatedError("offline");
          }
          this.dependencies.assertQueuedMutationReady();
          this.dependencies.assertContextUnchanged(context);
        },
        run: (operationContext) => {
          const baseline = this.dependencies.getTaskCacheEntry(request.task_gid);
          if (baseline == null) {
            return { kind: "not_started", result: this.createRejectedResult(request.task_gid, "task_missing") };
          }
          const baselineTask = asanaTaskResponseSchema.parse(baseline.asana_response);
          if (this.dependencies.hashGuiEditBaseline(baselineTask) !== request.expected_task_hash) {
            return { kind: "not_started", result: this.createRejectedResult(request.task_gid, "baseline_changed") };
          }
          const input: GuiEditInput = {
            task_gid: request.task_gid,
            project_gid: context.project_gid,
            workspace_gid: context.workspace_gid,
            section_gids: context.section_gids,
            device_id: context.device_id,
            created_via: "gui",
            activity_date: this.dependencies.today(),
            baseline_task: baselineTask,
            operation,
          };
          return applyGuiTaskWriteExecution(input, this.dependencies.getExecutionPort(), {
            isOnline: this.dependencies.isOnline,
            readTask: this.dependencies.readTask,
            validateRelation: this.dependencies.validateRelation,
          }, operationContext.signal);
        },
      });
    } catch (error: unknown) {
      if (error instanceof AsanaOperationInvalidatedError) {
        return { kind: "not_started", result: this.createRejectedResult(request.task_gid, error.reason) };
      }
      throw error;
    }
  }

  /** 指定IDの保存済みGUI編集executionを取得します。 */
  public getExecution(executionId: string): GuiEditExecution {
    return this.dependencies.getExecution(executionId);
  }

  /** 保存済みGUI編集を実行条件の検証後に再試行します。 */
  public async retryExecution(executionId: string, signal: AbortSignal): Promise<GuiEditExecution> {
    this.dependencies.assertMutationRequestAccepted();
    const context = this.dependencies.requireContext();
    return this.dependencies.queue.enqueue({
      priority: "user",
      kind: "gui_edit",
      signal,
      beforeStart: () => {
        this.dependencies.assertQueuedMutationReady();
        this.dependencies.assertContextUnchanged(context);
      },
      run: (operationContext) => this.dependencies.retryExecution(executionId, operationContext.signal),
    });
  }

  private createRejectedResult(taskGid: string, reasonCode: GuiRejectedResult["reason_code"]): GuiRejectedResult {
    return {
      operation_id: identifierSchema.parse(this.dependencies.createId()),
      task_gid: taskGid,
      outcome: "rejected",
      reason_code: reasonCode,
    };
  }
}
