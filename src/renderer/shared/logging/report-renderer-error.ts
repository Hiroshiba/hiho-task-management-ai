import { diagnosticsContracts, type DiagnosticError, type DiagnosticsApi } from "../../../shared/ipc-contracts/diagnostics";
import { redactSensitiveText } from "./redact-diagnostic-text";

function serializeError(error: Error, ancestors: WeakSet<Error>): DiagnosticError {
  if (ancestors.has(error)) {
    return { name: "CyclicError", message: "原因が循環しています。", stack: "CyclicError: 原因が循環しています。" };
  }
  ancestors.add(error);
  try {
    const redactedName = redactSensitiveText(error.name).slice(0, 200);
    const name = redactedName.length === 0 ? "Error" : redactedName;
    const redactedMessage = redactSensitiveText(error.message).slice(0, 4_096);
    const message = redactedMessage.length === 0 ? "Rendererで未処理の例外が発生しました。" : redactedMessage;
    const redactedStack = redactSensitiveText(error.stack ?? "").slice(0, 16_384);
    const stack = redactedStack.length === 0 ? `${name}: ${message}` : redactedStack;
    let cause: DiagnosticError | undefined;
    if (Object.prototype.hasOwnProperty.call(error, "cause")) {
      cause = error.cause instanceof Error
        ? serializeError(error.cause, ancestors)
        : { name: "NonError", message: "Error以外の値が原因として渡されました。", stack: "NonError: Error以外の値が原因として渡されました。" };
    }
    return {
      name,
      message,
      stack,
      ...(cause == null ? {} : { cause }),
    };
  } finally {
    ancestors.delete(error);
  }
}

/** Rendererの例外をMainの診断ログへ送ります。 */
export async function reportRendererError(
  api: DiagnosticsApi,
  error: unknown,
  level: "error" | "warning",
): Promise<string | undefined> {
  const reportableError = error instanceof Error
    ? error
    : new Error("RendererでError以外の値が例外として渡されました。");
  const input = diagnosticsContracts.report.request.parse({
    level,
    error: serializeError(reportableError, new WeakSet<Error>()),
  });
  try {
    const result = diagnosticsContracts.report.response.parse(await api.report(input));
    if (result.kind === "error") {
      console.error("Rendererの診断をMainに記録できませんでした。", input.error);
      return result.error_id;
    }
    return result.value.error_id;
  } catch {
    console.error("Rendererの診断をMainに記録できませんでした。", input.error);
    return undefined;
  }
}
