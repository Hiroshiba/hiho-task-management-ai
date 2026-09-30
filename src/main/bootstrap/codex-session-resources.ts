import {
  createCodexSessionWorkspaceUserDataPath,
  type CodexSessionService,
  type ExternalToolBroker,
  type ExternalToolStatusEvidenceCollector,
  type CodexSessionConnectionFactory,
  type CodexWorkspaceInitializationResult,
  type ExternalToolRegistry,
  type TaskctlRankingSchemas,
  type TaskctlSnapshot,
} from "../infrastructure/ai";
import { ObsidianReadError } from "../infrastructure/obsidian";
import { isProposalWorkspace } from "../application/proposal-generate";

type SessionResourcesOptions = {
  readonly parentPath: string;
  readonly codexHomePath: string;
  readonly executable: string;
  readonly obsidianReader: ReturnType<import("../application/obsidian-integration").ObsidianIntegrationWorkflow["createCodexPort"]>;
  readonly readOnlyVaultPaths: () => readonly string[];
  readonly connectionFactory: CodexSessionConnectionFactory;
  readonly onError: (error: unknown) => void;
  readonly snapshotProvider: () => TaskctlSnapshot;
  readonly syncBeforeTurn: (signal: AbortSignal) => Promise<void>;
  readonly taskctlSchemas: TaskctlRankingSchemas;
  readonly readyRegistry: () => ExternalToolRegistry | undefined;
  readonly createWorkspace: (userDataPath: string) => CodexWorkspaceInitializationResult;
  readonly createSession: (
    options: ConstructorParameters<typeof CodexSessionService>[0],
    schemas: TaskctlRankingSchemas,
  ) => CodexSessionService;
  readonly createEvidenceCollector: () => ExternalToolStatusEvidenceCollector;
  readonly createBroker: (
    registry: ExternalToolRegistry,
    tmpDirectoryPath: string,
    collector: ExternalToolStatusEvidenceCollector,
  ) => ExternalToolBroker;
  readonly installClient: typeof import("../infrastructure/ai").installContextctlClientScript;
};

export type CodexSessionResourceInputs = Omit<SessionResourcesOptions,
  "createWorkspace" | "createSession" | "createEvidenceCollector" | "createBroker" | "installClient"
>;

export type AiSessionExternalToolResources = {
  readonly broker: ExternalToolBroker | undefined;
  readonly collector: ExternalToolStatusEvidenceCollector;
  readonly endpoint: string | undefined;
};

/** Codexセッションとセッション専用の外部ツール資源を生成します。 */
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
  public createSession(
    workspace: CodexWorkspaceInitializationResult,
    externalToolEndpoint: string | undefined,
  ): CodexSessionService {
    return this.options.createSession({
      codexExecutablePath: this.options.executable,
      workspacePath: workspace.workspacePath,
      agentsFilePath: workspace.agentsFilePath,
      tmpDirectoryPath: workspace.tmpDirectoryPath,
      expectedCodexHomePathProvider: () => this.options.codexHomePath,
      obsidianReader: this.options.obsidianReader,
      isObsidianReadFailure: (error): error is ObsidianReadError =>
        error instanceof ObsidianReadError,
      readOnlyVaultPaths: [...this.options.readOnlyVaultPaths()],
      additionalUnixSocketPaths: externalToolEndpoint == null ? [] : [externalToolEndpoint],
      connectionFactory: this.options.connectionFactory,
      onError: this.options.onError,
      snapshotProvider: this.options.snapshotProvider,
      syncBeforeTurn: this.options.syncBeforeTurn,
      isProposalWorkspace,
    }, this.options.taskctlSchemas);
  }

  /** 外部ツールの接続準備と失敗時の資源解放を行います。 */
  public async prepareExternalTools(
    workspace: CodexWorkspaceInitializationResult,
    signal: AbortSignal,
  ): Promise<AiSessionExternalToolResources> {
    const collector = this.options.createEvidenceCollector();
    const registry = this.options.readyRegistry();
    if (registry == null) {
      return { broker: undefined, collector, endpoint: undefined };
    }
    const broker = this.createBroker(registry, workspace.tmpDirectoryPath, collector);
    try {
      const startResult = await broker.start(signal);
      if (startResult.kind !== "ready") {
        throw new Error("AIセッションの外部ツールブローカーを起動できませんでした。");
      }
      const installation = this.options.installClient({
        workspacePath: workspace.workspacePath,
        connectionInfoPath: startResult.connection_info_path,
        toolDefinitions: [...registry.list()],
      });
      if (installation.kind !== "ready") {
        throw new Error("AIセッションの外部ツール連携を有効化できませんでした。");
      }
      return { broker, collector, endpoint: startResult.endpoint };
    } catch (error: unknown) {
      try {
        await broker.stop();
      } catch (cleanupError: unknown) {
        throw new AggregateError(
          [error, cleanupError],
          "AIセッションの外部ツール起動後処理に失敗しました。",
          { cause: error },
        );
      }
      throw error;
    }
  }

  /** 外部ツールブローカーを生成します。 */
  public createBroker(
    registry: ExternalToolRegistry,
    tmpDirectoryPath: string,
    statusEvidenceCollector: ExternalToolStatusEvidenceCollector,
  ): ExternalToolBroker {
    return this.options.createBroker(registry, tmpDirectoryPath, statusEvidenceCollector);
  }
}
