import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  analyzeSource,
  listSourceFiles,
  objectStringValues,
  ownerForPath,
  proposalOperationKinds,
  readSource,
  repositoryRoot,
} from "./architecture-source.mjs";

const entryPoints = [
  ["Electron起動入口", "src/main/index.ts", "main/bootstrap"],
  ["MainRuntime生成", "src/main/bootstrap/create-main-runtime.ts", "main/bootstrap"],
  ["Electron起動と終了", "src/main/bootstrap/register-main-lifecycle.ts", "main/bootstrap"],
  ["ウィンドウの生成と保存", "src/main/bootstrap/main-window-runtime.ts", "main/bootstrap"],
  ["運用イベント監視", "src/main/bootstrap/operational-event-runtime.ts", "main/bootstrap"],
  ["アプリ本体の更新", "src/main/bootstrap/application-update-service.ts", "main/bootstrap"],
  ["Main workflow生成", "src/main/bootstrap/main-workflow-construction.ts", "main/bootstrap"],
  ["Main workflow結線", "src/main/bootstrap/main-workflow-composition.ts", "main/bootstrap"],
  ["IPC登録", "src/main/ipc/register-ipc.ts", "main/ipc"],
  ["preload bridge", "src/preload/index.ts", "preload"],
  ["Renderer起動", "src/renderer/app/main.ts", "renderer/app"],
  ["Renderer画面", "src/renderer/app/App.vue", "renderer/app"],
  ["変更案生成の状態", "src/main/application/proposal-generate/workflow-state.ts", "main/application/proposal-generate"],
  ["変更案生成のCodex接続", "src/main/application/proposal-generate/workflow-service.ts", "main/application/proposal-generate"],
  ["変更案適用と復旧", "src/main/application/proposal-apply/apply-stored-proposal.ts", "main/application/proposal-apply"],
  ["GUI編集", "src/main/application/gui-edit/apply.ts", "main/application/gui-edit"],
  ["Asana同期", "src/main/infrastructure/asana/sync/coordinator.ts", "main/infrastructure/asana"],
  ["タスク読取と同期", "src/main/application/task-read/workflow.ts", "main/application/task-read"],
  ["タスク読取の保存", "src/main/infrastructure/persistence/task-read-repository.ts", "main/infrastructure/persistence"],
  ["Obsidian連携", "src/main/application/obsidian-integration/workflow.ts", "main/application/obsidian-integration"],
  ["Vault読取", "src/main/infrastructure/obsidian/read-service.ts", "main/infrastructure/obsidian"],
  ["SQLite schema", "src/main/infrastructure/persistence/sqlite-schema.ts", "main/infrastructure/persistence"],
  ["機能別API選択", "src/renderer/app/feature-api-registry.ts", "renderer/app"],
];

