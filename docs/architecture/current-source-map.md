# ソース対応表

一覧は現在の作業ツリーにある`src`以下の手編集source 486件から生成しています。各行のownerはsourceの配置に対応します。生成: `node scripts/generate-current-source-map.mjs --write`。

## 機能と入口

| 機能 | owner | source |
| --- | --- | --- |
| アプリ起動・更新・ウィンドウ | main/bootstrap | src/main/index.ts, src/main/bootstrap/create-main-runtime.ts, src/main/bootstrap/register-main-lifecycle.ts, src/main/bootstrap/main-window-runtime.ts, src/main/bootstrap/window-state-controller.ts, src/main/bootstrap/operational-event-runtime.ts, src/main/bootstrap/application-update-service.ts |
| Main workflowの生成と結線 | main/bootstrap | src/main/bootstrap/main-workflow-construction.ts, src/main/bootstrap/main-workflow-composition.ts |
| 初回設定とAsana認証 | main/application/settings | src/main/application/settings/, src/main/infrastructure/asana/oauth/, src/main/infrastructure/asana/setup/ |
| タスク取得・同期・順位 | main/application/task-read | src/main/application/task-read/, src/main/infrastructure/asana/task-read-adapter.ts, src/main/infrastructure/persistence/task-read-repository.ts, src/main/infrastructure/asana/sync/, src/main/domain/ranking/ |
| タスク直接編集 | main/application/gui-edit | src/main/application/gui-edit/, src/main/infrastructure/asana/client/task-write-client.ts |
| 変更案の生成・検証・編集 | main/application/proposal-generate | src/main/application/proposal-generate/ |
| 変更案の操作契約 | main/domain | src/main/domain/proposal.ts, src/main/domain/proposal-write-operation.ts |
| 変更案のhandler登録とstep計画 | main/application/common | src/main/application/common/task-write-operation-manifest.ts, src/main/application/common/task-write-plan.ts |
| 変更案の承認・適用・復旧 | main/application/proposal-apply | src/main/application/proposal-apply/, src/main/infrastructure/persistence/proposal-application-history-repository.ts |
| 共通stepの実行と復旧 | main/application/task-write | src/main/application/task-write/, src/main/infrastructure/persistence/proposal-execution-repository.ts |
| 外部Codex接続とツール | main/infrastructure/ai | src/main/infrastructure/ai/ |
| 外部提案の準備・生成 | main/application/proposal-generate | src/main/application/proposal-generate/external-agent-generation.ts |
| 外部提案の承認・適用 | main/application/proposal-apply | src/main/application/proposal-apply/external-agent-application.ts |
| Obsidian参照・Vault設定 | main/application/obsidian-integration | src/main/application/obsidian-integration/, src/main/infrastructure/obsidian/, src/main/domain/obsidian-contracts.ts, src/main/infrastructure/persistence/vault-mapping-repository.ts |
| 設定と秘密情報 | main/application/settings | src/main/application/settings/, src/main/application/common/ports/secret-storage.ts, src/main/infrastructure/persistence/settings-repository.ts, src/main/infrastructure/persistence/secret-storage.ts |
| IPC契約と配送 | shared/ipc-contracts と main/ipc と preload | src/shared/ipc-contracts/, src/main/ipc/, src/preload/ |
| タスク画面 | renderer/features/tasks | src/renderer/features/tasks/ |
| 変更案画面 | renderer/features/proposals | src/renderer/features/proposals/ |
| 設定画面 | renderer/features/settings | src/renderer/features/settings/ |
| ログ・診断 | main/infrastructure/logging | src/main/infrastructure/logging/, src/main/infrastructure/persistence/diagnostic-log-repository.ts |
| mock指定 | renderer/shared/mock | src/renderer/shared/mock/mock-selection.ts |

| 入口 | source | owner |
| --- | --- | --- |
| Electron起動入口 | src/main/index.ts | main/bootstrap |
| MainRuntime生成 | src/main/bootstrap/create-main-runtime.ts | main/bootstrap |
| Electron起動と終了 | src/main/bootstrap/register-main-lifecycle.ts | main/bootstrap |
| ウィンドウの生成と保存 | src/main/bootstrap/main-window-runtime.ts | main/bootstrap |
| 運用イベント監視 | src/main/bootstrap/operational-event-runtime.ts | main/bootstrap |
| アプリ本体の更新 | src/main/bootstrap/application-update-service.ts | main/bootstrap |
| Main workflow生成 | src/main/bootstrap/main-workflow-construction.ts | main/bootstrap |
| Main workflow結線 | src/main/bootstrap/main-workflow-composition.ts | main/bootstrap |
| IPC登録 | src/main/ipc/register-ipc.ts | main/ipc |
| preload bridge | src/preload/index.ts | preload |
| Renderer起動 | src/renderer/app/main.ts | renderer/app |
| Renderer画面 | src/renderer/app/App.vue | renderer/app |
| 変更案生成の状態 | src/main/application/proposal-generate/workflow-state.ts | main/application/proposal-generate |
| 変更案生成のCodex接続 | src/main/application/proposal-generate/workflow-service.ts | main/application/proposal-generate |
| 変更案適用と復旧 | src/main/application/proposal-apply/apply-stored-proposal.ts | main/application/proposal-apply |
| GUI編集 | src/main/application/gui-edit/apply.ts | main/application/gui-edit |
| Asana同期 | src/main/infrastructure/asana/sync/coordinator.ts | main/infrastructure/asana |
| タスク読取と同期 | src/main/application/task-read/workflow.ts | main/application/task-read |
| タスク読取の保存 | src/main/infrastructure/persistence/task-read-repository.ts | main/infrastructure/persistence |
| Obsidian連携 | src/main/application/obsidian-integration/workflow.ts | main/application/obsidian-integration |
| Vault読取 | src/main/infrastructure/obsidian/read-service.ts | main/infrastructure/obsidian |
| SQLite schema | src/main/infrastructure/persistence/sqlite-schema.ts | main/infrastructure/persistence |
| 変更案実行journalのSQLite schema | src/main/infrastructure/persistence/proposal-execution-schema.ts | main/infrastructure/persistence |
| 機能別API選択 | src/renderer/app/feature-api-registry.ts | renderer/app |

## 全sourceのowner

