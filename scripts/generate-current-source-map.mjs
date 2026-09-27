import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  analyzeSource,
  enumStrings,
  listSourceFiles,
  ownerForPath,
  proposalOperationKinds,
  readSource,
  repositoryRoot,
} from "./architecture-source.mjs";

const entryPoints = [
  ["Electron起動入口", "src/main/index.ts", "main/bootstrap"],
  ["MainRuntime生成", "src/main/bootstrap/create-main-runtime.ts", "main/bootstrap"],
  ["Electron起動と終了", "src/main/bootstrap/register-main-lifecycle.ts", "main/bootstrap"],
  ["Mainの旧統合", "src/main/application/service.ts", "main/bootstrap"],
  ["IPC登録", "src/main/ipc/registry.ts", "main/ipc"],
  ["preload bridge", "src/preload/index.ts", "preload"],
  ["Renderer起動", "src/renderer/src/main.ts", "renderer/app"],
  ["Renderer画面", "src/renderer/src/App.vue", "renderer/app"],
  ["変更案生成", "src/main/ai/workflow/service.ts", "main/application/proposal-generate"],
  ["変更案適用と復旧", "src/main/ai/proposal-application/coordinator.ts", "main/application/proposal-apply"],
  ["GUI編集", "src/main/gui-edit/service.ts", "main/application/gui-edit"],
  ["Asana同期", "src/main/asana/sync/coordinator.ts", "main/infrastructure/asana"],
  ["SQLite schema", "src/main/infrastructure/persistence/sqlite-schema.ts", "main/infrastructure/persistence"],
  ["mock transport", "src/renderer/src/task-hub.ts", "renderer/shared/api"],
];

const functions = [
  ["アプリ起動・更新・ウィンドウ", "main/bootstrap", "src/main/bootstrap/create-main-runtime.ts, src/main/bootstrap/register-main-lifecycle.ts, src/main/index.ts, src/main/application-update.ts, src/main/window-state.ts"],
  ["初回設定とAsana認証", "main/application/settings", "src/main/setup/, src/main/auth/asana-oauth/"],
  ["タスク取得・同期・順位", "main/application/task-read", "src/main/read-model/, src/main/asana/sync/, src/main/domain/ranking/"],
  ["タスク直接編集", "main/application/gui-edit", "src/main/gui-edit/, src/main/asana/client/task-write-client.ts"],
  ["変更案の生成・検証・編集", "main/application/proposal-generate", "src/main/ai/workflow/, src/main/ai/proposal-validation/, src/main/ai/proposal-workspace/"],
  ["変更案の承認・適用・復旧", "main/application/proposal-apply", "src/main/ai/proposal-application/, src/main/storage/application-journal.ts"],
  ["外部Codex接続とツール", "main/infrastructure/ai", "src/main/codex/, src/main/external-agent/transport.ts, src/main/external-tools/"],
  ["外部提案の準備・生成", "main/application/proposal-generate", "src/main/external-agent/service.ts"],
  ["外部提案の承認・適用", "main/application/proposal-apply", "src/main/external-agent/service.ts"],
  ["Obsidian参照・Vault設定", "main/application/obsidian-integration", "src/main/obsidian/, src/main/storage/vault-mappings.ts"],
  ["GitHub App連携", "main/application/github-integration", "現行アプリ実装なし。READMEの公開用GitHub App設定だけ"],
  ["設定と秘密情報", "main/application/settings", "src/main/storage/device-settings.ts, src/main/auth/secret-storage/"],
  ["IPC契約と配送", "shared/ipc-contracts と main/ipc と preload", "src/shared/ipc/, src/main/ipc/, src/preload/"],
  ["タスク画面", "renderer/features/tasks", "src/renderer/src/Task*.vue"],
  ["変更案画面", "renderer/features/proposals", "src/renderer/src/Ai*.vue, src/renderer/src/*Proposal*.vue"],
  ["設定画面", "renderer/features/settings", "src/renderer/src/SettingsDialog.vue, src/renderer/src/SetupWizard.vue"],
  ["ログ・診断", "main/infrastructure/logging", "src/main/infrastructure/logging/, src/main/persistent-error-log.ts, src/main/storage/diagnostic-log.ts"],
  ["mock transport", "renderer/shared/mock", "src/renderer/src/task-hub.ts, src/renderer/src/mocks/"],
];

