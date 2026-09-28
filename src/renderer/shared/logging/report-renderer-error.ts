import { diagnosticsContracts, type DiagnosticsApi } from "../../../shared/ipc-contracts/diagnostics";

/** Rendererの例外をMainの診断ログへ送ります。 */
export async function reportRendererError(
  api: DiagnosticsApi,
  error: unknown,
  level: "error" | "warning",
): Promise<void> {
  try {
    const cause = error instanceof Error
      ? error
      : new Error("Rendererで未処理の例外が発生しました。", { cause: error });
    const message = cause.message.length > 0
      ? cause.message
      : "Rendererで未処理の例外が発生しました。";
    const input = diagnosticsContracts.report.request.parse({
      level,
      message: message.slice(0, 4_096),
      stack: (cause.stack ?? `${cause.name}: ${message}`).slice(0, 16_384),
    });
    const result = diagnosticsContracts.report.response.parse(await api.report(input));
    if (result.kind === "error") {
      console.error(new Error("Rendererの診断をMainに記録できませんでした。"));
    }
  } catch {
    console.error(new Error("Rendererの診断をMainに記録できませんでした。"));
  }
}
