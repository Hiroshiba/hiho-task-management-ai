import type { DiagnosticsApi } from "../../../shared/ipc-contracts/diagnostics";
import { diagnosticsContracts } from "../../../shared/ipc-contracts/diagnostics";

/** 画面確認用の診断API mockを作成します。 */
export function createMockDiagnosticsApi(): DiagnosticsApi {
  return {
    report: (input) => Promise.resolve().then(() => {
      const request = diagnosticsContracts.report.request.parse(input);
      if (request.level === "warning") {
        console.warn(request.error);
      } else {
        console.error(request.error);
      }
      return diagnosticsContracts.report.response.parse({
        kind: "ok",
        value: { error_id: "00000000-0000-4000-8000-000000000001" },
      });
    }),
  };
}