const externalAgentResponsibilities = [
  ["src/main/external-agent/service.ts", "CLI要求の検証・応答、bridgeとの接続", "main/infrastructure/ai"],
  ["src/main/external-agent/service.ts", "文脈、提案基準、作業領域、提出要求", "main/application/proposal-generate"],
  ["src/main/external-agent/service.ts", "提出済み提案の確認、承認、適用、journal照会", "main/application/proposal-apply"],
  ["src/main/external-agent/service.ts", "GUI状態の購読と解除", "main/ipc"],
  ["src/main/external-agent/service.ts", "依存の組み立てと停止", "main/bootstrap"],
];

const fileFormats = [
  ["SQLite", "taskhub.sqlite3", "src/main/bootstrap/create-main-runtime.ts", '"taskhub.sqlite3"', "main/infrastructure/persistence"],
  ["暗号化JSON", "secret-storage.json", "src/main/index.ts", '"secret-storage.json"', "main/infrastructure/persistence"],
  ["初回設定JSON", "setup-checkpoint.json", "src/main/index.ts", '"setup-checkpoint.json"', "main/application/settings"],
  ["ウィンドウJSON", "window-state.json", "src/main/index.ts", '"window-state.json"', "main/bootstrap"],
  ["更新試行JSON", "application-update-attempt.json", "src/main/application-update.ts", '"application-update-attempt.json"', "main/bootstrap"],
  ["エラーJSONL", "taskhub-error.log", "src/main/infrastructure/logging/jsonl-error-reporter.ts", '"taskhub-error.log"', "main/infrastructure/logging"],
  ["外部Codex設定JSON", "external-agent/config.json", "src/main/external-agent/resources.ts", '"config.json"', "main/application/settings"],
  ["外部Codex接続JSON", "external-agent/connection.json", "src/main/external-agent/resources.ts", '"connection.json"', "main/infrastructure/ai"],
  ["taskctl接続JSON", "taskctl-connection.json", "src/main/codex/taskctl/broker.ts", '"taskctl-connection.json"', "main/infrastructure/ai"],
  ["contextctl接続JSON", "contextctl-connection.json", "src/main/external-tools/broker.ts", '"contextctl-connection.json"', "main/infrastructure/ai"],
  ["Codex作業資源", "codex-workspace/ と codex-home/", "src/main/codex/workspace/schemas.ts", '"codex-workspace"', "main/infrastructure/ai"],
  ["Asana Custom external data", "Asana task external data", "src/shared/domain/external-data.ts", "customExternalDataSchemaVersion", "main/domain"],
];

const sqliteOwners = new Map([
  ["application_journal", "main/application/proposal-apply"],
  ["task_cache", "main/application/task-read"],
  ["project_metadata_cache", "main/application/task-read"],
  ["ranking_cache", "main/application/task-read"],
  ["cleanup_items_cache", "main/application/task-read"],
  ["sync_state", "main/application/task-read"],
  ["device_settings", "main/application/settings"],
  ["vault_mappings", "main/application/obsidian-integration"],
  ["diagnostic_log", "main/infrastructure/logging"],
  ["external_tool_definitions", "main/application/settings"],
]);

