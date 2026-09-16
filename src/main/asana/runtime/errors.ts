/** 予期しないエラーがすでに記録されたことを表します。 */
export class AsanaSyncRuntimeAlreadyReportedError extends Error {
  public constructor(cause: unknown) {
    super("Asana同期の予期しないエラーは記録済みです。", { cause });
    this.name = "AsanaSyncRuntimeAlreadyReportedError";
  }
}
