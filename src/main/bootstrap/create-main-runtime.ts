import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DiagnosticFailureDispositionError } from "../application/common/errors/diagnostic-failure";
import type { ErrorReporter } from "../application/common/errors/error-reporter";
import { JsonlErrorReporter, writeErrorReportFailure } from "../infrastructure/logging";
import {
  ApplicationUpdateAttemptStore,
  PersistenceRuntime,
  WindowStateStore,
} from "../infrastructure/persistence";
import {
  createLegacyRuntime,
  migrateLegacyPersistence,
  type LegacyRuntimeOptions,
  type LegacyRuntimePort,
} from "./legacy-runtime-port";

type MainRuntimeOptions = {
  readonly userDataPath: string;
  readonly secretStoragePath: string;
  readonly checkpointPath: string;
  readonly logsPath: string;
  readonly loggerFormatter: ConstructorParameters<typeof JsonlErrorReporter>[2];
  readonly legacy: Omit<LegacyRuntimeOptions, "lifecycle_signal" | "now_provider" | "create_id">;
};

/** Mainの単一ランタイムと資源の破棄入口です。 */
export interface MainRuntime {
  readonly legacy: LegacyRuntimePort;
  readonly reporter: ErrorReporter | undefined;
  readonly signal: AbortSignal;
  createWindowStateStore(): WindowStateStore;
  createApplicationUpdateAttemptStore(): ApplicationUpdateAttemptStore;
  abort(): void;
  dispose(): Promise<void>;
  closeLateFiles(): void;
}

/** Mainの診断sink、保存資源、未移行機能を一度だけ組み立てます。 */
export function createMainRuntime(options: MainRuntimeOptions): MainRuntime {
  let reporter: ErrorReporter | undefined;
  try {
    reporter = new JsonlErrorReporter(options.logsPath, [], options.loggerFormatter);
  } catch (error) {
    writeErrorReportFailure(error, [], options.loggerFormatter.redactText);
  }
  const controller = new AbortController();
  let persistence: PersistenceRuntime | undefined;
  try {
    persistence = new PersistenceRuntime(
      join(options.userDataPath, "taskhub.sqlite3"),
      migrateLegacyPersistence,
    );
    const openedPersistence = persistence;
    const files = {
      secretStorage: openedPersistence.openTextFile(options.secretStoragePath, "秘密情報ファイル"),
      checkpoint: openedPersistence.openTextFile(options.checkpointPath, "初回設定チェックポイント"),
    };
    const legacy = createLegacyRuntime({
      ...options.legacy,
      lifecycle_signal: controller.signal,
      now_provider: () => new Date(),
      create_id: randomUUID,
    }, openedPersistence, files);
    let disposal: Promise<void> | undefined;
    return {
      legacy,
      reporter,
      signal: controller.signal,
      createWindowStateStore: () => new WindowStateStore(
        openedPersistence.openLateTextFile(
          join(options.userDataPath, "window-state.json"),
          "ウィンドウ状態",
        ),
      ),
      createApplicationUpdateAttemptStore: () => new ApplicationUpdateAttemptStore(
        openedPersistence.openLateTextFile(
          join(options.userDataPath, "application-update-attempt.json"),
          "アプリ本体の更新試行",
        ),
      ),
      abort: () => controller.abort(),
      dispose: () => {
        if (disposal != null) {
          return disposal;
        }
        disposal = (async () => {
          controller.abort();
          const errors: unknown[] = [];
          try {
            await legacy.stop();
          } catch (error) {
            errors.push(error);
          }
          try {
            openedPersistence.close();
          } catch (error) {
            errors.push(error);
          }
          if (errors.length === 1) {
            throw errors[0];
          }
          if (errors.length > 1) {
            throw new AggregateError(errors, "Mainの停止と保存資源の終了に失敗しました。", {
              cause: errors[0],
            });
          }
        })().catch((error: unknown) => {
          disposal = undefined;
          throw error;
        });
        return disposal;
      },
      closeLateFiles: () => openedPersistence.closeLateFiles(),
    };
  } catch (error) {
    controller.abort();
    let failure = error;
    if (persistence != null) {
      try {
        persistence.close();
      } catch (closeError) {
        failure = new AggregateError(
          [error, closeError],
          "Mainの初期化と保存資源の終了に失敗しました。",
          { cause: error },
        );
      }
    }
    if (reporter == null) {
      writeErrorReportFailure(failure, [], options.loggerFormatter.redactText);
    } else {
      reporter.reportErrorOnce(failure, {
        source: "main",
        diagnosticCode: "app.error",
        context: "bootstrap",
        level: "error",
      });
    }
    throw new DiagnosticFailureDispositionError({
      kind: "recorded_only",
      recorded_error: failure,
      response_error: failure,
    });
  }
}
