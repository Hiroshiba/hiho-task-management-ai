# 変更案の適用と復旧

変更案の通常適用、再開、異常終了後の復旧、GUI直接編集は、同じ`TaskWritePlan`と`TaskWriteExecutor`を使います。proposal handlerは事前検証して順序付きstepを返し、外部書き込みはexecutorだけが実行します。workflow間の共有契約は`src/main/application/common/task-write-plan.ts`と`task-write-step.ts`に置きます。現行17操作の実効call列と読み戻し条件は[変更案17操作の書き込み行列](proposal-operation-matrix.md)を正本とします。

| 操作 | handlerのowner | 外部書き込みの種類 |
| --- | --- | --- |
| `create_task` | `proposal-apply` | 初期Custom external dataを含むAsana作成、タグ2件、必要な親関係、後続同期 |
| `update_title` | `proposal-apply` | Asana native field、活動日メタデータ、後続同期 |
| `update_notes` | `proposal-apply` | Asana native field、活動日メタデータ、後続同期 |
| `set_status` | `proposal-apply` | Asana所属と必要な完了フラグ、最終活動状態メタデータ、復帰時の活動日、後続同期 |
| `set_importance` | `proposal-apply` | カテゴリタグ、活動日メタデータ、後続同期 |
| `set_due` | `proposal-apply` | Asana native field、活動日メタデータ、後続同期 |
| `clear_due` | `proposal-apply` | Asana native field、活動日メタデータ、後続同期 |
| `set_duration` | `proposal-apply` | Asana Custom external data、後続同期 |
| `clear_duration` | `proposal-apply` | Asana Custom external data、後続同期 |
| `set_area` | `proposal-apply` | カテゴリタグ、活動日メタデータ、後続同期 |
| `set_dependencies` | `proposal-apply` | Asana Custom external dataの依存関係と活動日、後続同期 |
| `set_parent` | `proposal-apply` | Asana親関係、活動日メタデータ、後続同期 |
| `set_parent_work_mode` | `proposal-apply` | Asana Custom external dataの親作業モードと活動日、後続同期 |
| `link_obsidian` | `proposal-apply` | Asana Custom external data、後続同期 |
| `unlink_obsidian` | `proposal-apply` | Asana Custom external data、後続同期 |
| `complete` | `proposal-apply` | Asana native fieldと所属、後続同期 |
| `withdraw` | `proposal-apply` | Asana native fieldと所属、後続同期 |

17操作の識別子は [current-source-map.md](current-source-map.md) の機械生成一覧で照合します。旧変更案は既存境界で検証し、plan生成時は`src/main/domain/proposal-write-operation.ts`で書き込みに使う項目だけを検証します。manifestは`Record<ProposalWriteOperation["operation"], OperationHandler>`を`satisfies`で検査し、各操作をちょうど1handlerへ割り当てます。`importance`と`area`はカテゴリタグ、`duration`と`link_obsidian`はCustom external dataです。Obsidianノートへ書き込みません。native field、タグの追加と削除、Custom external dataは実際のAsana callごとに別stepとします。活動日はCustom external dataの変更項目であり、依存関係や親作業モードの変更と一つのAsana callへマージします。後続同期は適用可能な操作群の最後に一度だけ実行します。

## 保存するwrite step

各stepは`step_id`、`scope`、`kind`、`executor_version`、`payload`、`payload_fingerprint`、`retry_class`を持つimmutableな値です。対象参照は`payload.target`または同期用の`payload.targets`に保存し、既存GIDと作成タスクの一時参照を区別します。`retry_class`は`read_back_verifiable`、`idempotent`、`non_retryable`のいずれかです。作成は非再送、Asana属性は読み戻しで再送可否を判定し、ローカル同期は冪等です。実行関数、SDK object、資格情報は永続化しません。保存した`kind`と`executor_version`からexecutor registryで解決します。意味を変える場合はversionを上げ、旧versionの保存済みstepを移行し終えるまで旧executorを保持します。

planは`format_version`、`execution_id`、`origin`、既知の一時参照と順序付きstepを保存します。各Asana stepのpayloadには承認時の基準値または同じplanの作成操作を指す基準値の出所を含めます。作成stepのreceiptは新GIDと一時参照を結び、後続stepはそのreceiptから対象を解決します。fingerprintはpayloadの正規化JSONへSHA-256を適用し、保存後の読込時にも照合します。Zodはstep種別ごとにpayloadを検証し、同期stepを最後の1件に制限します。proposalの同期条件は確認済み操作で、`already_applied`も含めます。GUI直接編集の同期条件はwriter結果の取得です。

