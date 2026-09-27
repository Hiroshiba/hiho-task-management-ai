# 状態の所有者

各状態には唯一のowner、生成地点、破棄地点を定めます。現行のmodule直下とVue component内の状態候補は [current-source-map.md](current-source-map.md) に列挙しています。ファイルを移すときは、同じ値を複数ownerへ複製しません。

| 状態 | 唯一のowner | 生成 | 破棄・保存 |
| --- | --- | --- | --- |
| MainRuntimeと外部client | `create-main-runtime.ts`が返す`MainRuntime` | Electron app ready後 | app終了時にdispose |
| 起動、停止、ウィンドウ、online監視、自動更新 | `register-main-lifecycle.ts` | MainRuntime生成後 | app終了時にtimer、listener、windowを破棄。ウィンドウ状態と更新試行はJSONへ保存 |
| DB接続とtransaction | persistence adapter | MainRuntime生成時 | MainRuntime dispose。SQLiteへ保存 |
| Asana認証と同期実行 | settingsとtask-read workflowの実行単位 | 要求受付と同期開始時 | 終了時に中断・listenerを解放。token、同期状態、cacheは既存保存形式へ保存 |
| Vaultマッピング保存中lock | Obsidian integration workflow | 保存開始時 | 成功・失敗・中断後にfinallyで解放。マッピングはSQLiteへ保存 |
| Codex sessionと外部ツール接続 | `AiSessionRuntime`とAI adapter | session開始時 | session終了時にprocess、socket、作業資源を破棄 |
| AI変更案、会話根拠、取り下げ確認、生成世代 | `ProposalGenerationState` | session開始時 | session終了時にdispose。未承認案は永続化しない |
| AI状態と差分のMain側購読 | `AiEventRuntime` | MainRuntime生成時 | MainRuntime終了時にdispose |
| 外部提案の文脈、準備要求、提案基準、提出要求 | proposal-generate workflow | 文脈設定と提案準備時 | 文脈変更時に準備済み文脈を失効。提出要求は同一稼働中に照合し、停止時に破棄。未承認案は永続化しない |
| 提出済み外部提案の確認対象、承認状態、適用結果 | proposal-apply workflow | 提出受付時 | MainRuntime終了時にmemoryを破棄。適用記録はjournalへ保存 |
| proposal execution、plan、journal | proposal execution repository | 承認後、外部書き込み前 | terminal stateまで永続化。復旧は保存済みplanを読む |
| proposal実行中lock | proposal engine | execution開始時 | terminalまたは例外時のfinallyで解放。永続状態とも照合 |
| task write plan | 呼び出し単位のimmutable value | proposal handlerまたはGUI編集 | 実行完了後に破棄。実行開始前にjournalへ保存 |
| IPC handlerとsubscription | 各IPC handler | register時 | unregister関数で解除 |
| errorとwarningのsink | Main logging adapter | MainRuntime生成時 | MainRuntime dispose。JSONLへ保存 |
| Rendererの起動状態と配色 | `renderer/app` | app mount | media listenerをunmountで解除。配色初期値はOS設定 |
| タスク一覧、選択、filter、sort、編集進捗 | `renderer/features/tasks` | feature mount | timerとlistenerをunmountで解除。sortは再起動で初期値へ戻す |
| 変更案、AI session表示、承認、適用、復旧の表示 | `renderer/features/proposals` | feature mount | subscriptionと未完了UI要求をunmountで解除。案本文は保存しない |
| 初回設定、認証入力、Vault設定とGitHub連携状態の表示 | `renderer/features/settings` | feature mount | listenerをunmountで解除。保存済み値と連携状態はMainから再読込 |
| Obsidian link状態 | `renderer/features/obsidian-integration` | feature mount | 要求世代とlistenerをunmountで破棄 |
| GitHub連携機能の表示 | `renderer/features/github-integration` | feature mount | listenerをunmountで解除。GitHub App clientがない間はsettingsが利用不可状態を返す |
| mock選択 | `renderer/shared/mock/mock-selection.ts` | URLを1回解析 | reloadまでimmutable |
| toastとfeature非依存UI部品 | `renderer/shared/components` | app mount | unmount時にtimerとlistenerを解除 |

`App.vue`にある現行状態はsource mapの状態名ごとのownerへ移します。特にタスクの同期・編集状態、変更案の承認状態、設定の入力値とAsana認証確認timerをapp shellへ残しません。認証確認timerは他のAsana認証状態と同じsettingsが生成し、unmount時に破棄します。保存済み値をUI側で別の正本として保持せず、Mainから取得した値と未保存入力を区別します。

module直下の可変変数と暗黙cacheを最終形に残しません。immutable定数とSDKが要求する純粋なsingleton metadataだけを認めます。timer、イベント購読、外部接続の生成と解放は同じownerのライフサイクルへ結び付けます。