| source | owner |
| --- | --- |
| src/main/application/common/abort-signal.ts | main/application/common |
| src/main/application/common/diagnostic-log-service.ts | main/application/common |
| src/main/application/common/errors/diagnostic-failure.ts | main/application/common |
| src/main/application/common/errors/error-reporter.ts | main/application/common |
| src/main/application/common/errors/external-agent-service-error.ts | main/application/common |
| src/main/application/common/gui-task-write-result.ts | main/application/common |
| src/main/application/common/ports/ai-workflow-retry.ts | main/application/common |
| src/main/application/common/ports/asana-operation-queue.ts | main/application/common |
| src/main/application/common/ports/asana-task-read.ts | main/application/common |
| src/main/application/common/ports/asana-task-write.ts | main/application/common |
| src/main/application/common/ports/external-agent-proposal.ts | main/application/common |
| src/main/application/common/ports/obsidian-vault-repository.ts | main/application/common |
| src/main/application/common/ports/proposal-application-history.ts | main/application/common |
| src/main/application/common/ports/proposal-execution-context.ts | main/application/common |
| src/main/application/common/ports/proposal-execution-repository.ts | main/application/common |
| src/main/application/common/ports/proposal-generation-session.ts | main/application/common |
| src/main/application/common/ports/proposal-workspace.ts | main/application/common |
| src/main/application/common/ports/secret-storage.ts | main/application/common |
| src/main/application/common/ports/settings-repository.ts | main/application/common |
| src/main/application/common/ports/snapshot-hasher.ts | main/application/common |
| src/main/application/common/ports/task-read-repository.ts | main/application/common |
| src/main/application/common/ports/task-write-executor.ts | main/application/common |
| src/main/application/common/ports/task-write-read-back.ts | main/application/common |
| src/main/application/common/prepare-task-write-retry.ts | main/application/common |
| src/main/application/common/proposal-application-schemas.ts | main/application/common |
| src/main/application/common/runtime-clock.ts | main/application/common |
| src/main/application/common/task-write-operation-baseline.ts | main/application/common |
| src/main/application/common/task-write-operation-manifest.ts | main/application/common |
| src/main/application/common/task-write-plan.ts | main/application/common |
| src/main/application/common/task-write-step.ts | main/application/common |
| src/main/application/common/task-write-synchronization-error.ts | main/application/common |
| src/main/application/gui-edit/apply.ts | main/application/gui-edit |
| src/main/application/gui-edit/build-proposal-operation.ts | main/application/gui-edit |
| src/main/application/gui-edit/execution-workflow.ts | main/application/gui-edit |
| src/main/application/gui-edit/external-baseline.ts | main/application/gui-edit |
| src/main/application/gui-edit/index.ts | main/application/gui-edit |
| src/main/application/gui-edit/normalize-due-operation.ts | main/application/gui-edit |
| src/main/application/gui-edit/relation-graph-validation.ts | main/application/gui-edit |
| src/main/application/gui-edit/request-workflow.ts | main/application/gui-edit |
| src/main/application/gui-edit/status-repair.ts | main/application/gui-edit |
| src/main/application/gui-edit/write-plan.ts | main/application/gui-edit |
| src/main/application/obsidian-integration/index.ts | main/application/obsidian-integration |
| src/main/application/obsidian-integration/workflow.ts | main/application/obsidian-integration |
| src/main/application/proposal-apply/application-result.ts | main/application/proposal-apply |
| src/main/application/proposal-apply/apply-stored-proposal.ts | main/application/proposal-apply |
| src/main/application/proposal-apply/approval-execution.ts | main/application/proposal-apply |
| src/main/application/proposal-apply/approval-input-workflow.ts | main/application/proposal-apply |
| src/main/application/proposal-apply/approval-preparation.ts | main/application/proposal-apply |
| src/main/application/proposal-apply/approval-summary.ts | main/application/proposal-apply |
| src/main/application/proposal-apply/approval-task-read.ts | main/application/proposal-apply |
| src/main/application/proposal-apply/execute-stored-application.ts | main/application/proposal-apply |
| src/main/application/proposal-apply/execution-request-workflow.ts | main/application/proposal-apply |
| src/main/application/proposal-apply/execution-workflow.ts | main/application/proposal-apply |
| src/main/application/proposal-apply/external-agent-application-options.ts | main/application/proposal-apply |
| src/main/application/proposal-apply/external-agent-application.ts | main/application/proposal-apply |
| src/main/application/proposal-apply/external-agent-expiration.ts | main/application/proposal-apply |
| src/main/application/proposal-apply/external-agent-gui-edit.ts | main/application/proposal-apply |
| src/main/application/proposal-apply/external-agent-proposal-record.ts | main/application/proposal-apply |
| src/main/application/proposal-apply/external-agent-proposal-status.ts | main/application/proposal-apply |
| src/main/application/proposal-apply/external-agent-response.ts | main/application/proposal-apply |
| src/main/application/proposal-apply/external-agent-review.ts | main/application/proposal-apply |
| src/main/application/proposal-apply/external-agent-state.ts | main/application/proposal-apply |
| src/main/application/proposal-apply/history-workflow.ts | main/application/proposal-apply |
| src/main/application/proposal-apply/index.ts | main/application/proposal-apply |
| src/main/application/proposal-apply/latest-proposal-execution.ts | main/application/proposal-apply |
| src/main/application/proposal-apply/operation-order.ts | main/application/proposal-apply |
| src/main/application/proposal-apply/operation-result.ts | main/application/proposal-apply |
| src/main/application/proposal-apply/proposal-write-plan.ts | main/application/proposal-apply |
| src/main/application/proposal-apply/recover-stored-proposals.ts | main/application/proposal-apply |
| src/main/application/proposal-apply/recovery-references.ts | main/application/proposal-apply |
| src/main/application/proposal-apply/stored-proposal-result.ts | main/application/proposal-apply |
| src/main/application/proposal-generate/attempt-resources.ts | main/application/proposal-generate |
| src/main/application/proposal-generate/baseline-snapshot.ts | main/application/proposal-generate |
| src/main/application/proposal-generate/evidence-binding.ts | main/application/proposal-generate |
| src/main/application/proposal-generate/evidence-inheritance.ts | main/application/proposal-generate |
| src/main/application/proposal-generate/evidence-sources.ts | main/application/proposal-generate |
| src/main/application/proposal-generate/external-agent-context.ts | main/application/proposal-generate |
| src/main/application/proposal-generate/external-agent-contract.ts | main/application/proposal-generate |
| src/main/application/proposal-generate/external-agent-evidence.ts | main/application/proposal-generate |
| src/main/application/proposal-generate/external-agent-generation-guards.ts | main/application/proposal-generate |
| src/main/application/proposal-generate/external-agent-generation-options.ts | main/application/proposal-generate |
| src/main/application/proposal-generate/external-agent-generation.ts | main/application/proposal-generate |
| src/main/application/proposal-generate/external-agent-lifecycle.ts | main/application/proposal-generate |
| src/main/application/proposal-generate/external-agent-preparation.ts | main/application/proposal-generate |
| src/main/application/proposal-generate/external-agent-prepared-context.ts | main/application/proposal-generate |
| src/main/application/proposal-generate/external-agent-request.ts | main/application/proposal-generate |
| src/main/application/proposal-generate/external-agent-response.ts | main/application/proposal-generate |
| src/main/application/proposal-generate/external-agent-submission.ts | main/application/proposal-generate |
| src/main/application/proposal-generate/external-agent-task-query.ts | main/application/proposal-generate |
| src/main/application/proposal-generate/external-agent-validation-response.ts | main/application/proposal-generate |
| src/main/application/proposal-generate/external-agent-validation.ts | main/application/proposal-generate |
| src/main/application/proposal-generate/impact-ranking.ts | main/application/proposal-generate |
| src/main/application/proposal-generate/index.ts | main/application/proposal-generate |
| src/main/application/proposal-generate/proposal-baseline-workflow.ts | main/application/proposal-generate |
| src/main/application/proposal-generate/proposal-edit.ts | main/application/proposal-generate |
| src/main/application/proposal-generate/proposal-evidence.ts | main/application/proposal-generate |
| src/main/application/proposal-generate/proposal-store.ts | main/application/proposal-generate |
| src/main/application/proposal-generate/proposal-view.ts | main/application/proposal-generate |
| src/main/application/proposal-generate/proposal-workspace.ts | main/application/proposal-generate |
| src/main/application/proposal-generate/rebind-before.ts | main/application/proposal-generate |
| src/main/application/proposal-generate/retry-diagnostics.ts | main/application/proposal-generate |
| src/main/application/proposal-generate/retry-error-projection.ts | main/application/proposal-generate |
| src/main/application/proposal-generate/stored-proposal.ts | main/application/proposal-generate |
| src/main/application/proposal-generate/task-projection.ts | main/application/proposal-generate |
| src/main/application/proposal-generate/turn-attempt.ts | main/application/proposal-generate |
| src/main/application/proposal-generate/turn-commit.ts | main/application/proposal-generate |
| src/main/application/proposal-generate/turn-preparation.ts | main/application/proposal-generate |
| src/main/application/proposal-generate/turn-prompt.ts | main/application/proposal-generate |
| src/main/application/proposal-generate/turn-response.ts | main/application/proposal-generate |
| src/main/application/proposal-generate/turn-retry.ts | main/application/proposal-generate |
| src/main/application/proposal-generate/workflow-errors.ts | main/application/proposal-generate |
| src/main/application/proposal-generate/workflow-options.ts | main/application/proposal-generate |
| src/main/application/proposal-generate/workflow-selection.ts | main/application/proposal-generate |
| src/main/application/proposal-generate/workflow-service.ts | main/application/proposal-generate |
| src/main/application/proposal-generate/workflow-state.ts | main/application/proposal-generate |
| src/main/application/proposal-generate/workspace-validation.ts | main/application/proposal-generate |
| src/main/application/settings/asana-reauthentication.ts | main/application/settings |
| src/main/application/settings/codex-health.ts | main/application/settings |
| src/main/application/settings/index.ts | main/application/settings |
| src/main/application/settings/restore-setup-at-startup.ts | main/application/settings |
| src/main/application/settings/setup-asana-authorization.ts | main/application/settings |
| src/main/application/settings/setup-asana-resources.ts | main/application/settings |
| src/main/application/settings/setup-capability.ts | main/application/settings |
| src/main/application/settings/setup-codex-state.ts | main/application/settings |
| src/main/application/settings/setup-completion.ts | main/application/settings |
| src/main/application/settings/setup-ipc-workflow.ts | main/application/settings |
| src/main/application/settings/setup-ports.ts | main/application/settings |
| src/main/application/settings/setup-state-tools.ts | main/application/settings |
| src/main/application/settings/setup-validation.ts | main/application/settings |
| src/main/application/settings/setup-workflow.ts | main/application/settings |
| src/main/application/settings/state.ts | main/application/settings |
| src/main/application/system/index.ts | main/application/system |
| src/main/application/task-read/cleanup-aggregation.ts | main/application/task-read |
| src/main/application/task-read/display-order-input.ts | main/application/task-read |
| src/main/application/task-read/index.ts | main/application/task-read |
| src/main/application/task-read/local-state-refresh-workflow.ts | main/application/task-read |
| src/main/application/task-read/selected-snapshot.ts | main/application/task-read |
| src/main/application/task-read/sync-state-runtime.ts | main/application/task-read |
| src/main/application/task-read/task-read-index.ts | main/application/task-read |
| src/main/application/task-read/workflow.ts | main/application/task-read |
| src/main/application/task-write/index.ts | main/application/task-write |
| src/main/application/task-write/proposal-execution-engine.ts | main/application/task-write |
| src/main/application/task-write/proposal-execution-result.ts | main/application/task-write |
| src/main/application/task-write/proposal-execution-state.ts | main/application/task-write |
| src/main/application/task-write/readiness-workflow.ts | main/application/task-write |
| src/main/application/task-write/task-write-execution-result.ts | main/application/task-write |
| src/main/bootstrap/ai-event-runtime.ts | main/bootstrap |
| src/main/bootstrap/ai-interaction-runtime.ts | main/bootstrap |
| src/main/bootstrap/ai-session-runtime.ts | main/bootstrap |
| src/main/bootstrap/application-update-service.ts | main/bootstrap |
| src/main/bootstrap/codex-runtime-utilities.ts | main/bootstrap |
| src/main/bootstrap/codex-session-resources.ts | main/bootstrap |
| src/main/bootstrap/configured-codex-runtime.ts | main/bootstrap |
| src/main/bootstrap/create-ai-workflow.ts | main/bootstrap |
| src/main/bootstrap/create-external-agent-runtime.ts | main/bootstrap |
| src/main/bootstrap/create-main-runtime.ts | main/bootstrap |
| src/main/bootstrap/create-obsidian-runtime.ts | main/bootstrap |
| src/main/bootstrap/create-settings-composition-dependencies.ts | main/bootstrap |
| src/main/bootstrap/create-settings-runtime.ts | main/bootstrap |
| src/main/bootstrap/create-synchronization-composition-dependencies.ts | main/bootstrap |
| src/main/bootstrap/create-synchronization-runtime.ts | main/bootstrap |
| src/main/bootstrap/create-task-read-composition-dependencies.ts | main/bootstrap |
| src/main/bootstrap/create-task-read-runtime.ts | main/bootstrap |
| src/main/bootstrap/create-task-write-runtime.ts | main/bootstrap |
| src/main/bootstrap/journal-recovery-runtime.ts | main/bootstrap |
| src/main/bootstrap/main-runtime-options.ts | main/bootstrap |
| src/main/bootstrap/main-shutdown-runtime.ts | main/bootstrap |
| src/main/bootstrap/main-startup-runtime.ts | main/bootstrap |
| src/main/bootstrap/main-window-readiness.ts | main/bootstrap |
| src/main/bootstrap/main-window-runtime.ts | main/bootstrap |
| src/main/bootstrap/main-workflow-composition.ts | main/bootstrap |
| src/main/bootstrap/main-workflow-construction.ts | main/bootstrap |
| src/main/bootstrap/open-external-resource.ts | main/bootstrap |
| src/main/bootstrap/operational-context-runtime.ts | main/bootstrap |
| src/main/bootstrap/operational-event-runtime.ts | main/bootstrap |
| src/main/bootstrap/operational-services-runtime.ts | main/bootstrap |
| src/main/bootstrap/post-write-synchronization.ts | main/bootstrap |
| src/main/bootstrap/register-main-lifecycle.ts | main/bootstrap |
| src/main/bootstrap/renderer-environment.ts | main/bootstrap |
| src/main/bootstrap/security.ts | main/bootstrap |
| src/main/bootstrap/setup-contracts.ts | main/bootstrap |
| src/main/bootstrap/startup-gate.ts | main/bootstrap |
| src/main/bootstrap/synchronization-operations.ts | main/bootstrap |
| src/main/bootstrap/task-read-storage-contracts.ts | main/bootstrap |
| src/main/bootstrap/window-shortcuts.ts | main/bootstrap |
| src/main/bootstrap/window-state-controller.ts | main/bootstrap |
| src/main/domain/ai-workflow-schemas.ts | main/domain |
| src/main/domain/canonical-json.ts | main/domain |
| src/main/domain/external-data-ingestion.ts | main/domain |
| src/main/domain/external-data-merge.ts | main/domain |
| src/main/domain/external-data.ts | main/domain |
| src/main/domain/index.ts | main/domain |
| src/main/domain/normalization/graph.ts | main/domain |
| src/main/domain/normalization/index.ts | main/domain |
| src/main/domain/normalization/status.ts | main/domain |
| src/main/domain/normalization/tags.ts | main/domain |
| src/main/domain/obsidian-contracts.ts | main/domain |
| src/main/domain/obsidian-errors.ts | main/domain |
| src/main/domain/obsidian-uri.ts | main/domain |
| src/main/domain/primitives.ts | main/domain |
| src/main/domain/proposal-analysis/approval-comparison.ts | main/domain |
| src/main/domain/proposal-analysis/approval-conflict-schemas.ts | main/domain |
| src/main/domain/proposal-analysis/approval-results.ts | main/domain |
| src/main/domain/proposal-analysis/basic-validation-schemas.ts | main/domain |
| src/main/domain/proposal-analysis/basic-value-comparison.ts | main/domain |
| src/main/domain/proposal-analysis/basic.ts | main/domain |
| src/main/domain/proposal-analysis/conflict-classifier.ts | main/domain |
| src/main/domain/proposal-analysis/graph-validation-schemas.ts | main/domain |
| src/main/domain/proposal-analysis/graph.ts | main/domain |
| src/main/domain/proposal-analysis/proposal-projection.ts | main/domain |
| src/main/domain/proposal-analysis/task-projection.ts | main/domain |
| src/main/domain/proposal-analysis/utf8.ts | main/domain |
| src/main/domain/proposal-workspace.ts | main/domain |
| src/main/domain/proposal-write-operation.ts | main/domain |
| src/main/domain/proposal.ts | main/domain |
| src/main/domain/ranking/calculator.ts | main/domain |
| src/main/domain/ranking/index.ts | main/domain |
| src/main/domain/schemas.ts | main/domain |
| src/main/domain/setup-state.ts | main/domain |
| src/main/domain/snapshot-hash-input.ts | main/domain |
| src/main/domain/snapshot-normalization/index.ts | main/domain |
| src/main/domain/snapshot-normalization/normalizer.ts | main/domain |
| src/main/domain/snapshot-normalization/schemas.ts | main/domain |
| src/main/index.ts | main/bootstrap |
| src/main/infrastructure/ai/codex-app-server/common-schemas.ts | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-app-server/connection-overrides.ts | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-app-server/connection.ts | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-app-server/errors.ts | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-app-server/index.ts | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-app-server/rpc-endpoint.ts | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-app-server/rpc-schemas.ts | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-app-server/version.ts | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-diagnostic-detail.ts | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-obsidian/index.ts | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-obsidian/schemas.ts | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-session/capability-policy.ts | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-session/connection-configuration.ts | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-session/connection-inspector.ts | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-session/connection-recovery.ts | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-session/connection-start.ts | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-session/disable-ai.ts | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-session/dynamic-tools.ts | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-session/errors.ts | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-session/index.ts | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-session/notification-methods.ts | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-session/notification-router.ts | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-session/proposal-workspace-tool.ts | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-session/schemas.ts | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-session/session.ts | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-session/start-result.ts | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-session/startup.ts | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-session/thread-start.ts | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-session/tool-response.ts | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-session/turn-coordinator.ts | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-session/turn-output.ts | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-setup-adapter.ts | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-workspace/errors.ts | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-workspace/index.ts | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-workspace/initializer.ts | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-workspace/schemas.ts | main/infrastructure/ai |
| src/main/infrastructure/ai/external-agent/client-script.ts | main/infrastructure/ai |
| src/main/infrastructure/ai/external-agent/index.ts | main/infrastructure/ai |
| src/main/infrastructure/ai/external-agent/protocol-schemas.ts | main/infrastructure/ai |
| src/main/infrastructure/ai/external-agent/resources.ts | main/infrastructure/ai |
| src/main/infrastructure/ai/external-agent/transport-schemas.ts | main/infrastructure/ai |
| src/main/infrastructure/ai/external-agent/transport.ts | main/infrastructure/ai |
| src/main/infrastructure/ai/index.ts | main/infrastructure/ai |
| src/main/infrastructure/ai/snapshot-hasher.ts | main/infrastructure/ai |
| src/main/infrastructure/ai/taskctl/broker.ts | main/infrastructure/ai |
| src/main/infrastructure/ai/taskctl/client-script.ts | main/infrastructure/ai |
| src/main/infrastructure/ai/taskctl/errors.ts | main/infrastructure/ai |
| src/main/infrastructure/ai/taskctl/index.ts | main/infrastructure/ai |
| src/main/infrastructure/ai/taskctl/local-ipc-files.ts | main/infrastructure/ai |
| src/main/infrastructure/ai/taskctl/protocol-schemas.ts | main/infrastructure/ai |
| src/main/infrastructure/ai/taskctl/query.ts | main/infrastructure/ai |
| src/main/infrastructure/ai/taskctl/schemas.ts | main/infrastructure/ai |
| src/main/infrastructure/asana/client/client.ts | main/infrastructure/asana |
| src/main/infrastructure/asana/client/index.ts | main/infrastructure/asana |
| src/main/infrastructure/asana/client/setup-client.ts | main/infrastructure/asana |
| src/main/infrastructure/asana/client/task-write-client.ts | main/infrastructure/asana |
| src/main/infrastructure/asana/communication-runtime.ts | main/infrastructure/asana |
| src/main/infrastructure/asana/create-read-back.ts | main/infrastructure/asana |
| src/main/infrastructure/asana/display-order/index.ts | main/infrastructure/asana |
| src/main/infrastructure/asana/display-order/schemas.ts | main/infrastructure/asana |
| src/main/infrastructure/asana/display-order/service.ts | main/infrastructure/asana |
| src/main/infrastructure/asana/index.ts | main/infrastructure/asana |
| src/main/infrastructure/asana/normalization-plan.ts | main/infrastructure/asana |
| src/main/infrastructure/asana/oauth/asana-oauth.ts | main/infrastructure/asana |
| src/main/infrastructure/asana/oauth/coordinator.ts | main/infrastructure/asana |
| src/main/infrastructure/asana/oauth/errors.ts | main/infrastructure/asana |
| src/main/infrastructure/asana/oauth/index.ts | main/infrastructure/asana |
| src/main/infrastructure/asana/oauth/schemas.ts | main/infrastructure/asana |
| src/main/infrastructure/asana/operation-queue.ts | main/infrastructure/asana |
| src/main/infrastructure/asana/request-aborted-error.ts | main/infrastructure/asana |
| src/main/infrastructure/asana/response-body.ts | main/infrastructure/asana |
| src/main/infrastructure/asana/runtime/errors.ts | main/infrastructure/asana |
| src/main/infrastructure/asana/runtime/index.ts | main/infrastructure/asana |
| src/main/infrastructure/asana/runtime/schemas.ts | main/infrastructure/asana |
| src/main/infrastructure/asana/runtime/service.ts | main/infrastructure/asana |
| src/main/infrastructure/asana/scheduler/index.ts | main/infrastructure/asana |
| src/main/infrastructure/asana/scheduler/scheduler.ts | main/infrastructure/asana |
| src/main/infrastructure/asana/setup/capability-check.ts | main/infrastructure/asana |
| src/main/infrastructure/asana/setup/index.ts | main/infrastructure/asana |
| src/main/infrastructure/asana/setup/manifest.ts | main/infrastructure/asana |
| src/main/infrastructure/asana/setup/resource-coordinator.ts | main/infrastructure/asana |
| src/main/infrastructure/asana/sync-normalization.ts | main/infrastructure/asana |
| src/main/infrastructure/asana/sync-run-reservation.ts | main/infrastructure/asana |
| src/main/infrastructure/asana/sync-snapshot.ts | main/infrastructure/asana |
| src/main/infrastructure/asana/sync-token.ts | main/infrastructure/asana |
| src/main/infrastructure/asana/sync/coordinator.ts | main/infrastructure/asana |
| src/main/infrastructure/asana/sync/delta-sync-source.ts | main/infrastructure/asana |
| src/main/infrastructure/asana/sync/full-sync-source.ts | main/infrastructure/asana |
| src/main/infrastructure/asana/sync/index.ts | main/infrastructure/asana |
| src/main/infrastructure/asana/sync/normalization-plan-applier.ts | main/infrastructure/asana |
| src/main/infrastructure/asana/synchronization-run.ts | main/infrastructure/asana |
| src/main/infrastructure/asana/task-read-adapter.ts | main/infrastructure/asana |
| src/main/infrastructure/asana/task-write-asana-response.ts | main/infrastructure/asana |
| src/main/infrastructure/asana/task-write-call-adapter.ts | main/infrastructure/asana |
| src/main/infrastructure/asana/task-write-call-external.ts | main/infrastructure/asana |
| src/main/infrastructure/asana/task-write-call-schema.ts | main/infrastructure/asana |
| src/main/infrastructure/asana/task-write-read-back-adapter.ts | main/infrastructure/asana |
| src/main/infrastructure/asana/task-write-reconciliation.ts | main/infrastructure/asana |
| src/main/infrastructure/asana/token-provider.ts | main/infrastructure/asana |
| src/main/infrastructure/asana/transport/errors.ts | main/infrastructure/asana |
| src/main/infrastructure/asana/transport/index.ts | main/infrastructure/asana |
| src/main/infrastructure/asana/transport/transport.ts | main/infrastructure/asana |
| src/main/infrastructure/asana/transport/types.ts | main/infrastructure/asana |
| src/main/infrastructure/logging/error-detail-base.ts | main/infrastructure/logging |
| src/main/infrastructure/logging/index.ts | main/infrastructure/logging |
| src/main/infrastructure/logging/jsonl-error-reporter.ts | main/infrastructure/logging |
| src/main/infrastructure/logging/known-secrets.ts | main/infrastructure/logging |
| src/main/infrastructure/logging/persistent-error-log.ts | main/infrastructure/logging |
| src/main/infrastructure/logging/redact-known-secrets.ts | main/infrastructure/logging |
| src/main/infrastructure/logging/redact-sensitive-text.ts | main/infrastructure/logging |
| src/main/infrastructure/logging/safe-zod-issues.ts | main/infrastructure/logging |
| src/main/infrastructure/logging/stderr-error-report.ts | main/infrastructure/logging |
| src/main/infrastructure/obsidian/index.ts | main/infrastructure/obsidian |
| src/main/infrastructure/obsidian/markdown-reader.ts | main/infrastructure/obsidian |
| src/main/infrastructure/obsidian/read-error.ts | main/infrastructure/obsidian |
| src/main/infrastructure/obsidian/read-service.ts | main/infrastructure/obsidian |
| src/main/infrastructure/obsidian/secure-note-reader.ts | main/infrastructure/obsidian |
| src/main/infrastructure/obsidian/tasks-vault-discovery.ts | main/infrastructure/obsidian |
| src/main/infrastructure/obsidian/vault-path-security.ts | main/infrastructure/obsidian |
| src/main/infrastructure/persistence/application-update-attempt-store.ts | main/infrastructure/persistence |
| src/main/infrastructure/persistence/diagnostic-log-repository.ts | main/infrastructure/persistence |
| src/main/infrastructure/persistence/index.ts | main/infrastructure/persistence |
| src/main/infrastructure/persistence/persistence-runtime.ts | main/infrastructure/persistence |
| src/main/infrastructure/persistence/persistent-text-file.ts | main/infrastructure/persistence |
| src/main/infrastructure/persistence/proposal-application-history-record.ts | main/infrastructure/persistence |
| src/main/infrastructure/persistence/proposal-application-history-repository.ts | main/infrastructure/persistence |
| src/main/infrastructure/persistence/proposal-execution-record.ts | main/infrastructure/persistence |
| src/main/infrastructure/persistence/proposal-execution-repository.ts | main/infrastructure/persistence |
| src/main/infrastructure/persistence/proposal-execution-schema.ts | main/infrastructure/persistence |
| src/main/infrastructure/persistence/ranking-cache-schema.ts | main/infrastructure/persistence |
| src/main/infrastructure/persistence/secret-storage-errors.ts | main/infrastructure/persistence |
| src/main/infrastructure/persistence/secret-storage-schemas.ts | main/infrastructure/persistence |
| src/main/infrastructure/persistence/secret-storage.ts | main/infrastructure/persistence |
| src/main/infrastructure/persistence/secure-file-snapshot.ts | main/infrastructure/persistence |
| src/main/infrastructure/persistence/secure-path-guard.ts | main/infrastructure/persistence |
| src/main/infrastructure/persistence/settings-repository.ts | main/infrastructure/persistence |
| src/main/infrastructure/persistence/setup-checkpoint-store.ts | main/infrastructure/persistence |
| src/main/infrastructure/persistence/setup-checkpoint-v2-schema.ts | main/infrastructure/persistence |
| src/main/infrastructure/persistence/sqlite-connection.ts | main/infrastructure/persistence |
| src/main/infrastructure/persistence/sqlite-migration-backup.ts | main/infrastructure/persistence |
| src/main/infrastructure/persistence/sqlite-migration.ts | main/infrastructure/persistence |
| src/main/infrastructure/persistence/sqlite-schema.ts | main/infrastructure/persistence |
| src/main/infrastructure/persistence/storage-json.ts | main/infrastructure/persistence |
| src/main/infrastructure/persistence/storage-schemas.ts | main/infrastructure/persistence |
| src/main/infrastructure/persistence/sync-state-schema.ts | main/infrastructure/persistence |
| src/main/infrastructure/persistence/task-read-cache-contracts.ts | main/infrastructure/persistence |
| src/main/infrastructure/persistence/task-read-cache-schemas.ts | main/infrastructure/persistence |
| src/main/infrastructure/persistence/task-read-repository.ts | main/infrastructure/persistence |
| src/main/infrastructure/persistence/vault-mapping-repository.ts | main/infrastructure/persistence |
| src/main/infrastructure/persistence/window-state-store.ts | main/infrastructure/persistence |
| src/main/ipc/handlers/contract-handler.ts | main/ipc |
| src/main/ipc/handlers/diagnostics.ts | main/ipc |
| src/main/ipc/handlers/execution-dto.ts | main/ipc |
| src/main/ipc/handlers/obsidian-integration.ts | main/ipc |
| src/main/ipc/handlers/proposal-dto.ts | main/ipc |
| src/main/ipc/handlers/proposals.ts | main/ipc |
| src/main/ipc/handlers/settings.ts | main/ipc |
| src/main/ipc/handlers/system.ts | main/ipc |
| src/main/ipc/handlers/tasks.ts | main/ipc |
| src/main/ipc/register-ipc.ts | main/ipc |
| src/preload/index.ts | preload |
| src/renderer/app/App.vue | renderer/app |
| src/renderer/app/AppHeader.vue | renderer/app |
| src/renderer/app/feature-api-registry.ts | renderer/app |
| src/renderer/app/install-error-boundary.ts | renderer/app |
| src/renderer/app/main.ts | renderer/app |
| src/renderer/app/styles.css | renderer/app |
| src/renderer/app/use-app-bootstrap.ts | renderer/app |
| src/renderer/app/use-app-composition.ts | renderer/app |
| src/renderer/app/use-app-screen.ts | renderer/app |
| src/renderer/app/use-app-startup.ts | renderer/app |
| src/renderer/app/use-system-theme.ts | renderer/app |
| src/renderer/env.d.ts | renderer/app |
| src/renderer/features/obsidian-integration/TaskObsidianLinks.vue | renderer/features/obsidian-integration |
| src/renderer/features/obsidian-integration/VaultSettings.vue | renderer/features/obsidian-integration |
| src/renderer/features/obsidian-integration/index.ts | renderer/features/obsidian-integration |
| src/renderer/features/obsidian-integration/mock-obsidian-integration-api.ts | renderer/features/obsidian-integration |
| src/renderer/features/obsidian-integration/use-obsidian-integration.ts | renderer/features/obsidian-integration |
| src/renderer/features/proposals/AiPanel.vue | renderer/features/proposals |
| src/renderer/features/proposals/AiSessionDialog.vue | renderer/features/proposals |
| src/renderer/features/proposals/ApprovalResultPanel.vue | renderer/features/proposals |
| src/renderer/features/proposals/CreateTaskFieldsEditor.vue | renderer/features/proposals |
| src/renderer/features/proposals/ExecutionResultPanel.vue | renderer/features/proposals |
| src/renderer/features/proposals/ExternalProposalPanel.vue | renderer/features/proposals |
| src/renderer/features/proposals/ProposalDependenciesEditor.vue | renderer/features/proposals |
| src/renderer/features/proposals/ProposalHeaderActions.vue | renderer/features/proposals |
| src/renderer/features/proposals/ProposalHeaderStatus.vue | renderer/features/proposals |
| src/renderer/features/proposals/ProposalHistoryPanel.vue | renderer/features/proposals |
| src/renderer/features/proposals/ProposalOperationEditor.vue | renderer/features/proposals |
| src/renderer/features/proposals/ProposalReviewPanel.vue | renderer/features/proposals |
| src/renderer/features/proposals/index.ts | renderer/features/proposals |
| src/renderer/features/proposals/mock-proposal-data.ts | renderer/features/proposals |
| src/renderer/features/proposals/mock-proposals-api.ts | renderer/features/proposals |
| src/renderer/features/proposals/proposal-editor-form.ts | renderer/features/proposals |
| src/renderer/features/proposals/proposal-evidence-presentation.ts | renderer/features/proposals |
| src/renderer/features/proposals/proposal-execution-labels.ts | renderer/features/proposals |
| src/renderer/features/proposals/proposal-presentation.ts | renderer/features/proposals |
| src/renderer/features/proposals/proposal-state.ts | renderer/features/proposals |
| src/renderer/features/proposals/use-proposal-history.ts | renderer/features/proposals |
| src/renderer/features/proposals/use-proposal-review-presentation.ts | renderer/features/proposals |
| src/renderer/features/proposals/use-proposal-workspace.ts | renderer/features/proposals |
| src/renderer/features/proposals/use-proposals.ts | renderer/features/proposals |
| src/renderer/features/settings/AsanaReauthenticationAction.vue | renderer/features/settings |
| src/renderer/features/settings/AsanaReauthenticationPanel.vue | renderer/features/settings |
| src/renderer/features/settings/SettingsDialog.vue | renderer/features/settings |
| src/renderer/features/settings/SettingsTrigger.vue | renderer/features/settings |
| src/renderer/features/settings/SetupWizard.vue | renderer/features/settings |
| src/renderer/features/settings/index.ts | renderer/features/settings |
| src/renderer/features/settings/mock-settings-api.ts | renderer/features/settings |
| src/renderer/features/settings/setup-action.ts | renderer/features/settings |
| src/renderer/features/settings/use-asana-reauthentication.ts | renderer/features/settings |
| src/renderer/features/settings/use-settings.ts | renderer/features/settings |
| src/renderer/features/settings/use-setup.ts | renderer/features/settings |
| src/renderer/features/system/SystemUpdateStatus.vue | renderer/features/system |
| src/renderer/features/system/index.ts | renderer/features/system |
| src/renderer/features/system/mock-system-api.ts | renderer/features/system |
| src/renderer/features/system/use-system-update.ts | renderer/features/system |
| src/renderer/features/tasks/TaskDetail.vue | renderer/features/tasks |
| src/renderer/features/tasks/TaskFilters.vue | renderer/features/tasks |
| src/renderer/features/tasks/TaskHeaderStatus.vue | renderer/features/tasks |
| src/renderer/features/tasks/TaskList.vue | renderer/features/tasks |
| src/renderer/features/tasks/TaskRankingDetails.vue | renderer/features/tasks |
| src/renderer/features/tasks/TaskRelations.vue | renderer/features/tasks |
| src/renderer/features/tasks/TaskSort.vue | renderer/features/tasks |
| src/renderer/features/tasks/TaskSyncControls.vue | renderer/features/tasks |
| src/renderer/features/tasks/TaskWriteStatus.vue | renderer/features/tasks |
| src/renderer/features/tasks/index.ts | renderer/features/tasks |
| src/renderer/features/tasks/mock-tasks-api.ts | renderer/features/tasks |
| src/renderer/features/tasks/task-detail-draft.ts | renderer/features/tasks |
| src/renderer/features/tasks/task-duration.ts | renderer/features/tasks |
| src/renderer/features/tasks/task-filter.ts | renderer/features/tasks |
| src/renderer/features/tasks/task-input.ts | renderer/features/tasks |
| src/renderer/features/tasks/task-presentation.ts | renderer/features/tasks |
| src/renderer/features/tasks/use-task-drafts.ts | renderer/features/tasks |
| src/renderer/features/tasks/use-task-edit.ts | renderer/features/tasks |
| src/renderer/features/tasks/use-task-read.ts | renderer/features/tasks |
| src/renderer/features/tasks/use-task-sync.ts | renderer/features/tasks |
| src/renderer/index.html | renderer/app |
| src/renderer/shared/api/feature-apis.ts | renderer/shared/api |
| src/renderer/shared/components/RekaSelect.vue | renderer/shared/components |
| src/renderer/shared/components/ToastHost.vue | renderer/shared/components |
| src/renderer/shared/components/useToast.ts | renderer/shared/components |
| src/renderer/shared/format/date-time.ts | renderer/shared/format |
| src/renderer/shared/logging/report-renderer-error.ts | renderer/shared/logging |
| src/renderer/shared/mock/diagnostics.ts | renderer/shared/mock |
| src/renderer/shared/mock/mock-selection.ts | renderer/shared/mock |
| src/shared/ipc-contracts/common.ts | shared/ipc-contracts |
| src/shared/ipc-contracts/diagnostics.ts | shared/ipc-contracts |
| src/shared/ipc-contracts/execution.ts | shared/ipc-contracts |
| src/shared/ipc-contracts/external-proposal-state.ts | shared/ipc-contracts |
| src/shared/ipc-contracts/index.ts | shared/ipc-contracts |
| src/shared/ipc-contracts/obsidian-integration.ts | shared/ipc-contracts |
| src/shared/ipc-contracts/proposal-values.ts | shared/ipc-contracts |
| src/shared/ipc-contracts/proposals-channels.ts | shared/ipc-contracts |
| src/shared/ipc-contracts/proposals.ts | shared/ipc-contracts |
| src/shared/ipc-contracts/settings.ts | shared/ipc-contracts |
| src/shared/ipc-contracts/setup-schemas.ts | shared/ipc-contracts |
| src/shared/ipc-contracts/system.ts | shared/ipc-contracts |
| src/shared/ipc-contracts/task-values.ts | shared/ipc-contracts |
| src/shared/ipc-contracts/task-view.ts | shared/ipc-contracts |
| src/shared/ipc-contracts/tasks.ts | shared/ipc-contracts |
| src/shared/ipc-contracts/vault-values.ts | shared/ipc-contracts |

