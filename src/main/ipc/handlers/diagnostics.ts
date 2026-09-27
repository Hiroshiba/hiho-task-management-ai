import { diagnosticsContracts } from "../../../shared/ipc-contracts/diagnostics";
import type { ContractHandler } from "./contract-handler";

type DiagnosticsReporter = {
  reportErrorOnce(error: Error, context: {
    readonly source: "ipc";
    readonly diagnosticCode: "renderer.diagnostic";
    readonly context: "ipc_diagnostic";
    readonly level: "warning" | "error";
    readonly operationId?: string;
  }): string;
};

export type DiagnosticsHandlers = {
  readonly report: ContractHandler<typeof diagnosticsContracts.report>;
};

/** Rendererから受けた診断を一元loggerへ記録するIPC handlerを作成します。 */
export function createDiagnosticsHandlers(reporter: DiagnosticsReporter): DiagnosticsHandlers {
  return {
    report: (payload) => Promise.resolve().then(() => {
      const request = diagnosticsContracts.report.request.parse(payload);
      const error = new Error(request.message);
      error.stack = request.stack;
      const errorId = reporter.reportErrorOnce(error, {
        source: "ipc",
        diagnosticCode: "renderer.diagnostic",
        context: "ipc_diagnostic",
        level: request.level,
        ...(request.operation_id == null ? {} : { operationId: request.operation_id }),
      });
      return diagnosticsContracts.report.response.parse({ error_id: errorId });
    }),
  };
}