const functions = [
  ["アプリ起動・更新・ウィンドウ", "main/bootstrap", "src/main/index.ts, src/main/bootstrap/create-main-runtime.ts, src/main/bootstrap/register-main-lifecycle.ts, src/main/bootstrap/main-window-runtime.ts, src/main/bootstrap/window-state-controller.ts, src/main/bootstrap/operational-event-runtime.ts, src/main/bootstrap/application-update-service.ts"],
  ["Main workflowの生成と結線", "main/bootstrap", "src/main/bootstrap/main-workflow-construction.ts, src/main/bootstrap/main-workflow-composition.ts"],
  ["初回設定とAsana認証", "main/application/settings", "src/main/application/settings/, src/main/infrastructure/asana/oauth/, src/main/infrastructure/asana/setup/"],
  ["タスク取得・同期・順位", "main/application/task-read", "src/main/application/task-read/, src/main/infrastructure/asana/task-read-adapter.ts, src/main/infrastructure/persistence/task-read-repository.ts, src/main/infrastructure/asana/sync/, src/main/domain/ranking/"],
  ["タスク直接編集", "main/application/gui-edit", "src/main/application/gui-edit/, src/main/infrastructure/asana/client/task-write-client.ts"],
  ["変更案の生成・検証・編集", "main/application/proposal-generate", "src/main/application/proposal-generate/"],
  ["変更案の承認・適用・復旧", "main/application/proposal-apply", "src/main/application/proposal-apply/, src/main/application/common/task-write-plan.ts, src/main/infrastructure/persistence/proposal-application-history-repository.ts"],
  ["外部Codex接続とツール", "main/infrastructure/ai", "src/main/infrastructure/ai/"],
  ["外部提案の準備・生成", "main/application/proposal-generate", "src/main/application/proposal-generate/external-agent-generation.ts"],
  ["外部提案の承認・適用", "main/application/proposal-apply", "src/main/application/proposal-apply/external-agent-application.ts"],
  ["Obsidian参照・Vault設定", "main/application/obsidian-integration", "src/main/application/obsidian-integration/, src/main/infrastructure/obsidian/, src/main/domain/obsidian-contracts.ts, src/main/infrastructure/persistence/vault-mapping-repository.ts"],
  ["GitHub App連携", "main/application/github-integration", "現行アプリにclientはなく、src/main/application/settings/integration-status.tsが利用不可状態を返す"],
  ["設定と秘密情報", "main/application/settings", "src/main/application/settings/, src/main/application/common/ports/secret-storage.ts, src/main/infrastructure/persistence/settings-repository.ts, src/main/infrastructure/persistence/secret-storage.ts"],
  ["IPC契約と配送", "shared/ipc-contracts と main/ipc と preload", "src/shared/ipc-contracts/, src/main/ipc/, src/preload/"],
  ["タスク画面", "renderer/features/tasks", "src/renderer/features/tasks/"],
  ["変更案画面", "renderer/features/proposals", "src/renderer/features/proposals/"],
  ["設定画面", "renderer/features/settings", "src/renderer/features/settings/"],
  ["ログ・診断", "main/infrastructure/logging", "src/main/infrastructure/logging/, src/main/infrastructure/persistence/diagnostic-log-repository.ts"],
  ["mock指定", "renderer/shared/mock", "src/renderer/shared/mock/mock-selection.ts"],
];

const externalAgentResponsibilities = [
  ["src/main/application/proposal-generate/external-agent-generation.ts", "CLI要求、文脈、提案基準、作業領域、提出要求", "main/application/proposal-generate"],
  ["src/main/application/proposal-apply/external-agent-application.ts", "提出済み提案の確認、承認、適用、履歴照会、状態購読", "main/application/proposal-apply"],
  ["src/main/infrastructure/ai/external-agent/transport.ts", "外部連携bridgeの通信", "main/infrastructure/ai"],
  ["src/main/bootstrap/create-main-runtime.ts", "外部連携bridge adapterの生成", "main/bootstrap"],
  ["src/main/bootstrap/main-workflow-construction.ts", "外部提案workflowとbridge factoryの接続", "main/bootstrap"],
  ["src/main/bootstrap/main-workflow-composition.ts", "Main workflowとportの結線", "main/bootstrap"],
];

const fileFormats = [
  ["SQLite", "taskhub.sqlite3", "src/main/bootstrap/create-main-runtime.ts", '"taskhub.sqlite3"', "main/infrastructure/persistence"],
  ["暗号化JSON", "secret-storage.json", "src/main/bootstrap/create-main-runtime.ts", '"secret-storage.json"', "main/infrastructure/persistence"],
  ["初回設定JSON", "setup-checkpoint.json", "src/main/bootstrap/create-main-runtime.ts", '"setup-checkpoint.json"', "main/application/settings"],
  ["ウィンドウJSON", "window-state.json", "src/main/bootstrap/create-main-runtime.ts", '"window-state.json"', "main/bootstrap"],
  ["更新試行JSON", "application-update-attempt.json", "src/main/bootstrap/create-main-runtime.ts", '"application-update-attempt.json"', "main/bootstrap"],
  ["エラーJSONL", "taskhub-error.log", "src/main/infrastructure/logging/jsonl-error-reporter.ts", '"taskhub-error.log"', "main/infrastructure/logging"],
  ["外部Codex設定JSON", "external-agent/config.json", "src/main/infrastructure/ai/external-agent/resources.ts", '"config.json"', "main/application/settings"],
  ["外部Codex接続JSON", "external-agent/connection.json", "src/main/infrastructure/ai/external-agent/resources.ts", '"connection.json"', "main/infrastructure/ai"],
  ["taskctl接続JSON", "taskctl-connection.json", "src/main/infrastructure/ai/taskctl/broker.ts", '"taskctl-connection.json"', "main/infrastructure/ai"],
  ["contextctl接続JSON", "contextctl-connection.json", "src/main/infrastructure/ai/external-tools/broker.ts", '"contextctl-connection.json"', "main/infrastructure/ai"],
  ["Codex作業資源", "codex-workspace/ と codex-home/", "src/main/infrastructure/ai/codex-workspace/schemas.ts", '"codex-workspace"', "main/infrastructure/ai"],
  ["Asana Custom external data", "Asana task external data", "src/main/domain/external-data.ts", "customExternalDataSchemaVersion", "main/domain"],
];