外部エージェントの責務は次のsourceに配置しています。

| source | 責務 | owner |
| --- | --- | --- |
| src/main/application/proposal-generate/external-agent-generation.ts | CLI要求、文脈、提案基準、作業領域、提出要求 | main/application/proposal-generate |
| src/main/application/proposal-apply/external-agent-application.ts | 提出済み提案の確認、承認、適用、履歴照会、状態購読 | main/application/proposal-apply |
| src/main/infrastructure/ai/external-agent/transport.ts | 外部連携bridgeの通信 | main/infrastructure/ai |
| src/main/bootstrap/create-main-runtime.ts | 外部連携bridge adapterの生成 | main/bootstrap |
| src/main/bootstrap/main-workflow-construction.ts | 外部提案workflowとbridge factoryの接続 | main/bootstrap |
| src/main/bootstrap/main-workflow-composition.ts | Main workflowとportの結線 | main/bootstrap |

## 可変状態

TypeScriptのmodule直下にある`let`、`var`、instance生成、変更される`const`、Vue `script setup`直下の状態候補、classのinstance fieldを抽出しています。保存済みの状態とライフサイクルは [state-ownership.md](state-ownership.md) に記します。

| module source | symbol | owner |
| --- | --- | --- |

| Vue component | 状態 | owner |
| --- | --- | --- |
| src/renderer/features/obsidian-integration/VaultSettings.vue | vaultForm | renderer/features/obsidian-integration |
| src/renderer/features/obsidian-integration/VaultSettings.vue | vaultLocalError | renderer/features/obsidian-integration |
| src/renderer/features/proposals/AiPanel.vue | localError | renderer/features/proposals |
| src/renderer/features/proposals/AiPanel.vue | message | renderer/features/proposals |
| src/renderer/features/proposals/AiPanel.vue | messageInput | renderer/features/proposals |
| src/renderer/features/proposals/AiSessionDialog.vue | activeTab | renderer/features/proposals |
| src/renderer/features/proposals/AiSessionDialog.vue | closeButton | renderer/features/proposals |
| src/renderer/features/proposals/AiSessionDialog.vue | dialogElement | renderer/features/proposals |
| src/renderer/features/proposals/AiSessionDialog.vue | mobileDetailVisible | renderer/features/proposals |
| src/renderer/features/proposals/AiSessionDialog.vue | panelRefs | renderer/features/proposals |
| src/renderer/features/proposals/AiSessionDialog.vue | pendingExternalReviewRequestId | renderer/features/proposals |
| src/renderer/features/proposals/AiSessionDialog.vue | selectedHistoryExecutionId | renderer/features/proposals |
| src/renderer/features/proposals/ExternalProposalPanel.vue | selectedProposalId | renderer/features/proposals |
| src/renderer/features/proposals/ProposalHistoryPanel.vue | checked | renderer/features/proposals |
| src/renderer/features/proposals/ProposalHistoryPanel.vue | feedback | renderer/features/proposals |
| src/renderer/features/proposals/ProposalHistoryPanel.vue | results | renderer/features/proposals |
| src/renderer/features/proposals/ProposalHistoryPanel.vue | targetIds | renderer/features/proposals |
| src/renderer/features/proposals/ProposalOperationEditor.vue | form | renderer/features/proposals |
| src/renderer/features/proposals/ProposalOperationEditor.vue | nextDraftId | renderer/features/proposals |
| src/renderer/features/proposals/ProposalReviewPanel.vue | editingOperationId | renderer/features/proposals |
| src/renderer/features/proposals/ProposalReviewPanel.vue | localError | renderer/features/proposals |
| src/renderer/features/proposals/ProposalReviewPanel.vue | pendingEdit | renderer/features/proposals |
| src/renderer/features/proposals/ProposalReviewPanel.vue | selectedGroupIds | renderer/features/proposals |
| src/renderer/features/proposals/ProposalReviewPanel.vue | selectedOperationIds | renderer/features/proposals |
| src/renderer/features/proposals/ProposalReviewPanel.vue | selectionMode | renderer/features/proposals |
| src/renderer/features/settings/AsanaReauthenticationPanel.vue | codeInput | renderer/features/settings |
| src/renderer/features/settings/SetupWizard.vue | authorizationCodeInput | renderer/features/settings |
| src/renderer/features/settings/SetupWizard.vue | clientId | renderer/features/settings |
| src/renderer/features/settings/SetupWizard.vue | clientSecretInput | renderer/features/settings |
| src/renderer/features/settings/SetupWizard.vue | localError | renderer/features/settings |
| src/renderer/features/settings/SetupWizard.vue | projectName | renderer/features/settings |
| src/renderer/features/settings/SetupWizard.vue | vaultId | renderer/features/settings |
| src/renderer/features/settings/SetupWizard.vue | vaultPath | renderer/features/settings |
| src/renderer/features/tasks/TaskDetail.vue | activeTaskGid | renderer/features/tasks |
| src/renderer/features/tasks/TaskDetail.vue | area | renderer/features/tasks |
| src/renderer/features/tasks/TaskDetail.vue | dependencyText | renderer/features/tasks |
| src/renderer/features/tasks/TaskDetail.vue | draftDirty | renderer/features/tasks |
| src/renderer/features/tasks/TaskDetail.vue | dueKind | renderer/features/tasks |
| src/renderer/features/tasks/TaskDetail.vue | dueValue | renderer/features/tasks |
| src/renderer/features/tasks/TaskDetail.vue | durationUnit | renderer/features/tasks |
| src/renderer/features/tasks/TaskDetail.vue | durationValue | renderer/features/tasks |
| src/renderer/features/tasks/TaskDetail.vue | importance | renderer/features/tasks |
| src/renderer/features/tasks/TaskDetail.vue | localError | renderer/features/tasks |
| src/renderer/features/tasks/TaskDetail.vue | notes | renderer/features/tasks |
| src/renderer/features/tasks/TaskDetail.vue | parentGid | renderer/features/tasks |
| src/renderer/features/tasks/TaskDetail.vue | parentWorkMode | renderer/features/tasks |
| src/renderer/features/tasks/TaskDetail.vue | props | renderer/features/tasks |
| src/renderer/features/tasks/TaskDetail.vue | restoringForm | renderer/features/tasks |
| src/renderer/features/tasks/TaskDetail.vue | status | renderer/features/tasks |
| src/renderer/features/tasks/TaskDetail.vue | title | renderer/features/tasks |
| src/renderer/features/tasks/TaskSyncControls.vue | fullSyncConfirmationOpen | renderer/features/tasks |

