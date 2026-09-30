# 0001 機能境界と状態所有者を静的に強制する

状態: 採用。対象基準は`1a20178ab1a593ca5b0111728b504bb5466a8165`です。

対象基準ではMain入口、`application/service.ts`、変更案coordinatorとwriter、IPC registry、`App.vue`へ複数機能の判断と可変状態が集まっていました。修正PRでは適用復旧、新規作成後の読み戻し、同期後の表示、診断記録が複数moduleをまたいで繰り返し修正されていました。境界の決定を人手の注意だけに委ねると、新しい変更が同じ依存と所有の曖昧さを増やします。

採用案は [architecture.md](../architecture.md) のworkflow、port、adapter、composition rootへ機能を配置し、import方向、循環依存、旧path、module直下の可変状態候補を構造検査で失敗として検出することです。全sourceに同じ検査規則を適用します。各機能の可変状態は [state-ownership.md](../state-ownership.md) の唯一のownerが保持し、変更案の通常適用、復旧、GUI編集は [proposal-execution.md](../proposal-execution.md) の同じexecutorを使います。

比較した代替案は、既存moduleを残して薄いwrapperを置く案と、機能ごとに新旧を切り替える案です。前者は旧moduleへの依存と可変状態を残し、後者は同じproposal内で通常適用と復旧が異なるwriterへ流れる余地を残します。どちらも既存データと外部副作用の整合を単一のownerで保証できないため採用しません。

採用時に見込んだ費用はsourceの再配置、保存済み値の移行、IPC channelと17操作の整理、Rendererの状態移動、mockとCIの更新でした。外部書き込みと復旧を同じexecutorに統合し、保存形式の移行を各adapterの責務にしました。

検証はcache付きlint、incremental typecheck、全sourceの構造検査、行数検査、build、mock表示で行います。実サービスとGitHub Appのsecretはローカル検証に使いません。source一覧は現在の作業ツリーから生成します。
