/** Asana同期状態の参照と手動収集を提供するポートです。 */
export interface AsanaTaskReadPort<Result, State> {
  getSyncState(): State;
  synchronizeFull(signal: AbortSignal): Promise<Result>;
  synchronizeDelta(signal: AbortSignal): Promise<Result>;
}
