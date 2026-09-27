# 変更案の適用と復旧

変更案の通常適用、再開、異常終了後の復旧、GUI直接編集は、同じ`TaskWritePlan`と`TaskWriteExecutor`を使います。事前検証から順序付きstepを生成し、外部書き込みはexecutorだけが実行します。workflow間の共有契約は`src/main/application/common/task-write-plan.ts`、`task-write-step.ts`、`task-write-operation-manifest.ts`に置きます。現行17操作の実効call列と読み戻し条件は[変更案17操作の書き込み行列](proposal-operation-matrix.md)を正本とします。

| 操作 | step生成のowner | 外部書き込みの種類 |
| --- | --- | --- |
| `create_task` | 共通manifest | 初期Custom external dataを含むAsana作成、タグ2件、必要な親関係、後続同期 |
| `update_title` | 共通manifest | Asana native field、活動日メタデータ、後続同期 |
| `update_notes` | 共通manifest | Asana native field、活動日メタデータ、後続同期 |
| `set_status` | 共通manifest | Asana所属と必要な完了フラグ、最終活動状態メタデータ、復帰時の活動日、後続同期 |
| `set_importance` | 共通manifest | カテゴリタグ、活動日メタデータ、後続同期 |
| `set_due` | 共通manifest | Asana native field、活動日メタデータ、後続同期 |
| `clear_due` | 共通manifest | Asana native field、活動日メタデータ、後続同期 |
| `set_duration` | 共通manifest | Asana Custom external data、後続同期 |
| `clear_duration` | 共通manifest | Asana Custom external data、後続同期 |
| `set_area` | 共通manifest | カテゴリタグ、活動日メタデータ、後続同期 |
| `set_dependencies` | 共通manifest | Asana Custom external dataの依存関係と活動日、後続同期 |
| `set_parent` | 共通manifest | Asana親関係、活動日メタデータ、後続同期 |
| `set_parent_work_mode` | 共通manifest | Asana Custom external dataの親作業モードと活動日、後続同期 |
| `link_obsidian` | 共通manifest | Asana Custom external data、後続同期 |
| `unlink_obsidian` | 共通manifest | Asana Custom external data、後続同期 |
| `complete` | 共通manifest | Asana native fieldと所属、後続同期 |
| `withdraw` | 共通manifest | Asana native fieldと所属、後続同期 |

17操作の識別子は [current-source-map.md](current-source-map.md) の機械生成一覧で照合します。旧変更案は既存境界で検証し、plan生成時は`src/main/domain/proposal-write-operation.ts`で書き込みに使う項目だけを検証します。manifestは`Record<ProposalWriteOperation["operation"], OperationHandler>`を`satisfies`で検査し、各操作をちょうど1handlerへ割り当てます。`importance`と`area`はカテゴリタグ、`duration`と`link_obsidian`はCustom external dataです。Obsidianノートへ書き込みません。native field、タグの追加と削除、Custom external dataは実際のAsana callごとに別stepとします。活動日はCustom external dataの変更項目であり、依存関係や親作業モードの変更と一つのAsana callへマージします。後続同期は適用可能な操作群の最後に一度だけ実行します。GUI直接編集の活動日更新と状態修復もAsana callごとにstepへ分割します。状態修復では必要に応じてプロジェクト追加、セクション移動、完了値更新の順に実行します。

`create-main-runtime.ts`は保存用repository、単回送信のAsana transport、read client、404判定、読戻しadapter、全Asana step executor、後続同期executor、実行engineを一度だけ組み立てます。transportとread clientは既存Asana接続を共有します。clock、ID生成器、error reporterもMainRuntimeの既存資源を共有し、別のownerを作りません。保存済みstepの`kind`と`executor_version`は登録済みexecutorへ一意に対応させます。

通常適用はAI画面と外部agentの共有入口で承認直前の現在値を分類し、実行可能な操作を一つのexecutionへまとめます。承認競合とatomic groupの保留は書き込み対象から除き、既存の操作・グループ結果へ反映します。関係グラフは実行対象だけで再検証します。実行結果は保存済みstepとreceiptから投影し、途中成功と未確定操作を区別します。後続同期が失敗した操作は`local_resync_required`の`unknown`として返し、成功扱いしません。

