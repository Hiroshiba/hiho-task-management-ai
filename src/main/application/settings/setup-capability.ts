type CapabilityFailureReason =
  | "task_create_failed"
  | "task_update_failed"
  | "section_move_failed"
  | "tag_update_failed"
  | "external_data_failed"
  | "read_back_failed"
  | "cleanup_failed";

type CapabilityResult =
  | { readonly kind: "ready"; readonly test_task_gid: string }
  | { readonly kind: "failed"; readonly reason_code: string };

type CapabilityInput = {
  readonly project_gid: string;
  readonly section_gids: {
    readonly not_started: string;
    readonly in_progress: string;
    readonly withdrawn: string;
  };
  readonly tag_gid: string;
};

function safeCapabilityReason(result: CapabilityResult): CapabilityFailureReason {
  if (result.kind !== "failed") {
    throw new Error("能力検査の失敗結果が不正です。");
  }
  switch (result.reason_code) {
    case "task_create_failed":
      return "task_create_failed";
    case "task_update_failed":
      return "task_update_failed";
    case "section_move_failed":
      return "section_move_failed";
    case "tag_add_failed":
    case "tag_remove_failed":
      return "tag_update_failed";
    case "external_data_write_failed":
    case "external_data_read_failed":
    case "external_data_mismatch":
      return "external_data_failed";
    case "task_list_failed":
    case "task_withdraw_failed":
    case "readback_mismatch":
      return "read_back_failed";
  }
  throw new Error("能力検査の失敗理由が不正です。");
}

function capabilityFailureReason(
  error: unknown,
  isCapabilityError: (error: unknown) => error is { readonly result: CapabilityResult },
): CapabilityFailureReason | undefined {
  if (isCapabilityError(error)) {
    return safeCapabilityReason(error.result);
  }
  if (!(error instanceof AggregateError) || !Array.isArray(error.errors)) {
    return undefined;
  }
  if (error.errors.some((cause) => isCapabilityError(cause))) {
    return "cleanup_failed";
  }
  return undefined;
}

/** Asana能力検査を実行し、成功したテストタスクか失敗理由を返します。 */
export async function assessSetupCapability<TResult extends CapabilityResult>(
  input: CapabilityInput,
  signal: AbortSignal,
  dependencies: {
    readonly check: (input: CapabilityInput, signal: AbortSignal) => Promise<TResult>;
    readonly parseResult: (value: unknown) => TResult;
    readonly isCapabilityError: (error: unknown) => error is { readonly result: CapabilityResult };
    readonly hasRestAsanaHttpError: (error: unknown) => boolean;
    readonly reportCapabilityFailure: (error: unknown) => void;
  },
): Promise<
  | { readonly kind: "ready"; readonly test_task_gid: string }
  | { readonly kind: "failed"; readonly reason_code: CapabilityFailureReason }
> {
  let result: TResult;
  try {
    result = dependencies.parseResult(await dependencies.check(input, signal));
  } catch (error: unknown) {
    const reasonCode = capabilityFailureReason(error, dependencies.isCapabilityError);
    if (reasonCode != null) {
      if (dependencies.hasRestAsanaHttpError(error)) {
        dependencies.reportCapabilityFailure(error);
      }
      return { kind: "failed", reason_code: reasonCode };
    }
    throw error;
  }
  if (result.kind === "failed") {
    return { kind: "failed", reason_code: safeCapabilityReason(result) };
  }
  if (result.kind !== "ready") {
    throw new Error("Asana能力検査が成功状態を返しませんでした。");
  }
  return { kind: "ready", test_task_gid: result.test_task_gid };
}
