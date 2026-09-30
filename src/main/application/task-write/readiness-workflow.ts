type SynchronizationState = {
  readonly kind: string;
  readonly last_error_code?: string | undefined;
  readonly last_successful_sync_at?: string | undefined;
};

type TaskWriteReadinessDependencies = {
  readonly assertOperationalReady: () => void;
  readonly assertReauthenticationIdle: () => void;
  readonly isOnline: () => boolean;
  readonly getSynchronizationState: () => SynchronizationState;
  readonly hasPendingJournal: () => boolean;
  readonly hasIncompleteHistory: () => boolean;
  readonly hasOAuthAppMismatch: () => boolean;
};

/** 同期と復旧の状態からAsana書き込みの受付条件を判定します。 */
export class TaskWriteReadinessWorkflow {
  public constructor(private readonly dependencies: TaskWriteReadinessDependencies) {}

  /** 同期済みのオンライン状態で書き込めるか検証します。 */
  public assertWritesAllowed(): void {
    this.dependencies.assertOperationalReady();
    this.dependencies.assertReauthenticationIdle();
    const synchronizationState = this.dependencies.getSynchronizationState();
    if (synchronizationState.kind !== "online" || synchronizationState.last_error_code != null) {
      throw new Error("Asana同期が正常なオンライン状態になるまで書き込みを開始できません。");
    }
    this.assertRecoveryComplete("execute");
  }

  /** queue待機後の書き込み条件を検証します。 */
  public assertQueuedMutationReady(): void {
    this.assertWritesAllowed();
    if (!this.dependencies.isOnline()) {
      throw new Error("オフライン中はAsana変更操作を開始できません。");
    }
  }

  /** 同期中を含めて変更要求を受け付けられるか検証します。 */
  public assertMutationRequestAccepted(): void {
    this.dependencies.assertOperationalReady();
    this.dependencies.assertReauthenticationIdle();
    if (!this.dependencies.isOnline()) {
      throw new Error("オフライン中はAsana変更操作を受け付けられません。");
    }
    const synchronizationState = this.dependencies.getSynchronizationState();
    if (synchronizationState.kind !== "syncing") {
      if (synchronizationState.last_successful_sync_at == null) {
        throw new Error("初回同期が完了するまで変更操作を受け付けられません。");
      }
      this.assertWritesAllowed();
      return;
    }
    if (synchronizationState.last_successful_sync_at == null) {
      throw new Error("初回同期が完了するまで変更操作を受け付けられません。");
    }
    if (synchronizationState.last_error_code != null) {
      throw new Error("Asana同期エラーを解消するまで変更操作を受け付けられません。");
    }
    this.assertRecoveryComplete("accept");
  }

  private assertRecoveryComplete(phase: "accept" | "execute"): void {
    if (this.dependencies.hasPendingJournal() || this.dependencies.hasIncompleteHistory()) {
      throw new Error(phase === "accept"
        ? "未完了のAI適用ジャーナルを復旧するまで変更操作を受け付けられません。"
        : "未完了のAI適用ジャーナルを復旧するまで書き込みを開始できません。");
    }
    if (this.dependencies.hasOAuthAppMismatch()) {
      throw new Error(phase === "accept"
        ? "同一のAsana OAuthアプリ設定を確認するまで変更操作を受け付けられません。"
        : "同一のAsana OAuthアプリ設定を確認するまで書き込みを開始できません。");
    }
  }
}