| instance source | class member | owner |
| --- | --- | --- |
| src/main/application/common/diagnostic-log-service.ts | DiagnosticLogService.appVersion | main/application/common |
| src/main/application/common/diagnostic-log-service.ts | DiagnosticLogService.nowProvider | main/application/common |
| src/main/application/common/diagnostic-log-service.ts | DiagnosticLogService.parseAppVersion | main/application/common |
| src/main/application/common/diagnostic-log-service.ts | DiagnosticLogService.parseEntry | main/application/common |
| src/main/application/common/diagnostic-log-service.ts | DiagnosticLogService.parseRecord | main/application/common |
| src/main/application/common/diagnostic-log-service.ts | DiagnosticLogService.retentionLimit | main/application/common |
| src/main/application/common/diagnostic-log-service.ts | DiagnosticLogService.storage | main/application/common |
| src/main/application/common/errors/diagnostic-failure.ts | DiagnosticFailureDispositionError.disposition | main/application/common |
| src/main/application/common/errors/external-agent-service-error.ts | ExternalAgentServiceError.code | main/application/common |
| src/main/application/common/ports/ai-workflow-retry.ts | AiWorkflowRetryLogEventError.event | main/application/common |
| src/main/application/common/ports/asana-operation-queue.ts | AsanaOperationInvalidatedError.reason | main/application/common |
| src/main/application/common/task-write-synchronization-error.ts | TaskWriteSynchronizationError.code | main/application/common |
| src/main/application/gui-edit/execution-workflow.ts | GuiEditExecutionWorkflow.port | main/application/gui-edit |
| src/main/application/gui-edit/request-workflow.ts | GuiEditRequestWorkflow.dependencies | main/application/gui-edit |
| src/main/application/obsidian-integration/workflow.ts | ObsidianIntegrationWorkflow.dependencies | main/application/obsidian-integration |
| src/main/application/obsidian-integration/workflow.ts | ObsidianIntegrationWorkflow.saveInProgress | main/application/obsidian-integration |
| src/main/application/proposal-apply/execution-request-workflow.ts | ProposalExecutionRequestWorkflow.dependencies | main/application/proposal-apply |
| src/main/application/proposal-apply/execution-workflow.ts | ProposalExecutionWorkflow.port | main/application/proposal-apply |
| src/main/application/proposal-apply/external-agent-application.ts | ExternalAgentApplication.options | main/application/proposal-apply |
| src/main/application/proposal-apply/external-agent-application.ts | ExternalAgentApplication.proposals | main/application/proposal-apply |
| src/main/application/proposal-apply/external-agent-application.ts | ExternalAgentApplication.review | main/application/proposal-apply |
| src/main/application/proposal-apply/external-agent-review.ts | ExternalAgentReview.currentTarget | main/application/proposal-apply |
| src/main/application/proposal-apply/external-agent-review.ts | ExternalAgentReview.getState | main/application/proposal-apply |
| src/main/application/proposal-apply/external-agent-review.ts | ExternalAgentReview.listeners | main/application/proposal-apply |
| src/main/application/proposal-apply/history-workflow.ts | ProposalHistoryWorkflow.dependencies | main/application/proposal-apply |
| src/main/application/proposal-generate/external-agent-generation.ts | ExternalAgentGeneration.lifecycle | main/application/proposal-generate |
| src/main/application/proposal-generate/external-agent-generation.ts | ExternalAgentGeneration.options | main/application/proposal-generate |
| src/main/application/proposal-generate/external-agent-generation.ts | ExternalAgentGeneration.preparation | main/application/proposal-generate |
| src/main/application/proposal-generate/external-agent-generation.ts | ExternalAgentGeneration.submission | main/application/proposal-generate |
| src/main/application/proposal-generate/external-agent-lifecycle.ts | ExternalAgentLifecycle.currentContext | main/application/proposal-generate |
| src/main/application/proposal-generate/external-agent-lifecycle.ts | ExternalAgentLifecycle.ports | main/application/proposal-generate |
| src/main/application/proposal-generate/external-agent-lifecycle.ts | ExternalAgentLifecycle.stoppedState | main/application/proposal-generate |
| src/main/application/proposal-generate/external-agent-preparation.ts | ExternalAgentPreparation.contextPorts | main/application/proposal-generate |
| src/main/application/proposal-generate/external-agent-preparation.ts | ExternalAgentPreparation.contexts | main/application/proposal-generate |
| src/main/application/proposal-generate/external-agent-preparation.ts | ExternalAgentPreparation.requests | main/application/proposal-generate |
| src/main/application/proposal-generate/external-agent-submission.ts | ExternalAgentSubmission.requests | main/application/proposal-generate |
| src/main/application/proposal-generate/proposal-baseline-workflow.ts | ProposalBaselineWorkflow.dependencies | main/application/proposal-generate |
| src/main/application/proposal-generate/proposal-store.ts | ProposalStore.ProposalNotFoundError | main/application/proposal-generate |
| src/main/application/proposal-generate/proposal-store.ts | ProposalStore.StateError | main/application/proposal-generate |
| src/main/application/proposal-generate/proposal-store.ts | ProposalStore.WorkflowError | main/application/proposal-generate |
| src/main/application/proposal-generate/proposal-store.ts | ProposalStore.maximumProposals | main/application/proposal-generate |
| src/main/application/proposal-generate/proposal-store.ts | ProposalStore.parseProposalId | main/application/proposal-generate |
| src/main/application/proposal-generate/proposal-store.ts | ProposalStore.selection | main/application/proposal-generate |
| src/main/application/proposal-generate/proposal-workspace.ts | ProposalWorkspace.baselineSnapshotHash | main/application/proposal-generate |
| src/main/application/proposal-generate/proposal-workspace.ts | ProposalWorkspace.batches | main/application/proposal-generate |
| src/main/application/proposal-generate/proposal-workspace.ts | ProposalWorkspace.draft | main/application/proposal-generate |
| src/main/application/proposal-generate/proposal-workspace.ts | ProposalWorkspace.history | main/application/proposal-generate |
| src/main/application/proposal-generate/proposal-workspace.ts | ProposalWorkspace.revision | main/application/proposal-generate |
| src/main/application/proposal-generate/proposal-workspace.ts | ProposalWorkspace.state | main/application/proposal-generate |
| src/main/application/proposal-generate/proposal-workspace.ts | ProposalWorkspace.workspaceId | main/application/proposal-generate |
| src/main/application/proposal-generate/proposal-workspace.ts | ProposalWorkspaceConflictError.code | main/application/proposal-generate |
| src/main/application/proposal-generate/workflow-errors.ts | AiWorkflowRetryableFailureError.candidateDigest | main/application/proposal-generate |
| src/main/application/proposal-generate/workflow-errors.ts | AiWorkflowRetryableFailureError.issues | main/application/proposal-generate |
| src/main/application/proposal-generate/workflow-errors.ts | AiWorkflowRetryableFailureError.recoveryAction | main/application/proposal-generate |
| src/main/application/proposal-generate/workflow-service.ts | AiWorkflowService.options | main/application/proposal-generate |
| src/main/application/proposal-generate/workflow-service.ts | AiWorkflowService.retryDiagnosticDependencies | main/application/proposal-generate |
| src/main/application/proposal-generate/workflow-service.ts | AiWorkflowService.state | main/application/proposal-generate |
| src/main/application/proposal-generate/workflow-state.ts | ProposalGenerationState.StateError | main/application/proposal-generate |
| src/main/application/proposal-generate/workflow-state.ts | ProposalGenerationState.completedEvidenceSources | main/application/proposal-generate |
| src/main/application/proposal-generate/workflow-state.ts | ProposalGenerationState.deltaListeners | main/application/proposal-generate |
| src/main/application/proposal-generate/workflow-state.ts | ProposalGenerationState.lifecycle | main/application/proposal-generate |
| src/main/application/proposal-generate/workflow-state.ts | ProposalGenerationState.pendingWithdrawConfirmation | main/application/proposal-generate |
| src/main/application/proposal-generate/workflow-state.ts | ProposalGenerationState.proposals | main/application/proposal-generate |
| src/main/application/proposal-generate/workflow-state.ts | ProposalGenerationState.releaseTaskctlSnapshot | main/application/proposal-generate |
| src/main/application/proposal-generate/workflow-state.ts | ProposalGenerationState.removeSessionDelta | main/application/proposal-generate |
| src/main/application/proposal-generate/workflow-state.ts | ProposalGenerationState.reportListenerError | main/application/proposal-generate |
| src/main/application/proposal-generate/workflow-state.ts | ProposalGenerationState.sessionGeneration | main/application/proposal-generate |
| src/main/application/settings/asana-reauthentication.ts | AsanaReauthenticationRuntime.dependencies | main/application/settings |
| src/main/application/settings/asana-reauthentication.ts | AsanaReauthenticationRuntime.operation | main/application/settings |
| src/main/application/settings/codex-health.ts | CodexHealthWorkflow.dependencies | main/application/settings |
| src/main/application/settings/setup-asana-authorization.ts | SetupAsanaAuthorization.completionOperation | main/application/settings |
| src/main/application/settings/setup-asana-authorization.ts | SetupAsanaAuthorization.dependencies | main/application/settings |
| src/main/application/settings/setup-ipc-workflow.ts | SetupIpcWorkflow.dependencies | main/application/settings |
| src/main/application/settings/setup-workflow.ts | SetupOrchestrator.asana | main/application/settings |
| src/main/application/settings/setup-workflow.ts | SetupOrchestrator.asanaAuthorization | main/application/settings |
| src/main/application/settings/setup-workflow.ts | SetupOrchestrator.capability | main/application/settings |
| src/main/application/settings/setup-workflow.ts | SetupOrchestrator.checkpoint | main/application/settings |
| src/main/application/settings/setup-workflow.ts | SetupOrchestrator.codex | main/application/settings |
| src/main/application/settings/setup-workflow.ts | SetupOrchestrator.codexAvailability | main/application/settings |
| src/main/application/settings/setup-workflow.ts | SetupOrchestrator.contracts | main/application/settings |
| src/main/application/settings/setup-workflow.ts | SetupOrchestrator.database | main/application/settings |
| src/main/application/settings/setup-workflow.ts | SetupOrchestrator.deviceId | main/application/settings |
| src/main/application/settings/setup-workflow.ts | SetupOrchestrator.fullSync | main/application/settings |
| src/main/application/settings/setup-workflow.ts | SetupOrchestrator.reportCapabilityFailure | main/application/settings |
| src/main/application/settings/setup-workflow.ts | SetupOrchestrator.resources | main/application/settings |
| src/main/application/settings/setup-workflow.ts | SetupOrchestrator.resumeRequired | main/application/settings |
| src/main/application/settings/setup-workflow.ts | SetupOrchestrator.state | main/application/settings |
| src/main/application/settings/setup-workflow.ts | SetupOrchestrator.stateTools | main/application/settings |
| src/main/application/task-read/cleanup-aggregation.ts | CleanupAggregationService.noteExistsPort | main/application/task-read |
| src/main/application/task-read/cleanup-aggregation.ts | CleanupAggregationService.repository | main/application/task-read |
| src/main/application/task-read/local-state-refresh-workflow.ts | LocalStateRefreshWorkflow.dependencies | main/application/task-read |
| src/main/application/task-read/sync-state-runtime.ts | SyncStateRuntime.dependencies | main/application/task-read |
| src/main/application/task-read/sync-state-runtime.ts | SyncStateRuntime.diagnosticState | main/application/task-read |
| src/main/application/task-read/sync-state-runtime.ts | SyncStateRuntime.lastDisplaySyncAt | main/application/task-read |
| src/main/application/task-read/sync-state-runtime.ts | SyncStateRuntime.listeners | main/application/task-read |
| src/main/application/task-read/sync-state-runtime.ts | SyncStateRuntime.removeRuntimeSubscription | main/application/task-read |
| src/main/application/task-read/task-read-index.ts | TaskReadIndex.contracts | main/application/task-read |
| src/main/application/task-read/task-read-index.ts | TaskReadIndex.storage | main/application/task-read |
| src/main/application/task-read/workflow.ts | TaskReadWorkflow.dependencies | main/application/task-read |
| src/main/application/task-read/workflow.ts | TaskReadWorkflow.index | main/application/task-read |
| src/main/application/task-read/workflow.ts | TaskReadWorkflow.stateRuntime | main/application/task-read |
| src/main/application/task-write/proposal-execution-engine.ts | ProposalExecutionEngine.clock | main/application/task-write |
| src/main/application/task-write/proposal-execution-engine.ts | ProposalExecutionEngine.errorReporter | main/application/task-write |
| src/main/application/task-write/proposal-execution-engine.ts | ProposalExecutionEngine.executors | main/application/task-write |
| src/main/application/task-write/proposal-execution-engine.ts | ProposalExecutionEngine.locks | main/application/task-write |
| src/main/application/task-write/proposal-execution-engine.ts | ProposalExecutionEngine.readBack | main/application/task-write |
| src/main/application/task-write/proposal-execution-engine.ts | ProposalExecutionEngine.repository | main/application/task-write |
| src/main/application/task-write/proposal-execution-engine.ts | ProposalExecutionEngine.resultBuilder | main/application/task-write |
| src/main/application/task-write/readiness-workflow.ts | TaskWriteReadinessWorkflow.dependencies | main/application/task-write |
| src/main/bootstrap/ai-event-runtime.ts | AiEventRuntime.deltaListeners | main/bootstrap |
| src/main/bootstrap/ai-event-runtime.ts | AiEventRuntime.dependencies | main/bootstrap |
| src/main/bootstrap/ai-event-runtime.ts | AiEventRuntime.statusListeners | main/bootstrap |
| src/main/bootstrap/ai-interaction-runtime.ts | AiInteractionRuntime.dependencies | main/bootstrap |
| src/main/bootstrap/ai-session-runtime.ts | AiSessionRuntime.dependencies | main/bootstrap |
| src/main/bootstrap/ai-session-runtime.ts | AiSessionRuntime.sessions | main/bootstrap |
| src/main/bootstrap/ai-session-runtime.ts | AiSessionRuntime.starts | main/bootstrap |
| src/main/bootstrap/application-update-service.ts | ApplicationUpdateService.activeOperation | main/bootstrap |
| src/main/bootstrap/application-update-service.ts | ApplicationUpdateService.attemptStore | main/bootstrap |
| src/main/bootstrap/application-update-service.ts | ApplicationUpdateService.attemptedVersion | main/bootstrap |
| src/main/bootstrap/application-update-service.ts | ApplicationUpdateService.candidate | main/bootstrap |
| src/main/bootstrap/application-update-service.ts | ApplicationUpdateService.currentVersion | main/bootstrap |
| src/main/bootstrap/application-update-service.ts | ApplicationUpdateService.handleDownloadProgress | main/bootstrap |
| src/main/bootstrap/application-update-service.ts | ApplicationUpdateService.handleUpdaterError | main/bootstrap |
| src/main/bootstrap/application-update-service.ts | ApplicationUpdateService.installing | main/bootstrap |
| src/main/bootstrap/application-update-service.ts | ApplicationUpdateService.listeners | main/bootstrap |
| src/main/bootstrap/application-update-service.ts | ApplicationUpdateService.platform | main/bootstrap |
| src/main/bootstrap/application-update-service.ts | ApplicationUpdateService.quitAfterUpdateFailure | main/bootstrap |
| src/main/bootstrap/application-update-service.ts | ApplicationUpdateService.reportError | main/bootstrap |
| src/main/bootstrap/application-update-service.ts | ApplicationUpdateService.resourcesPath | main/bootstrap |
| src/main/bootstrap/application-update-service.ts | ApplicationUpdateService.restoredInstallFailure | main/bootstrap |
| src/main/bootstrap/application-update-service.ts | ApplicationUpdateService.started | main/bootstrap |
| src/main/bootstrap/application-update-service.ts | ApplicationUpdateService.state | main/bootstrap |
| src/main/bootstrap/application-update-service.ts | ApplicationUpdateService.updater | main/bootstrap |
| src/main/bootstrap/application-update-service.ts | ApplicationUpdateService.updaterListenersRegistered | main/bootstrap |
| src/main/bootstrap/codex-session-resources.ts | CodexSessionResources.options | main/bootstrap |
| src/main/bootstrap/configured-codex-runtime.ts | ConfiguredCodexRuntime.authenticationRequired | main/bootstrap |
| src/main/bootstrap/configured-codex-runtime.ts | ConfiguredCodexRuntime.availability | main/bootstrap |
| src/main/bootstrap/configured-codex-runtime.ts | ConfiguredCodexRuntime.dependencies | main/bootstrap |
| src/main/bootstrap/configured-codex-runtime.ts | ConfiguredCodexRuntime.launchState | main/bootstrap |
| src/main/bootstrap/configured-codex-runtime.ts | ConfiguredCodexRuntime.startResult | main/bootstrap |
| src/main/bootstrap/configured-codex-runtime.ts | ConfiguredCodexRuntime.synchronizationPromise | main/bootstrap |
| src/main/bootstrap/journal-recovery-runtime.ts | JournalRecoveryRuntime.dependencies | main/bootstrap |
| src/main/bootstrap/journal-recovery-runtime.ts | JournalRecoveryRuntime.pending | main/bootstrap |
| src/main/bootstrap/journal-recovery-runtime.ts | JournalRecoveryRuntime.recoveryPromise | main/bootstrap |
| src/main/bootstrap/journal-recovery-runtime.ts | JournalRecoveryRuntime.running | main/bootstrap |
| src/main/bootstrap/main-shutdown-runtime.ts | MainShutdownRuntime.dependencies | main/bootstrap |
| src/main/bootstrap/main-shutdown-runtime.ts | MainShutdownRuntime.stopped | main/bootstrap |
| src/main/bootstrap/main-startup-runtime.ts | MainStartupRuntime.dependencies | main/bootstrap |
| src/main/bootstrap/main-startup-runtime.ts | MainStartupRuntime.readyActivated | main/bootstrap |
| src/main/bootstrap/main-window-runtime.ts | MainWindowRuntime.dependencies | main/bootstrap |
| src/main/bootstrap/main-window-runtime.ts | MainWindowRuntime.mainWindow | main/bootstrap |
| src/main/bootstrap/main-window-runtime.ts | MainWindowRuntime.mainWindowStateController | main/bootstrap |
| src/main/bootstrap/main-window-runtime.ts | MainWindowRuntime.stopped | main/bootstrap |
| src/main/bootstrap/main-window-runtime.ts | MainWindowRuntime.windowCreationPromise | main/bootstrap |
| src/main/bootstrap/main-workflow-construction.ts | MainWorkflowConstruction.aiEvents | main/bootstrap |
| src/main/bootstrap/main-workflow-construction.ts | MainWorkflowConstruction.aiInteraction | main/bootstrap |
| src/main/bootstrap/main-workflow-construction.ts | MainWorkflowConstruction.aiRuntime | main/bootstrap |
| src/main/bootstrap/main-workflow-construction.ts | MainWorkflowConstruction.aiSessionWorkspaceParentPath | main/bootstrap |
| src/main/bootstrap/main-workflow-construction.ts | MainWorkflowConstruction.asana | main/bootstrap |
| src/main/bootstrap/main-workflow-construction.ts | MainWorkflowConstruction.attachedAsanaReauthentication | main/bootstrap |
| src/main/bootstrap/main-workflow-construction.ts | MainWorkflowConstruction.attachedDiagnostics | main/bootstrap |
| src/main/bootstrap/main-workflow-construction.ts | MainWorkflowConstruction.attachedSetup | main/bootstrap |
| src/main/bootstrap/main-workflow-construction.ts | MainWorkflowConstruction.attachedSynchronizationOperations | main/bootstrap |
| src/main/bootstrap/main-workflow-construction.ts | MainWorkflowConstruction.attachedTaskReadRuntime | main/bootstrap |
| src/main/bootstrap/main-workflow-construction.ts | MainWorkflowConstruction.checkpoint | main/bootstrap |
| src/main/bootstrap/main-workflow-construction.ts | MainWorkflowConstruction.cleanupAggregation | main/bootstrap |
| src/main/bootstrap/main-workflow-construction.ts | MainWorkflowConstruction.codexAdapter | main/bootstrap |
| src/main/bootstrap/main-workflow-construction.ts | MainWorkflowConstruction.codexHealth | main/bootstrap |
| src/main/bootstrap/main-workflow-construction.ts | MainWorkflowConstruction.codexSession | main/bootstrap |
| src/main/bootstrap/main-workflow-construction.ts | MainWorkflowConstruction.codexSessionResources | main/bootstrap |
| src/main/bootstrap/main-workflow-construction.ts | MainWorkflowConstruction.codexWorkspace | main/bootstrap |
| src/main/bootstrap/main-workflow-construction.ts | MainWorkflowConstruction.configuredCodexRuntime | main/bootstrap |
| src/main/bootstrap/main-workflow-construction.ts | MainWorkflowConstruction.createSyncRuntimeFactory | main/bootstrap |
| src/main/bootstrap/main-workflow-construction.ts | MainWorkflowConstruction.externalAgent | main/bootstrap |
| src/main/bootstrap/main-workflow-construction.ts | MainWorkflowConstruction.externalAgentApply | main/bootstrap |
| src/main/bootstrap/main-workflow-construction.ts | MainWorkflowConstruction.externalAgentBridge | main/bootstrap |
| src/main/bootstrap/main-workflow-construction.ts | MainWorkflowConstruction.externalAgentInstanceId | main/bootstrap |
| src/main/bootstrap/main-workflow-construction.ts | MainWorkflowConstruction.guiEditRequest | main/bootstrap |
| src/main/bootstrap/main-workflow-construction.ts | MainWorkflowConstruction.highPriorityTransport | main/bootstrap |
| src/main/bootstrap/main-workflow-construction.ts | MainWorkflowConstruction.interactiveReadClient | main/bootstrap |
| src/main/bootstrap/main-workflow-construction.ts | MainWorkflowConstruction.journalRecovery | main/bootstrap |
| src/main/bootstrap/main-workflow-construction.ts | MainWorkflowConstruction.localStateRefresh | main/bootstrap |
| src/main/bootstrap/main-workflow-construction.ts | MainWorkflowConstruction.oauth | main/bootstrap |
| src/main/bootstrap/main-workflow-construction.ts | MainWorkflowConstruction.obsidian | main/bootstrap |
| src/main/bootstrap/main-workflow-construction.ts | MainWorkflowConstruction.operationQueue | main/bootstrap |
| src/main/bootstrap/main-workflow-construction.ts | MainWorkflowConstruction.operationalContext | main/bootstrap |
| src/main/bootstrap/main-workflow-construction.ts | MainWorkflowConstruction.operationalServices | main/bootstrap |
| src/main/bootstrap/main-workflow-construction.ts | MainWorkflowConstruction.options | main/bootstrap |
| src/main/bootstrap/main-workflow-construction.ts | MainWorkflowConstruction.proposalApplicationHistoryRepository | main/bootstrap |
| src/main/bootstrap/main-workflow-construction.ts | MainWorkflowConstruction.proposalBaseline | main/bootstrap |
| src/main/bootstrap/main-workflow-construction.ts | MainWorkflowConstruction.proposalExecutionRequest | main/bootstrap |
| src/main/bootstrap/main-workflow-construction.ts | MainWorkflowConstruction.proposalHistory | main/bootstrap |
| src/main/bootstrap/main-workflow-construction.ts | MainWorkflowConstruction.readClient | main/bootstrap |
| src/main/bootstrap/main-workflow-construction.ts | MainWorkflowConstruction.secretStorage | main/bootstrap |
| src/main/bootstrap/main-workflow-construction.ts | MainWorkflowConstruction.settingsRepository | main/bootstrap |
| src/main/bootstrap/main-workflow-construction.ts | MainWorkflowConstruction.shutdownRuntime | main/bootstrap |
| src/main/bootstrap/main-workflow-construction.ts | MainWorkflowConstruction.startupRuntime | main/bootstrap |
| src/main/bootstrap/main-workflow-construction.ts | MainWorkflowConstruction.syncCoordinator | main/bootstrap |
| src/main/bootstrap/main-workflow-construction.ts | MainWorkflowConstruction.taskReadPersistenceContracts | main/bootstrap |
| src/main/bootstrap/main-workflow-construction.ts | MainWorkflowConstruction.taskReadRepository | main/bootstrap |
| src/main/bootstrap/main-workflow-construction.ts | MainWorkflowConstruction.taskWriteExecution | main/bootstrap |
| src/main/bootstrap/main-workflow-construction.ts | MainWorkflowConstruction.taskWriteReadiness | main/bootstrap |
| src/main/bootstrap/main-workflow-construction.ts | MainWorkflowConstruction.taskctlSchemas | main/bootstrap |
| src/main/bootstrap/main-workflow-construction.ts | MainWorkflowConstruction.vaultMappingRepository | main/bootstrap |
| src/main/bootstrap/main-workflow-construction.ts | MainWorkflowConstruction.writeClient | main/bootstrap |
| src/main/bootstrap/operational-context-runtime.ts | OperationalContextRuntime.context | main/bootstrap |
| src/main/bootstrap/operational-context-runtime.ts | OperationalContextRuntime.dependencies | main/bootstrap |
| src/main/bootstrap/operational-context-runtime.ts | OperationalContextRuntime.settings | main/bootstrap |
| src/main/bootstrap/operational-event-runtime.ts | OperationalEventRuntime.backgroundOperations | main/bootstrap |
| src/main/bootstrap/operational-event-runtime.ts | OperationalEventRuntime.dependencies | main/bootstrap |
| src/main/bootstrap/operational-event-runtime.ts | OperationalEventRuntime.foregroundScheduled | main/bootstrap |
| src/main/bootstrap/operational-event-runtime.ts | OperationalEventRuntime.onlineMonitorState | main/bootstrap |
| src/main/bootstrap/operational-event-runtime.ts | OperationalEventRuntime.onlinePollScheduled | main/bootstrap |
| src/main/bootstrap/operational-event-runtime.ts | OperationalEventRuntime.scheduleForegroundSync | main/bootstrap |
| src/main/bootstrap/operational-event-runtime.ts | OperationalEventRuntime.scheduleOnlinePoll | main/bootstrap |
| src/main/bootstrap/operational-services-runtime.ts | OperationalServicesRuntime.aiSessionsConfigured | main/bootstrap |
| src/main/bootstrap/operational-services-runtime.ts | OperationalServicesRuntime.dependencies | main/bootstrap |
| src/main/bootstrap/operational-services-runtime.ts | OperationalServicesRuntime.displayOrder | main/bootstrap |
| src/main/bootstrap/operational-services-runtime.ts | OperationalServicesRuntime.runtime | main/bootstrap |
| src/main/bootstrap/synchronization-operations.ts | SynchronizationOperations.applicationState | main/bootstrap |
| src/main/bootstrap/synchronization-operations.ts | SynchronizationOperations.dependencies | main/bootstrap |
| src/main/bootstrap/synchronization-operations.ts | SynchronizationOperations.failureDiagnosticSuppressionCount | main/bootstrap |
| src/main/bootstrap/window-state-controller.ts | WindowStateController.attached | main/bootstrap |
| src/main/bootstrap/window-state-controller.ts | WindowStateController.currentWindowState | main/bootstrap |
| src/main/bootstrap/window-state-controller.ts | WindowStateController.displaysProvider | main/bootstrap |
| src/main/bootstrap/window-state-controller.ts | WindowStateController.disposed | main/bootstrap |
| src/main/bootstrap/window-state-controller.ts | WindowStateController.fullscreenTransition | main/bootstrap |
| src/main/bootstrap/window-state-controller.ts | WindowStateController.handleBeforeInputEvent | main/bootstrap |
| src/main/bootstrap/window-state-controller.ts | WindowStateController.handleBoundsChanged | main/bootstrap |
| src/main/bootstrap/window-state-controller.ts | WindowStateController.handleClose | main/bootstrap |
| src/main/bootstrap/window-state-controller.ts | WindowStateController.handleClosed | main/bootstrap |
| src/main/bootstrap/window-state-controller.ts | WindowStateController.handleEnterFullScreen | main/bootstrap |
| src/main/bootstrap/window-state-controller.ts | WindowStateController.handleLeaveFullScreen | main/bootstrap |
| src/main/bootstrap/window-state-controller.ts | WindowStateController.handleMaximize | main/bootstrap |
| src/main/bootstrap/window-state-controller.ts | WindowStateController.handleUnmaximize | main/bootstrap |
| src/main/bootstrap/window-state-controller.ts | WindowStateController.saveTimer | main/bootstrap |
| src/main/bootstrap/window-state-controller.ts | WindowStateController.scheduleSave | main/bootstrap |
| src/main/bootstrap/window-state-controller.ts | WindowStateController.store | main/bootstrap |
| src/main/bootstrap/window-state-controller.ts | WindowStateController.window | main/bootstrap |
| src/main/domain/external-data.ts | CustomExternalDataCapacityError.byteLength | main/domain |
| src/main/domain/normalization/graph.ts | RelationshipCycleError.relation | main/domain |
| src/main/domain/normalization/graph.ts | RelationshipCycleError.task_gids | main/domain |
| src/main/infrastructure/ai/codex-app-server/connection-overrides.ts | CodexConfigOverride.argument | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-app-server/connection.ts | CodexAppServerConnection.capabilities | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-app-server/connection.ts | CodexAppServerConnection.child | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-app-server/connection.ts | CodexAppServerConnection.clientInfo | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-app-server/connection.ts | CodexAppServerConnection.codexHome | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-app-server/connection.ts | CodexAppServerConnection.configOverrides | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-app-server/connection.ts | CodexAppServerConnection.environment | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-app-server/connection.ts | CodexAppServerConnection.executable | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-app-server/connection.ts | CodexAppServerConnection.forcedStopTimer | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-app-server/connection.ts | CodexAppServerConnection.gracefulStopTimer | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-app-server/connection.ts | CodexAppServerConnection.processTerminationTarget | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-app-server/connection.ts | CodexAppServerConnection.queuedWrites | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-app-server/connection.ts | CodexAppServerConnection.stderrLineBytes | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-app-server/connection.ts | CodexAppServerConnection.stderrLineCount | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-app-server/connection.ts | CodexAppServerConnection.stderrReader | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-app-server/connection.ts | CodexAppServerConnection.stderrReadingStopped | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-app-server/connection.ts | CodexAppServerConnection.stdoutLineBytes | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-app-server/connection.ts | CodexAppServerConnection.stdoutReader | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-app-server/connection.ts | CodexAppServerConnection.stopPromise | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-app-server/connection.ts | CodexAppServerConnection.stopReject | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-app-server/connection.ts | CodexAppServerConnection.stopResolve | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-app-server/connection.ts | CodexAppServerConnection.writeQueue | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-app-server/errors.ts | CodexProcessExitError.exitCode | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-app-server/errors.ts | CodexProcessExitError.signal | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-app-server/errors.ts | CodexProtocolError.failureCode | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-app-server/errors.ts | CodexRequestAbortedError.method | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-app-server/errors.ts | CodexRequestTimeoutError.method | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-app-server/errors.ts | CodexRpcError.operation | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-app-server/errors.ts | CodexRpcError.rpcCode | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-app-server/errors.ts | CodexRpcError.rpcMessage | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-app-server/rpc-endpoint.ts | CodexRpcEndpoint.diagnosticListeners | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-app-server/rpc-endpoint.ts | CodexRpcEndpoint.diagnostics | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-app-server/rpc-endpoint.ts | CodexRpcEndpoint.dynamicToolHandler | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-app-server/rpc-endpoint.ts | CodexRpcEndpoint.dynamicToolRequests | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-app-server/rpc-endpoint.ts | CodexRpcEndpoint.nextRequestId | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-app-server/rpc-endpoint.ts | CodexRpcEndpoint.notificationListeners | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-app-server/rpc-endpoint.ts | CodexRpcEndpoint.onError | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-app-server/rpc-endpoint.ts | CodexRpcEndpoint.pendingRequests | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-app-server/rpc-endpoint.ts | CodexRpcEndpoint.requestTimeoutMs | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-app-server/rpc-endpoint.ts | CodexRpcEndpoint.state | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-app-server/rpc-endpoint.ts | CodexRpcEndpoint.terminalError | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-session/connection-recovery.ts | CodexConnectionRecovery.options | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-session/connection-recovery.ts | CodexConnectionRecovery.restartCount | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-session/connection-recovery.ts | CodexConnectionRecovery.restartPromise | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-session/dynamic-tools.ts | CodexDynamicToolHandler.options | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-session/errors.ts | CodexThreadStartCapabilityError.failureCode | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-session/notification-router.ts | CodexSessionNotificationRouter.options | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-session/session.ts | CodexSessionService.activeProposalWorkspace | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-session/session.ts | CodexSessionService.broker | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-session/session.ts | CodexSessionService.connection | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-session/session.ts | CodexSessionService.connectionConfigurationChanged | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-session/session.ts | CodexSessionService.connectionRecovery | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-session/session.ts | CodexSessionService.diagnostics | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-session/session.ts | CodexSessionService.disablePromise | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-session/session.ts | CodexSessionService.dynamicToolHandler | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-session/session.ts | CodexSessionService.frozenTaskctlSnapshot | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-session/session.ts | CodexSessionService.lifecycleAbortListener | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-session/session.ts | CodexSessionService.lifecycleSignal | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-session/session.ts | CodexSessionService.modelFormatInstruction | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-session/session.ts | CodexSessionService.notificationRouter | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-session/session.ts | CodexSessionService.options | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-session/session.ts | CodexSessionService.readOnlyVaultPaths | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-session/session.ts | CodexSessionService.recoveryAbortController | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-session/session.ts | CodexSessionService.removeDiagnosticListener | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-session/session.ts | CodexSessionService.removeDynamicToolListener | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-session/session.ts | CodexSessionService.removeNotificationListener | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-session/session.ts | CodexSessionService.responseSerializer | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-session/session.ts | CodexSessionService.safetyViolation | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-session/session.ts | CodexSessionService.selectedModel | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-session/session.ts | CodexSessionService.skillConfiguration | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-session/session.ts | CodexSessionService.startup | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-session/session.ts | CodexSessionService.state | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-session/session.ts | CodexSessionService.stopPromise | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-session/session.ts | CodexSessionService.structuredOutputSchema | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-session/session.ts | CodexSessionService.structuredOutputVerified | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-session/session.ts | CodexSessionService.successfullyStarted | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-session/session.ts | CodexSessionService.taskctlSchemas | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-session/session.ts | CodexSessionService.taskctlStartResult | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-session/session.ts | CodexSessionService.threadConfigurationChanged | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-session/session.ts | CodexSessionService.threadId | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-session/session.ts | CodexSessionService.threadSettingsNotification | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-session/session.ts | CodexSessionService.turnCoordinator | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-session/startup.ts | CodexSessionStartup.options | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-session/tool-response.ts | CodexToolResponseSerializer.maximumDynamicToolResponseBytes | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-session/tool-response.ts | CodexToolResponseSerializer.maximumProposalWorkspaceResponseBytes | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-session/tool-response.ts | CodexToolResponseSerializer.obsidianResponseSchema | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-session/tool-response.ts | CodexToolResponseSerializer.taskctlResponseSchema | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-session/turn-coordinator.ts | CodexTurnCoordinator.activeTurn | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-session/turn-coordinator.ts | CodexTurnCoordinator.deltaListeners | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-session/turn-coordinator.ts | CodexTurnCoordinator.options | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-setup-adapter.ts | CodexSetupAdapter.environment | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-setup-adapter.ts | CodexSetupAdapter.executable | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-setup-adapter.ts | CodexSetupAdapter.loginOpened | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-setup-adapter.ts | CodexSetupAdapter.openAuthorizationUrl | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-setup-adapter.ts | CodexSetupAdapter.session | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-setup-adapter.ts | CodexSetupAdapter.startResult | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-setup-adapter.ts | CodexSetupAdapter.started | main/infrastructure/ai |
| src/main/infrastructure/ai/codex-setup-adapter.ts | CodexSetupAdapter.structuredOutputVerified | main/infrastructure/ai |
| src/main/infrastructure/ai/external-agent/transport.ts | ExternalAgentBridge.acceptingConnections | main/infrastructure/ai |
| src/main/infrastructure/ai/external-agent/transport.ts | ExternalAgentBridge.configFile | main/infrastructure/ai |
| src/main/infrastructure/ai/external-agent/transport.ts | ExternalAgentBridge.connections | main/infrastructure/ai |
| src/main/infrastructure/ai/external-agent/transport.ts | ExternalAgentBridge.descriptor | main/infrastructure/ai |
| src/main/infrastructure/ai/external-agent/transport.ts | ExternalAgentBridge.enabled | main/infrastructure/ai |
| src/main/infrastructure/ai/external-agent/transport.ts | ExternalAgentBridge.handleRequest | main/infrastructure/ai |
| src/main/infrastructure/ai/external-agent/transport.ts | ExternalAgentBridge.lifecycleOperation | main/infrastructure/ai |
| src/main/infrastructure/ai/external-agent/transport.ts | ExternalAgentBridge.onError | main/infrastructure/ai |
| src/main/infrastructure/ai/external-agent/transport.ts | ExternalAgentBridge.openConfigFile | main/infrastructure/ai |
| src/main/infrastructure/ai/external-agent/transport.ts | ExternalAgentBridge.paths | main/infrastructure/ai |
| src/main/infrastructure/ai/external-agent/transport.ts | ExternalAgentBridge.requestControllers | main/infrastructure/ai |
| src/main/infrastructure/ai/external-agent/transport.ts | ExternalAgentBridge.secureFiles | main/infrastructure/ai |
| src/main/infrastructure/ai/external-agent/transport.ts | ExternalAgentBridge.server | main/infrastructure/ai |
| src/main/infrastructure/ai/external-agent/transport.ts | ExternalAgentBridge.state | main/infrastructure/ai |
| src/main/infrastructure/ai/external-agent/transport.ts | ExternalAgentBridge.stopPromise | main/infrastructure/ai |
| src/main/infrastructure/ai/external-agent/transport.ts | ExternalAgentBridge.unixEndpointDirectoryPath | main/infrastructure/ai |
| src/main/infrastructure/ai/external-agent/transport.ts | ExternalAgentBridge.userDataPath | main/infrastructure/ai |
| src/main/infrastructure/ai/taskctl/broker.ts | TaskctlBroker.abortListener | main/infrastructure/ai |
| src/main/infrastructure/ai/taskctl/broker.ts | TaskctlBroker.abortSignal | main/infrastructure/ai |
| src/main/infrastructure/ai/taskctl/broker.ts | TaskctlBroker.connectionInfo | main/infrastructure/ai |
| src/main/infrastructure/ai/taskctl/broker.ts | TaskctlBroker.connectionInfoPath | main/infrastructure/ai |
| src/main/infrastructure/ai/taskctl/broker.ts | TaskctlBroker.connections | main/infrastructure/ai |
| src/main/infrastructure/ai/taskctl/broker.ts | TaskctlBroker.diagnostics | main/infrastructure/ai |
| src/main/infrastructure/ai/taskctl/broker.ts | TaskctlBroker.files | main/infrastructure/ai |
| src/main/infrastructure/ai/taskctl/broker.ts | TaskctlBroker.internalError | main/infrastructure/ai |
| src/main/infrastructure/ai/taskctl/broker.ts | TaskctlBroker.schemas | main/infrastructure/ai |
| src/main/infrastructure/ai/taskctl/broker.ts | TaskctlBroker.server | main/infrastructure/ai |
| src/main/infrastructure/ai/taskctl/broker.ts | TaskctlBroker.snapshotProvider | main/infrastructure/ai |
| src/main/infrastructure/ai/taskctl/broker.ts | TaskctlBroker.socketDirectoryPath | main/infrastructure/ai |
| src/main/infrastructure/ai/taskctl/broker.ts | TaskctlBroker.socketPath | main/infrastructure/ai |
| src/main/infrastructure/ai/taskctl/broker.ts | TaskctlBroker.state | main/infrastructure/ai |
| src/main/infrastructure/ai/taskctl/broker.ts | TaskctlBroker.stopPromise | main/infrastructure/ai |
| src/main/infrastructure/ai/taskctl/broker.ts | TaskctlBroker.tmpDirectoryPath | main/infrastructure/ai |
| src/main/infrastructure/asana/client/client.ts | AsanaReadClient.transport | main/infrastructure/asana |
| src/main/infrastructure/asana/client/setup-client.ts | AsanaSetupClient.transport | main/infrastructure/asana |
| src/main/infrastructure/asana/client/task-write-client.ts | AsanaTaskWriteClient.transport | main/infrastructure/asana |
| src/main/infrastructure/asana/display-order/service.ts | AsanaDisplayOrderService.debounceTimer | main/infrastructure/asana |
| src/main/infrastructure/asana/display-order/service.ts | AsanaDisplayOrderService.lifecycleAbortListener | main/infrastructure/asana |
| src/main/infrastructure/asana/display-order/service.ts | AsanaDisplayOrderService.lifecycleSignal | main/infrastructure/asana |
| src/main/infrastructure/asana/display-order/service.ts | AsanaDisplayOrderService.notifyUnexpectedError | main/infrastructure/asana |
| src/main/infrastructure/asana/display-order/service.ts | AsanaDisplayOrderService.operationQueue | main/infrastructure/asana |
| src/main/infrastructure/asana/display-order/service.ts | AsanaDisplayOrderService.pending | main/infrastructure/asana |
| src/main/infrastructure/asana/display-order/service.ts | AsanaDisplayOrderService.running | main/infrastructure/asana |
| src/main/infrastructure/asana/display-order/service.ts | AsanaDisplayOrderService.stopController | main/infrastructure/asana |
| src/main/infrastructure/asana/display-order/service.ts | AsanaDisplayOrderService.stopped | main/infrastructure/asana |
| src/main/infrastructure/asana/display-order/service.ts | AsanaDisplayOrderService.writeClient | main/infrastructure/asana |
| src/main/infrastructure/asana/oauth/asana-oauth.ts | AsanaOAuthClient.clientId | main/infrastructure/asana |
| src/main/infrastructure/asana/oauth/asana-oauth.ts | AsanaOAuthClient.pendingAuthorization | main/infrastructure/asana |
| src/main/infrastructure/asana/oauth/asana-oauth.ts | AsanaOAuthClient.secretStorage | main/infrastructure/asana |
| src/main/infrastructure/asana/oauth/coordinator.ts | AsanaOAuthCoordinator.createOAuthClient | main/infrastructure/asana |
| src/main/infrastructure/asana/oauth/coordinator.ts | AsanaOAuthCoordinator.openAuthorizationUrl | main/infrastructure/asana |
| src/main/infrastructure/asana/oauth/coordinator.ts | AsanaOAuthCoordinator.outOfBandTransaction | main/infrastructure/asana |
| src/main/infrastructure/asana/oauth/coordinator.ts | AsanaOAuthCoordinator.secretStorage | main/infrastructure/asana |
| src/main/infrastructure/asana/oauth/errors.ts | AsanaOAuthAuthorizationUrlOpenError.kind | main/infrastructure/asana |
| src/main/infrastructure/asana/oauth/errors.ts | AsanaOAuthHttpError.requestId | main/infrastructure/asana |
| src/main/infrastructure/asana/oauth/errors.ts | AsanaOAuthHttpError.status | main/infrastructure/asana |
| src/main/infrastructure/asana/oauth/errors.ts | AsanaOAuthResponseError.status | main/infrastructure/asana |
| src/main/infrastructure/asana/oauth/errors.ts | AsanaOAuthTokenEndpointError.code | main/infrastructure/asana |
| src/main/infrastructure/asana/operation-queue.ts | AsanaOperationQueue.active | main/infrastructure/asana |
| src/main/infrastructure/asana/operation-queue.ts | AsanaOperationQueue.activeCompletion | main/infrastructure/asana |
| src/main/infrastructure/asana/operation-queue.ts | AsanaOperationQueue.backgroundQueue | main/infrastructure/asana |
| src/main/infrastructure/asana/operation-queue.ts | AsanaOperationQueue.lifecycleAbortListener | main/infrastructure/asana |
| src/main/infrastructure/asana/operation-queue.ts | AsanaOperationQueue.lifecycleSignal | main/infrastructure/asana |
| src/main/infrastructure/asana/operation-queue.ts | AsanaOperationQueue.owners | main/infrastructure/asana |
| src/main/infrastructure/asana/operation-queue.ts | AsanaOperationQueue.pumping | main/infrastructure/asana |
| src/main/infrastructure/asana/operation-queue.ts | AsanaOperationQueue.stopController | main/infrastructure/asana |
| src/main/infrastructure/asana/operation-queue.ts | AsanaOperationQueue.stopPromise | main/infrastructure/asana |
| src/main/infrastructure/asana/operation-queue.ts | AsanaOperationQueue.stopped | main/infrastructure/asana |
| src/main/infrastructure/asana/operation-queue.ts | AsanaOperationQueue.userQueue | main/infrastructure/asana |
| src/main/infrastructure/asana/runtime/service.ts | AsanaSyncRuntime.beforeSynchronization | main/infrastructure/asana |
| src/main/infrastructure/asana/runtime/service.ts | AsanaSyncRuntime.configuration | main/infrastructure/asana |
| src/main/infrastructure/asana/runtime/service.ts | AsanaSyncRuntime.connectionState | main/infrastructure/asana |
| src/main/infrastructure/asana/runtime/service.ts | AsanaSyncRuntime.coordinator | main/infrastructure/asana |
| src/main/infrastructure/asana/runtime/service.ts | AsanaSyncRuntime.forwardUnhandledError | main/infrastructure/asana |
| src/main/infrastructure/asana/runtime/service.ts | AsanaSyncRuntime.lastErrorCode | main/infrastructure/asana |
| src/main/infrastructure/asana/runtime/service.ts | AsanaSyncRuntime.lastSuccessfulSyncAt | main/infrastructure/asana |
| src/main/infrastructure/asana/runtime/service.ts | AsanaSyncRuntime.lifecycleAbortListener | main/infrastructure/asana |
| src/main/infrastructure/asana/runtime/service.ts | AsanaSyncRuntime.lifecycleSignal | main/infrastructure/asana |
| src/main/infrastructure/asana/runtime/service.ts | AsanaSyncRuntime.listeners | main/infrastructure/asana |
| src/main/infrastructure/asana/runtime/service.ts | AsanaSyncRuntime.notifyUnexpectedError | main/infrastructure/asana |
| src/main/infrastructure/asana/runtime/service.ts | AsanaSyncRuntime.nowProvider | main/infrastructure/asana |
| src/main/infrastructure/asana/runtime/service.ts | AsanaSyncRuntime.operationQueue | main/infrastructure/asana |
| src/main/infrastructure/asana/runtime/service.ts | AsanaSyncRuntime.parseSyncState | main/infrastructure/asana |
| src/main/infrastructure/asana/runtime/service.ts | AsanaSyncRuntime.runReservation | main/infrastructure/asana |
| src/main/infrastructure/asana/runtime/service.ts | AsanaSyncRuntime.state | main/infrastructure/asana |
| src/main/infrastructure/asana/runtime/service.ts | AsanaSyncRuntime.stateRepository | main/infrastructure/asana |
| src/main/infrastructure/asana/runtime/service.ts | AsanaSyncRuntime.stopController | main/infrastructure/asana |
| src/main/infrastructure/asana/runtime/service.ts | AsanaSyncRuntime.stopped | main/infrastructure/asana |
| src/main/infrastructure/asana/runtime/service.ts | AsanaSyncRuntime.timer | main/infrastructure/asana |
| src/main/infrastructure/asana/scheduler/scheduler.ts | AsanaRequestScheduler.attemptTimestamps | main/infrastructure/asana |
| src/main/infrastructure/asana/scheduler/scheduler.ts | AsanaRequestScheduler.highPriorityStartsWhileLowWaiting | main/infrastructure/asana |
| src/main/infrastructure/asana/scheduler/scheduler.ts | AsanaRequestScheduler.nextKindToStart | main/infrastructure/asana |
| src/main/infrastructure/asana/scheduler/scheduler.ts | AsanaRequestScheduler.rateLimitTimer | main/infrastructure/asana |
| src/main/infrastructure/asana/scheduler/scheduler.ts | AsanaRequestScheduler.readActiveCount | main/infrastructure/asana |
| src/main/infrastructure/asana/scheduler/scheduler.ts | AsanaRequestScheduler.readQueues | main/infrastructure/asana |
| src/main/infrastructure/asana/scheduler/scheduler.ts | AsanaRequestScheduler.writeActiveCount | main/infrastructure/asana |
| src/main/infrastructure/asana/scheduler/scheduler.ts | AsanaRequestScheduler.writeQueues | main/infrastructure/asana |
| src/main/infrastructure/asana/setup/capability-check.ts | AsanaCapabilityCheckError.result | main/infrastructure/asana |
| src/main/infrastructure/asana/setup/capability-check.ts | AsanaCapabilityCheckService.currentTime | main/infrastructure/asana |
| src/main/infrastructure/asana/setup/capability-check.ts | AsanaCapabilityCheckService.readClient | main/infrastructure/asana |
| src/main/infrastructure/asana/setup/capability-check.ts | AsanaCapabilityCheckService.writeClient | main/infrastructure/asana |
| src/main/infrastructure/asana/setup/resource-coordinator.ts | AsanaSetupResourceCoordinator.readClient | main/infrastructure/asana |
| src/main/infrastructure/asana/setup/resource-coordinator.ts | AsanaSetupResourceCoordinator.setupClient | main/infrastructure/asana |
| src/main/infrastructure/asana/sync-run-reservation.ts | SyncRunReservation.activeRunController | main/infrastructure/asana |
| src/main/infrastructure/asana/sync-run-reservation.ts | SyncRunReservation.activeRunGeneration | main/infrastructure/asana |
| src/main/infrastructure/asana/sync-run-reservation.ts | SyncRunReservation.options | main/infrastructure/asana |
| src/main/infrastructure/asana/sync-run-reservation.ts | SyncRunReservation.runGeneration | main/infrastructure/asana |
| src/main/infrastructure/asana/sync-run-reservation.ts | SyncRunReservation.scheduledRun | main/infrastructure/asana |
| src/main/infrastructure/asana/sync/coordinator.ts | AsanaSyncCoordinator.cacheParsers | main/infrastructure/asana |
| src/main/infrastructure/asana/sync/coordinator.ts | AsanaSyncCoordinator.deltaSyncSource | main/infrastructure/asana |
| src/main/infrastructure/asana/sync/coordinator.ts | AsanaSyncCoordinator.fullSyncSource | main/infrastructure/asana |
| src/main/infrastructure/asana/sync/coordinator.ts | AsanaSyncCoordinator.planApplier | main/infrastructure/asana |
| src/main/infrastructure/asana/sync/coordinator.ts | AsanaSyncCoordinator.readClient | main/infrastructure/asana |
| src/main/infrastructure/asana/sync/coordinator.ts | AsanaSyncCoordinator.repository | main/infrastructure/asana |
| src/main/infrastructure/asana/sync/coordinator.ts | AsanaSyncCoordinator.resultSchema | main/infrastructure/asana |
| src/main/infrastructure/asana/sync/coordinator.ts | AsanaSyncCoordinator.synchronizationInProgress | main/infrastructure/asana |
| src/main/infrastructure/asana/sync/coordinator.ts | AsanaSyncCoordinator.timestampProvider | main/infrastructure/asana |
| src/main/infrastructure/asana/sync/delta-sync-source.ts | AsanaDeltaSyncSource.readClient | main/infrastructure/asana |
| src/main/infrastructure/asana/sync/full-sync-source.ts | AsanaFullSyncSource.readClient | main/infrastructure/asana |
| src/main/infrastructure/asana/sync/full-sync-source.ts | AsanaFullSyncSource.writeClient | main/infrastructure/asana |
| src/main/infrastructure/asana/sync/normalization-plan-applier.ts | AsanaNormalizationPlanApplier.readClient | main/infrastructure/asana |
| src/main/infrastructure/asana/sync/normalization-plan-applier.ts | AsanaNormalizationPlanApplier.uuidGenerator | main/infrastructure/asana |
| src/main/infrastructure/asana/sync/normalization-plan-applier.ts | AsanaNormalizationPlanApplier.writeClient | main/infrastructure/asana |
| src/main/infrastructure/asana/task-read-adapter.ts | AsanaTaskReadAdapter.runtime | main/infrastructure/asana |
| src/main/infrastructure/asana/task-write-call-adapter.ts | AsanaTaskWriteCallAdapter.readClient | main/infrastructure/asana |
| src/main/infrastructure/asana/task-write-call-adapter.ts | AsanaTaskWriteCallAdapter.transport | main/infrastructure/asana |
| src/main/infrastructure/asana/task-write-read-back-adapter.ts | AsanaTaskWriteReadBackAdapter.isNotFound | main/infrastructure/asana |
| src/main/infrastructure/asana/task-write-read-back-adapter.ts | AsanaTaskWriteReadBackAdapter.readClient | main/infrastructure/asana |
| src/main/infrastructure/asana/task-write-read-back-adapter.ts | AsanaTaskWriteReadBackAdapter.wait | main/infrastructure/asana |
| src/main/infrastructure/asana/token-provider.ts | AsanaMutableTokenProvider.provider | main/infrastructure/asana |
| src/main/infrastructure/asana/token-provider.ts | AsanaOAuthRefreshHttpError.cause | main/infrastructure/asana |
| src/main/infrastructure/asana/transport/errors.ts | AsanaEventsResetError.syncToken | main/infrastructure/asana |
| src/main/infrastructure/asana/transport/errors.ts | AsanaHttpError.errors | main/infrastructure/asana |
| src/main/infrastructure/asana/transport/errors.ts | AsanaHttpError.requestId | main/infrastructure/asana |
| src/main/infrastructure/asana/transport/errors.ts | AsanaHttpError.responseBodyKind | main/infrastructure/asana |
| src/main/infrastructure/asana/transport/errors.ts | AsanaHttpError.source | main/infrastructure/asana |
| src/main/infrastructure/asana/transport/errors.ts | AsanaHttpError.status | main/infrastructure/asana |
| src/main/infrastructure/asana/transport/transport.ts | AsanaTransport.lastRefreshSourceToken | main/infrastructure/asana |
| src/main/infrastructure/asana/transport/transport.ts | AsanaTransport.lastRefreshToken | main/infrastructure/asana |
| src/main/infrastructure/asana/transport/transport.ts | AsanaTransport.refreshState | main/infrastructure/asana |
| src/main/infrastructure/asana/transport/transport.ts | AsanaTransport.scheduler | main/infrastructure/asana |
| src/main/infrastructure/asana/transport/transport.ts | AsanaTransport.tokenProvider | main/infrastructure/asana |
| src/main/infrastructure/logging/jsonl-error-reporter.ts | JsonlErrorReporter.errorLogPath | main/infrastructure/logging |
| src/main/infrastructure/logging/jsonl-error-reporter.ts | JsonlErrorReporter.formatter | main/infrastructure/logging |
| src/main/infrastructure/logging/jsonl-error-reporter.ts | JsonlErrorReporter.knownSecrets | main/infrastructure/logging |
| src/main/infrastructure/logging/jsonl-error-reporter.ts | JsonlErrorReporter.logsPath | main/infrastructure/logging |
| src/main/infrastructure/logging/jsonl-error-reporter.ts | JsonlErrorReporter.reported | main/infrastructure/logging |
| src/main/infrastructure/logging/jsonl-error-reporter.ts | JsonlErrorReporter.writing | main/infrastructure/logging |
| src/main/infrastructure/obsidian/read-error.ts | ObsidianReadError.code | main/infrastructure/obsidian |
| src/main/infrastructure/obsidian/read-service.ts | ObsidianReadService.repository | main/infrastructure/obsidian |
| src/main/infrastructure/persistence/application-update-attempt-store.ts | ApplicationUpdateAttemptStore.file | main/infrastructure/persistence |
| src/main/infrastructure/persistence/diagnostic-log-repository.ts | SqliteDiagnosticLogRepository.deleteOlderStatement | main/infrastructure/persistence |
| src/main/infrastructure/persistence/diagnostic-log-repository.ts | SqliteDiagnosticLogRepository.insertStatement | main/infrastructure/persistence |
| src/main/infrastructure/persistence/diagnostic-log-repository.ts | SqliteDiagnosticLogRepository.parseEntry | main/infrastructure/persistence |
| src/main/infrastructure/persistence/diagnostic-log-repository.ts | SqliteDiagnosticLogRepository.runtime | main/infrastructure/persistence |
| src/main/infrastructure/persistence/diagnostic-log-repository.ts | SqliteDiagnosticLogRepository.selectAllStatement | main/infrastructure/persistence |
| src/main/infrastructure/persistence/persistence-runtime.ts | PersistenceRuntime.database | main/infrastructure/persistence |
| src/main/infrastructure/persistence/persistence-runtime.ts | PersistenceRuntime.lateTextFiles | main/infrastructure/persistence |
| src/main/infrastructure/persistence/persistence-runtime.ts | PersistenceRuntime.migrationBackupPaths | main/infrastructure/persistence |
| src/main/infrastructure/persistence/persistence-runtime.ts | PersistenceRuntime.textFiles | main/infrastructure/persistence |
| src/main/infrastructure/persistence/persistent-text-file.ts | PersistentTextFileHandle.closed | main/infrastructure/persistence |
| src/main/infrastructure/persistence/persistent-text-file.ts | PersistentTextFileHandle.filePath | main/infrastructure/persistence |
| src/main/infrastructure/persistence/persistent-text-file.ts | PersistentTextFileHandle.label | main/infrastructure/persistence |
| src/main/infrastructure/persistence/proposal-application-history-repository.ts | SqliteProposalApplicationHistoryRepository.rejectionIds | main/infrastructure/persistence |
| src/main/infrastructure/persistence/proposal-application-history-repository.ts | SqliteProposalApplicationHistoryRepository.reporter | main/infrastructure/persistence |
| src/main/infrastructure/persistence/proposal-application-history-repository.ts | SqliteProposalApplicationHistoryRepository.runtime | main/infrastructure/persistence |
| src/main/infrastructure/persistence/proposal-execution-repository.ts | SqliteProposalExecutionRepository.listeners | main/infrastructure/persistence |
| src/main/infrastructure/persistence/proposal-execution-repository.ts | SqliteProposalExecutionRepository.parsePlan | main/infrastructure/persistence |
| src/main/infrastructure/persistence/proposal-execution-repository.ts | SqliteProposalExecutionRepository.parseReceipt | main/infrastructure/persistence |
| src/main/infrastructure/persistence/proposal-execution-repository.ts | SqliteProposalExecutionRepository.reporter | main/infrastructure/persistence |
| src/main/infrastructure/persistence/proposal-execution-repository.ts | SqliteProposalExecutionRepository.resultSchema | main/infrastructure/persistence |
| src/main/infrastructure/persistence/proposal-execution-repository.ts | SqliteProposalExecutionRepository.runtime | main/infrastructure/persistence |
| src/main/infrastructure/persistence/secret-storage.ts | SecretStorage.file | main/infrastructure/persistence |
| src/main/infrastructure/persistence/secret-storage.ts | SecretStorage.rememberLegacySecrets | main/infrastructure/persistence |
| src/main/infrastructure/persistence/settings-repository.ts | SqliteSettingsRepository.clearStatement | main/infrastructure/persistence |
| src/main/infrastructure/persistence/settings-repository.ts | SqliteSettingsRepository.parseSettings | main/infrastructure/persistence |
| src/main/infrastructure/persistence/settings-repository.ts | SqliteSettingsRepository.saveStatement | main/infrastructure/persistence |
| src/main/infrastructure/persistence/settings-repository.ts | SqliteSettingsRepository.selectStatement | main/infrastructure/persistence |
| src/main/infrastructure/persistence/setup-checkpoint-store.ts | SetupCheckpointStore.file | main/infrastructure/persistence |
| src/main/infrastructure/persistence/setup-checkpoint-store.ts | SetupCheckpointStore.parseState | main/infrastructure/persistence |
| src/main/infrastructure/persistence/task-read-repository.ts | TaskReadPersistenceRepository.contracts | main/infrastructure/persistence |
| src/main/infrastructure/persistence/task-read-repository.ts | TaskReadPersistenceRepository.runtime | main/infrastructure/persistence |
| src/main/infrastructure/persistence/vault-mapping-repository.ts | SqliteVaultMappingRepository.saveStatement | main/infrastructure/persistence |
| src/main/infrastructure/persistence/vault-mapping-repository.ts | SqliteVaultMappingRepository.selectAllStatement | main/infrastructure/persistence |
| src/main/infrastructure/persistence/window-state-store.ts | WindowStateStore.file | main/infrastructure/persistence |
| src/main/ipc/register-ipc.ts | FeatureIpcRegistry.activeInvokes | main/ipc |
| src/main/ipc/register-ipc.ts | FeatureIpcRegistry.options | main/ipc |
| src/main/ipc/register-ipc.ts | FeatureIpcRegistry.registeredIpcMain | main/ipc |
| src/main/ipc/register-ipc.ts | FeatureIpcRegistry.removers | main/ipc |
| src/main/ipc/register-ipc.ts | FeatureIpcRegistry.stopped | main/ipc |
| src/main/ipc/register-ipc.ts | FeatureIpcRegistry.subscriptions | main/ipc |
| src/main/ipc/register-ipc.ts | FeatureIpcRegistry.windows | main/ipc |

