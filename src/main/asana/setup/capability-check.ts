import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  asanaTaskResponseSchema,
  dateSchema,
  gidSchema,
  parseCustomExternalData,
  serializeCustomExternalData,
  type AsanaTaskResponse,
  type CustomExternalData,
} from "../../../shared/domain";
import { createInitialCustomExternalData } from "../../domain/external-data-ingestion";
import { AsanaRequestAbortedError } from "../scheduler";
import { AsanaReadClient } from "../client/client";
import {
  AsanaTaskWriteClient,
  type AsanaTaskUpdate,
} from "../client/task-write-client";

const capabilityCheckSectionGidsSchema = z
  .object({
    not_started: gidSchema,
    in_progress: gidSchema,
    withdrawn: gidSchema,
  })
  .strict()
  .superRefine((sectionGids, context) => {
    const values = Object.values(sectionGids);
    if (new Set(values).size !== values.length) {
      context.addIssue({
        code: "custom",
        message: "能力検査のセクションGIDを重複指定できません。",
      });
    }
  });

const capabilityCheckInputSchema = z
  .object({
    project_gid: gidSchema,
    section_gids: capabilityCheckSectionGidsSchema,
    tag_gid: gidSchema,
  })
  .strict();

const capabilityCheckChecksSchema = z
  .object({
    project_task_list: z.literal(true),
    task_create: z.literal(true),
    task_update: z.literal(true),
    section_move: z.literal(true),
    tag_add_remove: z.literal(true),
    external_data_read_write: z.literal(true),
    task_withdraw: z.literal(true),
  })
  .strict();

const capabilityCheckSuccessSchema = z
  .object({
    kind: z.literal("ready"),
    test_task_gid: gidSchema,
    checks: capabilityCheckChecksSchema,
  })
  .strict();

const capabilityCheckFailureReasonSchema = z.enum([
  "task_list_failed",
  "task_create_failed",
  "task_update_failed",
  "section_move_failed",
  "tag_add_failed",
  "tag_remove_failed",
  "external_data_write_failed",
  "external_data_read_failed",
  "external_data_mismatch",
  "task_withdraw_failed",
  "readback_mismatch",
]);

const capabilityCheckFailureSchema = z
  .object({
    kind: z.literal("failed"),
    reason_code: capabilityCheckFailureReasonSchema,
  })
  .strict();

const capabilityCheckResultSchema = z.discriminatedUnion("kind", [
  capabilityCheckSuccessSchema,
  capabilityCheckFailureSchema,
]);

type CapabilityCheckInput = z.infer<typeof capabilityCheckInputSchema>;
type CapabilityCheckResult = z.infer<typeof capabilityCheckResultSchema>;
type CapabilityCheckFailureReason = z.infer<
  typeof capabilityCheckFailureReasonSchema
>;

type CapabilityCheckReadClient = Pick<
  AsanaReadClient,
  "listProjectTasks" | "getTask"
>;

type CapabilityCheckWriteClient = Pick<
  AsanaTaskWriteClient,
  | "createTask"
  | "updateTask"
  | "addTaskToSection"
  | "addTaskTag"
  | "removeTaskTag"
>;

function validateAbortSignal(signal: AbortSignal): void {
  if (
    signal == null
    || typeof signal.aborted !== "boolean"
    || typeof signal.addEventListener !== "function"
    || typeof signal.removeEventListener !== "function"
  ) {
    throw new TypeError("AbortSignalが必要です。");
  }
}

function today(currentTime: () => Date): string {
  const now = currentTime();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error("能力検査の現在時刻が不正です。");
  }
  const japanTime = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return dateSchema.parse(japanTime.toISOString().slice(0, 10));
}

function parseTask(task: AsanaTaskResponse): AsanaTaskResponse {
  return asanaTaskResponseSchema.parse(task);
}

function assertTaskProjectMembership(
  task: AsanaTaskResponse,
  projectGid: string,
): void {
  const memberships = task.memberships.filter(
    (membership) => membership.project.gid === projectGid,
  );
  if (memberships.length !== 1) {
    throw new Error("能力検査タスクのプロジェクト所属を確認できません。");
  }
}

function assertTaskSectionMembership(
  task: AsanaTaskResponse,
  projectGid: string,
  sectionGid: string,
): void {
  const memberships = task.memberships.filter(
    (membership) =>
      membership.project.gid === projectGid
      && membership.section?.gid === sectionGid,
  );
  if (memberships.length !== 1) {
    throw new Error("能力検査タスクのセクション所属を確認できません。");
  }
}

function assertTaskTag(
  task: AsanaTaskResponse,
  tagGid: string,
  expected: boolean,
): void {
  const found = task.tags.some((tag) => tag.gid === tagGid);
  if (found !== expected) {
    throw new Error("能力検査タスクのタグ状態を確認できません。");
  }
}

