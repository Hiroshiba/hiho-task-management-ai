import { randomUUID } from "node:crypto";
import { isAbsolute, join, parse, resolve } from "node:path";
import { z } from "zod";
import {
  codexGeneratedProposalSchema,
  type Proposal,
  proposalSchema,
} from "../../../shared/ai";
import {
  canonicalizeJson,
  identifierSchema,
} from "../../../shared/domain";
import {
  assertSecurePersistentFileSnapshot,
  captureSecurePersistentFile,
  isolateSecurePersistentFile,
  normalizeSecurePersistentFilePath,
  removeSecurePersistentFileFromIsolation,
  readSecurePersistentTextFileWithByteLimit,
  type SecurePersistentFileIdentity,
  type SecurePersistentFileIsolationResult,
  type SecurePersistentFileLocation,
  writeSecurePersistentTextFileAtomically,
} from "../../local-storage-path";
import { AiWorkflowProposalFileError } from "./errors";

const maximumProposalFileBytes = 256 * 1024;

const proposalFilePathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine(isAbsolute, "変更案ファイルのパスは絶対パスでなければなりません。")
  .refine((value) => !value.includes("\0"), "変更案ファイルのパスが不正です。");

const sessionIdSchema = identifierSchema.refine(
  (value) => !value.includes("/") && !value.includes("\\"),
  "AIセッションIDにパス区切り文字を指定できません。",
);

const proposalFileStoreOptionsSchema = z
  .object({
    sessionId: sessionIdSchema,
    tmpDirectoryPath: proposalFilePathSchema,
  })
  .strict();

const proposalFileLeaseSchema = z
  .object({
    proposal_file_id: identifierSchema,
    proposal_file_path: proposalFilePathSchema,
  })
  .strict();

/** AIターン中に利用する提案ファイルの識別情報です。 */
export const aiWorkflowProposalFileLeaseSchema = proposalFileLeaseSchema;

export type AiWorkflowProposalFileLease = z.infer<typeof proposalFileLeaseSchema>;

type ProposalFileIdentity = SecurePersistentFileIdentity;

type ActiveProposalFileLocation = SecurePersistentFileLocation;

type ActiveProposalFile = {
  readonly lease: AiWorkflowProposalFileLease;
  readonly identity: ProposalFileIdentity;
  readonly location: ActiveProposalFileLocation;
};

type DraftFileCreation =
  | { readonly kind: "not_written" }
  | { readonly kind: "written"; readonly identity: ProposalFileIdentity };

type DraftFileRecovery =
  | { readonly kind: "not_found" }
  | { readonly kind: "identity_captured"; readonly identity: ProposalFileIdentity };

function isProposalFileWithinDirectory(
  proposalFilePath: string,
  tmpDirectoryPath: string,
): boolean {
  return parse(proposalFilePath).dir === tmpDirectoryPath;
}

function assertProposalFileSize(content: string): void {
  if (Buffer.byteLength(content, "utf8") > maximumProposalFileBytes) {
    throw new AiWorkflowProposalFileError(
      "変更案ファイルがサイズ上限を超えています。",
    );
  }
}

function createProposalFileId(sessionId: string, nonce: string): string {
  return identifierSchema.parse(`proposal-${sessionId}-${nonce}`);
}

function proposalFileIsolationError(
  result: SecurePersistentFileIsolationResult,
): Error {
  switch (result.kind) {
    case "isolated":
      return new Error("AI変更案ファイルは隔離済みです。");
    case "source_recreated":
      return new Error("AI変更案ファイルの元パスが隔離中に再作成されました。");
    case "identity_mismatch":
      return new Error("隔離したAI変更案ファイルの実体が発行時と一致しません。");
    case "verification_failed":
      return new Error("隔離したAI変更案ファイルを検証できません。", {
        cause: result.error,
      });
  }
}

function removeCreatedProposalFile(
  filePath: string,
  identity: ProposalFileIdentity,
): void {
  const current = captureSecurePersistentFile(filePath, "AI変更案ファイル");
  if (current.kind === "missing") {
    return;
  }
  if (current.device !== identity.device || current.inode !== identity.inode) {
    throw new Error("AI変更案ファイルの回収対象が発行時の実体と一致しません。");
  }
  const isolation = isolateSecurePersistentFile(
    filePath,
    identity,
    "AI変更案ファイル",
  );
  if (isolation.kind === "identity_mismatch") {
    throw proposalFileIsolationError(isolation);
  }
  const removal = removeSecurePersistentFileFromIsolation(
    isolation.isolationPath,
    filePath,
    identity,
    "AI変更案ファイル",
  );
  switch (removal.kind) {
    case "removed":
      return;
    case "identity_remains":
      throw new Error("AI変更案ファイルの作成失敗後も実体が残っています。", {
        cause: removal.error,
      });
    case "identity_removed_boundary_violation":
      throw new Error("AI変更案ファイルの作成失敗後に境界違反を検出しました。", {
        cause: removal.error,
      });
  }
}

