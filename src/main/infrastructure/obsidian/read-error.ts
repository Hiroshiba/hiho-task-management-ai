import { z } from "zod";

const obsidianErrorCodeSchema = z.enum([
  "vault_not_registered",
  "vault_unavailable",
  "vault_not_directory",
  "symlink_rejected",
  "path_security",
  "path_changed",
  "note_not_file",
  "file_read_failed",
  "invalid_utf8",
  "limit_exceeded",
]);

export type ObsidianReadErrorCode = z.infer<typeof obsidianErrorCodeSchema>;

/** Vault読み取り処理の構造化エラーを表します。 */
export class ObsidianReadError extends Error {
  public readonly code: ObsidianReadErrorCode;

  public constructor(
    code: ObsidianReadErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "ObsidianReadError";
    this.code = obsidianErrorCodeSchema.parse(code);
  }
}
