import type { AsanaTaskReadPort } from "../../application/common/ports/asana-task-read";

type AsanaTaskReadRuntime<Result, State> = {
  getState(): State;
  manualFullSync(signal: AbortSignal): Promise<Result>;
  manualSync(signal: AbortSignal): Promise<Result>;
};

/** 既存のAsana同期ランタイムをタスク読取ポートへ接続します。 */
export class AsanaTaskReadAdapter<Result, State> implements AsanaTaskReadPort<Result, State> {
  public constructor(private readonly runtime: () => AsanaTaskReadRuntime<Result, State>) {}

  /** 現在のAsana同期状態を取得します。 */
  public getSyncState(): State {
    return this.runtime().getState();
  }

  /** Asanaの完全同期を実行します。 */
  public synchronizeFull(signal: AbortSignal): Promise<Result> {
    return this.runtime().manualFullSync(signal);
  }

  /** Asanaの増分同期を実行します。 */
  public synchronizeDelta(signal: AbortSignal): Promise<Result> {
    return this.runtime().manualSync(signal);
  }
}
