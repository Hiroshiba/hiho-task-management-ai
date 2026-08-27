/** Codex専用ワークスペースの初期化に失敗したことを表します。 */
export class CodexWorkspaceError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CodexWorkspaceError";
  }
}