## IPC channel

channel文字列の正本は`src/shared/ipc-contracts`の機能別channel定義です。配送ownerは全件`main/ipc`と`preload`、契約ownerは`shared/ipc-contracts`です。

| channel | 機能owner |
| --- | --- |
| system:get-version | main/bootstrap |
| system:wait-for-startup | main/bootstrap |
| system:get-update-state | main/bootstrap |
| system:update-state:subscribe | main/bootstrap |
| system:update-state:unsubscribe | main/bootstrap |
| system:update-state | main/bootstrap |
| tasks:get-overview | main/application/task-read |
| tasks:get-detail | main/application/task-read |
| tasks:get-sync-state | main/application/task-read |
| tasks:run-sync | main/application/task-read |
| tasks:apply-edit | main/application/gui-edit |
| tasks:get-execution | main/application/gui-edit |
| tasks:retry-execution | main/application/gui-edit |
| tasks:sync-state:subscribe | main/application/task-read |
| tasks:sync-state:unsubscribe | main/application/task-read |
| tasks:sync-state | main/application/task-read |
| tasks:execution:subscribe | main/application/gui-edit |
| tasks:execution:unsubscribe | main/application/gui-edit |
| tasks:execution | main/application/gui-edit |
| settings:get-state | main/application/settings |
| settings:start | main/application/settings |
| settings:complete-codex-authentication | main/application/settings |
| settings:begin-asana-authorization | main/application/settings |
| settings:complete-asana-authorization | main/application/settings |
| settings:cancel-asana-authorization | main/application/settings |
| settings:list-workspaces | main/application/settings |
| settings:select-workspace | main/application/settings |
| settings:select-project | main/application/settings |
| settings:retry-resources | main/application/settings |
| settings:run-capability | main/application/settings |
| settings:choose-vault | main/application/settings |
| settings:run-full-sync | main/application/settings |
| settings:run-codex-capability | main/application/settings |
| settings:get-asana-authentication-state | main/application/settings |
| settings:begin-asana-reauthentication | main/application/settings |
| settings:complete-asana-reauthentication | main/application/settings |
| settings:cancel-asana-reauthentication | main/application/settings |
| proposals:get-ai-status | main/application/proposal-generate |
| proposals:start-session | main/application/proposal-generate |
| proposals:start-turn | main/application/proposal-generate |
| proposals:get-proposal | main/application/proposal-generate |
| proposals:select | main/application/proposal-generate |
| proposals:edit-operation | main/application/proposal-generate |
| proposals:reject | main/application/proposal-generate |
| proposals:approve | main/application/proposal-apply |
| proposals:close-session | main/application/proposal-generate |
| proposals:get-external-state | main/application/proposal-apply |
| proposals:set-external-enabled | main/application/proposal-generate |
| proposals:edit-external-operation | main/application/proposal-apply |
| proposals:select-external | main/application/proposal-apply |
| proposals:approve-external | main/application/proposal-apply |
| proposals:reject-external | main/application/proposal-apply |
| proposals:get-history-status | main/application/proposal-apply |
| proposals:confirm-history | main/application/proposal-apply |
| proposals:synchronize-history | main/application/proposal-apply |
| proposals:get-execution | main/application/proposal-apply |
| proposals:list-executions | main/application/proposal-apply |
| proposals:retry-execution | main/application/proposal-apply |
| proposals:ai-status:subscribe | main/application/proposal-generate |
| proposals:ai-status:unsubscribe | main/application/proposal-generate |
| proposals:ai-status | main/application/proposal-generate |
| proposals:ai-delta:subscribe | main/application/proposal-generate |
| proposals:ai-delta:unsubscribe | main/application/proposal-generate |
| proposals:ai-delta | main/application/proposal-generate |
| proposals:external-state:subscribe | main/application/proposal-apply |
| proposals:external-state:unsubscribe | main/application/proposal-apply |
| proposals:external-state | main/application/proposal-apply |
| proposals:execution:subscribe | main/application/proposal-apply |
| proposals:execution:unsubscribe | main/application/proposal-apply |
| proposals:execution | main/application/proposal-apply |
| obsidian-integration:validate-vault | main/application/obsidian-integration |
| obsidian-integration:list-vaults | main/application/obsidian-integration |
| obsidian-integration:list-vault-mappings | main/application/obsidian-integration |
| obsidian-integration:save-vault-mapping | main/application/obsidian-integration |
| obsidian-integration:resolve-path | main/application/obsidian-integration |
| obsidian-integration:note-exists | main/application/obsidian-integration |
| obsidian-integration:open-note | main/application/obsidian-integration |
| diagnostics:report | main/infrastructure/logging |

