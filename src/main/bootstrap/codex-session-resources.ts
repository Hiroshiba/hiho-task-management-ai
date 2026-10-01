import {
  createCodexSessionWorkspaceUserDataPath,
  type CodexSessionService,
  type CodexSessionConnectionFactory,
  type CodexWorkspaceInitializationResult,
  type TaskctlRankingSchemas,
  type TaskctlSnapshot,
} from "../infrastructure/ai";
import { ObsidianReadError } from "../infrastructure/obsidian";
import { isProposalWorkspace } from "../application/proposal-generate";

type SessionResourcesOptions = {
  readonly parentPath: string;
  readonly codexHomePath: string;
  readonly executable: string;
  readonly obsidianReader: ReturnType<
    import("../application/obsidian-integration").ObsidianIntegrationWorkflow["createCodexPort"]
  >;
  readonly readOnlyVaultPaths: () => readonly string[];
  readonly connectionFactory: CodexSessionConnectionFactory;
  readonly onError: (error: unknown) => void;
  readonly snapshotProvider: () => TaskctlSnapshot;
  readonly syncBeforeTurn: (signal: AbortSignal) => Promise<void>;
  readonly taskctlSchemas: TaskctlRankingSchemas;
  readonly createWorkspace: (userDataPath: string) => CodexWorkspaceInitializationResult;
  readonly createSession: (
    options: ConstructorParameters<typeof CodexSessionService>[0],
    schemas: TaskctlRankingSchemas,
  ) => CodexSessionService;
};

export type CodexSessionResourceInputs = Omit<
  SessionResourcesOptions,
  "createWorkspace" | "createSession"
>;

/** Codexセッションのワークスペースと接続資源を生成します。 */
export class CodexSessionResources {
  public constructor(private readonly options: SessionResourcesOptions) {}

  /** セッションIDに対応する隔離ワークスペースを生成します。 */
  public createWorkspace(sessionId: string): CodexWorkspaceInitializationResult {
    const workspaceUserDataPath = createCodexSessionWorkspaceUserDataPath(
      this.options.parentPath,
      sessionId,
    );
    return this.options.createWorkspace(workspaceUserDataPath);
  }

  /** Codexセッションを生成します。 */
  public createSession(workspace: CodexWorkspaceInitializationResult): CodexSessionService {
    return this.options.createSession(
      {
        codexExecutablePath: this.options.executable,
        workspacePath: workspace.workspacePath,
        agentsFilePath: workspace.agentsFilePath,
        tmpDirectoryPath: workspace.tmpDirectoryPath,
        expectedCodexHomePathProvider: () => this.options.codexHomePath,
        obsidianReader: this.options.obsidianReader,
        isObsidianReadFailure: (error): error is ObsidianReadError =>
          error instanceof ObsidianReadError,
        readOnlyVaultPaths: [...this.options.readOnlyVaultPaths()],
        connectionFactory: this.options.connectionFactory,
        onError: this.options.onError,
        snapshotProvider: this.options.snapshotProvider,
        syncBeforeTurn: this.options.syncBeforeTurn,
        isProposalWorkspace,
      },
      this.options.taskctlSchemas,
    );
  }
}
