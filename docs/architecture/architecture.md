# アーキテクチャ

この文書はアプリ全体の機能境界と依存方向の決定を定めます。現行のファイル、状態、IPC、保存形式の対応は [current-source-map.md](current-source-map.md) に記録します。現行の業務仕様と保存契約は [要件・設計書](../requirements_and_design.md) を正本とします。

## 最終配置と責任

| 配置 | 責任 |
| --- | --- |
| `src/shared/ipc-contracts` | Main、preload、Renderer間の直列化可能なDTOとchannel名 |
| `src/main/bootstrap` | `create-main-runtime.ts`で実装を組み立て、`register-main-lifecycle.ts`で起動と停止を管理 |
| `src/main/domain` | 外部入出力を持たない業務規則 |
| `src/main/application/common` | workflow間で共有するport、error契約、`task-write-plan.ts` |
| `src/main/application/task-read` | タスク取得、同期結果の反映、順位と一覧の提供 |
| `src/main/application/task-write` | 共通の書き込み計画と実行入口 |
| `src/main/application/proposal-generate` | 変更案の生成、検証、編集 |
| `src/main/application/proposal-apply` | 承認、適用、復旧、17操作のhandler |
| `src/main/application/gui-edit` | GUI直接編集を共通の書き込み計画へ変換 |
| `src/main/application/settings` | 初回設定、Asana認証、端末設定 |
| `src/main/application/github-integration` | GitHub連携のuse case。現行アプリにGitHub App実装はない |
| `src/main/application/obsidian-integration` | Vault設定とObsidian参照 |
| `src/main/infrastructure/asana` | Asana認証、transport、同期、書き込みadapter |
| `src/main/infrastructure/github` | GitHub client adapter。連携機能が使われるまで初期化しない |
| `src/main/infrastructure/obsidian` | 読み取り専用Vault adapter |
| `src/main/infrastructure/ai` | Codex、外部エージェント、ツール接続 |
| `src/main/infrastructure/persistence` | SQLite、JSON、transaction、移行 |
| `src/main/infrastructure/logging` | errorとwarningの一元記録 |
| `src/main/infrastructure/clock` | 時刻とID生成の実装 |
| `src/main/ipc/handlers` | 1 use caseにつき1 handlerの入力検証とDTO変換 |
| `src/main/ipc/register-ipc.ts` | handler登録と解除 |
| `src/preload/index.ts`, `src/preload/bridge.ts` | 検証済みtransportの公開 |
| `src/renderer/app` | 画面の配置、起動、OS配色、全体のエラー境界 |
| `src/renderer/features/tasks` | タスク閲覧と直接編集のUI状態 |
| `src/renderer/features/proposals` | 変更案生成、確認、適用、復旧のUI状態 |
| `src/renderer/features/settings` | 設定画面のUI状態 |
| `src/renderer/features/github-integration` | GitHub連携画面のUI状態 |
| `src/renderer/features/obsidian-integration` | Vaultとノート参照のUI状態 |
| `src/renderer/shared/api`, `components`, `logging`, `mock` | featureに依存しないtransport、部品、診断、mock選択 |

`src/main/index.ts`と`src/renderer/index.html`は既存のビルド入口として残し、業務ロジックと可変状態を持たせません。自動更新とウィンドウのライフサイクルはbootstrapが管理します。外部Codexとtaskctlの接続および外部エージェントのtransportはAI infrastructureが担います。`external-agent/service.ts`に同居する提案基準と生成、提出後の確認と承認・適用は、それぞれproposal-generateとproposal-applyへ分けます。`shared/storage/schemas.ts`の保存形式はpersistenceへ、`shared/view-model/task-filter.ts`の画面フィルターはrendererのtasksへ移します。境界を越えて渡す値だけをIPC契約に置きます。

## 依存方向

