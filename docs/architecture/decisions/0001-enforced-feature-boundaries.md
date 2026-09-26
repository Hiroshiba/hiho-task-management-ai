# 0001 機能境界と状態所有者を静的に強制する

状態: 採用。対象基準は`1a20178ab1a593ca5b0111728b504bb5466a8165`です。

現行のMain入口、`application/service.ts`、変更案coordinatorとwriter、IPC registry、`App.vue`へ複数機能の判断と可変状態が集まっています。修正PRでは適用復旧、新規作成後の読み戻し、同期後の表示、診断記録が複数moduleをまたいで繰り返し修正されています。境界の決定を人手の注意だけに委ねると、新しい変更が同じ依存と所有の曖昧さを増やします。

採用案は [architecture.md](../architecture.md) のworkflow、port、adapter、composition rootへ機能を移し、import方向、循環依存、旧path、module直下の可変状態候補を構造検査で失敗として検出することです。現行違反だけを固定baselineへ登録し、新しい違反を拒否します。各機能の可変状態は [state-ownership.md](../state-ownership.md) の唯一のownerへ移し、変更案の通常適用、復旧、GUI編集は [proposal-execution.md](../proposal-execution.md) の同じexecutorへ統合します。

比較した代替案は、既存moduleを残して薄いwrapperを置く案と、機能ごとに新旧を切り替える案です。前者は旧moduleへの依存と可変状態を残し、後者は同じproposal内で通常適用と復旧が異なるwriterへ流れる余地を残します。どちらも既存データと外部副作用の整合を単一のownerで保証できないため採用しません。

移行の費用は196件の現行sourceの再配置、SQLite v5とJSONの保存済み値の移行、64件のIPC channel、17操作、Rendererの状態移動、mockとCIの更新です。移行中は現行の入口と保存形式を維持し、新実装の全操作と復旧がそろった時点で単一の切替点を使います。旧実装との接続は指定された3ファイルに限定し、最終形では削除します。

検証は変更ファイルのcache付きlint、incremental typecheck、構造検査、phase末の全体検査とbuild、mock表示で行います。実サービスとGitHub Appのsecretはローカル検証に使いません。現行のsource一覧と違反baselineは基準commitの状態を表し、移行中の変更で解消したentryを削除します。