## 保存するwrite step

各stepは`step_id`、`scope`、`kind`、`executor_version`、`payload`、`payload_fingerprint`、`retry_class`を持つimmutableな値です。対象参照は`payload.target`または同期用の`payload.targets`に保存し、既存GIDと作成タスクの一時参照を区別します。`retry_class`は`read_back_verifiable`、`idempotent`、`non_retryable`のいずれかです。作成は非再送、Asana属性は読み戻しで再送可否を判定し、ローカル同期は冪等です。実行関数、SDK object、資格情報は永続化しません。保存した`kind`と`executor_version`からexecutor registryで解決します。意味を変える場合はversionを上げ、旧versionの保存済みstepを移行し終えるまで旧executorを保持します。

planは`format_version`、`execution_id`、`origin`、既知の一時参照と順序付きstepを保存します。GUI直接編集のplanは操作ID、タスクGID、プロジェクトGIDを`gui_context`に保存します。各Asana stepのpayloadには承認時の基準値または同じplanの作成操作を指す基準値の出所を含めます。作成stepのreceiptは新GIDと一時参照を結び、後続stepはそのreceiptから対象を解決します。fingerprintはpayloadの正規化JSONへSHA-256を適用し、保存後の読込時にも照合します。Zodはstep種別ごとにpayloadを検証し、同期stepを最後の1件に制限します。proposalの同期条件は確認済み操作で、`already_applied`も含めます。GUI直接編集の同期条件はwriter結果の取得です。

proposal executionには、最終resultの再構成に必要なgroup ID、atomic属性、group順とgroup内の操作ID順をimmutableなcontextとしてplanと同じtransactionで保存します。contextの操作ID集合はplanの操作ID集合と一致させ、Zodとfingerprintを保存時と読込時に照合します。GUI直接編集にはproposal contextを保存せず、`gui_context`とAsana stepの送信済みreceiptからGUI結果を再構成します。GUIの後続同期が失敗した場合は同期エラーコードをstepに保存し、再読込後もGUI結果の`sync_error_code`へ投影します。

外部書き込みの前に全stepと承認時の基準値を含むplanをjournalへ保存し、以後はplanを変更しません。復旧時は保存済み`kind`、`executor_version`、`payload`、`payload_fingerprint`を使用し、現在のhandlerからplanを再生成しません。stepは`planned`から、外部call直前に`running`を保存し、receipt確認後に`succeeded`を保存します。失敗したstepは`failed`または`confirmation_required`にします。保存が失敗したら外部callを開始しません。

全stepが`succeeded`になった後、proposal全体の最終resultとexecutionの`succeeded`への遷移を同じtransactionで保存します。最終resultの保存前に中断したexecutionは`running`のまま復旧対象に残し、保存済みcontextとstep receiptからresultを再構成します。`succeeded`への再要求では保存済みresultを返します。`failed`と`confirmation_required`への遷移では、該当stepとexecutionに同じerror IDを保存します。

異常終了後に`running`だったstepは読み戻して分類します。適用済みと確認できればreceiptを補完して`succeeded`、未適用と確認できてretry可能なら同じstep IDで再実行します。適用の有無を確認できない場合や非冪等なstepは`confirmation_required`として永続化し、自動再送しません。Asana native fieldとCustom external dataの部分成功は各stepの結果として保持し、成功済みstepを再送しません。

実行エンジンは保存済みexecutionを読み、`kind`と`executor_version`で書き込みexecutorを解決します。`proposal_operation_check`はAsanaのcore値、専用プロジェクト所属、Custom external dataの識別子と対象項目を読み戻します。`already_applied`なら対象GIDと観測状態のfingerprintを照合receiptへ保存し、同じ操作の後続Asana stepを外部callなしで成功保存します。省略したstepのreceiptには照合step IDを記し、読込時にも対象GIDと観測fingerprintの一致を確認します。後続同期は保存済みreceiptと一時参照から対象GIDを解決します。
照合stepだけを持つ操作で現在値が未適用なら、実行可能な書き込みstepがないため`failed`へ保存します。

