# 行数レビュー

手編集する`src`のTypeScript、Vue、CSS、HTML、`scripts`のコード、ルートのコード設定は401行から1000行を分割検討の対象とし、1001行以上をerrorにします。警告対象を残す場合は、単一責務と分割しない理由をpathごとに記録します。自動生成コードと純粋なmockデータだけを除外可能とし、現在の除外pathはありません。mock APIの実装は検査対象です。

| path | 単一責務 | 分割しない理由 |
| --- | --- | --- |
| `src/main/ai/proposal-workspace/service.ts` | 変更案workspaceの下書きと検証状態を管理する | 下書き、修正、提出の判定が同じrevisionとgroup状態を参照し、分割すると更新時の整合条件が複数箇所へ散るため。 |
| `src/main/ai/workflow/service.ts` | AIターンから変更案確定までのworkflowを進める | ターン中の証拠、再試行、承認準備が同じ進行状態を引き継ぎ、別ownerにすると確定前の状態を重複保持するため。 |
| `src/main/application/common/proposal-application-schemas.ts` | 変更案適用の入力と結果の契約を定義する | 適用、同期失敗、復旧の結果を一つの判別可能な契約として検証しており、分割すると結果の対応漏れを検出しにくくなるため。 |
| `src/main/application/proposal-generate/evidence-inheritance.ts` | 変更案編集時に継承可能な証拠を選ぶ | 状態変更と分割作成の参照を同じ基準案と対象照合で選び、分割すると証拠の採用条件がずれるため。 |
| `src/main/application/settings/setup-workflow.ts` | 初回設定の段階と完了状態を管理する | 認証、資源確認、保存の順序を一つの状態遷移で保証しており、段階ごとに分けると再開条件を複数ownerへ渡すため。 |
| `src/main/application/task-read/task-read-index.ts` | 読取済みタスクから一覧用索引を構築する | 状態、依存、順位、表示行が同じスナップショットの投影であり、別々に構築すると一覧内の時点がずれるため。 |
| `src/main/asana/client/task-write-client.ts` | Asanaのタスク書込操作をAPI要求へ変換する | 作成、更新、所属変更が同じタスク応答契約と要求検証を使い、操作別に分割すると書込結果の検証が重複するため。 |
| `src/main/asana/operation-queue.ts` | Asana操作の実行順を管理する | 待機、実行、中断が同じqueue状態を更新し、分割すると順序と終了処理のownerが分かれるため。 |
| `src/main/asana/runtime/service.ts` | Asana同期runtimeの起動と停止を管理する | online監視、定期同期、実行中の同期が同じ接続状態とtimerを共有し、分割すると重複起動を防ぐ状態が散るため。 |
| `src/main/asana/setup/capability-check.ts` | Asana資源の読取・書込能力を確認する | 試験用タスクの作成、読戻し、後片付けを一続きで扱い、分割すると試験失敗時の後片付けを追いにくくなるため。 |
| `src/main/asana/setup/manifest.ts` | 初回設定で必要なAsana資源の宣言と照合を定義する | sectionとtagの定義を同じmanifestに集めて構成済み資源と照合し、分割すると要求資源の集合が二重管理になるため。 |
| `src/main/asana/setup/resource-coordinator.ts` | Asana設定資源の作成と再利用を調整する | 既存資源の照合、作成、再確認が同じGID集合を更新し、分割すると再実行時の採用基準が散るため。 |
| `src/main/asana/sync/coordinator.ts` | Asana同期の方式選択と結果確定を管理する | fullとdeltaの選択、fallback、同期時刻の確定が同じ実行結果を使い、分割すると成功扱いの条件がずれるため。 |
| `src/main/asana/sync/full-sync-source.ts` | Asana全件同期の入力を収集する | project、task、影響下の子孫を一つの全件取得結果として返し、分割すると収集範囲と件数上限の判定が分かれるため。 |
| `src/main/asana/sync/normalization-plan-applier.ts` | 正規化計画をAsanaへ反映する | 書込前の状態照合と各書込結果を一つのplan単位で追跡し、分割すると部分適用時の結果を結び直す必要があるため。 |
| `src/main/asana/transport/transport.ts` | Asana HTTP要求の送信と応答処理を担う | URL生成、認証更新、再試行、応答検証が一要求の処理全体を成し、分割すると再送範囲と認証状態の所有が割れるため。 |
| `src/main/auth/asana-oauth/coordinator.ts` | Asana OAuthの開始から完了までを管理する | 認証待機、完了、取消が同じ保留中要求を更新し、分割すると有効期限と二重完了の判定が散るため。 |
| `src/main/bootstrap/ai-session-runtime.ts` | AI sessionの生成と解放を管理する | 開始中、稼働中、終了中の処理が同じsession記録と停止要求を参照し、分割すると後始末の重複を防ぎにくくなるため。 |
| `src/main/bootstrap/external-tool-runtime.ts` | 外部ツールの有効化と停止を管理する | 設定保存とbrokerの稼働状態を同じ遷移で確定し、分割すると保存済み設定と実接続の状態がずれるため。 |
| `src/main/codex/app-server/connection.ts` | Codex app-serverのprocess接続を管理する | 起動、JSON通信、timeout、終了が同じprocessと保留中要求を参照し、分割すると切断時の要求回収が散るため。 |
| `src/main/codex/session/session.ts` | Codex sessionのターンとツール呼出しを管理する | ターン結果、動的ツール、診断が同じsession識別子と応答順序に従い、分割すると終了時の未処理要求を追いにくくなるため。 |
| `src/main/codex/taskctl/broker.ts` | taskctl接続の要求配送を管理する | client接続、要求ID、timeout、中断が同じbroker状態を使い、分割すると保留中要求の回収が複数箇所になるため。 |
| `src/main/codex/taskctl/client-script.ts` | taskctl clientの起動scriptを定義する | Windowsとその他の起動文が同じ実行先と接続引数を表し、分割すると実行先の選択が食い違うため。 |
| `src/main/codex/workspace/integrations.ts` | Codex workspaceへ外部ツール連携を配置する | 配置先、権限、登録上限と生成ファイルを同時に検証し、分割すると設置結果と検証条件が離れるため。 |
| `src/main/domain/external-data-merge.ts` | Asana custom external dataの変更を合成する | 操作ごとの競合と適用済み判定を同じ元データと更新結果で比較し、分割するとmerge順序が見えにくくなるため。 |
| `src/main/domain/normalization/graph.ts` | タスク関係のグラフを正規化する | 親子、依存、循環の判定が同じ節点索引と到達関係を共有し、分割するとグラフ構築と判定が重複するため。 |
| `src/main/domain/normalization/status.ts` | タスク状態の観測値をsectionと照合する | section設定、直前状態、今回の観測を一つの遷移へまとめ、分割すると状態変更と通知の判定がずれるため。 |
| `src/main/domain/proposal-analysis/basic.ts` | 変更案の基本条件を検証する | 操作単位の検証結果をgroup単位へ集める一つの走査であり、分割するとエラー順と対象参照の照合が散るため。 |
| `src/main/domain/proposal-analysis/conflict-classifier.ts` | 承認時の変更案と現行タスクの競合を分類する | 全操作を同じ基準スナップショットと対象解決で判定し、分割すると操作間で競合基準が変わるため。 |
| `src/main/domain/proposal-analysis/graph.ts` | 選択された変更案の関係グラフを検証する | 作成対象、親子、依存の辺を同じ仮想グラフへ反映し、分割すると循環検出の対象集合がずれるため。 |
| `src/main/domain/ranking/calculator.ts` | タスクの順位を算出する | 除外、点数内訳、同点順を一つの順位結果として確定し、分割すると一覧順位と説明値が異なる計算経路になるため。 |
| `src/main/domain/snapshot-normalization/normalizer.ts` | Asana snapshotから正規化結果を作る | 状態、関係、タグ、外部データを同じ取得時点から投影し、分割すると計画間の参照整合性を再照合する必要があるため。 |
| `src/main/domain/snapshot-normalization/schemas.ts` | snapshot正規化の入出力契約を定義する | 各planと通知が一つの正規化結果へ集約され、分割すると判別子と結果形の対応が見えにくくなるため。 |
| `src/main/external-agent/client-script.ts` | 外部エージェントの起動scriptを生成する | client、launcher、installerが同じ実行先と接続引数を共有し、分割すると起動引数の整合を別途維持するため。 |
| `src/main/external-agent/transport.ts` | 外部エージェントとのbridge通信を管理する | endpoint、要求、timeout、停止が同じbridge状態に依存し、分割すると切断時の要求回収が散るため。 |
| `src/main/external-tools/broker.ts` | 外部ツールの接続と実行要求を配送する | 接続管理、実行中要求、停止処理が同じbroker状態を使い、分割すると中断時の資源回収が分かれるため。 |
| `src/main/external-tools/client-script.ts` | contextctl clientの起動scriptを生成する | 接続情報の読取から要求転送までを一つのscriptとして出力し、分割すると生成後のscriptを結合するだけになるため。 |
| `src/main/external-tools/discord.ts` | Discord読取ツールの要求を実行する | 検索とthread取得が同じ認証参照、文字数制限、応答整形を使い、分割するとDiscord側の制限が重複するため。 |
| `src/main/external-tools/schemas.ts` | 外部ツールprotocolの入出力契約を定義する | 要求、応答、診断と容量上限を同じprotocol版で検証し、分割すると版と制限の対応が散るため。 |
| `src/main/index.ts` | Electron Main入口の起動と終了を接続する | app、window、online監視、更新処理の終了順を同じ入口で制御し、分割すると起動と終了の依存順を別途同期するため。 |
| `src/main/infrastructure/ai/codex-app-server/rpc-endpoint.ts` | Codex RPCの要求と通知を配送する | 応答ID、保留中要求、通知を同じendpoint状態で照合し、分割するとtimeout後の応答処理が散るため。 |
| `src/main/infrastructure/ai/codex-app-server/rpc-schemas.ts` | Codex RPC methodの入出力を検証する | methodごとの要求と応答を同じRPC契約として列挙し、分割するとmethod登録と結果schemaの対応を追いにくくなるため。 |
| `src/main/infrastructure/ai/codex-session/capability-policy.ts` | Codex sessionへ渡す能力設定を検証する | 読取可能path、socket、skillを同じ権限境界で確定し、分割すると部分的に検証した設定を通しやすくなるため。 |
| `src/main/infrastructure/ai/codex-session/turn-coordinator.ts` | Codexターンの開始から完了までを調整する | 開始中、稼働中、終了済みの通知が同じactive turnへ集まり、分割すると通知順と終了判定が分かれるため。 |
| `src/main/infrastructure/ai/external-tools/connection-files.ts` | 外部ツール接続ファイルの作成と削除を管理する | ファイル権限、原子的な保存、削除を同じ接続情報に対して行い、分割すると途中失敗時の後始末が散るため。 |
| `src/main/infrastructure/asana/normalization-plan.ts` | Asana正規化planの適用契約を定義する | 状態とタグの操作、結果、失敗理由を一つのplan結果へ集め、分割すると操作と結果の判別子がずれるため。 |
| `src/main/infrastructure/asana/sync-normalization.ts` | 同期結果を正規化通知とcacheへ投影する | 適用結果、通知、順位cacheが同じ正規化結果を参照し、分割すると失敗時に保持する値が食い違うため。 |
| `src/main/infrastructure/persistence/proposal-application-history-repository.ts` | 変更案の適用履歴をSQLiteへ保存する | 履歴の移行、照合、記録が同じ行識別子とtransactionを使い、分割すると移行済み判定と書込が離れるため。 |
| `src/main/infrastructure/persistence/proposal-execution-repository.ts` | 変更案実行journalをSQLiteへ保存する | 実行、attempt、一覧取得が同じexecution IDと更新件数検証を使い、分割すると状態遷移の永続化条件が散るため。 |
| `src/main/infrastructure/persistence/sqlite-migration.ts` | SQLite schemaを現行版へ移行する | tableとcolumnの検査、作成、既存行数確認を一つの移行順で行い、分割すると途中版の判定が複数箇所になるため。 |
| `src/main/infrastructure/persistence/task-read-repository.ts` | タスク読取用の永続データを保存する | タスク、順位、同期状態の読み書きが同じsnapshot更新に属し、分割すると取得時点の整合を別途保証するため。 |
| `src/main/ipc/register-ipc.ts` | feature IPC handlerの登録と解除を管理する | invokeとsubscriptionが同じwindow接続とerror reporterを使い、分割すると登録数と解除数の対応を追いにくくなるため。 |
| `src/renderer/features/proposals/AiSessionDialog.vue` | AI sessionの対話画面を表示する | ターン入力、履歴、変更案確認が同じ選択中sessionに依存し、分割すると画面内の選択状態を子間で複製するため。 |
| `src/renderer/features/proposals/ExternalProposalPanel.vue` | 外部変更案の確認と承認状態を表示する | 選択中の提案、承認結果、実行履歴を一つのpanelで切り替え、分割すると選択IDを複数componentで同期するため。 |
| `src/renderer/features/proposals/ProposalOperationEditor.vue` | 変更案操作の編集フォームを表示する | 操作種別ごとの入力が同じdraft ID、対象候補、確定eventを使い、分割すると編集途中の状態を親へ押し上げるため。 |
| `src/renderer/features/proposals/ProposalReviewPanel.vue` | 変更案の選択と編集結果を確認する | groupとoperationの選択、編集、確認が同じ提案版を参照し、分割すると古い選択状態の無効化が散るため。 |
| `src/renderer/features/proposals/mock-proposals-api.ts` | 変更案APIのmock状態遷移を実装する | 選択、承認、履歴の返値が同じメモリ内の提案状態に依存し、分割するとmockの状態を重複保持するため。 |
| `src/renderer/features/proposals/use-proposal-workspace.ts` | 変更案workspaceのUI状態を管理する | session、ターン、ダイアログの表示が同じworkspace要求世代に依存し、分割すると遅い応答の無効化が複数箇所になるため。 |
| `src/renderer/features/proposals/use-proposals.ts` | 変更案featureの表示状態と操作を管理する | 一覧、選択、適用結果が同じ提案集合を更新し、分割すると画面間の再読込条件が散るため。 |
| `src/renderer/features/settings/SetupWizard.vue` | 初回設定の入力と進捗を表示する | 認証、project、Vaultの入力が同じ段階進行と保存結果に従い、分割すると前段の未保存入力を跨いで同期するため。 |
| `src/renderer/features/tasks/TaskDetail.vue` | 選択中タスクの詳細と直接編集を表示する | 各項目の入力が同じタスク版と保存状態を使い、分割すると同時編集の競合表示を子間で同期するため。 |
| `src/renderer/features/tasks/mock-tasks-api.ts` | タスクAPIのmock応答を作る | 一覧、詳細、直接編集が同じfixture状態とIDを使い、分割すると画面ごとのmockが異なるタスクを返すため。 |
| `src/shared/ai-workflow/schemas.ts` | AI workflowの要求と結果を検証する | snapshot、操作編集、選択、承認のschemaが同じ上限と識別子を参照し、分割すると各段階の契約がずれるため。 |
| `src/shared/ai/proposal.ts` | 変更案と操作の共通schemaを定義する | 17操作の判別子、group、証拠、Codex応答が同じ提案契約へ結び付き、分割すると操作追加時の受理範囲が散るため。 |
| `src/shared/domain/schemas.ts` | タスクdomainの共通値を検証する | 状態、重要度、期限、関係のschemaが同じtask契約で再利用され、分割すると同じ値の制約が複数定義になるため。 |
| `src/shared/external-agent/schemas.ts` | 外部エージェントprotocolを検証する | 登録、照会、準備、提案の要求と応答が同じprotocol版と容量制限に従い、分割すると版ごとの検証範囲が散るため。 |
| `src/shared/ipc-contracts/proposals.ts` | 変更案featureのIPC契約を定義する | 要求、応答、購読eventを一つの公開APIに結び付け、分割するとchannelと型の対応がずれるため。 |
| `src/shared/ipc-contracts/setup-schemas.ts` | 初回設定featureのIPC schemaを組み立てる | 設定状態と各段階の要求を同じ依存schemaから生成し、分割するとMainとRendererが別の契約を採用しやすくなるため。 |
