# 変更案17操作の書き込み行列

対象は2026年9月27日の現行writerです。旧入力の検証は`src/shared/ai/proposal.ts`の`proposalOperationSchema`が担います。plan生成時は`src/main/domain/proposal-write-operation.ts`が書き込みに必要な項目だけを検証し、manifestは`ProposalWriteOperation["operation"]`をキーにします。以下の列は適用可能な基準状態から実際に発生し得るAsana書き込みの順序です。既に変更後と一致する効果は読み戻しで省きます。

記号は`C`がタスク作成、`U`がタスク属性更新、`S`がセクション移動、`T+`がタグ追加、`T-`がタグ削除、`P+`が親設定、`P-`が親解除、`E`がCustom external data更新、`L`が後続同期です。`E`内の複数項目は一つのAsana `updateTask` callへマージします。矢印は外部callの順序、`?`は読み戻した状態に応じたcall省略です。

旧入口の「非作成」は`operation-writer.ts`の`applyNonCreate`から`non-create-write.ts`へ進みます。「native」は`native-operation-write.ts`、「external」は`external-metadata.ts`を指します。非作成操作は最初にタスクと承認時Custom external data基準を読み、nativeまたはタグの後に必要な`E`を実行し、最後にnativeとexternal dataを再読込して検証します。タグは`category-tag-write.ts`で追加後に読み戻してから旧タグを削除し、状態は`status-write.ts`でセクション移動後に読み戻してから完了フラグを更新します。

| 操作 | 旧入口 | 実効write列 | native・タグ・externalの入力 | 活動日と状態メタデータ | 後続同期 |
| --- | --- | --- | --- | --- | --- |
| `create_task` | 作成 | `C → T+重要度 → T+領域 → P+?` | `C`にタイトル、説明、期限、目的セクション、初期Custom external dataを同梱。親は指定時だけ後続call | 初期external dataに`activity_anchor_on`と`last_active_status`を設定 | `L` |
| `update_title` | 非作成→native→external | `U(title) → E` | 変更前後のタイトル、承認時external基準 | `E`で活動日 | `L` |
| `update_notes` | 非作成→native→external | `U(notes) → E` | 変更前後の説明、承認時external基準 | `E`で活動日 | `L` |
| `set_status` | 非作成→native→external | `S → U(completed)? → E` | 変更前後のセクション。完了値が変わる復帰時だけ`U` | `E`で`last_active_status`。完了・取下げから活動状態へ戻すときだけ同じ`E`で活動日 | `L` |
| `set_importance` | 非作成→native→external | `T+ → T-? → E` | `TaskHub/重要度/`タグを追加後、旧タグがある場合だけ削除 | `E`で活動日 | `L` |
| `set_due` | 非作成→native→external | `U(due_onまたはdue_at) → E` | 期限の種類と値、承認時external基準 | `E`で活動日 | `L` |
| `clear_due` | 非作成→native→external | `U(clear_due) → E` | 設定済み期限を解除 | `E`で活動日 | `L` |
| `set_duration` | 非作成→external | `E` | Custom external dataの所要時間をマージ | 更新しない | `L` |
| `clear_duration` | 非作成→external | `E` | Custom external dataの所要時間を解除 | 更新しない | `L` |
| `set_area` | 非作成→native→external | `T+ → T-? → E` | `TaskHub/領域/`タグを追加後、旧タグがある場合だけ削除 | `E`で活動日 | `L` |
| `set_dependencies` | 非作成→external | `E` | Custom external dataの依存関係をマージ | 同じ`E`で活動日 | `L` |
| `set_parent` | 非作成→native→external | `P+またはP- → E` | 親参照を設定または解除 | `E`で活動日 | `L` |
| `set_parent_work_mode` | 非作成→external | `E` | Custom external dataの親作業モードをマージ | 同じ`E`で活動日 | `L` |
| `link_obsidian` | 非作成→external | `E` | Asana Custom external dataへリンクを追加。Obsidianノートには書き込まない | 更新しない | `L` |
| `unlink_obsidian` | 非作成→external | `E` | Asana Custom external dataからリンクを削除 | 更新しない | `L` |
| `complete` | 非作成→native | `S → U(completed=true)` | 完了セクションへ移動して完了フラグを立てる。external基準は不要 | 更新しない | `L` |
| `withdraw` | 非作成→native | `S → U(completed=true)` | 取下げセクションへ移動して完了フラグを立てる。external基準は不要 | 更新しない | `L` |

