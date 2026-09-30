import { diagnosticsContracts, type DiagnosticError } from "../../../shared/ipc-contracts/diagnostics";
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
      const error = restoreDiagnosticError(request.error);
      const errorId = reporter.reportErrorOnce(error, {
        source: "ipc",
        diagnosticCode: "renderer.diagnostic",
        context: "ipc_diagnostic",
        level: request.level,
        ...(request.operation_id == null ? {} : { operationId: request.operation_id }),
      });
      return diagnosticsContracts.report.response.parse({ kind: "ok", value: { error_id: errorId } });
    }),
  };
}

function restoreDiagnosticError(value: DiagnosticError): Error {
  const error = value.cause == null
    ? new Error(value.message)
    : new Error(value.message, { cause: restoreDiagnosticError(value.cause) });
  error.name = value.name;
  error.stack = value.stack;
  return error;
}
