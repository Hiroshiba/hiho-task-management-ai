# アーキテクチャ

この文書はアプリ全体の機能境界と依存方向の決定を定めます。現行のファイル、状態、IPC、保存形式の対応は [current-source-map.md](current-source-map.md) に記録します。現行の業務仕様と保存契約は [要件・設計書](../requirements_and_design.md) を正本とします。

## 配置と責任

| 配置 | 責任 |
| --- | --- |
| `src/shared/ipc-contracts` | Main、preload、Renderer間の直列化可能なDTOとchannel名 |
| `src/main/bootstrap` | `create-main-runtime.ts`で実装を組み立て、`register-main-lifecycle.ts`で起動と停止、`MainWindowRuntime`でウィンドウ、`OperationalEventRuntime`で運用監視を管理 |
| `src/main/domain` | 外部入出力を持たない業務規則 |
| `src/main/application/common` | workflow間で共有するport、error・診断契約、書き込み計画と検証スキーマ、17操作のmanifest |
| `src/main/application/task-read` | タスク取得、同期結果の反映、順位と一覧の提供 |
| `src/main/application/task-write` | 共通の書き込み計画の実行、step状態と再試行の制御 |
| `src/main/application/proposal-generate` | 変更案の生成、検証、編集 |
| `src/main/application/proposal-apply` | 変更案の承認、適用、復旧 |
| `src/main/application/gui-edit` | GUI直接編集を共通の書き込み計画へ変換 |
| `src/main/application/settings` | 初回設定、Asana認証、端末設定 |
| `src/main/application/system` | アプリの起動完了、版、更新状態を提供する公開契約 |
| `src/main/application/obsidian-integration` | Vault設定とObsidian参照 |
| `src/main/infrastructure/asana` | Asana認証、transport、同期、書き込みadapter |
| `src/main/infrastructure/obsidian` | 読み取り専用Vault adapter |
| `src/main/infrastructure/ai` | Codex、外部エージェント、taskctl接続 |
| `src/main/infrastructure/persistence` | SQLite、JSON、transaction、移行 |
| `src/main/infrastructure/logging` | errorとwarningの一元記録 |
| `src/main/ipc/handlers` | 1 use caseにつき1 handlerの入力検証とDTO変換 |
| `src/main/ipc/register-ipc.ts` | handler登録と解除 |
| `src/preload/index.ts` | 検証済みtransportの公開 |
| `src/renderer/app`, `src/renderer/env.d.ts` | 画面の配置、起動、OS配色、全体のエラー境界、Rendererの環境型宣言 |
| `src/renderer/features/tasks` | タスク閲覧と直接編集のUI状態 |
| `src/renderer/features/proposals` | 変更案生成、確認、適用、復旧のUI状態 |
| `src/renderer/features/settings` | 設定画面のUI状態 |
| `src/renderer/features/system` | 自動更新の表示状態と購読 |
| `src/renderer/features/obsidian-integration` | Vaultとノート参照のUI状態 |
| `src/renderer/shared/api` | feature APIの注入キーと取得関数 |
| `src/renderer/shared/components`, `src/renderer/shared/format`, `src/renderer/shared/logging`, `src/renderer/shared/mock` | featureに依存しない部品、日時変換、診断、mock選択 |

`src/main/index.ts`と`src/renderer/index.html`はビルド入口であり、業務ロジックと可変状態を持ちません。自動更新とウィンドウのライフサイクルはbootstrapが管理します。外部Codexとtaskctlの接続および外部エージェントのtransportはAI infrastructureが担います。外部提案の準備、文脈、ワークスペース、提出要求はproposal-generateが管理し、提出済みrecord、確認、承認、適用、履歴はproposal-applyが管理します。両workflowは共有portで接続します。永続化固有のスキーマは`src/main/infrastructure/persistence`、workflow間で共有するplanとstepの検証スキーマは`src/main/application/common`にあります。画面フィルターは`src/renderer/features/tasks/task-filter.ts`が管理します。境界を越えて渡す値だけをIPC契約に置きます。

AI変更案の保持、会話根拠、取り下げ確認、生成世代は`ProposalGenerationState`がセッション単位で管理します。Codexターンは`application/common/ports/proposal-generation-session.ts`のportから呼び出し、AI応答の構造検証と訂正再試行を外部書き込みより先に完了します。承認時の再取得、基準値の照合、適用、保持値の削除は`proposal-apply`が順に実行します。AI状態と差分のMain側購読は`AiEventRuntime`、IPCからの提案操作の配送は`src/main/ipc/handlers/proposals.ts`が管理します。