| import元 | 許可する内部依存 | 禁止する依存 |
| --- | --- | --- |
| `main/domain` | 同一domain内の純粋なcode | application、infrastructure、IPC、Electron、Vue、SDK、DB、filesystem |
| `main/application/common` | domain、同一common内 | 個別workflow、infrastructure、IPC、Electron、Vue |
| `main/application/<workflow>` | domain、common、同一workflow内 | 別workflow、infrastructure、IPC、Electron、Vue、SDK |
| `main/infrastructure` | domain、commonのport、同一adapter群、外部SDK | 個別workflowの内部型、IPC、Renderer |
| `main/ipc` | IPC契約、workflowの公開入口、同一IPC内 | infrastructure、業務判断、永続化処理 |
| `main/bootstrap` | Mainの公開入口とIPC契約 | 業務判断、DTO変換、外部書き込み |
| `preload` | Electron、IPC契約、同一preload内 | Main実装、Renderer実装、業務判断 |
| `renderer/features/<feature>` | 同一feature、renderer/shared、IPC契約 | Main、preload実装、別feature内部 |
| `renderer/app` | featureの公開入口、renderer/shared、IPC契約 | feature内部、外部API直接呼び出し |
| `renderer/shared` | 同一shared、IPC契約 | feature、Main、preload実装 |
| `shared/ipc-contracts` | 同一契約内 | Main、preload、Renderer実装 |

各workflow、infrastructure adapter群、renderer featureの公開入口は、そのownerディレクトリ直下の`index.ts`です。bootstrapからworkflowとinfrastructure、IPCからworkflow、renderer/appからfeatureを読むときは、この入口だけを使います。内部階層の`index.ts`は公開入口になりません。workflow間の契約は`application/common`だけに置きます。変更案とGUI編集は`application/common/task-write-plan.ts`を共有し、相互の内部型を参照しません。re-exportで境界違反を隠しません。

`create-main-runtime.ts`だけがconcrete adapter、repository、logger、clock、ID生成器、外部clientを生成してportへ注入します。module import時に外部clientを作らず、実行時の設定値をmoduleの可変変数へ保持しません。IPCは入力をZodで検証してuse caseを呼び、返り値をDTOへ変換します。preloadはtransportのみ、Rendererは表示とUI状態のみを担当します。

## 移行中と最終形の不変条件

移行中は既存データ形式、既存IPC、既存Rendererの動作を維持します。新しい境界違反を追加せず、現行違反だけを`structure-migration-baseline.json`にpath、rule、symbol単位で固定し、解消したentryを同じ変更で削除します。baselineの初期集合はhashで固定し、Gitの全履歴を使って各更新後の集合が直前の集合を超えないことを検査します。新しい違反や解消済みの違反をbaselineへ追加できません。通常適用、復旧、GUI編集の切替前には17操作すべての新handlerと保存済みplanの復旧を揃えます。新旧を操作ごとに選択せず、MainRuntimeの単一の切替点でまとめて切り替えます。外部書き込みの成功が不明なstepを自動再送しません。

移行中に旧実装と接続するファイルは`src/main/bootstrap/legacy-runtime-port.ts`、`src/main/infrastructure/persistence/legacy-proposal-execution-repository.ts`、`src/main/application/proposal-apply/legacy-format-router.ts`の3つに限定します。これら以外の`legacy-*`、`compat-*`、`adapter-old-*`というファイルとディレクトリは配置先に関係なく禁止します。3ファイルは旧データの読込と切替に必要な期間だけ存在し、最終形では削除します。既存のSQLite v5、初回設定JSON v2、暗号化JSON v1、ウィンドウJSON v1、Asana Custom external data v1を読み書きできる状態を保ち、旧形式の移行は原子的かつ冪等にします。

最終形では全sourceが上記の唯一のownerに属し、workflow間の直接import、循環依存、module直下の可変状態候補、旧pathと互換exportがありません。`const`で宣言したmodule直下のオブジェクトも、memberへの代入や更新があれば可変状態候補です。MainとRendererの状態は [state-ownership.md](state-ownership.md)、外部書き込みと復旧は [proposal-execution.md](proposal-execution.md) の契約に従います。構造検査と行数検査をCIで実行し、1000行超をerror、401行から1000行をreview対象として扱います。

Electron、Vite、TypeScript、pnpm、Tailwind CSS、Vue、Reka UIを維持します。mock選択はURLの`mock`を1回だけ解析し、`mock=all`と機能名のカンマ区切りを扱います。OSの配色変更は再起動なしで反映します。GitHub Appの環境変数がない端末でも起動、lint、型検査、構造検査、build、mock表示を実行できます。
