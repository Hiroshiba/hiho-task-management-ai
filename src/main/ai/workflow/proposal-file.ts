import { createHash, randomUUID } from "node:crypto";
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
  readSecurePersistentFileBytesWithByteLimit,
  type SecurePersistentFileIdentity,
  type SecurePersistentFileIsolationResult,
  type SecurePersistentFileLocation,
  writeSecurePersistentTextFileAtomically,
} from "../../local-storage-path";
import {
  AiWorkflowProposalFileError,
} from "./errors";
import {
  aiWorkflowCandidateDigestSchema,
  aiWorkflowValidationErrorsSchema,
  type AiWorkflowCandidateDigest,
} from "./retry";

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

type ActiveValidationErrorsFile = {
  readonly path: string;
  readonly identity: ProposalFileIdentity;
  readonly location: ActiveProposalFileLocation;
};

export type AiWorkflowProposalCandidate = {
  readonly proposal: Proposal;
  readonly candidate_digest: AiWorkflowCandidateDigest;
};

export type AiWorkflowProposalFileRefreshResult =
  | { readonly kind: "refreshed"; readonly lease: AiWorkflowProposalFileLease }
  | {
      readonly kind: "refreshed_with_boundary_error";
      readonly lease: AiWorkflowProposalFileLease;
      readonly error: unknown;
    }
  | {
      readonly kind: "blocked";
      readonly error: unknown;
    };

type DraftFileCreation =
  | { readonly kind: "not_written" }
  | { readonly kind: "written"; readonly identity: ProposalFileIdentity };

type DraftFileRecovery =
  | { readonly kind: "not_found" }
  | { readonly kind: "identity_captured"; readonly identity: ProposalFileIdentity };