## 変更案の操作

識別子は`src/main/domain/proposal.ts`の`proposalOperationSchema`から抽出しています。操作契約は`main/domain`、handler登録とstep計画は`main/application/common`、変更案の承認と適用は`main/application/proposal-apply`が所有します。共通stepの実行は`main/application/task-write`、IPC DTOは`shared/ipc-contracts`が所有します。

| operation | 操作契約owner | handler・step計画owner | 承認・適用owner |
| --- | --- | --- | --- |
| clear_due | main/domain | main/application/common | main/application/proposal-apply |
| clear_duration | main/domain | main/application/common | main/application/proposal-apply |
| complete | main/domain | main/application/common | main/application/proposal-apply |
| create_task | main/domain | main/application/common | main/application/proposal-apply |
| link_obsidian | main/domain | main/application/common | main/application/proposal-apply |
| set_area | main/domain | main/application/common | main/application/proposal-apply |
| set_dependencies | main/domain | main/application/common | main/application/proposal-apply |
| set_due | main/domain | main/application/common | main/application/proposal-apply |
| set_duration | main/domain | main/application/common | main/application/proposal-apply |
| set_importance | main/domain | main/application/common | main/application/proposal-apply |
| set_parent | main/domain | main/application/common | main/application/proposal-apply |
| set_parent_work_mode | main/domain | main/application/common | main/application/proposal-apply |
| set_status | main/domain | main/application/common | main/application/proposal-apply |
| unlink_obsidian | main/domain | main/application/common | main/application/proposal-apply |
| update_notes | main/domain | main/application/common | main/application/proposal-apply |
| update_title | main/domain | main/application/common | main/application/proposal-apply |
| withdraw | main/domain | main/application/common | main/application/proposal-apply |