変更案とタスクは公開入力のスキーマで完全に検証してから、`main/domain/proposal-analysis`の非永続投影を基本検証、関係グラフ検証、承認競合分類に渡します。投影を公開入力の受理判定や保存形式に使用しません。承認後の関係グラフは、競合分類で実行可能と判定した操作だけを検証します。

## 依存方向

| import元 | 許可する内部依存 | 禁止する依存 |
| --- | --- | --- |
| `main/domain` | 同一domain内の純粋なcode | application、infrastructure、IPC、Electron、Vue、SDK、DB、filesystem |
| `main/application/common` | domain、同一common内 | 個別workflow、infrastructure、IPC、Electron、Vue |
| `main/application/<workflow>` | domain、common、同一workflow内 | 別workflow、infrastructure、IPC、Electron、Vue、SDK |
| `main/infrastructure` | domain、commonのport・error・診断契約、同一adapter群、外部SDK | 個別workflowの内部型、IPC、Renderer |
| `main/ipc` | IPC契約、workflowの公開入口、commonのerror・診断契約、同一IPC内 | infrastructure、業務判断、永続化処理 |
| `main/bootstrap` | Mainの公開入口、common、IPC handlerのfactoryと登録入口、IPC契約 | 業務判断、DTO変換、外部書き込み |
| `preload` | Electron、IPC契約、同一preload内 | Main実装、Renderer実装、業務判断 |
| `renderer/features/<feature>` | 同一feature、renderer/shared、IPC契約 | Main、preload実装、別feature内部 |
| `renderer/app` | featureの公開入口、renderer/shared、IPC契約 | feature内部、外部API直接呼び出し |
| `renderer/shared` | 同一shared、IPC契約 | feature、Main、preload実装 |
| `shared/ipc-contracts` | 同一契約内 | Main、preload、Renderer実装 |

各workflow、infrastructure adapter群、renderer featureの公開入口は、そのownerディレクトリ直下の`index.ts`です。bootstrapからworkflowとinfrastructure、IPCからworkflow、renderer/appからfeatureを読むときは、この入口だけを使います。内部階層の`index.ts`は公開入口になりません。workflow間の契約は`application/common`だけに置きます。変更案とGUI編集は`application/common/task-write-plan.ts`を共有し、相互の内部型を参照しません。re-exportで境界違反を隠しません。

`renderer/shared/format`はfeatureに依存しない日時の検証と日本時間への変換を担います。入力エラーの利用者向け文面は各featureが決めます。toastはアプリのmountごとに`renderer/shared/components`のstoreを生成し、子部品へ注入してunmount時に破棄します。

`create-main-runtime.ts`だけがconcrete adapter、repository、logger、clock、ID生成器、外部clientを生成してportへ注入します。module import時に外部clientを作らず、実行時の設定値をmoduleの可変変数へ保持しません。診断記録状態は`application/common/errors/diagnostic-failure.ts`を共通契約として、workflow、infrastructure、IPC、bootstrapが参照します。IPCは入力をZodで検証してuse caseを呼び、返り値をDTOへ変換します。preloadはtransportのみ、Rendererは表示とUI状態のみを担当します。

保存済み基準ハッシュとGUI編集基準ハッシュの入力はdomainで検証して正規化します。同期SHA-256は`application/common/ports/snapshot-hasher.ts`の境界を通し、`create-main-runtime.ts`がinfrastructure実装を注入します。ログはErrorのmessage、stack、cause、AggregateErrorの各要素だけを構造化し、Error以外の任意オブジェクトは型だけを記録します。既知secretは各文字列をJSON化する前に伏せ字にし、保存失敗時の標準エラー出力にも同じ規則を適用します。MainRuntimeが一度読んだsecretは、変更や削除後も古いErrorに含まれ得るため、dispose後の終了時診断を含めてMainプロセス終了まで伏せ字対象として保持します。Mainとは別のプロセスで動く外部連携クライアントは、入力やOS由来の例外文面を出力せず、安全な定型文だけを標準エラー出力と失敗応答へ渡します。

IPCのinvokeは送信元、要求、応答を検証し、検証やhandlerが例外を投げた場合は元のエラーをMainのerror reporterへ一度記録します。記録済みの失敗は同じerror IDを再利用します。Rendererへ返す例外時の応答は分類コード、短い日本語説明、error IDを含み、stackとcauseはMainの診断ログに保持します。Rendererからの診断送信も同じ成功・失敗応答形式を使います。

