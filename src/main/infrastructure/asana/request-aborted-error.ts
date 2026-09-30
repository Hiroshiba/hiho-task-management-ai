/** Asanaリクエストが実行開始前に中断されたことを表します。 */
export class AsanaRequestAbortedError extends Error {
  public constructor() {
    super("Asanaリクエストが実行開始前に中断されました。");
    this.name = "AsanaRequestAbortedError";
  }
}