## 保存形式

| 形式 | 保存先または対象 | source | 利用上のowner |
| --- | --- | --- | --- |
| SQLite | taskhub.sqlite3 | src/main/bootstrap/create-main-runtime.ts | main/infrastructure/persistence |
| 暗号化JSON | secret-storage.json | src/main/bootstrap/create-main-runtime.ts | main/infrastructure/persistence |
| 初回設定JSON | setup-checkpoint.json | src/main/bootstrap/create-main-runtime.ts | main/application/settings |
| ウィンドウJSON | window-state.json | src/main/bootstrap/create-main-runtime.ts | main/bootstrap |
| 更新試行JSON | application-update-attempt.json | src/main/bootstrap/create-main-runtime.ts | main/bootstrap |
| エラーJSONL | taskhub-error.log | src/main/infrastructure/logging/jsonl-error-reporter.ts | main/infrastructure/logging |
| 外部Codex設定JSON | external-agent/config.json | src/main/infrastructure/ai/external-agent/resources.ts | main/application/settings |
| 外部Codex接続JSON | external-agent/connection.json | src/main/infrastructure/ai/external-agent/resources.ts | main/infrastructure/ai |
| taskctl接続JSON | taskctl-connection.json | src/main/infrastructure/ai/taskctl/broker.ts | main/infrastructure/ai |
| Codex作業資源 | codex-workspace/ と codex-home/ | src/main/infrastructure/ai/codex-workspace/schemas.ts | main/infrastructure/ai |
| Asana Custom external data | Asana task external data | src/main/domain/external-data.ts | main/domain |