`create_task`は送信前に発行したUUIDと一致する既存タスクを専用プロジェクトで調べます。作成要求の`external.gid`と初期データは同じ`C`の入力です。応答の新GIDを後続属性更新より先にジャーナルへ保存し、GETの404、external、project所属、目的セクションの投影遅延だけを上限付きGETで再観測します。読み戻しで目的外の値が見えた場合は上書きせず競合とします。タグと親の各call後にもGETを挟み、最後に全属性とexternal dataを再検証します。根拠は`create-task-write.ts`の119〜129行、130〜200行、215〜310行、328〜446行です。

非作成では初期読込でcoreとexternal dataを独立に変更前、変更後、許可する部分適用、競合へ分類します。coreの後にexternal dataを再読込し、承認時基準からマージして必要な場合だけ`E`を送信します。書き込み後には両方を読戻します。根拠は`non-create-write.ts`の102〜180行、211〜289行、292〜457行です。重要度`3`と領域`未分類`は旧タグが付いていなくても変更前として扱い、旧タグがないまま新タグだけが付いた削除stepは適用済みとして扱います。カテゴリタグ名はワークスペース内で一意に解決し、タスク上のタグはGIDと名前で照合します。タグの許可する部分適用は新旧2タグの併存だけ、状態の許可する部分適用は目的セクションだけ変更済みで完了フラグが旧値の状態だけです。

通常適用では`applied`と`already_applied`を確認した操作のGIDを重複排除し、操作群の最後に`postApply`を一回実行します。`L`は操作ごとのAsana callではなく実行全体の最終stepです。GUI直接編集ではwriter結果が得られた後、競合結果を含めて`postApply`を呼びます。共通planの`local_synchronize.condition`はproposalでは`verified_operation`、GUIでは`writer_result_available`を使います。executorは実行元に応じて異なる事後同期入口を呼び、成功時に同期したGIDをreceiptへ保存します。同期失敗時は先に成功したAsana receiptを残して`confirmation_required`へ進めます。根拠は`journal-progress.ts`の72〜105行、`post-apply-completion.ts`の62〜83行、`gui-edit/service.ts`の875〜899行です。

再開では保存済みの承認時external基準と一時参照を使います。`read_back`以降はwriterを再実行せずローカル同期へ進みます。それ以前でも`inspectRecovery`でcoreとexternal dataを照合し、両方が変更後なら再送せず、第三状態や結果不明なら手動確認へ送ります。作成のGIDが未保存の`write_started`ではUUID一致タスクを探索し、0件または複数件で再作成しません。根拠は`recovery-operations.ts`の532〜685行、780〜890行と`recovery-writer-input.ts`の43〜113行です。

保存用planは既知の一時参照、stepの順序、scope、payloadを含む全体のfingerprintを持ちます。各payloadのfingerprintも個別に照合します。非作成操作では外部callが0件になる場合も`proposal_operation_check`を先頭に保存し、操作の変更前後、対象プロジェクト、セクション、workspace、承認時external基準を復旧後の照合に使用します。タスクのプロジェクト所属とcore・external dataを読み戻し、両方が変更後なら`already_applied`として外部callを省きます。照合stepと後続のexternal更新stepには同じ承認時基準を使います。

`set_duration`、`clear_duration`、`set_dependencies`、`set_parent_work_mode`の変更前値は承認時external基準と一致させます。`link_obsidian`は基準に同一Vault・パスがないこと、`unlink_obsidian`は同一Vault・パスの全属性が変更前値と一致することを確認します。作成タスクを基準にする場合は先行する作成stepの初期external dataと照合します。作成操作は一時参照の依存順に並べ、同時に作成できる操作は操作ID順にします。自身や未解決の一時参照を参照させません。親変更の変更前親も同じ参照検証に含めます。

Custom external dataの読戻しでは、依存関係を変更対象のタスクGIDごとに分類し、他のGIDへの変更を保持します。一つの`E`に含む変更前後が同じ項目と、承認時基準と予定日のどちらよりも新しい活動日は、他の項目の適用判定に影響させません。活動日は承認時基準、現在値、予定日の最大値を保持し、変更対象の値が第三状態なら競合として扱います。変更対象の一部だけが変更後なら適用有無を不明として自動再送しません。
