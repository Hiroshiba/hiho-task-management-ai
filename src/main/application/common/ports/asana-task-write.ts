import type { z } from "zod";
import { z as schema } from "zod";

type AsanaWriteJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly AsanaWriteJsonValue[]
  | { readonly [key: string]: AsanaWriteJsonValue };

export type AsanaSingleAttemptWriteRequest<T> = {
  readonly method: "POST" | "PUT";
  readonly path: readonly string[];
  readonly query?: Readonly<Record<string, string | readonly string[]>>;
  readonly body: { readonly [key: string]: AsanaWriteJsonValue };
  readonly response_schema: z.ZodType<T>;
};

/** 一つの書き込み要求を認証更新後も再送せずに送信します。 */
export interface AsanaSingleAttemptWritePort {
  requestSingleAttempt<T>(
    request: AsanaSingleAttemptWriteRequest<T>,
    signal: AbortSignal,
  ): Promise<T>;
}

export interface AsanaTaskWriteReadClientPort {
  getTask(taskGid: string, signal: AbortSignal): Promise<unknown>;
  listProjectTasks(projectGid: string, signal: AbortSignal): Promise<unknown>;
  listWorkspaceTags(workspaceGid: string, signal: AbortSignal): Promise<unknown>;
}

export const taskWriteSynchronizationFailureCodeSchema = schema.enum([
  "authentication_required",
  "offline",
  "aborted",
  "stopped",
  "payment_required",
  "rate_limited",
  "http_error",
  "transport_error",
  "response_error",
  "events_reset",
  "request_aborted",
  "sync_in_progress",
  "unexpected_error",
]);

export type TaskWriteSynchronizationFailureCode = z.infer<typeof taskWriteSynchronizationFailureCodeSchema>;

export type TaskWritePostSynchronizationResult =
  | { readonly kind: "synchronized" }
  | {
      readonly kind: "recovery_required";
      readonly error_code: TaskWriteSynchronizationFailureCode;
      readonly cause?: unknown;
    };

/** 既存ランタイムが所有するAsana接続と事後同期を公開します。 */
export interface TaskWriteAsanaBridge {
  readonly transport: AsanaSingleAttemptWritePort;
  readonly readClient: AsanaTaskWriteReadClientPort;
  isNotFound(error: unknown): boolean;
  synchronizeAfterProposalWrite(
    requiredTaskGids: readonly string[],
    executionId: string,
    signal: AbortSignal,
  ): Promise<TaskWritePostSynchronizationResult>;
  synchronizeAfterGuiWrite(
    requiredTaskGids: readonly string[],
    executionId: string,
    signal: AbortSignal,
  ): Promise<TaskWritePostSynchronizationResult>;
}
