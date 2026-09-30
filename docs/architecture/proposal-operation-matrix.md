# 変更案17操作の書き込み行列

入力は`src/main/domain/proposal.ts`の`proposalOperationSchema`で検証します。書き込み項目は`src/main/domain/proposal-write-operation.ts`で検証し、`src/main/application/common/task-write-operation-manifest.ts`が操作ごとの保存用stepを生成します。Asanaへの書き込みは`src/main/infrastructure/asana/task-write-call-adapter.ts`のexecutorが実行します。以下は適用可能な基準状態から発生し得るAsana書き込みの順序です。変更後と一致する効果は読み戻しで省きます。

`C`はタスク作成、`U`はタスク属性更新、`S`はセクション移動、`T+`はタグ追加、`T-`はタグ削除、`P+`は親設定、`P-`は親解除、`E`はCustom external data更新、`L`は後続同期です。`E`内の複数項目は一つのAsana `updateTask` callへまとめます。矢印は外部callの順序、`?`は読み戻した状態に応じたcall省略です。

| 操作 | 実効write列 | native・タグ・externalの入力 | 活動日と状態メタデータ | 後続同期 |
| --- | --- | --- | --- | --- |
| `create_task` | `C → T+重要度 → T+領域 → P+?` | `C`にタイトル、説明、期限、目的セクション、初期Custom external dataを同梱。親は指定時だけ後続call | 初期external dataに`activity_anchor_on`と`last_active_status`を設定 | `L` |
| `update_title` | `U(title) → E` | 変更前後のタイトル、承認時external基準 | `E`で活動日 | `L` |
| `update_notes` | `U(notes) → E` | 変更前後の説明、承認時external基準 | `E`で活動日 | `L` |
| `set_status` | `S → U(completed)? → E` | 変更前後のセクション。完了値が変わる復帰時だけ`U` | `E`で`last_active_status`。完了・取下げから活動状態へ戻すときだけ同じ`E`で活動日 | `L` |
| `set_importance` | `T+ → T-? → E` | `TaskHub/重要度/`タグを追加後、旧タグがある場合だけ削除 | `E`で活動日 | `L` |
| `set_due` | `U(due_onまたはdue_at) → E` | 期限の種類と値、承認時external基準 | `E`で活動日 | `L` |
| `clear_due` | `U(clear_due) → E` | 設定済み期限を解除 | `E`で活動日 | `L` |
| `set_duration` | `E` | Custom external dataの所要時間をマージ | 更新しない | `L` |
| `clear_duration` | `E` | Custom external dataの所要時間を解除 | 更新しない | `L` |
| `set_area` | `T+ → T-? → E` | `TaskHub/領域/`タグを追加後、旧タグがある場合だけ削除 | `E`で活動日 | `L` |
| `set_dependencies` | `E` | Custom external dataの依存関係をマージ | 同じ`E`で活動日 | `L` |
| `set_parent` | `P+またはP- → E` | 親参照を設定または解除 | `E`で活動日 | `L` |
| `set_parent_work_mode` | `E` | Custom external dataの親作業モードをマージ | 同じ`E`で活動日 | `L` |
| `link_obsidian` | `E` | Asana Custom external dataへリンクを追加。Obsidianノートには書き込まない | 更新しない | `L` |
| `unlink_obsidian` | `E` | Asana Custom external dataからリンクを削除 | 更新しない | `L` |
| `complete` | `S → U(completed=true)` | 完了セクションへ移動して完了フラグを立てる。external基準は不要 | 更新しない | `L` |
| `withdraw` | `S → U(completed=true)` | 取下げセクションへ移動して完了フラグを立てる。external基準は不要 | 更新しない | `L` |

`create_task`は送信前に発行したUUIDで既存タスクを探索します。作成後はGID、外部データ、所属、目的セクションを読み戻します。読み戻しで適用の有無を確定できない場合は同じ作成stepを自動再送しません。タグと親関係は別stepとして保存し、成功済みのreceiptを再利用します。

非作成操作は`proposal_operation_check`でcore、所属、Custom external dataを承認時基準と照合します。native field、タグの追加と削除、external dataは実際のAsana callごとに別stepです。重要度`3`と領域`未分類`はタグなしを基準状態として扱います。タグは新タグ追加後に旧タグを削除し、状態変更はセクション移動後に必要な完了フラグを更新します。

`L`は操作群の最後に一度だけ実行する`local_synchronize` stepです。proposalの実行条件は`verified_operation`、GUI直接編集の実行条件は`writer_result_available`です。同期失敗時は先に成功したAsana receiptを残し、`confirmation_required`へ進めます。復旧は保存済みplan、step状態、receiptを読み戻し、未適用と確認できたstepだけを再実行します。

保存用planは既知の一時参照、stepの順序、scope、payloadを含む全体のfingerprintを持ちます。各payloadのfingerprintも個別に照合します。照合stepと後続のexternal更新stepには同じ承認時基準を使います。作成操作は一時参照の依存順に並べ、同時に作成できる操作は操作ID順にします。

Custom external dataの読戻しでは、依存関係を変更対象のタスクGIDごとに分類し、他のGIDへの変更を保持します。活動日は承認時基準、現在値、予定日の最大値を保持します。変更対象の一部だけが変更後なら適用有無を不明として自動再送しません。