proposal executionには、最終resultの再構成に必要なgroup ID、atomic属性、group順とgroup内の操作ID順をimmutableなcontextとしてplanと同じtransactionで保存します。contextの操作ID集合はplanの操作ID集合と一致させ、Zodとfingerprintを保存時と読込時に照合します。GUI直接編集にはproposal contextを保存しません。

外部書き込みの前に全stepと承認時の基準値を含むplanをjournalへ保存し、以後はplanを変更しません。復旧時は保存済み`kind`、`executor_version`、`payload`、`payload_fingerprint`を使用し、現在のhandlerからplanを再生成しません。stepは`planned`から、外部call直前に`running`を保存し、receipt確認後に`succeeded`を保存します。失敗したstepは`failed`または`confirmation_required`にします。保存が失敗したら外部callを開始しません。

全stepが`succeeded`になった後、proposal全体の最終resultとexecutionの`succeeded`への遷移を同じtransactionで保存します。最終resultの保存前に中断したexecutionは`running`のまま復旧対象に残し、保存済みcontextとstep receiptからresultを再構成します。`succeeded`への再要求では保存済みresultを返します。`failed`と`confirmation_required`への遷移では、該当stepとexecutionに同じerror IDを保存します。

異常終了後に`running`だったstepは読み戻して分類します。適用済みと確認できればreceiptを補完して`succeeded`、未適用と確認できてretry可能なら同じstep IDで再実行します。適用の有無を確認できない場合や非冪等なstepは`confirmation_required`として永続化し、自動再送しません。Asana native fieldとCustom external dataの部分成功は各stepの結果として保持し、成功済みstepを再送しません。

実行エンジンは保存済みexecutionを読み、`kind`と`executor_version`で書き込みexecutorを解決します。`proposal_operation_check`はAsanaのcore値、専用プロジェクト所属、Custom external dataの識別子と対象項目を読み戻します。`already_applied`なら対象GIDと観測状態のfingerprintを照合receiptへ保存し、同じ操作の後続Asana stepを外部callなしで成功保存します。省略したstepのreceiptには照合step IDを記し、読込時にも対象GIDと観測fingerprintの一致を確認します。後続同期は保存済みreceiptと一時参照から対象GIDを解決します。

Asana stepは書き込み前後に読戻し、作成stepは事前発行UUIDで専用プロジェクトを探索します。作成後のGETでは404と外部データ、所属、セクションの投影待ちだけを上限付きで再観測します。`running`の作成stepでUUID一致タスクが見つからなくても自動作成しません。読戻し障害と判定不能な状態は元のエラーを記録し、同じstepを再送せず`confirmation_required`へ保存します。
書き込みが失敗しても読戻しで未適用と確定できたretry可能なstepだけ、同じstep IDのattemptを保存して最大3回まで再試行します。

proposal単位の同時実行を禁止します。二重click、IPC再送、起動時復旧は同じlockとrepositoryのexecution stateで判定します。`succeeded`への再要求は保存済みresultだけを返します。`failed`と`confirmation_required`への再要求は保存済み状態とerror IDを返し、同じexecution IDで再実行しません。利用者が明示的にやり直す場合だけ、元execution IDを参照する新executionを作ります。

SQLite v6は`application_journal`を保持し、新しい`proposal_executions`と`proposal_execution_steps`を追加します。v3、v4、v5からのschema移行は一つのtransactionで行い、旧行の件数を照合します。新executionの全planと全stepは外部callより前に一つのtransactionで保存します。step状態と試行回数はCASで更新し、receiptまたはerror IDとexecution状態も同じtransactionで確定します。最終resultは`succeeded`へのCASと同時に保存します。保存時と読込時にplan全体と各payloadのfingerprintを照合します。

旧`application_journal`は一時readerがSELECTだけで解釈します。旧形式には外部call単位のstepとreceiptがないため、未確定の操作を再送可能な新planへ推測変換せず、`confirmation_required`として返します。変換できない行は元データを保持し、error ID付きの拒否結果を返します。新形式の通常適用と復旧を揃えてから全経路を一括切替し、旧writerと旧format routerを削除します。