const storageDatabaseMethodDestinations = [
  ["close", "PersistenceRuntime", "T07"],
  ["replaceTaskCache", "TaskCacheRepository", "T09"],
  ["applyTaskCacheDiff", "TaskCacheRepository", "T09"],
  ["getTaskCache", "TaskCacheRepository", "T09"],
  ["saveSyncSnapshot", "SyncSnapshotRepository", "T09"],
  ["getTaskCacheEntry", "TaskCacheRepository", "T09"],
  ["saveProjectMetadataCache", "ProjectMetadataRepository", "T09"],
  ["getProjectMetadataCache", "ProjectMetadataRepository", "T09"],
  ["getProjectMetadataCaches", "ProjectMetadataRepository", "T09"],
  ["saveRankingCache", "RankingRepository", "T09"],
  ["getRankingCache", "RankingRepository", "T09"],
  ["getCleanupItems", "CleanupItemsRepository", "T09"],
  ["replaceCleanupItemsByKinds", "CleanupItemsRepository", "T09"],
  ["mergeCleanupItemsByKinds", "CleanupItemsRepository", "T09"],
  ["saveSyncState", "SyncStateRepository", "T09"],
  ["getSyncState", "SyncStateRepository", "T09"],
  ["getSyncStates", "SyncStateRepository", "T09"],
  ["saveDeviceSettings", "DeviceSettingsRepository", "T17"],
  ["getDeviceSettings", "DeviceSettingsRepository", "T17"],
  ["clearDeviceSettings", "DeviceSettingsRepository", "T17"],
  ["saveVaultMapping", "VaultMappingRepository", "T15"],
  ["deleteVaultMapping", "VaultMappingRepository", "T15"],
  ["getVaultMappings", "VaultMappingRepository", "T15"],
  ["prepareApplicationJournals", "ApplicationJournalRepository", "T21"],
  ["recordApplicationJournalTaskCreated", "ApplicationJournalRepository", "T21"],
  ["updateApplicationJournalStage", "ApplicationJournalRepository", "T21"],
  ["completeApplicationJournal", "ApplicationJournalRepository", "T21"],
  ["clearApplicationJournalRecoveryCause", "ApplicationJournalRepository", "T21"],
  ["getApplicationJournal", "ApplicationJournalRepository", "T21"],
  ["getApplicationJournalsByProposal", "ApplicationJournalRepository", "T21"],
  ["getIncompleteApplicationJournals", "ApplicationJournalRepository", "T21"],
  ["appendDiagnosticLog", "DiagnosticLogRepository", "T06"],
  ["getDiagnosticLogs", "DiagnosticLogRepository", "T06"],
  ["saveExternalToolDefinition", "ExternalToolDefinitionRepository", "T17"],
  ["replaceExternalToolDefinitions", "ExternalToolDefinitionRepository", "T17"],
  ["deleteExternalToolDefinition", "ExternalToolDefinitionRepository", "T17"],
  ["getExternalToolDefinitions", "ExternalToolDefinitionRepository", "T17"],
  ["clearCaches", "CacheMaintenanceRepository", "T09"],
];

const appStateOwners = new Map([
  ["renderer/app", ["screen", "appUpdateState", "removeAppUpdateSubscription", "isMounted"]],
  ["renderer/features/tasks", [
    "activeSyncMode", "activeSyncReload", "clockTimer", "connectionState",
    "currentAsOf", "filter", "guiEditGeneration", "guiEditStates", "lastLoadedSuccessfulSyncAt",
    "normalizationNotificationDisplayState", "overview", "removeSyncSubscription", "selectedTask",
    "selectedTaskGid", "taskDataGeneration", "taskDetailGeneration", "taskEditMarkerGeneration",
    "taskEditMarkers", "taskFeedback", "taskSort",
  ]],
  ["renderer/features/proposals", [
    "aiDialogComponent", "aiDialogFeedback", "aiDialogRef", "aiDialogReturnFocus", "aiDialogVisible",
    "aiSelectedSessionId", "aiSessionCreating", "aiSessions", "codexState", "externalAgentBusy",
    "externalAgentEditResult", "externalAgentState", "removeAiStatusSubscription", "removeAiSubscription",
    "removeExternalAgentSubscription",
  ]],
  ["renderer/features/settings", [
    "asanaAuthenticationBusy", "asanaAuthenticationState", "asanaAuthenticationStateGeneration",
    "asanaAuthenticationStateLoadInProgress", "asanaAuthenticationStateLoaded",
    "asanaAuthenticationStateNeedsRecheck", "asanaAuthenticationStateRequestBusy",
    "asanaAuthenticationStateTimer", "asanaAuthorizationCodeInput", "settingsDialogFeedback",
    "settingsDialogVisible", "setupBusy", "setupState",
    "vaultMappingBusy", "vaultMappingFeedback", "vaultMappings", "vaultMappingsLoadGeneration",
    "vaultMappingsLoading", "vaultSaveGeneration",
  ]],
  ["renderer/features/obsidian-integration", [
    "obsidianStatusGeneration", "obsidianStatuses", "registeredVaultIds",
  ]],
  ["renderer/shared/components", ["feedback"]],
]);