| 形式 | version | source | version symbol |
| --- | --- | --- | --- |
| SQLite | 11 | src/main/infrastructure/persistence/sqlite-schema.ts | storageSchemaVersion |
| 初回設定JSON | 3 | src/main/infrastructure/persistence/setup-checkpoint-store.ts | checkpointVersion |
| 暗号化JSON | 2 | src/main/infrastructure/persistence/secret-storage.ts | encryptedFileVersion |
| ウィンドウJSON | 1 | src/main/infrastructure/persistence/window-state-store.ts | windowStateVersion |
| Asana Custom external data | 1 | src/main/domain/external-data.ts | customExternalDataSchemaVersion |

SQLite接続とtransactionは`main/infrastructure/persistence`が所有し、SQLite schemaのversionは上記の値です。

| SQLite table | 利用上のowner |
| --- | --- |
| application_journal | main/application/proposal-apply |
| cleanup_items_cache | main/application/task-read |
| device_settings | main/application/settings |
| diagnostic_log | main/infrastructure/logging |
| legacy_application_history | main/application/proposal-apply |
| pending_normalization_baseline | main/application/task-read |
| project_metadata_cache | main/application/task-read |
| proposal_execution_steps | main/application/task-write |
| proposal_executions | main/application/task-write |
| ranking_cache | main/application/task-read |
| sync_state | main/application/task-read |
| task_cache | main/application/task-read |
| vault_mappings | main/application/obsidian-integration |

| SQLite table | DDL正本 |
| --- | --- |
| application_journal | src/main/infrastructure/persistence/sqlite-schema.ts |
| cleanup_items_cache | src/main/infrastructure/persistence/sqlite-schema.ts |
| device_settings | src/main/infrastructure/persistence/sqlite-schema.ts |
| diagnostic_log | src/main/infrastructure/persistence/sqlite-schema.ts |
| legacy_application_history | src/main/infrastructure/persistence/sqlite-schema.ts |
| pending_normalization_baseline | src/main/infrastructure/persistence/sqlite-schema.ts |
| project_metadata_cache | src/main/infrastructure/persistence/sqlite-schema.ts |
| proposal_execution_steps | src/main/infrastructure/persistence/proposal-execution-schema.ts |
| proposal_executions | src/main/infrastructure/persistence/proposal-execution-schema.ts |
| ranking_cache | src/main/infrastructure/persistence/sqlite-schema.ts |
| sync_state | src/main/infrastructure/persistence/sqlite-schema.ts |
| task_cache | src/main/infrastructure/persistence/sqlite-schema.ts |
| vault_mappings | src/main/infrastructure/persistence/sqlite-schema.ts |