function candidateDigest(bytes: Buffer): AiWorkflowCandidateDigest {
  return aiWorkflowCandidateDigestSchema.parse({
    kind: "available",
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}

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

function removeTrackedSecureFile(
  filePath: string,
  identity: ProposalFileIdentity,
  location: ActiveProposalFileLocation,
  label: string,
): {
  readonly result: SecurePersistentFileIsolationResult
    | ReturnType<typeof removeSecurePersistentFileFromIsolation>;
  readonly location: ActiveProposalFileLocation;
} {
  if (location.kind === "source_path") {
    const isolation = isolateSecurePersistentFile(
      filePath,
      identity,
      label,
    );
    const isolationLocation: ActiveProposalFileLocation = {
      kind: "isolation_path",
      path: isolation.isolationPath,
    };
    if (isolation.kind !== "isolated") {
      return { result: isolation, location: isolationLocation };
    }
    return {
      result: removeSecurePersistentFileFromIsolation(
        isolation.isolationPath,
        filePath,
        identity,
        label,
      ),
      location: isolationLocation,
    };
  }
  return {
    result: removeSecurePersistentFileFromIsolation(
      location.path,
      filePath,
      identity,
      label,
    ),
    location,
  };
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
  private readonly activeValidationErrorsFiles = new Map<string, ActiveValidationErrorsFile>();

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

  /** 応答の変更案を正規化して提案ファイルへ保存し、保存内容を検証します。 */
  public stageProposal(
    proposalFileId: string,
    proposal: Proposal,
  ): AiWorkflowProposalCandidate {
    const parsedProposalFileId = identifierSchema.parse(proposalFileId);
    const activeFile = this.activeFiles.get(parsedProposalFileId);
    if (activeFile == null) {
      throw new AiWorkflowProposalFileError(
        "指定された変更案ファイルは現在のAIターンへ発行されていません。",
      );
    }
    if (activeFile.location.kind !== "source_path") {
      throw new AiWorkflowProposalFileError(
        "AI変更案ファイルの保存位置が失われています。",
      );
    }
    const validatedProposal = codexGeneratedProposalSchema.parse(proposal);
    const content = canonicalizeJson(validatedProposal);
    assertProposalFileSize(content);
    let writtenIdentity: ProposalFileIdentity;
    try {
      const currentIdentity = assertSecurePersistentFileSnapshot(
        activeFile.lease.proposal_file_path,
        activeFile.identity,
        "AI変更案ファイル",
      );
      if (currentIdentity.kind === "missing") {
        throw new Error("AI変更案ファイルが保存前に消失しました。");
      }
      writtenIdentity = writeSecurePersistentTextFileAtomically(
        activeFile.lease.proposal_file_path,
        content,
        "AI変更案ファイル",
      );
    } catch (error: unknown) {
      throw new AiWorkflowProposalFileError(
        "AI変更案ファイルへ変更案を保存できません。",
        error,
      );
    }
    this.activeFiles.set(parsedProposalFileId, {
      ...activeFile,
      identity: writtenIdentity,
      location: { kind: "source_path" },
    });
    let capturedIdentity: ProposalFileIdentity;
    try {
      const captured = assertSecurePersistentFileSnapshot(
        activeFile.lease.proposal_file_path,
        writtenIdentity,
        "AI変更案ファイル",
      );
      if (captured.kind === "missing") {
        throw new Error("AI変更案ファイルを保存後に確認できません。");
      }
      capturedIdentity = captured;
      this.activeFiles.set(parsedProposalFileId, {
        ...activeFile,
        identity: capturedIdentity,
        location: { kind: "source_path" },
      });
      const bytes = readSecurePersistentFileBytesWithByteLimit(
        activeFile.lease.proposal_file_path,
        "AI変更案ファイル",
        maximumProposalFileBytes,
      );
      if (bytes == null) {
        throw new Error("AI変更案ファイルを保存後に読み込めません。");
      }
      const afterReadIdentity = assertSecurePersistentFileSnapshot(
        activeFile.lease.proposal_file_path,
        capturedIdentity,
        "AI変更案ファイル",
      );
      if (afterReadIdentity.kind === "missing") {
        throw new Error("AI変更案ファイルが読み取り後に消失しました。");
      }
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const parsedContent: unknown = JSON.parse(decoded);
      const readProposal = codexGeneratedProposalSchema.parse(parsedContent);
      const canonicalBytes = Buffer.from(content, "utf8");
      if (!bytes.equals(canonicalBytes)) {
        throw new Error("AI変更案ファイルの保存内容が正規化後の変更案と一致しません。");
      }
      return {
        proposal: proposalSchema.parse(readProposal),
        candidate_digest: candidateDigest(canonicalBytes),
      };
    } catch (error: unknown) {
      throw new AiWorkflowProposalFileError(
        "AI変更案ファイルの保存内容を安全に検証できません。",
        error,
      );
    }
  }

  /** 検証エラーをAIへ渡すセッション専用ファイルのパスを返します。 */
  public validationErrorsFilePath(logicalTurnId: string): string {
    const parsedTurnId = identifierSchema.parse(logicalTurnId);
    const path = normalizeSecurePersistentFilePath(
      join(
        this.tmpDirectoryPath,
        `${this.sessionId}-${parsedTurnId}-validation-errors.json`,
      ),
    );
    if (!isProposalFileWithinDirectory(path, this.tmpDirectoryPath)) {
      throw new AiWorkflowProposalFileError(
        "検証エラーファイルの保存先がAIセッション用tmpの直下ではありません。",
      );
    }
    return path;
  }

  /** 構造化検証エラーをセッション専用ファイルへ原子的に保存します。 */
  public writeValidationErrors(
    logicalTurnId: string,
    input: unknown,
  ): string {
    const parsedTurnId = identifierSchema.parse(logicalTurnId);
    const validationErrors = aiWorkflowValidationErrorsSchema.parse(input);
    const path = this.validationErrorsFilePath(parsedTurnId);
    const content = canonicalizeJson(validationErrors);
    assertProposalFileSize(content);
    const activeFile = this.activeValidationErrorsFiles.get(parsedTurnId);
    if (activeFile == null) {
      const existing = captureSecurePersistentFile(path, "AI変更案検証エラーファイル");
      if (existing.kind !== "missing") {
        throw new AiWorkflowProposalFileError(
          "未登録の検証エラーファイルが既に存在します。",
        );
      }
    } else {
      if (activeFile.location.kind !== "source_path") {
        throw new AiWorkflowProposalFileError(
          "検証エラーファイルの書き込み位置が失われています。",
        );
      }
      const current = assertSecurePersistentFileSnapshot(
        activeFile.path,
        activeFile.identity,
        "AI変更案検証エラーファイル",
      );
      if (current.kind === "missing") {
        throw new AiWorkflowProposalFileError(
          "検証エラーファイルが書き込み前に消失しました。",
        );
      }
    }
    try {
      const writtenIdentity = writeSecurePersistentTextFileAtomically(
        path,
        content,
        "AI変更案検証エラーファイル",
      );
      const capturedIdentity = assertSecurePersistentFileSnapshot(
        path,
        writtenIdentity,
        "AI変更案検証エラーファイル",
      );
      if (capturedIdentity.kind === "missing") {
        throw new Error("検証エラーファイルを保存後に確認できません。");
      }
      this.activeValidationErrorsFiles.set(parsedTurnId, {
        path,
        identity: capturedIdentity,
        location: { kind: "source_path" },
      });
    } catch (error: unknown) {
      try {
        const captured = captureSecurePersistentFile(
          path,
          "AI変更案検証エラーファイル",
        );
        if (captured.kind !== "missing") {
          this.activeValidationErrorsFiles.set(parsedTurnId, {
            path,
            identity: captured,
            location: { kind: "source_path" },
          });
        }
      } catch (captureError: unknown) {
        throw new AggregateError(
          [error, captureError],
          "検証エラーファイルの保存失敗と作成済みファイルの確認に失敗しました。",
          { cause: error },
        );
      }
      throw new AiWorkflowProposalFileError(
        "検証エラーファイルを保存できません。",
        error,
      );
    }
    return path;
  }

  /** 修正可能なエラー後に旧提案を破棄して新しい下書きを発行します。 */
  public refreshDraft(
    proposalFileId: string,
    baseProposal: Proposal | undefined,
  ): AiWorkflowProposalFileRefreshResult {
    const parsedProposalFileId = identifierSchema.parse(proposalFileId);
    const activeFile = this.activeFiles.get(parsedProposalFileId);
    if (activeFile == null) {
      return {
        kind: "blocked",
        error: new AiWorkflowProposalFileError(
          "更新するAI変更案ファイルが登録されていません。",
        ),
      };
    }
    let removal: ReturnType<typeof removeTrackedSecureFile>;
    try {
      removal = removeTrackedSecureFile(
        activeFile.lease.proposal_file_path,
        activeFile.identity,
        activeFile.location,
        "AI変更案ファイル",
      );
    } catch (error: unknown) {
      return { kind: "blocked", error };
    }
    switch (removal.result.kind) {
      case "removed":
        this.activeFiles.delete(parsedProposalFileId);
        return this.createRefreshedDraft(baseProposal);
      case "identity_remains":
        this.activeFiles.set(parsedProposalFileId, {
          ...activeFile,
          location: removal.location,
        });
        return {
          kind: "blocked",
          error: new AiWorkflowProposalFileError(
            "旧AI変更案ファイルの実体が残っているため新しい下書きを発行できません。",
            removal.result.error,
          ),
        };
      case "identity_removed_boundary_violation": {
        this.activeFiles.delete(parsedProposalFileId);
        const refreshed = this.createRefreshedDraft(baseProposal);
        if (refreshed.kind === "blocked") {
          return {
            kind: "blocked",
            error: new AggregateError(
              [removal.result.error, refreshed.error],
              "旧AI変更案ファイルの境界違反と新しい下書きの発行に失敗しました。",
              { cause: removal.result.error },
            ),
          };
        }
        return {
          kind: "refreshed_with_boundary_error",
          lease: refreshed.lease,
          error: removal.result.error,
        };
      }
      case "source_recreated":
      case "identity_mismatch":
      case "verification_failed":
        this.activeFiles.set(parsedProposalFileId, {
          ...activeFile,
          location: removal.location,
        });
        return {
          kind: "blocked",
          error: proposalFileIsolationError(removal.result),
        };
    }
    throw new Error("未対応のAI変更案ファイル削除結果です。");
  }

  private createRefreshedDraft(
    baseProposal: Proposal | undefined,
  ): AiWorkflowProposalFileRefreshResult {
    try {
      return {
        kind: "refreshed",
        lease: this.createDraft(baseProposal),
      };
    } catch (error: unknown) {
      return { kind: "blocked", error };
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
    this.disposeProposalFileEntry(parsedProposalFileId, activeFile);
  }

  /** ターン内の検証エラーファイルを安全に削除します。 */
  public disposeValidationErrors(logicalTurnId: string): void {
    const parsedTurnId = identifierSchema.parse(logicalTurnId);
    const activeFile = this.activeValidationErrorsFiles.get(parsedTurnId);
    if (activeFile == null) {
      return;
    }
    let removal: ReturnType<typeof removeTrackedSecureFile>;
    try {
      removal = removeTrackedSecureFile(
        activeFile.path,
        activeFile.identity,
        activeFile.location,
        "AI変更案検証エラーファイル",
      );
    } catch (error: unknown) {
      throw new AiWorkflowProposalFileError(
        "検証エラーファイルを削除できません。",
        error,
      );
    }
    switch (removal.result.kind) {
      case "removed":
        this.activeValidationErrorsFiles.delete(parsedTurnId);
        return;
      case "identity_remains":
        this.activeValidationErrorsFiles.set(parsedTurnId, {
          ...activeFile,
          location: removal.location,
        });
        throw new AiWorkflowProposalFileError(
          "検証エラーファイルの実体が残っているため削除を完了できません。",
          removal.result.error,
        );
      case "identity_removed_boundary_violation":
        this.activeValidationErrorsFiles.delete(parsedTurnId);
        throw new AiWorkflowProposalFileError(
          "検証エラーファイル削除後に境界違反を検出しました。",
          removal.result.error,
        );
      case "source_recreated":
      case "identity_mismatch":
      case "verification_failed":
        this.activeValidationErrorsFiles.set(parsedTurnId, {
          ...activeFile,
          location: removal.location,
        });
        throw new AiWorkflowProposalFileError(
          "検証エラーファイルの安全な削除を完了できません。",
          proposalFileIsolationError(removal.result),
        );
    }
  }

  private disposeProposalFileEntry(
    proposalFileId: string,
    activeFile: ActiveProposalFile,
  ): void {
    let removal: ReturnType<typeof removeTrackedSecureFile>;
    try {
      removal = removeTrackedSecureFile(
        activeFile.lease.proposal_file_path,
        activeFile.identity,
        activeFile.location,
        "AI変更案ファイル",
      );
    } catch (error: unknown) {
      throw new AiWorkflowProposalFileError(
        "AI変更案ファイルを削除できません。",
        error,
      );
    }
    switch (removal.result.kind) {
      case "removed":
        this.activeFiles.delete(proposalFileId);
        return;
      case "identity_remains":
        this.activeFiles.set(proposalFileId, {
          ...activeFile,
          location: removal.location,
        });
        throw new AiWorkflowProposalFileError(
          "AI変更案ファイルの実体が残っているため削除を完了できません。",
          removal.result.error,
        );
      case "identity_removed_boundary_violation":
        this.activeFiles.delete(proposalFileId);
        throw new AiWorkflowProposalFileError(
          "AI変更案ファイル削除後に境界違反を検出しました。",
          removal.result.error,
        );
      case "source_recreated":
      case "identity_mismatch":
      case "verification_failed":
        this.activeFiles.set(proposalFileId, {
          ...activeFile,
          location: removal.location,
        });
        throw new AiWorkflowProposalFileError(
          "AI変更案ファイルの安全な削除を完了できません。",
          proposalFileIsolationError(removal.result),
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
    for (const logicalTurnId of [...this.activeValidationErrorsFiles.keys()]) {
      try {
        this.disposeValidationErrors(logicalTurnId);
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