const externalAgentStateOwners = new Map([
  ["main/application/proposal-generate", [
    "context", "lifecycle", "preparation", "preparedContexts", "preparedRequests",
    "requests", "review", "submission",
  ]],
  ["main/application/proposal-apply", ["proposals", "reviewTarget"]],
  ["main/ipc", ["listeners"]],
  ["main/bootstrap", ["options", "stopped"]],
  ["main/application/common", ["code"]],
]);

const applicationStateOwners = new Map([
  ["main/application/proposal-generate", [
    "aiApplicationState", "aiDeltaListeners", "aiSessionStarts", "aiSessionWorkspaceParentPath",
    "aiSessions", "aiSessionsConfigured", "aiStartResult", "aiStatusListeners",
    "codexAvailability", "configuredCodexLaunchState", "configuredCodexSynchronizationPromise",
    "externalAgent", "externalAgentBridge", "externalAgentInstanceId", "externalStatusEvidenceCollector",
    "externalToolLifecycle", "externalToolRegistry",
  ]],
  ["main/application/proposal-apply", [
    "applicationCoordinator", "journalRecoveryPending", "journalRecoveryPromise", "journalRecoveryRunning",
    "writer",
  ]],
  ["main/application/task-read", [
    "cleanupAggregation", "displayOrder", "lastDisplaySyncAt", "operationQueue", "planApplier",
    "readModel", "runtime", "scheduler", "syncCoordinator", "syncDiagnosticState",
    "syncFailureDiagnosticSuppressionCount", "syncStateListeners",
  ]],
  ["main/application/settings", [
    "asanaReauthenticationOperation", "capability", "checkpoint", "codexAuthenticationRequired",
    "context", "externalToolConfigurationOperation", "oauth", "resources", "settings", "setup",
    "vaultMappingSaveInProgress",
  ]],
  ["main/application/gui-edit", ["guiEdit"]],
  ["main/application/obsidian-integration", ["obsidian"]],
  ["main/infrastructure/logging", ["diagnostics"]],
  ["main/bootstrap", [
    "aiInteraction", "aiRuntime", "asanaReauthentication", "codexAdapter",
    "codexConnectionFactory", "codexSession", "codexWorkspace", "configuredCodexRuntime",
    "database", "deltaSource", "externalTools", "fullSource", "interactiveReadClient",
    "interactiveWriteClient", "journalRecovery", "lifecycleRuntime", "operationalContext",
    "operationalServices", "options", "readClient", "readyActivated",
    "removeRuntimeSubscription", "secretStorage", "setupClient", "stopped",
    "syncStateRuntime", "synchronizationOperations", "tokenProvider", "transport",
    "writeClient",
  ]],
]);

function stateOwner(path, symbol, defaultOwner) {
  if (path === "src/renderer/src/AppHeader.vue" && symbol === "fullSyncConfirmationOpen") {
    return "renderer/features/tasks";
  }
  if (path === "src/main/index.ts" && symbol === "persistentErrorLog") {
    return "main/infrastructure/logging";
  }
  if (path !== "src/renderer/src/App.vue") {
    return defaultOwner;
  }
  for (const [owner, symbols] of appStateOwners) {
    if (symbols.includes(symbol)) {
      return owner;
    }
  }
  throw new Error(`App.vueの状態owner候補がありません: ${symbol}`);
}

function instanceStateOwner(path, symbol, defaultOwner) {
  if (path === "src/main/external-agent/service.ts") {
    const member = symbol.slice(symbol.indexOf(".") + 1);
    for (const [owner, members] of externalAgentStateOwners) {
      if (members.includes(member)) {
        return owner;
      }
    }
    throw new Error(`ExternalAgentServiceの状態owner候補がありません: ${symbol}`);
  }
  if (path !== "src/main/application/service.ts" || !symbol.startsWith("TaskHubApplication.")) {
    return defaultOwner;
  }
  const member = symbol.slice("TaskHubApplication.".length);
  for (const [owner, members] of applicationStateOwners) {
    if (members.includes(member)) {
      return owner;
    }
  }
  throw new Error(`TaskHubApplicationの状態owner候補がありません: ${member}`);
}

function version(path, name) {
  const match = readSource(path).match(new RegExp(`(?:export )?const ${name} = (\\d+);`));
  if (match == null) {
    throw new Error(`保存形式の版を取得できません: ${path}: ${name}`);
  }
  return match[1];
}