function assertExternalData(
  task: AsanaTaskResponse,
  expectedGid: string,
  expectedData: string,
): void {
  if (
    task.external == null
    || task.external.gid !== expectedGid
    || task.external.data !== expectedData
  ) {
    throw new AsanaCapabilityCheckError(
      "external_data_mismatch",
      new Error("能力検査タスクのCustom external dataが一致しません。"),
    );
  }
}

function updatedExternalData(data: CustomExternalData): string {
  return serializeCustomExternalData({
    ...data,
    rev: data.rev + 1,
  });
}

/** 初回設定でAsanaの必須操作能力を検査したことを表すエラーです。 */
export class AsanaCapabilityCheckError extends Error {
  public readonly result: Extract<CapabilityCheckResult, { kind: "failed" }>;

  public constructor(
    reasonCode: CapabilityCheckFailureReason,
    cause: unknown,
  ) {
    super("Asanaの初回能力検査に失敗しました。", { cause });
    this.name = "AsanaCapabilityCheckError";
    this.result = capabilityCheckFailureSchema.parse({
      kind: "failed",
      reason_code: reasonCode,
    });
  }
}

/** 初回設定でAsanaの必須操作能力を実操作により検査します。 */
export class AsanaCapabilityCheckService {
  private readonly readClient: CapabilityCheckReadClient;
  private readonly writeClient: CapabilityCheckWriteClient;
  private readonly currentTime: () => Date;

  public constructor(
    readClient: CapabilityCheckReadClient,
    writeClient: CapabilityCheckWriteClient,
    currentTime: () => Date,
  ) {
    if (
      typeof readClient?.listProjectTasks !== "function"
      || typeof readClient.getTask !== "function"
    ) {
      throw new TypeError("能力検査の読み取りクライアントが必要です。");
    }
    if (
      typeof writeClient?.createTask !== "function"
      || typeof writeClient.updateTask !== "function"
      || typeof writeClient.addTaskToSection !== "function"
      || typeof writeClient.addTaskTag !== "function"
      || typeof writeClient.removeTaskTag !== "function"
    ) {
      throw new TypeError("能力検査の書き込みクライアントが必要です。");
    }
    if (typeof currentTime !== "function") {
      throw new TypeError("能力検査の現在時刻関数が必要です。");
    }
    this.readClient = readClient;
    this.writeClient = writeClient;
    this.currentTime = currentTime;
  }

