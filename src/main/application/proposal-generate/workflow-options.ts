import { z } from "zod";

type WorkflowOptionsShape = {
  readonly sessionId: string;
  readonly session: unknown;
  readonly snapshotProvider: unknown;
  readonly taskctlSnapshotProvider: unknown;
  readonly parseTaskctlSnapshot: unknown;
  readonly createId: unknown;
  readonly hashCanonicalJson: unknown;
  readonly hashBaselineSnapshot: unknown;
  readonly redactSensitiveText: unknown;
  readonly isSessionOutputValidationError: unknown;
  readonly isSessionSyncError: unknown;
  readonly baselineExternalDataProvider: unknown;
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
  readonly createId: TOptions["createId"];
  readonly hashCanonicalJson: TOptions["hashCanonicalJson"];
  readonly hashBaselineSnapshot: TOptions["hashBaselineSnapshot"];
  readonly redactSensitiveText: TOptions["redactSensitiveText"];
  readonly isSessionOutputValidationError: TOptions["isSessionOutputValidationError"];
  readonly isSessionSyncError: TOptions["isSessionSyncError"];
  readonly baselineExternalDataProvider: TOptions["baselineExternalDataProvider"];
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

const idFactorySchema = z.custom<TOptions["createId"]>(
  (value) => typeof value === "function",
  "変更案のID生成関数が必要です。",
);

const canonicalJsonHashSchema = z.custom<TOptions["hashCanonicalJson"]>(
  (value) => typeof value === "function",
  "変更案のハッシュ生成関数が必要です。",
);
const baselineSnapshotHashSchema = z.custom<TOptions["hashBaselineSnapshot"]>(
  (value) => typeof value === "function",
  "基準スナップショットのハッシュ生成関数が必要です。",
);

const redactSensitiveTextSchema = z.custom<TOptions["redactSensitiveText"]>(
  (value) => typeof value === "function",
  "診断情報の伏せ字関数が必要です。",
);

const sessionOutputValidationErrorGuardSchema = z.custom<TOptions["isSessionOutputValidationError"]>(
  (value) => typeof value === "function",
  "Codexの構造化出力エラー判定関数が必要です。",
);

const sessionSyncErrorGuardSchema = z.custom<TOptions["isSessionSyncError"]>(
  (value) => typeof value === "function",
  "Codexの同期エラー判定関数が必要です。",
);

const baselineExternalDataProviderSchema = z.custom<TOptions["baselineExternalDataProvider"]>(
  (value) => typeof value === "function",
  "基準Custom external data供給関数が必要です。",
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
    createId: idFactorySchema,
    hashCanonicalJson: canonicalJsonHashSchema,
    hashBaselineSnapshot: baselineSnapshotHashSchema,
    redactSensitiveText: redactSensitiveTextSchema,
    isSessionOutputValidationError: sessionOutputValidationErrorGuardSchema,
    isSessionSyncError: sessionSyncErrorGuardSchema,
    baselineExternalDataProvider: baselineExternalDataProviderSchema,
    executeApproval: approvalExecutorSchema,
    logRetryEvent: retryEventLoggerSchema,
    reportListenerError: listenerErrorReporterSchema,
  })
  .strict()
    .parse(options);
}
