import { z } from "zod";

/** ターン中に収集した外部状態根拠を検証するschemaを作成します。 */
export function createTrustedExternalStatusEvidenceSchema(gidSchema: z.ZodType<string>) {
  return z
  .array(
    z
      .object({
        kind: z.literal("external_tool"),
        locator: z.string().refine((value) => value.trim().length > 0, {
          message: "外部状態根拠locatorを空にできません。",
        }),
        target_task_gid: gidSchema,
        status: z.enum(["closed", "completed", "cancelled"]),
      })
      .strict(),
  )
  .max(256)
  .superRefine((references, context) => {
    const seen = new Set<string>();
    references.forEach((reference, index) => {
      if (seen.has(reference.locator)) {
        context.addIssue({
          code: "custom",
          path: [index, "locator"],
          message: "外部状態根拠locatorを重複指定できません。",
        });
        return;
      }
      seen.add(reference.locator);
    });
  });
}

type WorkflowOptionsShape = {
  readonly sessionId: string;
  readonly session: unknown;
  readonly snapshotProvider: unknown;
  readonly taskctlSnapshotProvider: unknown;
  readonly parseTaskctlSnapshot: unknown;
  readonly baselineExternalDataProvider: unknown;
  readonly externalStatusEvidenceCollector: unknown;
  readonly executeApproval: unknown;
  readonly logRetryEvent: unknown;
  readonly reportListenerError: unknown;
};

/** AIワークフローの依存境界を検証します。 */
export function parseWorkflowOptions<TOptions extends WorkflowOptionsShape>(
  options: TOptions,
  identifierSchema: z.ZodType<string>,
): {
  readonly sessionId: string;
  readonly session: TOptions["session"];
  readonly snapshotProvider: TOptions["snapshotProvider"];
  readonly taskctlSnapshotProvider: TOptions["taskctlSnapshotProvider"];
  readonly parseTaskctlSnapshot: TOptions["parseTaskctlSnapshot"];
  readonly baselineExternalDataProvider: TOptions["baselineExternalDataProvider"];
  readonly externalStatusEvidenceCollector: TOptions["externalStatusEvidenceCollector"];
  readonly executeApproval: TOptions["executeApproval"];
  readonly logRetryEvent: TOptions["logRetryEvent"];
  readonly reportListenerError: TOptions["reportListenerError"];
} {
const sessionPortSchema = z.custom<TOptions["session"]>(
  (value) => {
    if (typeof value !== "object" || value == null) {
      return false;
    }
    return [
      "startTurnWithPreparation",
      "freezeTaskctlSnapshot",
      "releaseTaskctlSnapshot",
      "activateProposalWorkspace",
      "onDelta",
    ].every((name) => typeof Reflect.get(value, name) === "function");
  },
  "AIセッション境界が不正です。",
);

const snapshotProviderSchema = z.custom<TOptions["snapshotProvider"]>(
  (value) => typeof value === "function",
  "AIスナップショット供給関数が必要です。",
);

const taskctlSnapshotProviderSchema = z.custom<TOptions["taskctlSnapshotProvider"]>(
  (value) => typeof value === "function",
  "taskctlスナップショット供給関数が必要です。",
);

const taskctlSnapshotParserSchema = z.custom<TOptions["parseTaskctlSnapshot"]>(
  (value) => typeof value === "function",
  "taskctlスナップショット検証関数が必要です。",
);

const baselineExternalDataProviderSchema = z.custom<TOptions["baselineExternalDataProvider"]>(
  (value) => typeof value === "function",
  "基準Custom external data供給関数が必要です。",
);

const externalStatusEvidenceCollectorSchema = z.custom<
  TOptions["externalStatusEvidenceCollector"]
>(
  (value) => typeof value === "object"
    && value != null
    && ["beginTurn", "snapshotTurn", "finishTurn", "cancelTurn"].every(
      (name) => typeof Reflect.get(value, name) === "function",
    ),
  "外部状態根拠収集境界が必要です。",
);

const approvalExecutorSchema = z.custom<TOptions["executeApproval"]>(
  (value) => typeof value === "function",
  "承認実行関数が必要です。",
);

const retryEventLoggerSchema = z.custom<TOptions["logRetryEvent"]>(
  (value) => typeof value === "function",
  "AI変更案の再試行ログ関数が必要です。",
);

const listenerErrorReporterSchema = z.custom<TOptions["reportListenerError"]>(
  (value) => typeof value === "function",
  "差分購読のエラー記録関数が必要です。",
);

return z
  .object({
    sessionId: identifierSchema,
    session: sessionPortSchema,
    snapshotProvider: snapshotProviderSchema,
    taskctlSnapshotProvider: taskctlSnapshotProviderSchema,
    parseTaskctlSnapshot: taskctlSnapshotParserSchema,
    baselineExternalDataProvider: baselineExternalDataProviderSchema,
    externalStatusEvidenceCollector: externalStatusEvidenceCollectorSchema,
    executeApproval: approvalExecutorSchema,
    logRetryEvent: retryEventLoggerSchema,
    reportListenerError: listenerErrorReporterSchema,
  })
  .strict()
    .parse(options);
}
