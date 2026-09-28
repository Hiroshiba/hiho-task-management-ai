import { diagnosticsContracts, serializeDiagnosticError, type DiagnosticsApi } from "../../../shared/ipc-contracts/diagnostics";

/** Rendererの例外をMainの診断ログへ送ります。 */
export async function reportRendererError(
  api: DiagnosticsApi,
  error: unknown,
  level: "error" | "warning",
): Promise<string | undefined> {
  const input = diagnosticsContracts.report.request.parse({
    level,
    error: serializeDiagnosticError(error),
  });
  try {
    const result = diagnosticsContracts.report.response.parse(await api.report(input));
    if (result.kind === "error") {
      console.error("Rendererの診断をMainに記録できませんでした。", input.error);
      return undefined;
    }
    return result.value.error_id;
  } catch (error) {
    console.error("Rendererの診断をMainに記録できませんでした。", input.error, serializeDiagnosticError(error));
    return undefined;
  }
}
