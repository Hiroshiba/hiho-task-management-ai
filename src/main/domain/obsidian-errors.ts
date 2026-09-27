/** Vault設定の同時変更を表します。 */
export class ObsidianVaultMappingConflictError extends Error {
  public constructor() {
    super("AIセッションまたはCodex処理が進行中のためVault設定を変更できません。AIアシスタントの各依頼を「確認して閉じる」または「依頼を中止」で閉じてから、Vaultを設定してください。");
    this.name = "ObsidianVaultMappingConflictError";
  }
}
