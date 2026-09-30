import {
  CodexRpcError,
  codexRpcCodeSchema,
  codexRpcMessageSchema,
  codexRpcOperationSchema,
  type CodexRpcOperation,
} from "./codex-app-server/errors";
import {
  CodexThreadStartCapabilityError,
  codexThreadStartCapabilityFailureCodeSchema,
  type CodexThreadStartCapabilityFailureCode,
} from "./codex-session/errors";

type CodexDiagnosticDetail = {
  readonly capability_failure?: CodexThreadStartCapabilityFailureCode;
  readonly rpc_operation?: CodexRpcOperation;
  readonly rpc_code?: number;
  readonly rpc_message?: string;
};

type CodexDiagnosticDetailAdapter = {
  readonly capabilityFailureSchema: typeof codexThreadStartCapabilityFailureCodeSchema;
  readonly rpcOperationSchema: typeof codexRpcOperationSchema;
  readonly rpcCodeSchema: typeof codexRpcCodeSchema;
  readonly read: (value: unknown, redactText: (value: string) => string) => CodexDiagnosticDetail;
};

/** Codex固有のエラー情報を診断ログへ渡すアダプターを作ります。 */
export function createCodexDiagnosticDetailAdapter(): CodexDiagnosticDetailAdapter {
  return {
    capabilityFailureSchema: codexThreadStartCapabilityFailureCodeSchema,
    rpcOperationSchema: codexRpcOperationSchema,
    rpcCodeSchema: codexRpcCodeSchema,
    read(value: unknown, redactText: (value: string) => string): CodexDiagnosticDetail {
      if (value instanceof CodexThreadStartCapabilityError) {
        return {
          capability_failure: codexThreadStartCapabilityFailureCodeSchema.parse(value.failureCode),
        };
      }
      if (value instanceof CodexRpcError) {
        return {
          rpc_operation: codexRpcOperationSchema.parse(value.operation),
          rpc_code: codexRpcCodeSchema.parse(value.rpcCode),
          rpc_message: redactText(codexRpcMessageSchema.parse(value.rpcMessage)),
        };
      }
      return {};
    },
  };
}
