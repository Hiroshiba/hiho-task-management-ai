/** アプリの起動、版、更新状態を提供する公開操作です。 */
export interface SystemWorkflow<UpdateState> {
  getVersion(): string;
  waitForStartup(signal: AbortSignal): Promise<void>;
  getUpdateState(): UpdateState;
  onUpdateState(listener: (state: UpdateState) => void): () => void;
}
