# 変更案の適用と復旧

変更案の通常適用、再開、異常終了後の復旧、GUI直接編集は、同じ`TaskWritePlan`と`TaskWriteExecutor`を使います。proposal handlerは事前検証して順序付きstepを返し、外部書き込みはexecutorだけが実行します。workflow間の共有契約は`src/main/application/common/task-write-plan.ts`に置きます。

| 操作 | handlerのowner | 外部書き込みの種類 |
| --- | --- | --- |
| `create_task` | `proposal-apply` | Asana作成、必要なタグと親関係、後続同期 |
| `update_title` | `proposal-apply` | Asana native field、活動日メタデータ、後続同期 |
| `update_notes` | `proposal-apply` | Asana native field、後続同期 |
| `set_status` | `proposal-apply` | Asana native fieldと所属、後続同期 |
| `set_importance` | `proposal-apply` | カテゴリタグ、後続同期 |
| `set_due` | `proposal-apply` | Asana native field、活動日メタデータ、後続同期 |
| `clear_due` | `proposal-apply` | Asana native field、活動日メタデータ、後続同期 |
| `set_duration` | `proposal-apply` | Asana Custom external data、後続同期 |
| `clear_duration` | `proposal-apply` | Asana Custom external data、後続同期 |
| `set_area` | `proposal-apply` | カテゴリタグ、後続同期 |
| `set_dependencies` | `proposal-apply` | Asana Custom external data、後続同期 |
| `set_parent` | `proposal-apply` | Asana親関係、活動日メタデータ、後続同期 |
| `set_parent_work_mode` | `proposal-apply` | Asana Custom external data、後続同期 |
| `link_obsidian` | `proposal-apply` | Asana Custom external data、後続同期 |
| `unlink_obsidian` | `proposal-apply` | Asana Custom external data、後続同期 |
| `complete` | `proposal-apply` | Asana native fieldと所属、後続同期 |
| `withdraw` | `proposal-apply` | Asana native fieldと所属、後続同期 |

17操作の識別子は [current-source-map.md](current-source-map.md) の機械生成一覧で照合します。最終registryは`Record<ProposalOperationKind, OperationHandler>`を`satisfies`で検査し、各操作をちょうど1handlerへ割り当てます。`importance`と`area`はカテゴリタグ、`duration`と`link_obsidian`はCustom external dataです。Obsidianノートへ書き込みません。native field、タグ、external data、活動日メタデータ、後続同期は、実際の外部callごとに別stepとします。

## 保存するwrite step

各stepは`stepId`、`kind`、`executorVersion`、`targetId`、`payload`、`payloadFingerprint`、`retryClass`を持つimmutableな値です。`retryClass`は`read-back-verifiable`、`idempotent`、`non-retryable`のいずれかです。実行関数は永続化しません。保存した`kind`と`executorVersion`からexecutor registryで解決します。意味を変える場合はversionを上げ、旧versionの保存済みstepを移行し終えるまで旧executorを保持します。

外部書き込みの前に全stepと承認時の基準値を含むplanをjournalへ保存し、以後はplanを変更しません。復旧時は保存済み`kind`、`executorVersion`、`payload`、`payloadFingerprint`を使用し、現在のhandlerからplanを再生成しません。stepは`planned`から、外部call直前に`running`を保存し、receipt確認後に`succeeded`を保存します。失敗したstepは`failed`または`confirmation_required`にします。保存が失敗したら外部callを開始しません。

異常終了後に`running`だったstepは読み戻して分類します。適用済みと確認できればreceiptを補完して`succeeded`、未適用と確認できてretry可能なら同じstep IDで再実行します。適用の有無を確認できない場合や非冪等なstepは`confirmation_required`として永続化し、自動再送しません。Asana native fieldとCustom external dataの部分成功は各stepの結果として保持し、成功済みstepを再送しません。

proposal単位の同時実行を禁止します。二重click、IPC再送、起動時復旧は同じlockとrepositoryのexecution stateで判定します。`succeeded`への再要求は保存済みresultだけを返します。`failed`と`confirmation_required`への再要求は保存済み状態とerror IDを返し、同じexecution IDで再実行しません。利用者が明示的にやり直す場合だけ、元execution IDを参照する新executionを作ります。

既存のSQLite v5 `application_journal`は、現行の適用段階と最終結果を保持します。移行では元データをbackupし、transactionまたは一時ファイルのatomic renameでversion付き新journalへ冪等変換します。1件の変換失敗で元データを削除せず、件数と失敗IDを記録します。移行が完了していない旧dataを黙って無視しません。新形式の通常適用と復旧を揃えてから全経路を一括切替し、旧writerと旧format routerを削除します。