const sqliteOwners = new Map([
  ["application_journal", "main/application/proposal-apply"],
  ["legacy_application_history", "main/application/proposal-apply"],
  ["pending_normalization_baseline", "main/application/task-read"],
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

function version(path, name) {
  const match = readSource(path).match(new RegExp(`(?:export )?const ${name} = (\\d+);`));
  if (match == null) {
    throw new Error(`保存形式の版を取得できません: ${path}: ${name}`);
  }
  return match[1];
}

function ownerForChannel(channel) {
  if (channel.startsWith("system:")) return "main/bootstrap";
  if (channel.startsWith("settings:")) return "main/application/settings";
  if (channel.startsWith("tasks:")) {
    return channel.includes("edit") || channel.includes("execution")
      ? "main/application/gui-edit" : "main/application/task-read";
  }
  if (channel.startsWith("proposals:")) {
    return channel.includes("approve") || channel.includes("history") || channel.includes("execution")
      ? "main/application/proposal-apply" : "main/application/proposal-generate";
  }
  if (channel.startsWith("obsidian-integration:")) return "main/application/obsidian-integration";
  if (channel.startsWith("github-integration:")) return "main/application/github-integration";
  if (channel.startsWith("diagnostics:")) return "main/infrastructure/logging";
  throw new Error(`IPC channelのownerがありません: ${channel}`);
}

function table(head, rows) {
  return [
    `| ${head.join(" | ")} |`,
    `| ${head.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
    "",
  ].join("\n");
}

function render() {
  const paths = listSourceFiles();
  const source = paths.map((path) => ({ path, owner: ownerForPath(path), analysis: analyzeSource(path, readSource(path)) }));
  const moduleState = source.flatMap(({ path, owner, analysis }) => analysis.mutable.map((symbol) => [path, symbol, owner]));
  const componentState = source.flatMap(({ path, owner, analysis }) => analysis.componentState
    .map((symbol) => [path, symbol, owner]));
  const instanceState = source.flatMap(({ path, owner, analysis }) => analysis.instanceState
    .map((symbol) => [path, symbol, owner]));
  const channels = [
    ["src/shared/ipc-contracts/system.ts", "systemChannels"],
    ["src/shared/ipc-contracts/tasks.ts", "tasksChannels"],
    ["src/shared/ipc-contracts/settings.ts", "settingsChannels"],
    ["src/shared/ipc-contracts/proposals-channels.ts", "proposalsChannels"],
    ["src/shared/ipc-contracts/obsidian-integration.ts", "obsidianIntegrationChannels"],
    ["src/shared/ipc-contracts/github-integration.ts", "githubIntegrationChannels"],
    ["src/shared/ipc-contracts/diagnostics.ts", "diagnosticsChannels"],
  ].flatMap(([path, name]) => objectStringValues(path, name));
  if (channels.length !== new Set(channels).size) {
    throw new Error("IPC channelが重複しています。");
  }
  const operations = proposalOperationKinds();
  if (operations.length !== 17) {
    throw new Error(`変更案の操作は17種類のはずです: ${operations.length}`);
  }
  const databaseSource = readSource("src/main/infrastructure/persistence/sqlite-schema.ts");
  const tables = [...new Set([...databaseSource.matchAll(/CREATE TABLE (\w+)/g)].map((match) => match[1]))].sort();
  if (tables.length !== sqliteOwners.size || tables.some((name) => !sqliteOwners.has(name))) {
    throw new Error("SQLite tableのownerが不足しています。");
  }
  for (const [, , path, marker] of fileFormats) {
    if (!readSource(path).includes(marker)) {
      throw new Error(`保存形式の参照を確認できません: ${path}: ${marker}`);
    }
  }
  const versions = [
    ["SQLite", "src/main/infrastructure/persistence/sqlite-schema.ts", "storageSchemaVersion"],
    ["初回設定JSON", "src/main/infrastructure/persistence/setup-checkpoint-store.ts", "checkpointVersion"],
    ["暗号化JSON", "src/main/infrastructure/persistence/secret-storage.ts", "encryptedFileVersion"],
    ["ウィンドウJSON", "src/main/infrastructure/persistence/window-state-store.ts", "windowStateVersion"],
    ["Asana Custom external data", "src/main/domain/external-data.ts", "customExternalDataSchemaVersion"],
  ].map(([name, path, symbol]) => [name, version(path, symbol), path, symbol]);
  for (const [, path] of entryPoints) {
    if (!paths.includes(path)) {
      throw new Error(`主要entry pointがありません: ${path}`);
    }
  }
  return [
    "# ソース対応表",
    "",
    "一覧は現在の作業ツリーにある`src`以下の手編集source "
      + paths.length + "件から生成しています。各行のownerはsourceの配置に対応します。生成: `node scripts/generate-current-source-map.mjs --write`。",
    "",
    "## 機能と入口",
    "",
    table(["機能", "owner", "source"], functions),
    table(["入口", "source", "owner"], entryPoints),
    "## 全sourceのowner",
    "",
    table(["source", "owner"], source.map(({ path, owner }) => [path, owner])),
    "外部エージェントの責務は次のsourceに配置しています。",
    "",
    table(["source", "責務", "owner"], externalAgentResponsibilities),
    "## 可変状態",
    "",
    "TypeScriptのmodule直下にある`let`、`var`、instance生成、変更される`const`、Vue `script setup`直下の状態候補、classのinstance fieldを抽出しています。保存済みの状態とライフサイクルは [state-ownership.md](state-ownership.md) に記します。",
    "",
    table(["module source", "symbol", "owner"], moduleState),
    table(["Vue component", "状態", "owner"], componentState),
    table(["instance source", "class member", "owner"], instanceState),
    "## IPC channel",
    "",
    "channel文字列の正本は`src/shared/ipc-contracts`の機能別channel定義です。配送ownerは全件`main/ipc`と`preload`、契約ownerは`shared/ipc-contracts`です。",
    "",
    table(["channel", "機能owner"], channels.map((channel) => [channel, ownerForChannel(channel)])),
    "## 変更案の操作",
    "",
    "識別子は`src/main/domain/proposal.ts`の`proposalOperationSchema`から抽出しています。操作契約は`main/domain`、適用handlerと実行は`main/application/proposal-apply`が所有します。IPC DTOは`shared/ipc-contracts`が所有します。",
    "",
    table(["operation", "適用owner"], operations.map((operation) => [operation, "main/application/proposal-apply"])),
    "## 保存形式",
    "",
    table(["形式", "保存先または対象", "source", "利用上のowner"], fileFormats.map(([format, target, path, , owner]) => [format, target, path, owner])),
    table(["形式", "version", "source", "version symbol"], versions),
    "SQLite接続とtransactionは`main/infrastructure/persistence`が所有し、SQLite schemaのversionは上記の値です。",
    "",
    table(["SQLite table", "利用上のowner"], tables.map((name) => [name, sqliteOwners.get(name)])),
  ].join("\n");
}

const markdown = render();
if (process.argv.includes("--write")) {
  const path = join(repositoryRoot, "docs/architecture/current-source-map.md");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, markdown);
} else {
  process.stdout.write(markdown);
}