  /** 初回設定でAsanaの必須操作能力を検査します。 */
  public async check(
    input: CapabilityCheckInput,
    signal: AbortSignal,
  ): Promise<CapabilityCheckResult> {
    const validatedInput = capabilityCheckInputSchema.parse(input);
    validateAbortSignal(signal);
    if (signal.aborted) {
      throw new AsanaRequestAbortedError();
    }

    let createdTaskGid: string | undefined;
    try {
      await this.runStep(
        "task_list_failed",
        async () => {
          const tasks = await this.readClient.listProjectTasks(
            validatedInput.project_gid,
            signal,
          );
          for (const task of tasks) {
            parseTask(task);
          }
        },
      );

      const initialization = createInitialCustomExternalData({
        id: randomUUID(),
        activity_anchor_on: today(this.currentTime),
        last_active_status: "not_started",
        device_id: "capability_check",
        created_via: "capability_check",
      });
      const title = `TaskHub能力検査 ${initialization.gid}`;
      const createdTaskReference = await this.runStep(
        "task_create_failed",
        async () =>
          this.writeClient.createTask(
            {
              project_gid: validatedInput.project_gid,
              title,
              external: {
                gid: initialization.gid,
                data: initialization.data,
              },
            },
            signal,
          ),
      );
      const testTaskGid = createdTaskReference.gid;
      createdTaskGid = testTaskGid;
      let currentTask = await this.readTask(testTaskGid, signal);
      assertTaskProjectMembership(currentTask, validatedInput.project_gid);
      assertExternalData(
        currentTask,
        initialization.gid,
        initialization.data,
      );

      const updatedTitle = `${title} 更新`;
      await this.runStep(
        "task_update_failed",
        async () => {
          const update: AsanaTaskUpdate = {
            kind: "title",
            value: updatedTitle,
          };
          await this.writeClient.updateTask(testTaskGid, update, signal);
        },
      );
      currentTask = await this.readTask(testTaskGid, signal);
      if (currentTask.name !== updatedTitle) {
        throw new AsanaCapabilityCheckError(
          "readback_mismatch",
          new Error("能力検査タスクの更新結果が一致しません。"),
        );
      }

      await this.runStep(
        "section_move_failed",
        async () => {
          await this.writeClient.addTaskToSection(
            testTaskGid,
            validatedInput.section_gids.in_progress,
            { kind: "none" },
            signal,
          );
        },
      );
      currentTask = await this.readTask(testTaskGid, signal);
      assertTaskSectionMembership(
        currentTask,
        validatedInput.project_gid,
        validatedInput.section_gids.in_progress,
      );

      await this.runStep(
        "tag_add_failed",
        async () => {
          await this.writeClient.addTaskTag(
            testTaskGid,
            validatedInput.tag_gid,
            signal,
          );
        },
      );
      currentTask = await this.readTask(testTaskGid, signal);
      assertTaskTag(currentTask, validatedInput.tag_gid, true);

      await this.runStep(
        "tag_remove_failed",
        async () => {
          await this.writeClient.removeTaskTag(
            testTaskGid,
            validatedInput.tag_gid,
            signal,
          );
        },
      );
      currentTask = await this.readTask(testTaskGid, signal);
      assertTaskTag(currentTask, validatedInput.tag_gid, false);

      const parsedExternal = parseCustomExternalData(initialization.data);
      if (parsedExternal.kind !== "valid") {
        throw new AsanaCapabilityCheckError(
          "external_data_read_failed",
          new Error("能力検査用Custom external dataを解析できません。"),
        );
      }
      const updatedExternal = updatedExternalData(parsedExternal.data);
      await this.runStep(
        "external_data_write_failed",
        async () => {
          await this.writeClient.updateTask(
            testTaskGid,
            {
              kind: "external",
              value: {
                gid: initialization.gid,
                data: updatedExternal,
              },
            },
            signal,
          );
        },
      );
      currentTask = await this.readTask(testTaskGid, signal);
      assertExternalData(currentTask, initialization.gid, updatedExternal);

      await this.withdrawTask(
        testTaskGid,
        validatedInput.section_gids.withdrawn,
        signal,
      );
      currentTask = await this.readTask(testTaskGid, signal);
      assertTaskSectionMembership(
        currentTask,
        validatedInput.project_gid,
        validatedInput.section_gids.withdrawn,
      );
      if (!currentTask.completed) {
        throw new AsanaCapabilityCheckError(
          "readback_mismatch",
          new Error("能力検査タスクを取り下げ状態へ確認できません。"),
        );
      }

      return capabilityCheckSuccessSchema.parse({
        kind: "ready",
        test_task_gid: testTaskGid,
        checks: {
          project_task_list: true,
          task_create: true,
          task_update: true,
          section_move: true,
          tag_add_remove: true,
          external_data_read_write: true,
          task_withdraw: true,
        },
      });
    } catch (error: unknown) {
      const failure = error instanceof AsanaRequestAbortedError
        || error instanceof AsanaCapabilityCheckError
        ? error
        : new AsanaCapabilityCheckError("readback_mismatch", error);
      return this.cleanupAfterFailure(
        createdTaskGid,
        validatedInput.section_gids.withdrawn,
        signal,
        failure,
      );
    }
  }

  private async readTask(
    taskGid: string,
    signal: AbortSignal,
  ): Promise<AsanaTaskResponse> {
    return this.runStep(
      "external_data_read_failed",
      async () => parseTask(await this.readClient.getTask(taskGid, signal)),
    );
  }

  private async runStep<T>(
    reasonCode: CapabilityCheckFailureReason,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error: unknown) {
      if (error instanceof AsanaRequestAbortedError) {
        throw error;
      }
      if (error instanceof AsanaCapabilityCheckError) {
        throw error;
      }
      throw new AsanaCapabilityCheckError(reasonCode, error);
    }
  }

  private async withdrawTask(
    taskGid: string,
    sectionGid: string,
    signal: AbortSignal,
  ): Promise<void> {
    await this.runStep(
      "task_withdraw_failed",
      async () => {
        await this.writeClient.addTaskToSection(
          taskGid,
          sectionGid,
          { kind: "none" },
          signal,
        );
        await this.writeClient.updateTask(
          taskGid,
          { kind: "completed", value: true },
          signal,
        );
      },
    );
  }

  private async cleanupAfterFailure(
    taskGid: string | undefined,
    withdrawnSectionGid: string,
    signal: AbortSignal,
    originalError: unknown,
  ): Promise<never> {
    if (taskGid == null) {
      throw originalError;
    }
    const cleanupErrors: unknown[] = [];
    try {
      await this.writeClient.addTaskToSection(
        taskGid,
        withdrawnSectionGid,
        { kind: "none" },
        signal,
      );
    } catch (error: unknown) {
      cleanupErrors.push(error);
    }
    try {
      await this.writeClient.updateTask(
        taskGid,
        { kind: "completed", value: true },
        signal,
      );
    } catch (error: unknown) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length === 0) {
      throw originalError;
    }
    throw new AggregateError(
      [originalError, ...cleanupErrors],
      "Asana能力検査と試験タスクの後処理に失敗しました。",
      { cause: originalError },
    );
  }
}

export {
  capabilityCheckFailureReasonSchema,
  capabilityCheckInputSchema,
  capabilityCheckResultSchema,
};
export type {
  CapabilityCheckInput as AsanaCapabilityCheckInput,
  CapabilityCheckResult as AsanaCapabilityCheckResult,
};