Asana stepは書き込み前後に読戻し、作成stepは事前発行UUIDで専用プロジェクトを探索します。作成後のGETでは404と外部データ、所属、セクションの投影待ちだけを上限付きで再観測します。`running`の作成stepでUUID一致タスクが見つからなくても自動作成しません。読戻し障害と判定不能な状態は元のエラーを記録し、同じstepを再送せず`confirmation_required`へ保存します。
書き込みが失敗しても読戻しで未適用と確定できたretry可能なstepだけ、同じstep IDのattemptを保存して最大3回まで再試行します。
Asana書き込みstepのtransportは各attemptで一度だけ送信します。通信失敗、429、5xx、401後の認証更新でも同じattempt内では再送しません。再試行の判断とattemptの保存は実行エンジンが読戻し後に行います。

proposal単位の同時実行を禁止します。二重click、IPC再送、起動時復旧は同じlockとrepositoryのexecution stateで判定します。`succeeded`への再要求は保存済みresultだけを返します。`failed`と`confirmation_required`への再要求は保存済み状態とerror IDを返し、同じexecution IDで再実行しません。利用者が明示的にやり直す場合だけ、元execution IDを参照する新executionを作ります。

proposalの後続同期は適用状態が`applying`で、操作queueの実行権を所有する場合に限り呼びます。保存済みexecutionの復旧中は復旧用の同期条件に従います。GUI編集の後続同期はGUI編集のqueue所有条件に従う別入口を呼びます。いずれも条件が整わない段階で成功や空同期を返さず、実行を始めません。
保存済みexecutionの復旧中は、後続同期の未完了判定から実行中の自身だけを除きます。別の未完了executionまたは未確定の旧ジャーナルがある場合は後続同期を開始しません。

SQLite v8は`proposal_executions`と`proposal_execution_steps`を共通の実行journalとして使い、旧`application_journal`を別の`legacy_application_history`へ移します。v3からv7のDBを開く場合、schemaを変更する前にWALの確定済み内容を`taskhub.sqlite3.pre-v8.backup.sqlite3`へ`VACUUM INTO`で保存します。バックアップはDBと同じ所有者限定ディレクトリに置き、ファイル権限、再読込、整合性、旧行の内容と各テーブルの件数を照合します。異常終了後も同じパスのバックアップを再読込し、元行を履歴へ移すまで保持します。schema移行はtransactionで行い、旧行の件数を照合します。新executionの全planと全stepは外部callより前に一つのtransactionで保存します。step状態と試行回数はCASで更新し、receiptまたはerror IDとexecution状態も同じtransactionで確定します。最終resultは`succeeded`へのCASと同時に保存します。保存時と読込時にplan全体と各payloadのfingerprintを照合します。

旧形式には外部call単位のstepとreceiptがないため、新journalの実行可能なplanへ推測変換しません。旧行ごとに元のschema version、複合ID、stage、final result、reason、schema変更前の全列のJSON snapshotとSHA-256、独立した確認状態を版付き非実行履歴へ保存します。v3とv4の元行はバックアップから読み、schema移行後の行との値の対応を検証します。保存済み履歴を同じtransaction内で再読込して内容と件数を照合した後だけ元行を削除します。同じ内容の移行は追加せず、同じIDで異なる内容の履歴は元行を残します。旧行への参照はSELECTだけに限ります。失敗行と未確認履歴は復旧表示へ統合し、一般の書き込みと同期を止めます。同じproposalの履歴がある場合、確認状態にかかわらず新しいexecutionを作りません。元のfinal resultは確認結果で上書きせず、未確認履歴を自動再送しません。外部agentの状態照会は履歴を`journal`または`unknown`へ投影し、新形式は保存済みexecutionの操作結果を`execution`へ投影します。
