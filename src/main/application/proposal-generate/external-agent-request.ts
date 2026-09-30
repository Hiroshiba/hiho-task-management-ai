type RequestErrorCode =
  | "invalid_request"
  | "context_mismatch"
  | "stale_revision"
  | "request_id_reused"
  | "conflict";

/** 外部連携要求を検証し、想定内エラーをCLI応答へ変換します。 */
export async function handleExternalAgentRequest<
  TInput extends { readonly operation: string },
  TServiceCode extends string,
  TResponse,
>(
  input: unknown,
  ports: {
    readonly parseInput: (value: unknown) => TInput;
    readonly isInputError: (error: unknown) => boolean;
    readonly isServiceError: (error: unknown) => error is { readonly code: TServiceCode; readonly message: string };
    readonly workspaceConflict: (error: unknown) => { readonly code: string; readonly message: string } | undefined;
    readonly isWorkspaceInputError: (error: unknown) => error is { readonly message: string };
    readonly createErrorResponse: (code: RequestErrorCode | TServiceCode, message: string, revision?: number) => TResponse;
    readonly createInfoResponse: () => TResponse;
    readonly assertEnabled: () => void;
    readonly dispatch: (input: TInput) => TResponse | Promise<TResponse>;
    readonly currentWorkspaceRevision: (input: TInput) => number;
  },
): Promise<TResponse> {
  let parsedInput: TInput;
  try {
    parsedInput = ports.parseInput(input);
  } catch (error: unknown) {
    if (ports.isInputError(error)) {
      return ports.createErrorResponse("invalid_request", "外部連携要求の形式が不正です。");
    }
    throw error;
  }
  try {
    if (parsedInput.operation === "agent-info") {
      return ports.createInfoResponse();
    }
    ports.assertEnabled();
    return await ports.dispatch(parsedInput);
  } catch (error: unknown) {
    if (ports.isServiceError(error)) {
      return ports.createErrorResponse(error.code, error.message);
    }
    const conflict = ports.workspaceConflict(error);
    if (conflict != null) {
      switch (conflict.code) {
        case "workspace_mismatch":
          return ports.createErrorResponse("context_mismatch", conflict.message);
        case "revision_mismatch":
          if (!("workspace_id" in parsedInput)) {
            throw error;
          }
          return ports.createErrorResponse(
            "stale_revision", conflict.message, ports.currentWorkspaceRevision(parsedInput),
          );
        case "edit_batch_id_reused":
          return ports.createErrorResponse("request_id_reused", conflict.message);
        case "state_mismatch":
          return ports.createErrorResponse("conflict", conflict.message);
      }
    }
    if (ports.isWorkspaceInputError(error)) {
      return ports.createErrorResponse("invalid_request", error.message);
    }
    if (ports.isInputError(error)) {
      return ports.createErrorResponse("invalid_request", "外部連携要求の形式が不正です。");
    }
    throw error;
  }
}