/** AI変更案をセッション専用の一時ファイルへ保存、読み込み、破棄します。 */
export class AiWorkflowProposalFileStore {
  private readonly sessionId: string;
  private readonly tmpDirectoryPath: string;
  private readonly activeFiles = new Map<string, ActiveProposalFile>();

  public constructor(options: {
    readonly sessionId: string;
    readonly tmpDirectoryPath: string;
  }) {
    const validatedOptions = proposalFileStoreOptionsSchema.parse(options);
    this.sessionId = validatedOptions.sessionId;
    this.tmpDirectoryPath = resolve(validatedOptions.tmpDirectoryPath);
  }

  /** AIターン用の提案ファイルを作成します。 */
  public createDraft(baseProposal: Proposal | undefined): AiWorkflowProposalFileLease {
    if (baseProposal != null) {
      proposalSchema.parse(baseProposal);
    }
    const nonce = identifierSchema.parse(randomUUID());
    const proposalFileId = createProposalFileId(this.sessionId, nonce);
    const proposalFilePath = normalizeSecurePersistentFilePath(
      join(this.tmpDirectoryPath, `${proposalFileId}.json`),
    );
    if (!isProposalFileWithinDirectory(proposalFilePath, this.tmpDirectoryPath)) {
      throw new AiWorkflowProposalFileError(
        "変更案ファイルの保存先がAIセッション用tmpの直下ではありません。",
      );
    }
    const lease = proposalFileLeaseSchema.parse({
      proposal_file_id: proposalFileId,
      proposal_file_path: proposalFilePath,
    });
    const content = canonicalizeJson(baseProposal ?? {});
    assertProposalFileSize(content);
    let creation: DraftFileCreation = { kind: "not_written" };
    try {
      const writtenIdentity = writeSecurePersistentTextFileAtomically(
        lease.proposal_file_path,
        content,
        "AI変更案ファイル",
      );
      creation = { kind: "written", identity: writtenIdentity };
      const capturedIdentity = assertSecurePersistentFileSnapshot(
        lease.proposal_file_path,
        writtenIdentity,
        "AI変更案ファイル",
      );
      if (capturedIdentity.kind === "missing") {
        throw new Error("AI変更案ファイルを作成後に確認できません。");
      }
      this.activeFiles.set(lease.proposal_file_id, {
        lease,
        identity: capturedIdentity,
        location: { kind: "source_path" },
      });
    } catch (error: unknown) {
      let recovery: DraftFileRecovery;
      if (creation.kind === "written") {
        recovery = { kind: "identity_captured", identity: creation.identity };
      } else {
        try {
          const captured = captureSecurePersistentFile(
            lease.proposal_file_path,
            "AI変更案ファイル",
          );
          recovery = captured.kind === "missing"
            ? { kind: "not_found" }
            : { kind: "identity_captured", identity: captured };
        } catch (captureError: unknown) {
          throw new AggregateError(
            [error, captureError],
            "AI変更案ファイルの作成失敗と作成済みファイルの確認に失敗しました。",
            { cause: error },
          );
        }
      }
      if (recovery.kind === "not_found") {
        throw error;
      }
      try {
        removeCreatedProposalFile(lease.proposal_file_path, recovery.identity);
      } catch (cleanupError: unknown) {
        throw new AggregateError(
          [error, cleanupError],
          "AI変更案ファイルの作成失敗と作成済みファイルの回収に失敗しました。",
          { cause: error },
        );
      }
      if (creation.kind === "not_written") {
        throw error;
      }
      throw new AiWorkflowProposalFileError(
        "AI変更案ファイルを作成できません。",
        error,
      );
    }
    return lease;
  }