購読通知の検証と未処理のlistener例外はpreloadが元の失敗を一度だけ診断IPCへ送り、購読したfeatureへ失敗開始と記録結果を通知します。診断IPCの失敗応答にあるerror IDは元の失敗のIDとして表示しません。featureは状態を特定できる失敗の開始時に古い成功状態を失効させ、実行対象を特定できない失敗は一度だけ通知します。後続の正常通知や初期取得より古い記録結果は表示せず、購読解除後の記録結果は画面へ渡しません。

変更案のIPC表示値は17操作を操作種別ごとの後値、変更前値、対象、作成経緯、状態根拠とともに検証します。Mainは基準ハッシュ、基本検証、グラフ検証、選択状態、順位影響を変更案の表示値から投影し、Rendererで再計算しません。編集要求は操作種別に対応する後値を契約で検証し、Mainで保持中の操作IDと種別を照合してからworkflowへ渡します。外部変更案は提案IDと表示版も保持中の状態と照合します。

初回設定のIPC要求・応答を検証するZod契約は`shared/ipc-contracts`に一元化し、`main/domain`には内部状態の型と検証スキーマを置きます。settings workflowの検証は起動側からparser portとして注入し、workflowからIPC契約を直接参照しません。IPCの基本schemaの組立ても`shared/ipc-contracts`内で完結し、Mainのdomainへ依存しません。

ObsidianのVault設定と読取は`application/obsidian-integration`が操作順と競合を管理し、`infrastructure/obsidian`がfilesystemを参照します。Vaultの実体パス検証後だけマッピングを保存し、保存後にCodexへ読取専用パスを反映します。ノートの本文をAsana external dataへ書き込まず、Obsidianリンクの更新はAsana側の責務とします。

AIのタスク参照には同期済みキャッシュを読む`taskctl`、外部情報の参照には登録済みVaultを読む`obsidian` dynamic toolを使います。外部Codexからの提案は`external_review`として既存の検証・承認経路へ渡します。アプリ本体の更新はGitHub Releasesから取得し、bootstrapと`renderer/features/system`が更新状態を管理します。署名・公開用のGitHub Appは中央の公開workflowで使います。

## 構造と状態の不変条件

`node scripts/check-architecture.mjs --all`と`--changed`は、現在の全sourceを同じ規則で検査します。文字列リテラルと置換なしテンプレートによる`import()`・`require()`、TypeScriptの`import()`型も依存に含めます。import方向、循環依存、旧path、module直下の可変状態に違反があれば失敗します。content hash cacheは解析結果の再利用だけに使い、診断の判定は実行のたびに全sourceへ適用します。CIも`--all`で同じ規則を適用します。

変更案の通常適用は17操作の共通manifestからstepを生成し、GUI直接編集も対応する操作をこのmanifestへ渡します。GUI固有の活動日更新と状態修復は、実際のAsana callごとにstepへ分けて同じ`TaskWritePlan`へまとめます。全stepは実行前にjournalへ保存し、通常実行と復旧は共通engineとexecutorで保存済みplanを実行します。復旧時にhandlerからplanを再生成せず、外部書き込みの成功が不明なstepを自動再送しません。

`legacy-*`、`compat-*`、`adapter-old-*`というファイルとディレクトリは配置先に関係なく禁止します。SQLite、初回設定JSON、暗号化JSON、ウィンドウJSON、Asana Custom external dataを読み書きできる状態を保ち、保存形式の移行は原子的かつ冪等にします。

Mainの公開入口は`src/main/bootstrap/create-main-runtime.ts`から生成し、`main-workflow-construction.ts`がworkflowとruntimeを依存順に生成します。`main-workflow-composition.ts`は公開portと起動・終了入口を結線します。SQLite移行処理はpersistence adapterが担当します。

全sourceが上記の唯一のownerに属し、workflow間の直接import、循環依存、module直下の可変状態候補、旧pathと互換exportがありません。`const`で宣言したmodule直下のオブジェクトも、memberへの代入や更新があれば可変状態候補です。MainとRendererの状態は [state-ownership.md](state-ownership.md)、外部書き込みと復旧は [proposal-execution.md](proposal-execution.md) の契約に従います。構造検査と行数検査をCIで実行し、1000行超をerror、401行から1000行をreview対象として扱います。

Electron、Vite、TypeScript、pnpm、Tailwind CSS、Vue、Reka UIを維持します。mock選択はURLの`mock`を1回だけ解析し、`mock=all`と機能名のカンマ区切りを扱います。feature APIの実transportとmock transportは`renderer/app`の単一registryで選び、指定のない機能は実transportを使います。OSの配色変更は再起動なしで反映します。
