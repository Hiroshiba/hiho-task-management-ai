/** 適用に必要な AbortSignal の機能を検証します。 */
export function validateAbortSignal(signal: AbortSignal): void {
  if (
    signal == null
    || typeof signal.aborted !== "boolean"
    || typeof signal.addEventListener !== "function"
    || typeof signal.removeEventListener !== "function"
  ) {
    throw new TypeError("AbortSignalが必要です。");
  }
}

/** 中断要求があれば処理を止めます。 */
export function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) {
    return;
  }
  signal.throwIfAborted();
  throw new Error("処理が中断されました。");
}

/** 適用後同期の結果を検証し、診断に使う原因を保持します。 */
export function parseSynchronizationResult<TResult extends object>(
  value: TResult & { readonly cause?: unknown },
  parse: (value: unknown) => TResult,
): TResult & { readonly cause?: unknown } {
  const { cause, ...result } = value;
  const parsed = parse(result);
  return Object.prototype.hasOwnProperty.call(value, "cause")
    ? { ...parsed, cause }
    : parsed;
}

/** writer の操作識別子と対象 GID を照合します。 */
export function validateOperationWriterResult<TResult extends { readonly operation_id: string; readonly task_gid: string }>(
  operationId: string,
  result: unknown,
  expectedTaskGid: string | undefined,
  parse: (value: unknown) => TResult,
): TResult {
  const parsed = parse(result);
  if (parsed.operation_id !== operationId) {
    throw new Error("writerのoperation_idが一致しません。");
  }
  if (expectedTaskGid != null && parsed.task_gid !== expectedTaskGid) {
    throw new Error("writerの対象GIDが一致しません。");
  }
  return parsed;
}

/** 作成要求が副作用を残さず拒否されたと確定できるか判定します。 */
export function isDefinitiveCreateRejection<TOperation extends { readonly operation: string }>(
  operation: TOperation,
  lastWriteAction: string | undefined,
  createdTaskGid: string | undefined,
  error: unknown,
  isKnownRejectionError: (error: unknown) => boolean,
  getHttpStatus: (error: unknown) => number | undefined,
  definitiveStatuses: ReadonlySet<number>,
): boolean {
  if (
    operation.operation !== "create_task"
    || lastWriteAction !== "create_task"
    || createdTaskGid != null
    || !isKnownRejectionError(error)
  ) {
    return false;
  }
  const status = getHttpStatus(error);
  return status != null && definitiveStatuses.has(status);
}
