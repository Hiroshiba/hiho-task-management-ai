# 現行source map

基準commit: `1a20178ab1a593ca5b0111728b504bb5466a8165`。対象は`src`以下の手編集source 196件で、各行のownerは移行完了時に責任を持つ候補です。現行の物理配置とは異なります。生成: `node scripts/generate-current-source-map.mjs --revision=1a20178ab1a593ca5b0111728b504bb5466a8165 --write`。

## 機能と入口

| 機能 | 最終owner | 現行source |
| --- | --- | --- |
| アプリ起動・更新・ウィンドウ | main/bootstrap | src/main/index.ts, src/main/application-update.ts, src/main/window-state.ts |
| 初回設定とAsana認証 | main/application/settings | src/main/setup/, src/main/auth/asana-oauth/ |
| タスク取得・同期・順位 | main/application/task-read | src/main/read-model/, src/main/asana/sync/, src/main/domain/ranking/ |
| タスク直接編集 | main/application/gui-edit | src/main/gui-edit/, src/main/asana/client/task-write-client.ts |
| 変更案の生成・検証・編集 | main/application/proposal-generate | src/main/ai/workflow/, src/main/ai/proposal-validation/, src/main/ai/proposal-workspace/ |
| 変更案の承認・適用・復旧 | main/application/proposal-apply | src/main/ai/proposal-application/, src/main/storage/application-journal.ts |
| 外部Codex接続とツール | main/infrastructure/ai | src/main/codex/, src/main/external-agent/transport.ts, src/main/external-tools/ |
| 外部提案の準備・生成 | main/application/proposal-generate | src/main/external-agent/service.ts |
| 外部提案の承認・適用 | main/application/proposal-apply | src/main/external-agent/service.ts |
| Obsidian参照・Vault設定 | main/application/obsidian-integration | src/main/obsidian/, src/main/storage/vault-mappings.ts |
| GitHub App連携 | main/application/github-integration | 現行アプリ実装なし。READMEの公開用GitHub App設定だけ |
| 設定と秘密情報 | main/application/settings | src/main/storage/device-settings.ts, src/main/auth/secret-storage/ |
| IPC契約と配送 | shared/ipc-contracts と main/ipc と preload | src/shared/ipc/, src/main/ipc/, src/preload/ |
| タスク画面 | renderer/features/tasks | src/renderer/src/Task*.vue |
| 変更案画面 | renderer/features/proposals | src/renderer/src/Ai*.vue, src/renderer/src/*Proposal*.vue |
| 設定画面 | renderer/features/settings | src/renderer/src/SettingsDialog.vue, src/renderer/src/SetupWizard.vue |
| ログ・診断 | main/infrastructure/logging | src/main/persistent-error-log.ts, src/main/storage/diagnostic-log.ts |
| mock transport | renderer/shared/mock | src/renderer/src/task-hub.ts, src/renderer/src/mocks/ |

| 入口 | 現行source | 最終owner |
| --- | --- | --- |
| Electron起動と終了 | src/main/index.ts | main/bootstrap |
| Mainの現行統合 | src/main/application/service.ts | main/bootstrap |
| IPC登録 | src/main/ipc/registry.ts | main/ipc |
| preload bridge | src/preload/index.ts | preload |
| Renderer起動 | src/renderer/src/main.ts | renderer/app |
| Renderer画面 | src/renderer/src/App.vue | renderer/app |
| 変更案生成 | src/main/ai/workflow/service.ts | main/application/proposal-generate |
| 変更案適用と復旧 | src/main/ai/proposal-application/coordinator.ts | main/application/proposal-apply |
| GUI編集 | src/main/gui-edit/service.ts | main/application/gui-edit |
| Asana同期 | src/main/asana/sync/coordinator.ts | main/infrastructure/asana |
| SQLite schema | src/main/storage/database.ts | main/infrastructure/persistence |
| mock transport | src/renderer/src/task-hub.ts | renderer/shared/api |

## 全sourceのowner候補

| 現行source | 最終owner候補 |
| --- | --- |
| src/main/ai/proposal-application/coordinator.ts | main/application/proposal-apply |
| src/main/ai/proposal-application/index.ts | main/application/proposal-apply |
| src/main/ai/proposal-application/operation-writer.ts | main/application/proposal-apply |
| src/main/ai/proposal-application/schemas.ts | main/application/proposal-apply |
| src/main/ai/proposal-approval/conflict-classifier.ts | main/application/proposal-generate |
| src/main/ai/proposal-approval/index.ts | main/application/proposal-generate |
| src/main/ai/proposal-validation/basic.ts | main/application/proposal-generate |
| src/main/ai/proposal-validation/graph.ts | main/application/proposal-generate |
| src/main/ai/proposal-validation/index.ts | main/application/proposal-generate |
| src/main/ai/proposal-workspace/index.ts | main/application/proposal-generate |
| src/main/ai/proposal-workspace/service.ts | main/application/proposal-generate |
| src/main/ai/workflow/errors.ts | main/application/proposal-generate |
| src/main/ai/workflow/index.ts | main/application/proposal-generate |
| src/main/ai/workflow/retry.ts | main/application/proposal-generate |
| src/main/ai/workflow/selection.ts | main/application/proposal-generate |
| src/main/ai/workflow/service.ts | main/application/proposal-generate |
| src/main/application-update.ts | main/bootstrap |
| src/main/application/checkpoint.ts | main/infrastructure/persistence |
| src/main/application/cleanup-aggregation.ts | main/application/task-read |
| src/main/application/codex-adapter.ts | main/infrastructure/ai |
| src/main/application/diagnostics.ts | main/infrastructure/logging |
| src/main/application/schemas.ts | main/application/common |
| src/main/application/service.ts | main/bootstrap |
| src/main/asana/client/client.ts | main/infrastructure/asana |
| src/main/asana/client/index.ts | main/infrastructure/asana |
| src/main/asana/client/setup-client.ts | main/infrastructure/asana |
| src/main/asana/client/task-write-client.ts | main/infrastructure/asana |
| src/main/asana/create-read-back.ts | main/infrastructure/asana |
| src/main/asana/display-order/index.ts | main/infrastructure/asana |
| src/main/asana/display-order/schemas.ts | main/infrastructure/asana |
| src/main/asana/display-order/service.ts | main/infrastructure/asana |
| src/main/asana/operation-queue.ts | main/infrastructure/asana |
| src/main/asana/runtime/errors.ts | main/infrastructure/asana |
| src/main/asana/runtime/index.ts | main/infrastructure/asana |
| src/main/asana/runtime/schemas.ts | main/infrastructure/asana |
| src/main/asana/runtime/service.ts | main/infrastructure/asana |
| src/main/asana/scheduler/index.ts | main/infrastructure/asana |
| src/main/asana/scheduler/scheduler.ts | main/infrastructure/asana |
| src/main/asana/setup/capability-check.ts | main/infrastructure/asana |
| src/main/asana/setup/index.ts | main/infrastructure/asana |
| src/main/asana/setup/manifest.ts | main/infrastructure/asana |
| src/main/asana/setup/resource-coordinator.ts | main/infrastructure/asana |
| src/main/asana/sync-token.ts | main/infrastructure/asana |
| src/main/asana/sync/coordinator.ts | main/infrastructure/asana |
| src/main/asana/sync/delta-sync-source.ts | main/infrastructure/asana |
| src/main/asana/sync/full-sync-source.ts | main/infrastructure/asana |
| src/main/asana/sync/index.ts | main/infrastructure/asana |
| src/main/asana/sync/normalization-plan-applier.ts | main/infrastructure/asana |
| src/main/asana/transport/errors.ts | main/infrastructure/asana |
| src/main/asana/transport/index.ts | main/infrastructure/asana |
| src/main/asana/transport/transport.ts | main/infrastructure/asana |
| src/main/asana/transport/types.ts | main/infrastructure/asana |
| src/main/auth/asana-oauth/asana-oauth.ts | main/infrastructure/asana |
| src/main/auth/asana-oauth/coordinator.ts | main/infrastructure/asana |
| src/main/auth/asana-oauth/errors.ts | main/infrastructure/asana |
| src/main/auth/asana-oauth/index.ts | main/infrastructure/asana |
| src/main/auth/asana-oauth/schemas.ts | main/infrastructure/asana |
| src/main/auth/secret-storage/errors.ts | main/infrastructure/persistence |
| src/main/auth/secret-storage/index.ts | main/infrastructure/persistence |
| src/main/auth/secret-storage/schemas.ts | main/infrastructure/persistence |
| src/main/auth/secret-storage/secret-storage.ts | main/infrastructure/persistence |
| src/main/codex/app-server/connection.ts | main/infrastructure/ai |
| src/main/codex/app-server/errors.ts | main/infrastructure/ai |
| src/main/codex/app-server/index.ts | main/infrastructure/ai |
| src/main/codex/app-server/schemas.ts | main/infrastructure/ai |
| src/main/codex/app-server/version.ts | main/infrastructure/ai |
| src/main/codex/obsidian/index.ts | main/infrastructure/ai |
| src/main/codex/obsidian/schemas.ts | main/infrastructure/ai |
| src/main/codex/session/errors.ts | main/infrastructure/ai |
| src/main/codex/session/index.ts | main/infrastructure/ai |
| src/main/codex/session/schemas.ts | main/infrastructure/ai |
| src/main/codex/session/session.ts | main/infrastructure/ai |
| src/main/codex/taskctl/broker.ts | main/infrastructure/ai |
| src/main/codex/taskctl/client-script.ts | main/infrastructure/ai |
| src/main/codex/taskctl/errors.ts | main/infrastructure/ai |
| src/main/codex/taskctl/index.ts | main/infrastructure/ai |
| src/main/codex/taskctl/query.ts | main/infrastructure/ai |
| src/main/codex/taskctl/schemas.ts | main/infrastructure/ai |
| src/main/codex/workspace/errors.ts | main/infrastructure/ai |
| src/main/codex/workspace/index.ts | main/infrastructure/ai |
| src/main/codex/workspace/initializer.ts | main/infrastructure/ai |
| src/main/codex/workspace/integrations.ts | main/infrastructure/ai |
| src/main/codex/workspace/schemas.ts | main/infrastructure/ai |
| src/main/diagnostic-failure.ts | main/application/common |
| src/main/domain/external-data-ingestion.ts | main/domain |
| src/main/domain/external-data-merge.ts | main/domain |
| src/main/domain/index.ts | main/domain |
| src/main/domain/normalization/graph.ts | main/domain |
| src/main/domain/normalization/index.ts | main/domain |
| src/main/domain/normalization/status.ts | main/domain |
| src/main/domain/normalization/tags.ts | main/domain |
| src/main/domain/ranking/calculator.ts | main/domain |
| src/main/domain/ranking/index.ts | main/domain |
| src/main/domain/snapshot-hash.ts | main/domain |
| src/main/domain/snapshot-normalization/index.ts | main/domain |
| src/main/domain/snapshot-normalization/normalizer.ts | main/domain |
| src/main/domain/snapshot-normalization/schemas.ts | main/domain |
| src/main/external-agent/client-script.ts | main/infrastructure/ai |
| src/main/external-agent/index.ts | main/infrastructure/ai |
| src/main/external-agent/resources.ts | main/infrastructure/ai |
| src/main/external-agent/service.ts | main/application/proposal-generate |
| src/main/external-agent/transport-schemas.ts | main/infrastructure/ai |
| src/main/external-agent/transport.ts | main/infrastructure/ai |
| src/main/external-tools/broker.ts | main/infrastructure/ai |
| src/main/external-tools/client-script.ts | main/infrastructure/ai |
| src/main/external-tools/discord.ts | main/infrastructure/ai |
| src/main/external-tools/errors.ts | main/infrastructure/ai |
| src/main/external-tools/index.ts | main/infrastructure/ai |
| src/main/external-tools/registry.ts | main/infrastructure/ai |
| src/main/external-tools/schemas.ts | main/infrastructure/ai |
| src/main/external-tools/status-evidence-collector.ts | main/infrastructure/ai |
| src/main/gui-edit/baseline.ts | main/application/gui-edit |
| src/main/gui-edit/index.ts | main/application/gui-edit |
| src/main/gui-edit/schemas.ts | main/application/gui-edit |
| src/main/gui-edit/service.ts | main/application/gui-edit |
| src/main/index.ts | main/bootstrap |
| src/main/ipc/index.ts | main/ipc |
| src/main/ipc/registry.ts | main/ipc |
| src/main/local-storage-path.ts | main/infrastructure/persistence |
| src/main/obsidian/errors.ts | main/infrastructure/obsidian |
| src/main/obsidian/index.ts | main/infrastructure/obsidian |
| src/main/obsidian/obsidian-read-service.ts | main/infrastructure/obsidian |
| src/main/obsidian/obsidian-uri.ts | main/infrastructure/obsidian |
| src/main/obsidian/tasks-vault-discovery.ts | main/infrastructure/obsidian |
| src/main/persistent-error-log.ts | main/infrastructure/logging |
| src/main/read-model/index.ts | main/application/task-read |
| src/main/read-model/service.ts | main/application/task-read |
| src/main/redact-sensitive-text.ts | main/infrastructure/logging |
| src/main/security.ts | main/bootstrap |
| src/main/setup/index.ts | main/application/settings |
| src/main/setup/service.ts | main/application/settings |
| src/main/startup-gate.ts | main/bootstrap |
| src/main/storage/application-journal.ts | main/infrastructure/persistence |
| src/main/storage/cleanup-items-cache.ts | main/infrastructure/persistence |
| src/main/storage/database.ts | main/infrastructure/persistence |
| src/main/storage/device-settings.ts | main/infrastructure/persistence |
| src/main/storage/diagnostic-log.ts | main/infrastructure/persistence |
| src/main/storage/external-tool-definitions.ts | main/infrastructure/persistence |
| src/main/storage/index.ts | main/infrastructure/persistence |
| src/main/storage/json.ts | main/infrastructure/persistence |
| src/main/storage/project-metadata-cache.ts | main/infrastructure/persistence |
| src/main/storage/ranking-cache.ts | main/infrastructure/persistence |
| src/main/storage/sync-state.ts | main/infrastructure/persistence |
| src/main/storage/task-cache.ts | main/infrastructure/persistence |
| src/main/storage/types.ts | main/infrastructure/persistence |
| src/main/storage/vault-mappings.ts | main/infrastructure/persistence |
| src/main/window-state.ts | main/infrastructure/persistence |
| src/preload/index.ts | preload |
| src/renderer/env.d.ts | renderer/app |
| src/renderer/index.html | renderer/app |
| src/renderer/src/AiPanel.vue | renderer/features/proposals |
| src/renderer/src/AiSessionDialog.vue | renderer/features/proposals |
| src/renderer/src/App.vue | renderer/app |
| src/renderer/src/AppHeader.vue | renderer/app |
| src/renderer/src/ExternalProposalPanel.vue | renderer/features/proposals |
| src/renderer/src/ProposalOperationEditor.vue | renderer/features/proposals |
| src/renderer/src/ProposalReviewPanel.vue | renderer/features/proposals |
| src/renderer/src/RekaSelect.vue | renderer/shared/components |
| src/renderer/src/SettingsDialog.vue | renderer/features/settings |
| src/renderer/src/SetupWizard.vue | renderer/features/settings |
| src/renderer/src/TaskDetail.vue | renderer/features/tasks |
| src/renderer/src/TaskFilters.vue | renderer/features/tasks |
| src/renderer/src/TaskList.vue | renderer/features/tasks |
| src/renderer/src/TaskSort.vue | renderer/features/tasks |
| src/renderer/src/ToastHost.vue | renderer/shared/components |
| src/renderer/src/duration.ts | renderer/shared/components |
| src/renderer/src/main.ts | renderer/app |
| src/renderer/src/mocks/task-hub.ts | renderer/shared/mock |
| src/renderer/src/state.ts | renderer/app |
| src/renderer/src/styles.css | renderer/app |
| src/renderer/src/task-hub.ts | renderer/shared/api |
| src/renderer/src/useToast.ts | renderer/shared/components |
| src/shared/ai-workflow/index.ts | shared/ipc-contracts |
| src/shared/ai-workflow/schemas.ts | shared/ipc-contracts |
| src/shared/ai/index.ts | main/domain |
| src/shared/ai/proposal-workspace.ts | shared/ipc-contracts |
| src/shared/ai/proposal.ts | main/domain |
| src/shared/domain/canonical-json.ts | main/domain |
| src/shared/domain/external-data.ts | main/domain |
| src/shared/domain/index.ts | main/domain |
| src/shared/domain/primitives.ts | main/domain |
| src/shared/domain/schemas.ts | main/domain |
| src/shared/external-agent/index.ts | shared/ipc-contracts |
| src/shared/external-agent/schemas.ts | shared/ipc-contracts |
| src/shared/ipc/index.ts | shared/ipc-contracts |
| src/shared/ipc/schemas.ts | shared/ipc-contracts |
| src/shared/setup/index.ts | shared/ipc-contracts |
| src/shared/setup/schemas.ts | shared/ipc-contracts |
| src/shared/storage/index.ts | shared/ipc-contracts |
| src/shared/storage/schemas.ts | main/infrastructure/persistence |
| src/shared/task-hub-api.ts | shared/ipc-contracts |
| src/shared/taskctl/index.ts | shared/ipc-contracts |
| src/shared/taskctl/schemas.ts | shared/ipc-contracts |
| src/shared/view-model/index.ts | shared/ipc-contracts |
| src/shared/view-model/schemas.ts | shared/ipc-contracts |
| src/shared/view-model/task-filter.ts | renderer/features/tasks |

外部エージェントの現行serviceには複数の責務が同居しています。ファイル単位の候補を提案生成とし、移行時は次のownerへ分離します。

| 現行source | 責務 | 最終owner候補 |
| --- | --- | --- |
| src/main/external-agent/service.ts | CLI要求の検証・応答、bridgeとの接続 | main/infrastructure/ai |
| src/main/external-agent/service.ts | 文脈、提案基準、作業領域、提出要求 | main/application/proposal-generate |
| src/main/external-agent/service.ts | 提出済み提案の確認、承認、適用、journal照会 | main/application/proposal-apply |
| src/main/external-agent/service.ts | GUI状態の購読と解除 | main/ipc |
| src/main/external-agent/service.ts | 依存の組み立てと停止 | main/bootstrap |

## 可変状態候補

TypeScriptのmodule直下にある`let`、`var`、instance生成、変更される`const`、Vue `script setup`直下の状態候補、classのinstance fieldを抽出しています。保存済みの状態とライフサイクルは [state-ownership.md](state-ownership.md) に記します。

| module source | symbol | 最終owner候補 |
| --- | --- | --- |
| src/main/ai/proposal-application/coordinator.ts | definitiveCreateTaskRejectionStatuses | main/application/proposal-apply |
| src/main/codex/app-server/version.ts | safeEnvironmentKeys | main/infrastructure/ai |
| src/main/codex/app-server/version.ts | safeEnvironmentKeysByLowerCase | main/infrastructure/ai |
| src/main/codex/session/session.ts | requiredSkillNames | main/infrastructure/ai |
| src/main/external-tools/broker.ts | forbiddenInvocationVerbParts | main/infrastructure/ai |
| src/main/external-tools/discord.ts | discordThreadTypes | main/infrastructure/ai |
| src/main/external-tools/schemas.ts | readOnlyCommandHeads | main/infrastructure/ai |
| src/main/external-tools/schemas.ts | forbiddenCommandParts | main/infrastructure/ai |
| src/main/external-tools/schemas.ts | forbiddenArgumentNameParts | main/infrastructure/ai |
| src/main/index.ts | mainWindow | main/bootstrap |
| src/main/index.ts | mainWindowRegistry | main/bootstrap |
| src/main/index.ts | mainWindowStateController | main/bootstrap |
| src/main/index.ts | taskHubApplication | main/bootstrap |
| src/main/index.ts | applicationUpdateService | main/bootstrap |
| src/main/index.ts | lifecycleController | main/bootstrap |
| src/main/index.ts | windowCreationPromise | main/bootstrap |
| src/main/index.ts | applicationStartPromise | main/bootstrap |
| src/main/index.ts | backgroundOperations | main/bootstrap |
| src/main/index.ts | shutdownState | main/bootstrap |
| src/main/index.ts | onlineMonitorState | main/bootstrap |
| src/main/index.ts | foregroundScheduled | main/bootstrap |
| src/main/index.ts | onlinePollScheduled | main/bootstrap |
| src/main/index.ts | powerMonitorRegistered | main/bootstrap |
| src/main/index.ts | versionIpcRegistered | main/bootstrap |
| src/main/index.ts | persistentErrorLog | main/infrastructure/logging |
| src/main/index.ts | uncaughtExceptionMonitorRegistered | main/bootstrap |
| src/main/index.ts | startupGate | main/bootstrap |
| src/main/persistent-error-log.ts | persistentErrorLogFailureOutputEnabled | main/infrastructure/logging |
| src/main/security.ts | allowedAsanaExternalHosts | main/bootstrap |
| src/main/security.ts | allowedAsanaAuthorizationHosts | main/bootstrap |
| src/main/security.ts | allowedCodexAuthorizationHosts | main/bootstrap |
| src/main/storage/database.ts | localAsynchronousCleanupItemKindSet | main/infrastructure/persistence |
| src/renderer/src/useToast.ts | messages | renderer/shared/components |
| src/renderer/src/useToast.ts | nextMessageId | renderer/shared/components |

| Vue component | 状態候補 | 最終owner候補 |
| --- | --- | --- |
| src/renderer/src/AiPanel.vue | localError | renderer/features/proposals |
| src/renderer/src/AiPanel.vue | message | renderer/features/proposals |
| src/renderer/src/AiPanel.vue | messageInput | renderer/features/proposals |
| src/renderer/src/AiSessionDialog.vue | activeTab | renderer/features/proposals |
| src/renderer/src/AiSessionDialog.vue | closeButton | renderer/features/proposals |
| src/renderer/src/AiSessionDialog.vue | dialogElement | renderer/features/proposals |
| src/renderer/src/AiSessionDialog.vue | mobileDetailVisible | renderer/features/proposals |
| src/renderer/src/AiSessionDialog.vue | panelRefs | renderer/features/proposals |
| src/renderer/src/AiSessionDialog.vue | pendingExternalReviewRequestId | renderer/features/proposals |
| src/renderer/src/App.vue | activeSyncMode | renderer/features/tasks |
| src/renderer/src/App.vue | activeSyncReload | renderer/features/tasks |
| src/renderer/src/App.vue | aiDialogComponent | renderer/features/proposals |
| src/renderer/src/App.vue | aiDialogFeedback | renderer/features/proposals |
| src/renderer/src/App.vue | aiDialogRef | renderer/features/proposals |
| src/renderer/src/App.vue | aiDialogReturnFocus | renderer/features/proposals |
| src/renderer/src/App.vue | aiDialogVisible | renderer/features/proposals |
| src/renderer/src/App.vue | aiSelectedSessionId | renderer/features/proposals |
| src/renderer/src/App.vue | aiSessionCreating | renderer/features/proposals |
| src/renderer/src/App.vue | aiSessions | renderer/features/proposals |
| src/renderer/src/App.vue | appUpdateState | renderer/app |
| src/renderer/src/App.vue | asanaAuthenticationBusy | renderer/features/settings |
| src/renderer/src/App.vue | asanaAuthenticationState | renderer/features/settings |
| src/renderer/src/App.vue | asanaAuthenticationStateGeneration | renderer/features/settings |
| src/renderer/src/App.vue | asanaAuthenticationStateLoadInProgress | renderer/features/settings |
| src/renderer/src/App.vue | asanaAuthenticationStateLoaded | renderer/features/settings |
| src/renderer/src/App.vue | asanaAuthenticationStateNeedsRecheck | renderer/features/settings |
| src/renderer/src/App.vue | asanaAuthenticationStateRequestBusy | renderer/features/settings |
| src/renderer/src/App.vue | asanaAuthenticationStateTimer | renderer/features/settings |
| src/renderer/src/App.vue | asanaAuthorizationCodeInput | renderer/features/settings |
| src/renderer/src/App.vue | clockTimer | renderer/features/tasks |
| src/renderer/src/App.vue | codexState | renderer/features/proposals |
| src/renderer/src/App.vue | connectionState | renderer/features/tasks |
| src/renderer/src/App.vue | currentAsOf | renderer/features/tasks |
| src/renderer/src/App.vue | externalAgentBusy | renderer/features/proposals |
| src/renderer/src/App.vue | externalAgentEditResult | renderer/features/proposals |
| src/renderer/src/App.vue | externalAgentState | renderer/features/proposals |
| src/renderer/src/App.vue | feedback | renderer/shared/components |
| src/renderer/src/App.vue | filter | renderer/features/tasks |
| src/renderer/src/App.vue | guiEditGeneration | renderer/features/tasks |
| src/renderer/src/App.vue | guiEditStates | renderer/features/tasks |
| src/renderer/src/App.vue | isMounted | renderer/app |
| src/renderer/src/App.vue | lastLoadedSuccessfulSyncAt | renderer/features/tasks |
| src/renderer/src/App.vue | normalizationNotificationDisplayState | renderer/features/tasks |
| src/renderer/src/App.vue | obsidianStatusGeneration | renderer/features/obsidian-integration |
| src/renderer/src/App.vue | obsidianStatuses | renderer/features/obsidian-integration |
| src/renderer/src/App.vue | overview | renderer/features/tasks |
| src/renderer/src/App.vue | registeredVaultIds | renderer/features/obsidian-integration |
| src/renderer/src/App.vue | removeAiStatusSubscription | renderer/features/proposals |
| src/renderer/src/App.vue | removeAiSubscription | renderer/features/proposals |
| src/renderer/src/App.vue | removeAppUpdateSubscription | renderer/app |
| src/renderer/src/App.vue | removeExternalAgentSubscription | renderer/features/proposals |
| src/renderer/src/App.vue | removeSyncSubscription | renderer/features/tasks |
| src/renderer/src/App.vue | screen | renderer/app |
| src/renderer/src/App.vue | selectedTask | renderer/features/tasks |
| src/renderer/src/App.vue | selectedTaskGid | renderer/features/tasks |
| src/renderer/src/App.vue | settingsDialogFeedback | renderer/features/settings |
| src/renderer/src/App.vue | settingsDialogVisible | renderer/features/settings |
| src/renderer/src/App.vue | setupBusy | renderer/features/settings |
| src/renderer/src/App.vue | setupState | renderer/features/settings |
| src/renderer/src/App.vue | taskDataGeneration | renderer/features/tasks |
| src/renderer/src/App.vue | taskDetailGeneration | renderer/features/tasks |
| src/renderer/src/App.vue | taskEditMarkerGeneration | renderer/features/tasks |
| src/renderer/src/App.vue | taskEditMarkers | renderer/features/tasks |
| src/renderer/src/App.vue | taskFeedback | renderer/features/tasks |
| src/renderer/src/App.vue | taskSort | renderer/features/tasks |
| src/renderer/src/App.vue | vaultMappingBusy | renderer/features/settings |
| src/renderer/src/App.vue | vaultMappingFeedback | renderer/features/settings |
| src/renderer/src/App.vue | vaultMappings | renderer/features/settings |
| src/renderer/src/App.vue | vaultMappingsLoadGeneration | renderer/features/settings |
| src/renderer/src/App.vue | vaultMappingsLoading | renderer/features/settings |
| src/renderer/src/App.vue | vaultSaveGeneration | renderer/features/settings |
| src/renderer/src/AppHeader.vue | fullSyncConfirmationOpen | renderer/features/tasks |
| src/renderer/src/ExternalProposalPanel.vue | selectedProposalId | renderer/features/proposals |
| src/renderer/src/ProposalOperationEditor.vue | form | renderer/features/proposals |
| src/renderer/src/ProposalOperationEditor.vue | nextDraftId | renderer/features/proposals |
| src/renderer/src/ProposalReviewPanel.vue | awaitingEditResult | renderer/features/proposals |
| src/renderer/src/ProposalReviewPanel.vue | editingOperationId | renderer/features/proposals |
| src/renderer/src/ProposalReviewPanel.vue | localError | renderer/features/proposals |
| src/renderer/src/ProposalReviewPanel.vue | selectedGroupIds | renderer/features/proposals |
| src/renderer/src/ProposalReviewPanel.vue | selectedOperationIds | renderer/features/proposals |
| src/renderer/src/ProposalReviewPanel.vue | selectionMode | renderer/features/proposals |
| src/renderer/src/SettingsDialog.vue | vaultForm | renderer/features/settings |
| src/renderer/src/SettingsDialog.vue | vaultLocalError | renderer/features/settings |
| src/renderer/src/SetupWizard.vue | authorizationCodeInput | renderer/features/settings |
| src/renderer/src/SetupWizard.vue | clientId | renderer/features/settings |
| src/renderer/src/SetupWizard.vue | clientSecretInput | renderer/features/settings |
| src/renderer/src/SetupWizard.vue | localError | renderer/features/settings |
| src/renderer/src/SetupWizard.vue | projectName | renderer/features/settings |
| src/renderer/src/SetupWizard.vue | vaultId | renderer/features/settings |
| src/renderer/src/SetupWizard.vue | vaultPath | renderer/features/settings |
| src/renderer/src/TaskDetail.vue | activeTaskGid | renderer/features/tasks |
| src/renderer/src/TaskDetail.vue | area | renderer/features/tasks |
| src/renderer/src/TaskDetail.vue | conflictAcknowledgedGenerations | renderer/features/tasks |
| src/renderer/src/TaskDetail.vue | dependencyText | renderer/features/tasks |
| src/renderer/src/TaskDetail.vue | draftDirty | renderer/features/tasks |
| src/renderer/src/TaskDetail.vue | dueKind | renderer/features/tasks |
| src/renderer/src/TaskDetail.vue | dueValue | renderer/features/tasks |
| src/renderer/src/TaskDetail.vue | durationUnit | renderer/features/tasks |
| src/renderer/src/TaskDetail.vue | durationValue | renderer/features/tasks |
| src/renderer/src/TaskDetail.vue | formDrafts | renderer/features/tasks |
| src/renderer/src/TaskDetail.vue | importance | renderer/features/tasks |
| src/renderer/src/TaskDetail.vue | localError | renderer/features/tasks |
| src/renderer/src/TaskDetail.vue | notes | renderer/features/tasks |
| src/renderer/src/TaskDetail.vue | parentGid | renderer/features/tasks |
| src/renderer/src/TaskDetail.vue | parentWorkMode | renderer/features/tasks |
| src/renderer/src/TaskDetail.vue | processedMarkerGenerations | renderer/features/tasks |
| src/renderer/src/TaskDetail.vue | restoringForm | renderer/features/tasks |
| src/renderer/src/TaskDetail.vue | staleFormDrafts | renderer/features/tasks |
| src/renderer/src/TaskDetail.vue | status | renderer/features/tasks |
| src/renderer/src/TaskDetail.vue | title | renderer/features/tasks |

| instance source | class member | 最終owner候補 |
| --- | --- | --- |
| src/main/ai/proposal-application/coordinator.ts | AsanaProposalApplicationCoordinator.diagnostic | main/application/proposal-apply |
| src/main/ai/proposal-application/coordinator.ts | AsanaProposalApplicationCoordinator.journal | main/application/proposal-apply |
| src/main/ai/proposal-application/coordinator.ts | AsanaProposalApplicationCoordinator.postApply | main/application/proposal-apply |
| src/main/ai/proposal-application/coordinator.ts | AsanaProposalApplicationCoordinator.readClient | main/application/proposal-apply |
| src/main/ai/proposal-application/coordinator.ts | AsanaProposalApplicationCoordinator.timestampProvider | main/application/proposal-apply |
| src/main/ai/proposal-application/coordinator.ts | AsanaProposalApplicationCoordinator.uuidGenerator | main/application/proposal-apply |
| src/main/ai/proposal-application/coordinator.ts | AsanaProposalApplicationCoordinator.writer | main/application/proposal-apply |
| src/main/ai/proposal-application/operation-writer.ts | AsanaProposalOperationWriter.readClient | main/application/proposal-apply |
| src/main/ai/proposal-application/operation-writer.ts | AsanaProposalOperationWriter.writeClient | main/application/proposal-apply |
| src/main/ai/proposal-application/operation-writer.ts | CreateTaskNotFoundError.taskGid | main/application/proposal-apply |
| src/main/ai/proposal-workspace/service.ts | ProposalWorkspace.baselineSnapshotHash | main/application/proposal-generate |
| src/main/ai/proposal-workspace/service.ts | ProposalWorkspace.batches | main/application/proposal-generate |
| src/main/ai/proposal-workspace/service.ts | ProposalWorkspace.draft | main/application/proposal-generate |
| src/main/ai/proposal-workspace/service.ts | ProposalWorkspace.history | main/application/proposal-generate |
| src/main/ai/proposal-workspace/service.ts | ProposalWorkspace.revision | main/application/proposal-generate |
| src/main/ai/proposal-workspace/service.ts | ProposalWorkspace.state | main/application/proposal-generate |
| src/main/ai/proposal-workspace/service.ts | ProposalWorkspace.workspaceId | main/application/proposal-generate |
| src/main/ai/proposal-workspace/service.ts | ProposalWorkspaceConflictError.code | main/application/proposal-generate |
| src/main/ai/workflow/errors.ts | AiWorkflowRetryableFailureError.candidateDigest | main/application/proposal-generate |
| src/main/ai/workflow/errors.ts | AiWorkflowRetryableFailureError.issues | main/application/proposal-generate |
| src/main/ai/workflow/errors.ts | AiWorkflowRetryableFailureError.recoveryAction | main/application/proposal-generate |
| src/main/ai/workflow/retry.ts | AiWorkflowRetryLogEventError.event | main/application/proposal-generate |
| src/main/ai/workflow/service.ts | AiWorkflowService.completedEvidenceSources | main/application/proposal-generate |
| src/main/ai/workflow/service.ts | AiWorkflowService.deltaListeners | main/application/proposal-generate |
| src/main/ai/workflow/service.ts | AiWorkflowService.lifecycle | main/application/proposal-generate |
| src/main/ai/workflow/service.ts | AiWorkflowService.listenerErrorCount | main/application/proposal-generate |
| src/main/ai/workflow/service.ts | AiWorkflowService.options | main/application/proposal-generate |
| src/main/ai/workflow/service.ts | AiWorkflowService.pendingWithdrawConfirmation | main/application/proposal-generate |
| src/main/ai/workflow/service.ts | AiWorkflowService.proposals | main/application/proposal-generate |
| src/main/ai/workflow/service.ts | AiWorkflowService.removeSessionDelta | main/application/proposal-generate |
| src/main/ai/workflow/service.ts | AiWorkflowService.sessionGeneration | main/application/proposal-generate |
| src/main/application-update.ts | ApplicationUpdateAttemptStore.filePath | main/bootstrap |
| src/main/application-update.ts | ApplicationUpdateService.activeOperation | main/bootstrap |
| src/main/application-update.ts | ApplicationUpdateService.attemptStore | main/bootstrap |
| src/main/application-update.ts | ApplicationUpdateService.attemptedVersion | main/bootstrap |
| src/main/application-update.ts | ApplicationUpdateService.candidate | main/bootstrap |
| src/main/application-update.ts | ApplicationUpdateService.currentVersion | main/bootstrap |
| src/main/application-update.ts | ApplicationUpdateService.installing | main/bootstrap |
| src/main/application-update.ts | ApplicationUpdateService.listeners | main/bootstrap |
| src/main/application-update.ts | ApplicationUpdateService.platform | main/bootstrap |
| src/main/application-update.ts | ApplicationUpdateService.quitAfterUpdateFailure | main/bootstrap |
| src/main/application-update.ts | ApplicationUpdateService.reportError | main/bootstrap |
| src/main/application-update.ts | ApplicationUpdateService.resourcesPath | main/bootstrap |
| src/main/application-update.ts | ApplicationUpdateService.restoredInstallFailure | main/bootstrap |
| src/main/application-update.ts | ApplicationUpdateService.started | main/bootstrap |
| src/main/application-update.ts | ApplicationUpdateService.state | main/bootstrap |
| src/main/application-update.ts | ApplicationUpdateService.updater | main/bootstrap |
| src/main/application/checkpoint.ts | SetupCheckpointStore.filePath | main/infrastructure/persistence |
| src/main/application/cleanup-aggregation.ts | CleanupAggregationService.database | main/application/task-read |
| src/main/application/cleanup-aggregation.ts | CleanupAggregationService.noteExistsPort | main/application/task-read |
| src/main/application/codex-adapter.ts | CodexSetupAdapter.environment | main/infrastructure/ai |
| src/main/application/codex-adapter.ts | CodexSetupAdapter.executable | main/infrastructure/ai |
| src/main/application/codex-adapter.ts | CodexSetupAdapter.loginOpened | main/infrastructure/ai |
| src/main/application/codex-adapter.ts | CodexSetupAdapter.openAuthorizationUrl | main/infrastructure/ai |
| src/main/application/codex-adapter.ts | CodexSetupAdapter.session | main/infrastructure/ai |
| src/main/application/codex-adapter.ts | CodexSetupAdapter.startResult | main/infrastructure/ai |
| src/main/application/codex-adapter.ts | CodexSetupAdapter.started | main/infrastructure/ai |
| src/main/application/codex-adapter.ts | CodexSetupAdapter.structuredOutputVerified | main/infrastructure/ai |
| src/main/application/diagnostics.ts | DiagnosticLogService.appVersion | main/infrastructure/logging |
| src/main/application/diagnostics.ts | DiagnosticLogService.nowProvider | main/infrastructure/logging |
| src/main/application/diagnostics.ts | DiagnosticLogService.retentionLimit | main/infrastructure/logging |
| src/main/application/diagnostics.ts | DiagnosticLogService.storage | main/infrastructure/logging |
| src/main/application/service.ts | AsanaOAuthRefreshHttpError.cause | main/bootstrap |
| src/main/application/service.ts | TaskHubApplication.aiApplicationState | main/application/proposal-generate |
| src/main/application/service.ts | TaskHubApplication.aiDeltaListeners | main/application/proposal-generate |
| src/main/application/service.ts | TaskHubApplication.aiSessionStarts | main/application/proposal-generate |
| src/main/application/service.ts | TaskHubApplication.aiSessionWorkspaceParentPath | main/application/proposal-generate |
| src/main/application/service.ts | TaskHubApplication.aiSessions | main/application/proposal-generate |
| src/main/application/service.ts | TaskHubApplication.aiSessionsConfigured | main/application/proposal-generate |
| src/main/application/service.ts | TaskHubApplication.aiStartResult | main/application/proposal-generate |
| src/main/application/service.ts | TaskHubApplication.aiStatusListeners | main/application/proposal-generate |
| src/main/application/service.ts | TaskHubApplication.applicationCoordinator | main/application/proposal-apply |
| src/main/application/service.ts | TaskHubApplication.asanaReauthenticationOperation | main/application/settings |
| src/main/application/service.ts | TaskHubApplication.capability | main/application/settings |
| src/main/application/service.ts | TaskHubApplication.checkpoint | main/application/settings |
| src/main/application/service.ts | TaskHubApplication.cleanupAggregation | main/application/task-read |
| src/main/application/service.ts | TaskHubApplication.codexAdapter | main/bootstrap |
| src/main/application/service.ts | TaskHubApplication.codexAuthenticationRequired | main/application/settings |
| src/main/application/service.ts | TaskHubApplication.codexAvailability | main/application/proposal-generate |
| src/main/application/service.ts | TaskHubApplication.codexConnectionFactory | main/bootstrap |
| src/main/application/service.ts | TaskHubApplication.codexSession | main/bootstrap |
| src/main/application/service.ts | TaskHubApplication.codexWorkspace | main/bootstrap |
| src/main/application/service.ts | TaskHubApplication.configuredCodexLaunchState | main/application/proposal-generate |
| src/main/application/service.ts | TaskHubApplication.configuredCodexSynchronizationPromise | main/application/proposal-generate |
| src/main/application/service.ts | TaskHubApplication.context | main/application/settings |
| src/main/application/service.ts | TaskHubApplication.database | main/bootstrap |
| src/main/application/service.ts | TaskHubApplication.deltaSource | main/bootstrap |
| src/main/application/service.ts | TaskHubApplication.diagnostics | main/infrastructure/logging |
| src/main/application/service.ts | TaskHubApplication.displayOrder | main/application/task-read |
| src/main/application/service.ts | TaskHubApplication.externalAgent | main/application/proposal-generate |
| src/main/application/service.ts | TaskHubApplication.externalAgentBridge | main/application/proposal-generate |
| src/main/application/service.ts | TaskHubApplication.externalAgentInstanceId | main/application/proposal-generate |
| src/main/application/service.ts | TaskHubApplication.externalStatusEvidenceCollector | main/application/proposal-generate |
| src/main/application/service.ts | TaskHubApplication.externalToolConfigurationOperation | main/application/settings |
| src/main/application/service.ts | TaskHubApplication.externalToolLifecycle | main/application/proposal-generate |
| src/main/application/service.ts | TaskHubApplication.externalToolRegistry | main/application/proposal-generate |
| src/main/application/service.ts | TaskHubApplication.fullSource | main/bootstrap |
| src/main/application/service.ts | TaskHubApplication.guiEdit | main/application/gui-edit |
| src/main/application/service.ts | TaskHubApplication.interactiveReadClient | main/bootstrap |
| src/main/application/service.ts | TaskHubApplication.interactiveWriteClient | main/bootstrap |
| src/main/application/service.ts | TaskHubApplication.journalRecoveryPending | main/application/proposal-apply |
| src/main/application/service.ts | TaskHubApplication.journalRecoveryPromise | main/application/proposal-apply |
| src/main/application/service.ts | TaskHubApplication.journalRecoveryRunning | main/application/proposal-apply |
| src/main/application/service.ts | TaskHubApplication.lastDisplaySyncAt | main/application/task-read |
| src/main/application/service.ts | TaskHubApplication.oauth | main/application/settings |
| src/main/application/service.ts | TaskHubApplication.obsidian | main/application/obsidian-integration |
| src/main/application/service.ts | TaskHubApplication.operationQueue | main/application/task-read |
| src/main/application/service.ts | TaskHubApplication.options | main/bootstrap |
| src/main/application/service.ts | TaskHubApplication.planApplier | main/application/task-read |
| src/main/application/service.ts | TaskHubApplication.readClient | main/bootstrap |
| src/main/application/service.ts | TaskHubApplication.readModel | main/application/task-read |
| src/main/application/service.ts | TaskHubApplication.readyActivated | main/bootstrap |
| src/main/application/service.ts | TaskHubApplication.removeRuntimeSubscription | main/bootstrap |
| src/main/application/service.ts | TaskHubApplication.resources | main/application/settings |
| src/main/application/service.ts | TaskHubApplication.runtime | main/application/task-read |
| src/main/application/service.ts | TaskHubApplication.scheduler | main/application/task-read |
| src/main/application/service.ts | TaskHubApplication.secretStorage | main/bootstrap |
| src/main/application/service.ts | TaskHubApplication.settings | main/application/settings |
| src/main/application/service.ts | TaskHubApplication.setup | main/application/settings |
| src/main/application/service.ts | TaskHubApplication.setupClient | main/bootstrap |
| src/main/application/service.ts | TaskHubApplication.stopped | main/bootstrap |
| src/main/application/service.ts | TaskHubApplication.syncCoordinator | main/application/task-read |
| src/main/application/service.ts | TaskHubApplication.syncDiagnosticState | main/application/task-read |
| src/main/application/service.ts | TaskHubApplication.syncFailureDiagnosticSuppressionCount | main/application/task-read |
| src/main/application/service.ts | TaskHubApplication.syncStateListeners | main/application/task-read |
| src/main/application/service.ts | TaskHubApplication.tokenProvider | main/bootstrap |
| src/main/application/service.ts | TaskHubApplication.transport | main/bootstrap |
| src/main/application/service.ts | TaskHubApplication.vaultMappingSaveInProgress | main/application/settings |
| src/main/application/service.ts | TaskHubApplication.writeClient | main/bootstrap |
| src/main/application/service.ts | TaskHubApplication.writer | main/application/proposal-apply |
| src/main/asana/client/client.ts | AsanaReadClient.transport | main/infrastructure/asana |
| src/main/asana/client/setup-client.ts | AsanaSetupClient.transport | main/infrastructure/asana |
| src/main/asana/client/task-write-client.ts | AsanaTaskWriteClient.transport | main/infrastructure/asana |
| src/main/asana/display-order/service.ts | AsanaDisplayOrderService.debounceTimer | main/infrastructure/asana |
| src/main/asana/display-order/service.ts | AsanaDisplayOrderService.lifecycleAbortListener | main/infrastructure/asana |
| src/main/asana/display-order/service.ts | AsanaDisplayOrderService.lifecycleSignal | main/infrastructure/asana |
| src/main/asana/display-order/service.ts | AsanaDisplayOrderService.notifyUnexpectedError | main/infrastructure/asana |
| src/main/asana/display-order/service.ts | AsanaDisplayOrderService.operationQueue | main/infrastructure/asana |
| src/main/asana/display-order/service.ts | AsanaDisplayOrderService.pending | main/infrastructure/asana |
| src/main/asana/display-order/service.ts | AsanaDisplayOrderService.running | main/infrastructure/asana |
| src/main/asana/display-order/service.ts | AsanaDisplayOrderService.stopController | main/infrastructure/asana |
| src/main/asana/display-order/service.ts | AsanaDisplayOrderService.stopped | main/infrastructure/asana |
| src/main/asana/display-order/service.ts | AsanaDisplayOrderService.writeClient | main/infrastructure/asana |
| src/main/asana/operation-queue.ts | AsanaOperationInvalidatedError.reason | main/infrastructure/asana |
| src/main/asana/operation-queue.ts | AsanaOperationQueue.active | main/infrastructure/asana |
| src/main/asana/operation-queue.ts | AsanaOperationQueue.activeCompletion | main/infrastructure/asana |
| src/main/asana/operation-queue.ts | AsanaOperationQueue.backgroundQueue | main/infrastructure/asana |
| src/main/asana/operation-queue.ts | AsanaOperationQueue.lifecycleAbortListener | main/infrastructure/asana |
| src/main/asana/operation-queue.ts | AsanaOperationQueue.lifecycleSignal | main/infrastructure/asana |
| src/main/asana/operation-queue.ts | AsanaOperationQueue.owners | main/infrastructure/asana |
| src/main/asana/operation-queue.ts | AsanaOperationQueue.pumping | main/infrastructure/asana |
| src/main/asana/operation-queue.ts | AsanaOperationQueue.stopController | main/infrastructure/asana |
| src/main/asana/operation-queue.ts | AsanaOperationQueue.stopPromise | main/infrastructure/asana |
| src/main/asana/operation-queue.ts | AsanaOperationQueue.stopped | main/infrastructure/asana |
| src/main/asana/operation-queue.ts | AsanaOperationQueue.userQueue | main/infrastructure/asana |
| src/main/asana/runtime/service.ts | AsanaSyncRuntime.activeRunController | main/infrastructure/asana |
| src/main/asana/runtime/service.ts | AsanaSyncRuntime.activeRunGeneration | main/infrastructure/asana |
| src/main/asana/runtime/service.ts | AsanaSyncRuntime.beforeSynchronization | main/infrastructure/asana |
| src/main/asana/runtime/service.ts | AsanaSyncRuntime.configuration | main/infrastructure/asana |
| src/main/asana/runtime/service.ts | AsanaSyncRuntime.connectionState | main/infrastructure/asana |
| src/main/asana/runtime/service.ts | AsanaSyncRuntime.coordinator | main/infrastructure/asana |
| src/main/asana/runtime/service.ts | AsanaSyncRuntime.database | main/infrastructure/asana |
| src/main/asana/runtime/service.ts | AsanaSyncRuntime.forwardUnhandledError | main/infrastructure/asana |
| src/main/asana/runtime/service.ts | AsanaSyncRuntime.lastErrorCode | main/infrastructure/asana |
| src/main/asana/runtime/service.ts | AsanaSyncRuntime.lastSuccessfulSyncAt | main/infrastructure/asana |
| src/main/asana/runtime/service.ts | AsanaSyncRuntime.lifecycleAbortListener | main/infrastructure/asana |
| src/main/asana/runtime/service.ts | AsanaSyncRuntime.lifecycleSignal | main/infrastructure/asana |
| src/main/asana/runtime/service.ts | AsanaSyncRuntime.listeners | main/infrastructure/asana |
| src/main/asana/runtime/service.ts | AsanaSyncRuntime.notifyUnexpectedError | main/infrastructure/asana |
| src/main/asana/runtime/service.ts | AsanaSyncRuntime.nowProvider | main/infrastructure/asana |
| src/main/asana/runtime/service.ts | AsanaSyncRuntime.operationQueue | main/infrastructure/asana |
| src/main/asana/runtime/service.ts | AsanaSyncRuntime.runGeneration | main/infrastructure/asana |
| src/main/asana/runtime/service.ts | AsanaSyncRuntime.scheduledRun | main/infrastructure/asana |
| src/main/asana/runtime/service.ts | AsanaSyncRuntime.state | main/infrastructure/asana |
| src/main/asana/runtime/service.ts | AsanaSyncRuntime.stopController | main/infrastructure/asana |
| src/main/asana/runtime/service.ts | AsanaSyncRuntime.stopped | main/infrastructure/asana |
| src/main/asana/runtime/service.ts | AsanaSyncRuntime.timer | main/infrastructure/asana |
| src/main/asana/scheduler/scheduler.ts | AsanaRequestScheduler.attemptTimestamps | main/infrastructure/asana |
| src/main/asana/scheduler/scheduler.ts | AsanaRequestScheduler.highPriorityStartsWhileLowWaiting | main/infrastructure/asana |
| src/main/asana/scheduler/scheduler.ts | AsanaRequestScheduler.nextKindToStart | main/infrastructure/asana |
| src/main/asana/scheduler/scheduler.ts | AsanaRequestScheduler.rateLimitTimer | main/infrastructure/asana |
| src/main/asana/scheduler/scheduler.ts | AsanaRequestScheduler.readActiveCount | main/infrastructure/asana |
| src/main/asana/scheduler/scheduler.ts | AsanaRequestScheduler.readQueues | main/infrastructure/asana |
| src/main/asana/scheduler/scheduler.ts | AsanaRequestScheduler.writeActiveCount | main/infrastructure/asana |
| src/main/asana/scheduler/scheduler.ts | AsanaRequestScheduler.writeQueues | main/infrastructure/asana |
| src/main/asana/setup/capability-check.ts | AsanaCapabilityCheckError.result | main/infrastructure/asana |
| src/main/asana/setup/capability-check.ts | AsanaCapabilityCheckService.currentTime | main/infrastructure/asana |
| src/main/asana/setup/capability-check.ts | AsanaCapabilityCheckService.readClient | main/infrastructure/asana |
| src/main/asana/setup/capability-check.ts | AsanaCapabilityCheckService.writeClient | main/infrastructure/asana |
| src/main/asana/setup/resource-coordinator.ts | AsanaSetupResourceCoordinator.readClient | main/infrastructure/asana |
| src/main/asana/setup/resource-coordinator.ts | AsanaSetupResourceCoordinator.setupClient | main/infrastructure/asana |
| src/main/asana/sync/coordinator.ts | AsanaSyncCoordinator.database | main/infrastructure/asana |
| src/main/asana/sync/coordinator.ts | AsanaSyncCoordinator.deltaSyncSource | main/infrastructure/asana |
| src/main/asana/sync/coordinator.ts | AsanaSyncCoordinator.fullSyncSource | main/infrastructure/asana |
| src/main/asana/sync/coordinator.ts | AsanaSyncCoordinator.planApplier | main/infrastructure/asana |
| src/main/asana/sync/coordinator.ts | AsanaSyncCoordinator.readClient | main/infrastructure/asana |
| src/main/asana/sync/coordinator.ts | AsanaSyncCoordinator.synchronizationInProgress | main/infrastructure/asana |
| src/main/asana/sync/coordinator.ts | AsanaSyncCoordinator.timestampProvider | main/infrastructure/asana |
| src/main/asana/sync/delta-sync-source.ts | AsanaDeltaSyncSource.readClient | main/infrastructure/asana |
| src/main/asana/sync/full-sync-source.ts | AsanaFullSyncSource.readClient | main/infrastructure/asana |
| src/main/asana/sync/full-sync-source.ts | AsanaFullSyncSource.writeClient | main/infrastructure/asana |
| src/main/asana/sync/normalization-plan-applier.ts | AsanaNormalizationPlanApplier.readClient | main/infrastructure/asana |
| src/main/asana/sync/normalization-plan-applier.ts | AsanaNormalizationPlanApplier.uuidGenerator | main/infrastructure/asana |
| src/main/asana/sync/normalization-plan-applier.ts | AsanaNormalizationPlanApplier.writeClient | main/infrastructure/asana |
| src/main/asana/transport/errors.ts | AsanaEventsResetError.syncToken | main/infrastructure/asana |
| src/main/asana/transport/errors.ts | AsanaHttpError.errors | main/infrastructure/asana |
| src/main/asana/transport/errors.ts | AsanaHttpError.requestId | main/infrastructure/asana |
| src/main/asana/transport/errors.ts | AsanaHttpError.responseBodyKind | main/infrastructure/asana |
| src/main/asana/transport/errors.ts | AsanaHttpError.source | main/infrastructure/asana |
| src/main/asana/transport/errors.ts | AsanaHttpError.status | main/infrastructure/asana |
| src/main/asana/transport/transport.ts | AsanaTransport.lastRefreshSourceToken | main/infrastructure/asana |
| src/main/asana/transport/transport.ts | AsanaTransport.lastRefreshToken | main/infrastructure/asana |
| src/main/asana/transport/transport.ts | AsanaTransport.refreshState | main/infrastructure/asana |
| src/main/asana/transport/transport.ts | AsanaTransport.scheduler | main/infrastructure/asana |
| src/main/asana/transport/transport.ts | AsanaTransport.tokenProvider | main/infrastructure/asana |
| src/main/auth/asana-oauth/asana-oauth.ts | AsanaOAuthClient.clientId | main/infrastructure/asana |
| src/main/auth/asana-oauth/asana-oauth.ts | AsanaOAuthClient.pendingAuthorization | main/infrastructure/asana |
| src/main/auth/asana-oauth/asana-oauth.ts | AsanaOAuthClient.secretStorage | main/infrastructure/asana |
| src/main/auth/asana-oauth/coordinator.ts | AsanaOAuthCoordinator.openAuthorizationUrl | main/infrastructure/asana |
| src/main/auth/asana-oauth/coordinator.ts | AsanaOAuthCoordinator.outOfBandTransaction | main/infrastructure/asana |
| src/main/auth/asana-oauth/coordinator.ts | AsanaOAuthCoordinator.secretStorage | main/infrastructure/asana |
| src/main/auth/asana-oauth/errors.ts | AsanaOAuthAuthorizationUrlOpenError.kind | main/infrastructure/asana |
| src/main/auth/asana-oauth/errors.ts | AsanaOAuthHttpError.requestId | main/infrastructure/asana |
| src/main/auth/asana-oauth/errors.ts | AsanaOAuthHttpError.status | main/infrastructure/asana |
| src/main/auth/asana-oauth/errors.ts | AsanaOAuthResponseError.status | main/infrastructure/asana |
| src/main/auth/asana-oauth/errors.ts | AsanaOAuthTokenEndpointError.code | main/infrastructure/asana |
| src/main/auth/secret-storage/secret-storage.ts | SecretStorage.filePath | main/infrastructure/persistence |
| src/main/codex/app-server/connection.ts | CodexAppServerConnection.capabilities | main/infrastructure/ai |
| src/main/codex/app-server/connection.ts | CodexAppServerConnection.child | main/infrastructure/ai |
| src/main/codex/app-server/connection.ts | CodexAppServerConnection.clientInfo | main/infrastructure/ai |
| src/main/codex/app-server/connection.ts | CodexAppServerConnection.codexHome | main/infrastructure/ai |
| src/main/codex/app-server/connection.ts | CodexAppServerConnection.configOverrides | main/infrastructure/ai |
| src/main/codex/app-server/connection.ts | CodexAppServerConnection.diagnosticListeners | main/infrastructure/ai |
| src/main/codex/app-server/connection.ts | CodexAppServerConnection.diagnostics | main/infrastructure/ai |
| src/main/codex/app-server/connection.ts | CodexAppServerConnection.dynamicToolHandler | main/infrastructure/ai |
| src/main/codex/app-server/connection.ts | CodexAppServerConnection.dynamicToolRequests | main/infrastructure/ai |
| src/main/codex/app-server/connection.ts | CodexAppServerConnection.environment | main/infrastructure/ai |
| src/main/codex/app-server/connection.ts | CodexAppServerConnection.executable | main/infrastructure/ai |
| src/main/codex/app-server/connection.ts | CodexAppServerConnection.forcedStopTimer | main/infrastructure/ai |
| src/main/codex/app-server/connection.ts | CodexAppServerConnection.gracefulStopTimer | main/infrastructure/ai |
| src/main/codex/app-server/connection.ts | CodexAppServerConnection.nextRequestId | main/infrastructure/ai |
| src/main/codex/app-server/connection.ts | CodexAppServerConnection.notificationListeners | main/infrastructure/ai |
| src/main/codex/app-server/connection.ts | CodexAppServerConnection.onError | main/infrastructure/ai |
| src/main/codex/app-server/connection.ts | CodexAppServerConnection.pendingRequests | main/infrastructure/ai |
| src/main/codex/app-server/connection.ts | CodexAppServerConnection.processTerminationTarget | main/infrastructure/ai |
| src/main/codex/app-server/connection.ts | CodexAppServerConnection.queuedWrites | main/infrastructure/ai |
| src/main/codex/app-server/connection.ts | CodexAppServerConnection.requestTimeoutMs | main/infrastructure/ai |
| src/main/codex/app-server/connection.ts | CodexAppServerConnection.state | main/infrastructure/ai |
| src/main/codex/app-server/connection.ts | CodexAppServerConnection.stderrLineBytes | main/infrastructure/ai |
| src/main/codex/app-server/connection.ts | CodexAppServerConnection.stderrLineCount | main/infrastructure/ai |
| src/main/codex/app-server/connection.ts | CodexAppServerConnection.stderrReader | main/infrastructure/ai |
| src/main/codex/app-server/connection.ts | CodexAppServerConnection.stderrReadingStopped | main/infrastructure/ai |
| src/main/codex/app-server/connection.ts | CodexAppServerConnection.stdoutLineBytes | main/infrastructure/ai |
| src/main/codex/app-server/connection.ts | CodexAppServerConnection.stdoutReader | main/infrastructure/ai |
| src/main/codex/app-server/connection.ts | CodexAppServerConnection.stopPromise | main/infrastructure/ai |
| src/main/codex/app-server/connection.ts | CodexAppServerConnection.stopReject | main/infrastructure/ai |
| src/main/codex/app-server/connection.ts | CodexAppServerConnection.stopResolve | main/infrastructure/ai |
| src/main/codex/app-server/connection.ts | CodexAppServerConnection.terminalError | main/infrastructure/ai |
| src/main/codex/app-server/connection.ts | CodexAppServerConnection.writeQueue | main/infrastructure/ai |
| src/main/codex/app-server/errors.ts | CodexProcessExitError.exitCode | main/infrastructure/ai |
| src/main/codex/app-server/errors.ts | CodexProcessExitError.signal | main/infrastructure/ai |
| src/main/codex/app-server/errors.ts | CodexProtocolError.failureCode | main/infrastructure/ai |
| src/main/codex/app-server/errors.ts | CodexRequestAbortedError.method | main/infrastructure/ai |
| src/main/codex/app-server/errors.ts | CodexRequestTimeoutError.method | main/infrastructure/ai |
| src/main/codex/app-server/errors.ts | CodexRpcError.operation | main/infrastructure/ai |
| src/main/codex/app-server/errors.ts | CodexRpcError.rpcCode | main/infrastructure/ai |
| src/main/codex/app-server/errors.ts | CodexRpcError.rpcMessage | main/infrastructure/ai |
| src/main/codex/app-server/schemas.ts | CodexConfigOverride.argument | main/infrastructure/ai |
| src/main/codex/session/errors.ts | CodexThreadStartCapabilityError.failureCode | main/infrastructure/ai |
| src/main/codex/session/session.ts | CodexSessionService.activeProposalWorkspace | main/infrastructure/ai |
| src/main/codex/session/session.ts | CodexSessionService.activeTurn | main/infrastructure/ai |
| src/main/codex/session/session.ts | CodexSessionService.additionalLocalSocketPaths | main/infrastructure/ai |
| src/main/codex/session/session.ts | CodexSessionService.broker | main/infrastructure/ai |
| src/main/codex/session/session.ts | CodexSessionService.connection | main/infrastructure/ai |
| src/main/codex/session/session.ts | CodexSessionService.connectionConfigurationChanged | main/infrastructure/ai |
| src/main/codex/session/session.ts | CodexSessionService.deltaListeners | main/infrastructure/ai |
| src/main/codex/session/session.ts | CodexSessionService.diagnostics | main/infrastructure/ai |
| src/main/codex/session/session.ts | CodexSessionService.disablePromise | main/infrastructure/ai |
| src/main/codex/session/session.ts | CodexSessionService.frozenTaskctlSnapshot | main/infrastructure/ai |
| src/main/codex/session/session.ts | CodexSessionService.lifecycleAbortListener | main/infrastructure/ai |
| src/main/codex/session/session.ts | CodexSessionService.lifecycleSignal | main/infrastructure/ai |
| src/main/codex/session/session.ts | CodexSessionService.modelFormatInstruction | main/infrastructure/ai |
| src/main/codex/session/session.ts | CodexSessionService.options | main/infrastructure/ai |
| src/main/codex/session/session.ts | CodexSessionService.readOnlyVaultPaths | main/infrastructure/ai |
| src/main/codex/session/session.ts | CodexSessionService.recoveryAbortController | main/infrastructure/ai |
| src/main/codex/session/session.ts | CodexSessionService.removeDiagnosticListener | main/infrastructure/ai |
| src/main/codex/session/session.ts | CodexSessionService.removeDynamicToolListener | main/infrastructure/ai |
| src/main/codex/session/session.ts | CodexSessionService.removeNotificationListener | main/infrastructure/ai |
| src/main/codex/session/session.ts | CodexSessionService.restartCount | main/infrastructure/ai |
| src/main/codex/session/session.ts | CodexSessionService.restartPromise | main/infrastructure/ai |
| src/main/codex/session/session.ts | CodexSessionService.safetyViolation | main/infrastructure/ai |
| src/main/codex/session/session.ts | CodexSessionService.selectedModel | main/infrastructure/ai |
| src/main/codex/session/session.ts | CodexSessionService.skillConfiguration | main/infrastructure/ai |
| src/main/codex/session/session.ts | CodexSessionService.state | main/infrastructure/ai |
| src/main/codex/session/session.ts | CodexSessionService.stopPromise | main/infrastructure/ai |
| src/main/codex/session/session.ts | CodexSessionService.structuredOutputSchema | main/infrastructure/ai |
| src/main/codex/session/session.ts | CodexSessionService.structuredOutputVerified | main/infrastructure/ai |
| src/main/codex/session/session.ts | CodexSessionService.successfullyStarted | main/infrastructure/ai |
| src/main/codex/session/session.ts | CodexSessionService.taskctlStartResult | main/infrastructure/ai |
| src/main/codex/session/session.ts | CodexSessionService.threadConfigurationChanged | main/infrastructure/ai |
| src/main/codex/session/session.ts | CodexSessionService.threadId | main/infrastructure/ai |
| src/main/codex/session/session.ts | CodexSessionService.threadSettingsNotification | main/infrastructure/ai |
| src/main/codex/taskctl/broker.ts | TaskctlBroker.abortListener | main/infrastructure/ai |
| src/main/codex/taskctl/broker.ts | TaskctlBroker.abortSignal | main/infrastructure/ai |
| src/main/codex/taskctl/broker.ts | TaskctlBroker.connectionInfo | main/infrastructure/ai |
| src/main/codex/taskctl/broker.ts | TaskctlBroker.connectionInfoPath | main/infrastructure/ai |
| src/main/codex/taskctl/broker.ts | TaskctlBroker.connections | main/infrastructure/ai |
| src/main/codex/taskctl/broker.ts | TaskctlBroker.diagnostics | main/infrastructure/ai |
| src/main/codex/taskctl/broker.ts | TaskctlBroker.internalError | main/infrastructure/ai |
| src/main/codex/taskctl/broker.ts | TaskctlBroker.server | main/infrastructure/ai |
| src/main/codex/taskctl/broker.ts | TaskctlBroker.snapshotProvider | main/infrastructure/ai |
| src/main/codex/taskctl/broker.ts | TaskctlBroker.socketDirectoryPath | main/infrastructure/ai |
| src/main/codex/taskctl/broker.ts | TaskctlBroker.socketPath | main/infrastructure/ai |
| src/main/codex/taskctl/broker.ts | TaskctlBroker.state | main/infrastructure/ai |
| src/main/codex/taskctl/broker.ts | TaskctlBroker.stopPromise | main/infrastructure/ai |
| src/main/codex/taskctl/broker.ts | TaskctlBroker.tmpDirectoryPath | main/infrastructure/ai |
| src/main/diagnostic-failure.ts | DiagnosticFailureDispositionError.disposition | main/application/common |
| src/main/domain/normalization/graph.ts | RelationshipCycleError.relation | main/domain |
| src/main/domain/normalization/graph.ts | RelationshipCycleError.task_gids | main/domain |
| src/main/external-agent/service.ts | ExternalAgentService.context | main/application/proposal-generate |
| src/main/external-agent/service.ts | ExternalAgentService.listeners | main/ipc |
| src/main/external-agent/service.ts | ExternalAgentService.options | main/bootstrap |
| src/main/external-agent/service.ts | ExternalAgentService.preparedContexts | main/application/proposal-generate |
| src/main/external-agent/service.ts | ExternalAgentService.preparedRequests | main/application/proposal-generate |
| src/main/external-agent/service.ts | ExternalAgentService.proposals | main/application/proposal-apply |
| src/main/external-agent/service.ts | ExternalAgentService.requests | main/application/proposal-generate |
| src/main/external-agent/service.ts | ExternalAgentService.reviewTarget | main/application/proposal-apply |
| src/main/external-agent/service.ts | ExternalAgentService.stopped | main/bootstrap |
| src/main/external-agent/service.ts | ExternalAgentServiceError.code | main/application/common |
| src/main/external-agent/transport.ts | ExternalAgentBridge.acceptingConnections | main/infrastructure/ai |
| src/main/external-agent/transport.ts | ExternalAgentBridge.connections | main/infrastructure/ai |
| src/main/external-agent/transport.ts | ExternalAgentBridge.descriptor | main/infrastructure/ai |
| src/main/external-agent/transport.ts | ExternalAgentBridge.enabled | main/infrastructure/ai |
| src/main/external-agent/transport.ts | ExternalAgentBridge.handleRequest | main/infrastructure/ai |
| src/main/external-agent/transport.ts | ExternalAgentBridge.lifecycleOperation | main/infrastructure/ai |
| src/main/external-agent/transport.ts | ExternalAgentBridge.onError | main/infrastructure/ai |
| src/main/external-agent/transport.ts | ExternalAgentBridge.paths | main/infrastructure/ai |
| src/main/external-agent/transport.ts | ExternalAgentBridge.requestControllers | main/infrastructure/ai |
| src/main/external-agent/transport.ts | ExternalAgentBridge.server | main/infrastructure/ai |
| src/main/external-agent/transport.ts | ExternalAgentBridge.state | main/infrastructure/ai |
| src/main/external-agent/transport.ts | ExternalAgentBridge.stopPromise | main/infrastructure/ai |
| src/main/external-agent/transport.ts | ExternalAgentBridge.unixEndpointDirectoryPath | main/infrastructure/ai |
| src/main/external-agent/transport.ts | ExternalAgentBridge.userDataPath | main/infrastructure/ai |
| src/main/external-tools/broker.ts | ExternalToolBroker.activeRuns | main/infrastructure/ai |
| src/main/external-tools/broker.ts | ExternalToolBroker.connectionInfo | main/infrastructure/ai |
| src/main/external-tools/broker.ts | ExternalToolBroker.connectionInfoPath | main/infrastructure/ai |
| src/main/external-tools/broker.ts | ExternalToolBroker.connections | main/infrastructure/ai |
| src/main/external-tools/broker.ts | ExternalToolBroker.diagnostics | main/infrastructure/ai |
| src/main/external-tools/broker.ts | ExternalToolBroker.discordCredentialProvider | main/infrastructure/ai |
| src/main/external-tools/broker.ts | ExternalToolBroker.endpoint | main/infrastructure/ai |
| src/main/external-tools/broker.ts | ExternalToolBroker.registry | main/infrastructure/ai |
| src/main/external-tools/broker.ts | ExternalToolBroker.server | main/infrastructure/ai |
| src/main/external-tools/broker.ts | ExternalToolBroker.startAbortListener | main/infrastructure/ai |
| src/main/external-tools/broker.ts | ExternalToolBroker.startAbortSignal | main/infrastructure/ai |
| src/main/external-tools/broker.ts | ExternalToolBroker.startAbortStopPromise | main/infrastructure/ai |
| src/main/external-tools/broker.ts | ExternalToolBroker.startController | main/infrastructure/ai |
| src/main/external-tools/broker.ts | ExternalToolBroker.startListenPromise | main/infrastructure/ai |
| src/main/external-tools/broker.ts | ExternalToolBroker.state | main/infrastructure/ai |
| src/main/external-tools/broker.ts | ExternalToolBroker.statusEvidenceCollector | main/infrastructure/ai |
| src/main/external-tools/broker.ts | ExternalToolBroker.stopPromise | main/infrastructure/ai |
| src/main/external-tools/broker.ts | ExternalToolBroker.stopRequested | main/infrastructure/ai |
| src/main/external-tools/broker.ts | ExternalToolBroker.tmpDirectoryPath | main/infrastructure/ai |
| src/main/external-tools/discord.ts | SecretStorageDiscordCredentialProvider.secretStorage | main/infrastructure/ai |
| src/main/external-tools/errors.ts | ExternalToolError.code | main/infrastructure/ai |
| src/main/external-tools/errors.ts | ExternalToolError.retryable | main/infrastructure/ai |
| src/main/external-tools/registry.ts | ExternalToolRegistry.definitions | main/infrastructure/ai |
| src/main/external-tools/status-evidence-collector.ts | ExternalToolStatusEvidenceCollector.state | main/infrastructure/ai |
| src/main/gui-edit/service.ts | AsanaGuiEditService.onlineStateProvider | main/application/gui-edit |
| src/main/gui-edit/service.ts | AsanaGuiEditService.operationIdProvider | main/application/gui-edit |
| src/main/gui-edit/service.ts | AsanaGuiEditService.postApply | main/application/gui-edit |
| src/main/gui-edit/service.ts | AsanaGuiEditService.readClient | main/application/gui-edit |
| src/main/gui-edit/service.ts | AsanaGuiEditService.relationGraphValidator | main/application/gui-edit |
| src/main/gui-edit/service.ts | AsanaGuiEditService.reportFailure | main/application/gui-edit |
| src/main/gui-edit/service.ts | AsanaGuiEditService.statusWriteClient | main/application/gui-edit |
| src/main/gui-edit/service.ts | AsanaGuiEditService.writer | main/application/gui-edit |
| src/main/ipc/registry.ts | IpcHandlerRegistry.activeAbortControllers | main/ipc |
| src/main/ipc/registry.ts | IpcHandlerRegistry.aiStatusSubscribers | main/ipc |
| src/main/ipc/registry.ts | IpcHandlerRegistry.aiSubscribers | main/ipc |
| src/main/ipc/registry.ts | IpcHandlerRegistry.appUpdateSubscribers | main/ipc |
| src/main/ipc/registry.ts | IpcHandlerRegistry.cleanup | main/ipc |
| src/main/ipc/registry.ts | IpcHandlerRegistry.disposed | main/ipc |
| src/main/ipc/registry.ts | IpcHandlerRegistry.externalAgentSubscribers | main/ipc |
| src/main/ipc/registry.ts | IpcHandlerRegistry.options | main/ipc |
| src/main/ipc/registry.ts | IpcHandlerRegistry.registeredIpcMain | main/ipc |
| src/main/ipc/registry.ts | IpcHandlerRegistry.syncSubscribers | main/ipc |
| src/main/obsidian/obsidian-read-service.ts | ObsidianReadError.code | main/infrastructure/obsidian |
| src/main/obsidian/obsidian-read-service.ts | ObsidianReadService.database | main/infrastructure/obsidian |
| src/main/persistent-error-log.ts | PersistentErrorLog.errorLogPath | main/infrastructure/logging |
| src/main/persistent-error-log.ts | PersistentErrorLog.logsPath | main/infrastructure/logging |
| src/main/persistent-error-log.ts | PersistentErrorLog.writing | main/infrastructure/logging |
| src/main/read-model/service.ts | ReadModelService.storage | main/application/task-read |
| src/main/setup/service.ts | SetupOrchestrator.asana | main/application/settings |
| src/main/setup/service.ts | SetupOrchestrator.authorizationCompletionOperation | main/application/settings |
| src/main/setup/service.ts | SetupOrchestrator.capability | main/application/settings |
| src/main/setup/service.ts | SetupOrchestrator.checkpoint | main/application/settings |
| src/main/setup/service.ts | SetupOrchestrator.codex | main/application/settings |
| src/main/setup/service.ts | SetupOrchestrator.codexAvailability | main/application/settings |
| src/main/setup/service.ts | SetupOrchestrator.database | main/application/settings |
| src/main/setup/service.ts | SetupOrchestrator.deviceId | main/application/settings |
| src/main/setup/service.ts | SetupOrchestrator.externalTool | main/application/settings |
| src/main/setup/service.ts | SetupOrchestrator.fullSync | main/application/settings |
| src/main/setup/service.ts | SetupOrchestrator.oauth | main/application/settings |
| src/main/setup/service.ts | SetupOrchestrator.reportCapabilityFailure | main/application/settings |
| src/main/setup/service.ts | SetupOrchestrator.resources | main/application/settings |
| src/main/setup/service.ts | SetupOrchestrator.resumeRequired | main/application/settings |
| src/main/setup/service.ts | SetupOrchestrator.state | main/application/settings |
| src/main/storage/application-journal.ts | ApplicationJournalStore.completeStatement | main/infrastructure/persistence |
| src/main/storage/application-journal.ts | ApplicationJournalStore.corruptPlanRecoveryCauses | main/infrastructure/persistence |
| src/main/storage/application-journal.ts | ApplicationJournalStore.database | main/infrastructure/persistence |
| src/main/storage/application-journal.ts | ApplicationJournalStore.insertPreparedStatement | main/infrastructure/persistence |
| src/main/storage/application-journal.ts | ApplicationJournalStore.markProposalUnresolvedStatement | main/infrastructure/persistence |
| src/main/storage/application-journal.ts | ApplicationJournalStore.recordCreatedTaskStatement | main/infrastructure/persistence |
| src/main/storage/application-journal.ts | ApplicationJournalStore.selectByProposalStatement | main/infrastructure/persistence |
| src/main/storage/application-journal.ts | ApplicationJournalStore.selectIncompleteStatement | main/infrastructure/persistence |
| src/main/storage/application-journal.ts | ApplicationJournalStore.selectOneStatement | main/infrastructure/persistence |
| src/main/storage/application-journal.ts | ApplicationJournalStore.updateStageStatement | main/infrastructure/persistence |
| src/main/storage/cleanup-items-cache.ts | CleanupItemsCacheStore.database | main/infrastructure/persistence |
| src/main/storage/cleanup-items-cache.ts | CleanupItemsCacheStore.saveStatement | main/infrastructure/persistence |
| src/main/storage/cleanup-items-cache.ts | CleanupItemsCacheStore.selectStatement | main/infrastructure/persistence |
| src/main/storage/database.ts | StorageDatabase.applicationJournalStore | main/infrastructure/persistence |
| src/main/storage/database.ts | StorageDatabase.cleanupItemsCacheStore | main/infrastructure/persistence |
| src/main/storage/database.ts | StorageDatabase.database | main/infrastructure/persistence |
| src/main/storage/database.ts | StorageDatabase.deviceSettingsStore | main/infrastructure/persistence |
| src/main/storage/database.ts | StorageDatabase.diagnosticLogStore | main/infrastructure/persistence |
| src/main/storage/database.ts | StorageDatabase.externalToolDefinitionStore | main/infrastructure/persistence |
| src/main/storage/database.ts | StorageDatabase.projectMetadataCacheStore | main/infrastructure/persistence |
| src/main/storage/database.ts | StorageDatabase.rankingCacheStore | main/infrastructure/persistence |
| src/main/storage/database.ts | StorageDatabase.syncStateStore | main/infrastructure/persistence |
| src/main/storage/database.ts | StorageDatabase.taskCacheStore | main/infrastructure/persistence |
| src/main/storage/database.ts | StorageDatabase.vaultMappingStore | main/infrastructure/persistence |
| src/main/storage/device-settings.ts | DeviceSettingsStore.clearStatement | main/infrastructure/persistence |
| src/main/storage/device-settings.ts | DeviceSettingsStore.database | main/infrastructure/persistence |
| src/main/storage/device-settings.ts | DeviceSettingsStore.saveStatement | main/infrastructure/persistence |
| src/main/storage/device-settings.ts | DeviceSettingsStore.selectStatement | main/infrastructure/persistence |
| src/main/storage/diagnostic-log.ts | DiagnosticLogStore.database | main/infrastructure/persistence |
| src/main/storage/diagnostic-log.ts | DiagnosticLogStore.deleteOlderStatement | main/infrastructure/persistence |
| src/main/storage/diagnostic-log.ts | DiagnosticLogStore.insertStatement | main/infrastructure/persistence |
| src/main/storage/diagnostic-log.ts | DiagnosticLogStore.selectAllStatement | main/infrastructure/persistence |
| src/main/storage/external-tool-definitions.ts | ExternalToolDefinitionStore.database | main/infrastructure/persistence |
| src/main/storage/external-tool-definitions.ts | ExternalToolDefinitionStore.deleteAllStatement | main/infrastructure/persistence |
| src/main/storage/external-tool-definitions.ts | ExternalToolDefinitionStore.deleteStatement | main/infrastructure/persistence |
| src/main/storage/external-tool-definitions.ts | ExternalToolDefinitionStore.saveStatement | main/infrastructure/persistence |
| src/main/storage/external-tool-definitions.ts | ExternalToolDefinitionStore.selectAllStatement | main/infrastructure/persistence |
| src/main/storage/project-metadata-cache.ts | ProjectMetadataCacheStore.database | main/infrastructure/persistence |
| src/main/storage/project-metadata-cache.ts | ProjectMetadataCacheStore.saveStatement | main/infrastructure/persistence |
| src/main/storage/project-metadata-cache.ts | ProjectMetadataCacheStore.selectAllStatement | main/infrastructure/persistence |
| src/main/storage/project-metadata-cache.ts | ProjectMetadataCacheStore.selectOneStatement | main/infrastructure/persistence |
| src/main/storage/ranking-cache.ts | RankingCacheStore.database | main/infrastructure/persistence |
| src/main/storage/ranking-cache.ts | RankingCacheStore.saveStatement | main/infrastructure/persistence |
| src/main/storage/ranking-cache.ts | RankingCacheStore.selectStatement | main/infrastructure/persistence |
| src/main/storage/sync-state.ts | SyncStateStore.database | main/infrastructure/persistence |
| src/main/storage/sync-state.ts | SyncStateStore.saveStatement | main/infrastructure/persistence |
| src/main/storage/sync-state.ts | SyncStateStore.selectAllStatement | main/infrastructure/persistence |
| src/main/storage/sync-state.ts | SyncStateStore.selectOneStatement | main/infrastructure/persistence |
| src/main/storage/task-cache.ts | TaskCacheStore.database | main/infrastructure/persistence |
| src/main/storage/task-cache.ts | TaskCacheStore.deleteAllStatement | main/infrastructure/persistence |
| src/main/storage/task-cache.ts | TaskCacheStore.deleteByGidStatement | main/infrastructure/persistence |
| src/main/storage/task-cache.ts | TaskCacheStore.insertStatement | main/infrastructure/persistence |
| src/main/storage/task-cache.ts | TaskCacheStore.selectAllStatement | main/infrastructure/persistence |
| src/main/storage/task-cache.ts | TaskCacheStore.selectOneStatement | main/infrastructure/persistence |
| src/main/storage/task-cache.ts | TaskCacheStore.upsertStatement | main/infrastructure/persistence |
| src/main/storage/vault-mappings.ts | VaultMappingStore.database | main/infrastructure/persistence |
| src/main/storage/vault-mappings.ts | VaultMappingStore.deleteStatement | main/infrastructure/persistence |
| src/main/storage/vault-mappings.ts | VaultMappingStore.saveStatement | main/infrastructure/persistence |
| src/main/storage/vault-mappings.ts | VaultMappingStore.selectAllStatement | main/infrastructure/persistence |
| src/main/window-state.ts | WindowStateController.currentWindowState | main/infrastructure/persistence |
| src/main/window-state.ts | WindowStateController.displaysProvider | main/infrastructure/persistence |
| src/main/window-state.ts | WindowStateController.disposed | main/infrastructure/persistence |
| src/main/window-state.ts | WindowStateController.fullscreenTransition | main/infrastructure/persistence |
| src/main/window-state.ts | WindowStateController.handleBeforeInputEvent | main/infrastructure/persistence |
| src/main/window-state.ts | WindowStateController.handleBoundsChanged | main/infrastructure/persistence |
| src/main/window-state.ts | WindowStateController.handleClose | main/infrastructure/persistence |
| src/main/window-state.ts | WindowStateController.handleClosed | main/infrastructure/persistence |
| src/main/window-state.ts | WindowStateController.handleEnterFullScreen | main/infrastructure/persistence |
| src/main/window-state.ts | WindowStateController.handleLeaveFullScreen | main/infrastructure/persistence |
| src/main/window-state.ts | WindowStateController.handleMaximize | main/infrastructure/persistence |
| src/main/window-state.ts | WindowStateController.handleUnmaximize | main/infrastructure/persistence |
| src/main/window-state.ts | WindowStateController.saveTimer | main/infrastructure/persistence |
| src/main/window-state.ts | WindowStateController.scheduleSave | main/infrastructure/persistence |
| src/main/window-state.ts | WindowStateController.store | main/infrastructure/persistence |
| src/main/window-state.ts | WindowStateController.window | main/infrastructure/persistence |
| src/main/window-state.ts | WindowStateStore.filePath | main/infrastructure/persistence |
| src/shared/domain/external-data.ts | CustomExternalDataCapacityError.byteLength | main/domain |

## IPC channel

channel文字列の正本は`src/shared/ipc/schemas.ts`の`ipcChannelSchema`です。配送ownerは全件`main/ipc`と`preload`、契約ownerは`shared/ipc-contracts`です。

| channel | 機能owner候補 |
| --- | --- |
| app:get-version | main/bootstrap |
| app:wait-for-startup | main/bootstrap |
| app-update:get-state | main/bootstrap |
| app-update:state:subscribe | main/bootstrap |
| app-update:state:unsubscribe | main/bootstrap |
| app-update:state | main/bootstrap |
| asana:get-authentication-state | main/application/settings |
| asana:begin-reauthentication | main/application/settings |
| asana:complete-reauthentication | main/application/settings |
| asana:cancel-reauthentication | main/application/settings |
| read-model:get-overview | main/application/task-read |
| read-model:get-task-detail | main/application/task-read |
| sync:run | main/application/task-read |
| sync:get-state | main/application/task-read |
| sync:state:subscribe | main/application/task-read |
| sync:state:unsubscribe | main/application/task-read |
| sync:state | main/application/task-read |
| setup:get-state | main/application/settings |
| setup:start | main/application/settings |
| setup:complete-codex-authentication | main/application/settings |
| setup:begin-asana-authorization | main/application/settings |
| setup:complete-asana-authorization | main/application/settings |
| setup:cancel-asana-authorization | main/application/settings |
| setup:list-workspaces | main/application/settings |
| setup:select-workspace | main/application/settings |
| setup:select-project | main/application/settings |
| setup:retry-resources | main/application/settings |
| setup:run-capability | main/application/settings |
| setup:choose-vault | main/application/settings |
| setup:choose-external-tool | main/application/settings |
| setup:run-full-sync | main/application/settings |
| setup:run-codex-capability | main/application/settings |
| gui:apply | main/application/gui-edit |
| ai:start-turn | main/application/proposal-generate |
| ai:start-new-session | main/application/proposal-generate |
| ai:get-status | main/application/proposal-generate |
| ai:get-proposal | main/application/proposal-generate |
| ai:select | main/application/proposal-generate |
| ai:edit-operation | main/application/proposal-generate |
| ai:reject | main/application/proposal-generate |
| ai:approve | main/application/proposal-apply |
| ai:close-session | main/application/proposal-generate |
| ai:delta:subscribe | main/application/proposal-generate |
| ai:delta:unsubscribe | main/application/proposal-generate |
| ai:delta | main/application/proposal-generate |
| ai:status:subscribe | main/application/proposal-generate |
| ai:status:unsubscribe | main/application/proposal-generate |
| ai:status | main/application/proposal-generate |
| external-agent:get-state | main/application/proposal-generate |
| external-agent:set-enabled | main/application/proposal-generate |
| external-agent:edit | main/application/proposal-generate |
| external-agent:select | main/application/proposal-generate |
| external-agent:approve | main/application/proposal-apply |
| external-agent:reject | main/application/proposal-generate |
| external-agent:state:subscribe | main/application/proposal-generate |
| external-agent:state:unsubscribe | main/application/proposal-generate |
| external-agent:state | main/application/proposal-generate |
| obsidian:validate-vault | main/application/obsidian-integration |
| obsidian:list-vaults | main/application/obsidian-integration |
| obsidian:list-vault-mappings | main/application/obsidian-integration |
| obsidian:save-vault-mapping | main/application/obsidian-integration |
| obsidian:resolve-path | main/application/obsidian-integration |
| obsidian:note-exists | main/application/obsidian-integration |
| obsidian:open-note | main/application/obsidian-integration |

## 変更案の操作

識別子は`src/shared/ai/proposal.ts`の`proposalOperationSchema`から抽出しています。操作契約の最終ownerは`main/domain`、適用handlerと実行のownerは`main/application/proposal-apply`です。IPC DTOは`shared/ipc-contracts`が所有します。

| operation | 適用owner |
| --- | --- |
| clear_due | main/application/proposal-apply |
| clear_duration | main/application/proposal-apply |
| complete | main/application/proposal-apply |
| create_task | main/application/proposal-apply |
| link_obsidian | main/application/proposal-apply |
| set_area | main/application/proposal-apply |
| set_dependencies | main/application/proposal-apply |
| set_due | main/application/proposal-apply |
| set_duration | main/application/proposal-apply |
| set_importance | main/application/proposal-apply |
| set_parent | main/application/proposal-apply |
| set_parent_work_mode | main/application/proposal-apply |
| set_status | main/application/proposal-apply |
| unlink_obsidian | main/application/proposal-apply |
| update_notes | main/application/proposal-apply |
| update_title | main/application/proposal-apply |
| withdraw | main/application/proposal-apply |

## 保存形式

| 形式 | 保存先または対象 | 現行source | 利用上のowner候補 |
| --- | --- | --- | --- |
| SQLite | taskhub.sqlite3 | src/main/index.ts | main/infrastructure/persistence |
| 暗号化JSON | secret-storage.json | src/main/index.ts | main/infrastructure/persistence |
| 初回設定JSON | setup-checkpoint.json | src/main/index.ts | main/application/settings |
| ウィンドウJSON | window-state.json | src/main/index.ts | main/bootstrap |
| 更新試行JSON | application-update-attempt.json | src/main/application-update.ts | main/bootstrap |
| エラーJSONL | taskhub-error.log | src/main/persistent-error-log.ts | main/infrastructure/logging |
| 外部Codex設定JSON | external-agent/config.json | src/main/external-agent/resources.ts | main/application/settings |
| 外部Codex接続JSON | external-agent/connection.json | src/main/external-agent/resources.ts | main/infrastructure/ai |
| taskctl接続JSON | taskctl-connection.json | src/main/codex/taskctl/broker.ts | main/infrastructure/ai |
| contextctl接続JSON | contextctl-connection.json | src/main/external-tools/broker.ts | main/infrastructure/ai |
| Codex作業資源 | codex-workspace/ と codex-home/ | src/main/codex/workspace/schemas.ts | main/infrastructure/ai |
| Asana Custom external data | Asana task external data | src/shared/domain/external-data.ts | main/domain |

| 形式 | 現行version | 現行source | version symbol |
| --- | --- | --- | --- |
| SQLite | 5 | src/main/storage/database.ts | storageSchemaVersion |
| 初回設定JSON | 2 | src/main/application/checkpoint.ts | checkpointVersion |
| 暗号化JSON | 1 | src/main/auth/secret-storage/secret-storage.ts | encryptedFileVersion |
| ウィンドウJSON | 1 | src/main/window-state.ts | windowStateVersion |
| Asana Custom external data | 1 | src/shared/domain/external-data.ts | customExternalDataSchemaVersion |

SQLite接続とtransactionは`main/infrastructure/persistence`が所有し、SQLite schemaの現行versionは上記の値です。

| SQLite table | 利用上のowner候補 |
| --- | --- |
| application_journal | main/application/proposal-apply |
| cleanup_items_cache | main/application/task-read |
| device_settings | main/application/settings |
| diagnostic_log | main/infrastructure/logging |
| external_tool_definitions | main/application/settings |
| project_metadata_cache | main/application/task-read |
| ranking_cache | main/application/task-read |
| sync_state | main/application/task-read |
| task_cache | main/application/task-read |
| vault_mappings | main/application/obsidian-integration |