  /** AIターン完了後に提案ファイルを安全に読み込みます。 */
  public readProposal(proposalFileId: string): Proposal {
    const parsedProposalFileId = identifierSchema.parse(proposalFileId);
    const activeFile = this.activeFiles.get(parsedProposalFileId);
    if (activeFile == null) {
      throw new AiWorkflowProposalFileError(
        "指定された変更案ファイルは現在のAIターンへ発行されていません。",
      );
    }
    if (activeFile.location.kind !== "source_path") {
      throw new AiWorkflowProposalFileError(
        "AI変更案ファイルの安全な読み込み位置が失われています。",
      );
    }
    try {
      const expectedIdentity = assertSecurePersistentFileSnapshot(
        activeFile.lease.proposal_file_path,
        activeFile.identity,
        "AI変更案ファイル",
      );
      const proposalFilePath = activeFile.lease.proposal_file_path;
      if (expectedIdentity.kind === "missing") {
        throw new AiWorkflowProposalFileError(
          "AI変更案ファイルが見つかりません。",
        );
      }
      const content = readSecurePersistentTextFileWithByteLimit(
        proposalFilePath,
        "AI変更案ファイル",
        maximumProposalFileBytes,
      );
      assertSecurePersistentFileSnapshot(
        proposalFilePath,
        activeFile.identity,
        "AI変更案ファイル",
      );
      if (content == null) {
        throw new AiWorkflowProposalFileError(
          "AI変更案ファイルが見つかりません。",
        );
      }
      assertProposalFileSize(content);
      let parsedContent: unknown;
      try {
        parsedContent = JSON.parse(content);
      } catch (error: unknown) {
        throw new AiWorkflowProposalFileError(
          "AI変更案ファイルのJSONが不正です。",
          error,
        );
      }
      try {
        return codexGeneratedProposalSchema.parse(parsedContent);
      } catch (error: unknown) {
        throw new AiWorkflowProposalFileError(
          "AI変更案ファイルの内容が不正です。",
          error,
        );
      }
    } catch (error: unknown) {
      if (error instanceof AiWorkflowProposalFileError) {
        throw error;
      }
      throw new AiWorkflowProposalFileError(
        "AI変更案ファイルを安全に読み込めません。",
        error,
      );
    }
  }

  /** AIターンの終了時に提案ファイルを削除します。 */
  public dispose(proposalFileId: string): void {
    const parsedProposalFileId = identifierSchema.parse(proposalFileId);
    const activeFile = this.activeFiles.get(parsedProposalFileId);
    if (activeFile == null) {
      throw new AiWorkflowProposalFileError(
        "指定された変更案ファイルは現在のAIターンへ発行されていません。",
      );
    }
    try {
      let isolationPath: string;
      if (activeFile.location.kind === "source_path") {
        const isolation = isolateSecurePersistentFile(
          activeFile.lease.proposal_file_path,
          activeFile.identity,
          "AI変更案ファイル",
        );
        isolationPath = isolation.isolationPath;
        this.activeFiles.set(parsedProposalFileId, {
          ...activeFile,
          location: { kind: "isolation_path", path: isolationPath },
        });
        if (isolation.kind === "identity_mismatch") {
          this.activeFiles.delete(parsedProposalFileId);
          throw proposalFileIsolationError(isolation);
        }
        if (isolation.kind !== "isolated") {
          throw proposalFileIsolationError(isolation);
        }
      } else {
        isolationPath = activeFile.location.path;
      }
      const removal = removeSecurePersistentFileFromIsolation(
        isolationPath,
        activeFile.lease.proposal_file_path,
        activeFile.identity,
        "AI変更案ファイル",
      );
      switch (removal.kind) {
        case "removed":
          this.activeFiles.delete(parsedProposalFileId);
          return;
        case "identity_remains":
          this.activeFiles.set(parsedProposalFileId, {
            ...activeFile,
            location: removal.location,
          });
          throw new AiWorkflowProposalFileError(
            "AI変更案ファイルの実体が残っているため削除を完了できません。",
            removal.error,
          );
        case "identity_removed_boundary_violation":
          this.activeFiles.delete(parsedProposalFileId);
          throw new AiWorkflowProposalFileError(
            "AI変更案ファイル削除後に境界違反を検出しました。",
            removal.error,
          );
      }
    } catch (error: unknown) {
      if (error instanceof AiWorkflowProposalFileError) {
        throw error;
      }
      throw new AiWorkflowProposalFileError(
        "AI変更案ファイルを削除できません。",
        error,
      );
    }
  }

  /** AIセッション終了時に残った提案ファイルを削除します。 */
  public disposeAll(): void {
    const errors: unknown[] = [];
    for (const proposalFileId of [...this.activeFiles.keys()]) {
      try {
        this.dispose(proposalFileId);
      } catch (error: unknown) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AiWorkflowProposalFileError(
        "AIセッションの提案ファイルをすべて削除できません。",
        new AggregateError(errors),
      );
    }
  }
}
