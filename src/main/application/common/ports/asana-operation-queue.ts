export type AsanaOperationPriority = "user" | "background";
export type AsanaOperationKind =
  | "synchronization"
  | "gui_edit"
  | "ai_apply"
  | "ai_snapshot"
  | "display_order"
  | "journal_recovery"
  | "context_change"
  | "external_snapshot"
  | "external_apply";
export type AsanaOperationInvalidationReason =
  | "synchronization_failed"
  | "offline"
  | "context_changed";

/** 待機中のAsana操作が後続処理へ引き継げないことを表します。 */
export class AsanaOperationInvalidatedError extends Error {
  public readonly reason: AsanaOperationInvalidationReason;

  public constructor(reason: AsanaOperationInvalidationReason) {
    super("Asana操作の待機中に実行条件が失われました。");
    this.name = "AsanaOperationInvalidatedError";
    this.reason = reason;
  }
}

/** 実行中のAsana操作が所有する明示的な実行コンテキストです。 */
export type AsanaOperationContext = {
  readonly kind: AsanaOperationKind;
  readonly signal: AbortSignal;
};

export type AsanaOperationQueueInput<T> = {
  readonly priority: AsanaOperationPriority;
  readonly kind: AsanaOperationKind;
  readonly signal: AbortSignal;
  readonly run: (context: AsanaOperationContext) => T | PromiseLike<T>;
  readonly beforeStart?: (context: AsanaOperationContext) => void | PromiseLike<void>;
};

/** 外部エージェントへAsana操作の受付と失効だけを公開します。 */
export interface ExternalAgentAsanaOperationQueuePort {
  enqueue<T>(input: AsanaOperationQueueInput<T>): Promise<T>;
  invalidatePendingMutations(reason: AsanaOperationInvalidationReason): void;
}