function ownerForChannel(channel) {
  if (channel.startsWith("app-update:")) return "main/bootstrap";
  if (channel.startsWith("app:")) return "main/bootstrap";
  if (channel.startsWith("asana:") || channel.startsWith("setup:")) return "main/application/settings";
  if (channel.startsWith("read-model:") || channel.startsWith("sync:")) return "main/application/task-read";
  if (channel.startsWith("gui:")) return "main/application/gui-edit";
  if (channel === "ai:approve") return "main/application/proposal-apply";
  if (channel.startsWith("ai:")) return "main/application/proposal-generate";
  if (channel === "external-agent:approve") return "main/application/proposal-apply";
  if (channel.startsWith("external-agent:")) return "main/application/proposal-generate";
  if (channel.startsWith("obsidian:")) return "main/application/obsidian-integration";
  throw new Error(`IPC channelのowner候補がありません: ${channel}`);
}

function table(head, rows) {
  return [
    `| ${head.join(" | ")} |`,
    `| ${head.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
    "",
  ].join("\n");
}

function render(revision) {
  const paths = listSourceFiles();
  const source = paths.map((path) => ({ path, owner: ownerForPath(path), analysis: analyzeSource(path, readSource(path)) }));
  const moduleState = source.flatMap(({ path, owner, analysis }) => analysis.mutable.map((symbol) => [path, symbol, stateOwner(path, symbol, owner)]));
  const componentState = source.flatMap(({ path, owner, analysis }) => analysis.componentState
    .map((symbol) => [path, symbol, stateOwner(path, symbol, owner)]));
  const instanceState = source.flatMap(({ path, owner, analysis }) => analysis.instanceState
    .map((symbol) => [path, symbol, instanceStateOwner(path, symbol, owner)]));
  const channels = enumStrings("src/shared/ipc/schemas.ts", "ipcChannelSchema");
  const operations = proposalOperationKinds();
  if (operations.length !== 17) {
    throw new Error(`変更案の操作は17種類のはずです: ${operations.length}`);
  }
  const databaseSource = readSource("src/main/infrastructure/persistence/sqlite-schema.ts");
  const tables = [...new Set([...databaseSource.matchAll(/CREATE TABLE (\w+)/g)].map((match) => match[1]))].sort();
  if (tables.length !== sqliteOwners.size || tables.some((name) => !sqliteOwners.has(name))) {
    throw new Error("SQLite tableのowner候補が不足しています。");
  }
  for (const [, , path, marker] of fileFormats) {
    if (!readSource(path).includes(marker)) {
      throw new Error(`保存形式の参照を確認できません: ${path}: ${marker}`);
    }
  }
  const versions = [
    ["SQLite", "src/main/infrastructure/persistence/sqlite-schema.ts", "storageSchemaVersion"],
    ["初回設定JSON", "src/main/application/checkpoint.ts", "checkpointVersion"],
    ["暗号化JSON", "src/main/auth/secret-storage/secret-storage.ts", "encryptedFileVersion"],
    ["ウィンドウJSON", "src/main/window-state.ts", "windowStateVersion"],
    ["Asana Custom external data", "src/shared/domain/external-data.ts", "customExternalDataSchemaVersion"],
  ].map(([name, path, symbol]) => [name, version(path, symbol), path, symbol]);
  const facadeMethods = [...readSource("src/main/storage/database.ts")
    .matchAll(/^ {2}public (\w+)\(/gm)]
    .map((match) => match[1])
    .filter((method) => method !== "constructor");
  const destinations = new Map(storageDatabaseMethodDestinations.map(
    ([method, repository, task]) => [method, { repository, task }],
  ));
  if (
    destinations.size !== storageDatabaseMethodDestinations.length
    || facadeMethods.length !== destinations.size
    || facadeMethods.some((method) => !destinations.has(method))
  ) {
    throw new Error("StorageDatabase methodの移行先が一意に決まっていません。");
  }
  for (const [, path] of entryPoints) {
    if (!paths.includes(path)) {
      throw new Error(`主要entry pointがありません: ${path}`);
    }
  }
  return [
    "# 現行source map",
    "",
    "基準commit: `" + revision + "`。対象は`src`以下の手編集source "
      + paths.length + "件で、各行のownerは移行完了時に責任を持つ候補です。現行の物理配置とは異なります。生成: `node scripts/generate-current-source-map.mjs --revision="
      + revision + " --write`。",
    "",
    "## 機能と入口",
    "",
    table(["機能", "最終owner", "現行source"], functions),
    table(["入口", "現行source", "最終owner"], entryPoints),
    "## 全sourceのowner候補",
    "",
    table(["現行source", "最終owner候補"], source.map(({ path, owner }) => [path, owner])),
    "外部エージェントの現行serviceには複数の責務が同居しています。ファイル単位の候補を提案生成とし、移行時は次のownerへ分離します。",
    "",
    table(["現行source", "責務", "最終owner候補"], externalAgentResponsibilities),
    "## 可変状態候補",
    "",
    "TypeScriptのmodule直下にある`let`、`var`、instance生成、変更される`const`、Vue `script setup`直下の状態候補、classのinstance fieldを抽出しています。保存済みの状態とライフサイクルは [state-ownership.md](state-ownership.md) に記します。",
    "",
    table(["module source", "symbol", "最終owner候補"], moduleState),
    table(["Vue component", "状態候補", "最終owner候補"], componentState),
    table(["instance source", "class member", "最終owner候補"], instanceState),
    "## IPC channel",
    "",
    "channel文字列の正本は`src/shared/ipc/schemas.ts`の`ipcChannelSchema`です。配送ownerは全件`main/ipc`と`preload`、契約ownerは`shared/ipc-contracts`です。",
    "",
    table(["channel", "機能owner候補"], channels.map((channel) => [channel, ownerForChannel(channel)])),
    "## 変更案の操作",
    "",
    "識別子は`src/shared/ai/proposal.ts`の`proposalOperationSchema`から抽出しています。操作契約の最終ownerは`main/domain`、適用handlerと実行のownerは`main/application/proposal-apply`です。IPC DTOは`shared/ipc-contracts`が所有します。",
    "",
    table(["operation", "適用owner"], operations.map((operation) => [operation, "main/application/proposal-apply"])),
    "## 保存形式",
    "",
    table(["形式", "保存先または対象", "現行source", "利用上のowner候補"], fileFormats.map(([format, target, path, , owner]) => [format, target, path, owner])),
    table(["形式", "現行version", "現行source", "version symbol"], versions),
    "SQLite接続とtransactionは`main/infrastructure/persistence`が所有し、SQLite schemaの現行versionは上記の値です。",
    "",
    "## StorageDatabaseの移行先",
    "",
    "現行facadeの公開methodを列挙し、用途別repositoryと移行taskを一意に割り当てます。`PersistenceRuntime`は接続とtransactionのownerです。",
    "",
    table(["現行method", "移行先", "task"], facadeMethods.map((method) => [
      method,
      destinations.get(method).repository,
      destinations.get(method).task,
    ])),
    table(["SQLite table", "利用上のowner候補"], tables.map((name) => [name, sqliteOwners.get(name)])),
    "## T49で削除する移行経路",
    "",
    "旧Main機能の移行後は、次の経路と`check-architecture.mjs`の旧service向け例外を削除します。",
    "",
    table(["対象", "削除条件"], [
      ["src/main/application/service.ts", "未移行機能のworkflow移管完了"],
      ["src/main/bootstrap/legacy-runtime-port.ts", "旧serviceへの唯一の接続が不要"],
      ["src/main/storage/database.tsとsrc/main/storage/index.ts", "用途別repositoryへのfacade移管と旧保存形式の移行完了"],
      ["src/main/bootstrap/main-lifecycle-runtime.ts", "旧serviceの起動・停止処理を新runtimeへ移管"],
    ]),
  ].join("\n");
}

const revisionArgument = process.argv.find((argument) => argument.startsWith("--revision="));
if (revisionArgument == null || revisionArgument.slice("--revision=".length).length === 0) {
  throw new Error("--revisionに基準commitを指定してください。");
}
const revision = revisionArgument.slice("--revision=".length);
const markdown = render(revision);
if (process.argv.includes("--write")) {
  const path = join(repositoryRoot, "docs/architecture/current-source-map.md");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, markdown);
} else {
  process.stdout.write(markdown);
}
