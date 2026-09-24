# hiho-task-ai

AIが僕のタスクを管理してくれたりする仕組みやGUI

## インストールと更新

署名版の配布先は[edge Release](https://github.com/Hiroshiba/hiho-task-management-ai/releases/tag/edge)です。中央リポジトリの[oreore-codesigner](https://github.com/Hiroshiba/oreore-codesigner)で自己署名して公開します。TaskHubの署名公開と実機での導入・更新は未確認です。

初回は中央の[端末の初期設定](https://github.com/Hiroshiba/oreore-codesigner/blob/main/docs/device-setup.md)に従い、公開証明書のfingerprintを別の信頼できる経路で照合してから、OSに応じた証明書の登録を行ってください。その後、ブラウザーでReleaseから次の署名済みファイルを取得します。

| OS          | 配布形式           | 導入方法                                                                                                                   |
| ----------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| macOS x64   | ZIP                | 隔離属性を保持したまま展開し、TaskHub.appをアプリケーションフォルダーへ移す                                                |
| Windows x64 | 通常NSIS、NSIS Web | ダウンロード元の情報を保持し、デジタル署名を確認してインストーラーを実行する。NSIS Webは追加のパッケージをダウンロードする |

macOS arm64ネイティブ版、DMG、Windows ZIPは生成しません。自己署名のため、証明書の登録後もmacOSのGatekeeperやWindowsのSmartScreenの警告が残る場合があります。macOSでは配布元と署名を確認して個別アプリの許可操作を行います。詳しい操作は端末の初期設定を参照し、隔離属性の削除やOSの保護設定全体の無効化は行わないでください。Smart App Controlが強制されているWindows端末は対象外です。

アプリ内の自動更新・差分更新は未実装です。署名版同士の手動更新では、更新前の版と設定を下記の方法で記録してから、次の操作を行います。

- macOS x64では、ブラウザーでedge Releaseから次版の署名済みZIPを取得します。TaskHubを終了し、隔離属性を保持したままZIPを展開して、`/Applications/TaskHub.app`を置き換えます。置き換えたアプリを起動します。
- Windows x64では、ブラウザーでedge Releaseから次版の署名済み通常NSISを取得します。ダウンロード元の情報を保持してデジタル署名を確認し、TaskHubを終了して通常NSISを再実行します。インストール先のTaskHubを起動します。NSIS Webは初回導入用です。

初回導入後と更新前後に、実際に起動するアプリの版表記を記録します。macOSでは`/Applications/TaskHub.app/Contents/Info.plist`の`CFBundleShortVersionString`、Windowsではインストール先の`TaskHub.exe`のプロパティの「詳細」にあるファイルバージョンを確認します。prereleaseを含む版表記は実成果物で未確認です。Releaseの更新メタデータの`version`と実際の成果物の版表記の対応を確かめてから照合し、表記から次版を識別できない場合は版の確認を未完了として記録してください。

設定保持の検証では、初回導入後にObsidianのVaultを登録し、ヘッダーの「設定」に表示されるVault IDと絶対パスを更新前後で比較します。更新後に初回設定をやり直さず起動でき、登録値が保持されることを確認してください。Asanaのタスクが表示されることだけでは、ローカルデータの保持を確認したことにはなりません。

旧未署名版からの移行は、署名版同士の更新とは別に実機検証が必要です。設定・データの保存先は変えませんが、移行時の保持は未検証です。旧Windows ZIPからの移行は、既存フォルダーの単純な上書きではなく、署名済み通常NSISによるインストールになります。旧macOS版からの置き換えも未検証です。

## 開発

```sh
pnpm install
pnpm run dev
```

WebとElectronのフロントは、URLの`mock`クエリでmockを選べます。対応する機能名は`app`、`asana`、`readModel`、`sync`、`setup`、`gui`、`externalAgent`、`ai`、`obsidian`です。

WebフロントはViteだけを起動します。

```sh
pnpm run dev:web
```

サーバー起動後、表示されたURLへ次のように指定します。

```text
http://localhost:5173/?mock=all
http://localhost:5173/?mock=asana,readModel
```

`mock=all`は全機能をmockにし、機能名をカンマ区切りで指定すると列挙した機能だけをmockにします。指定していない機能は通常のAPIを使います。Webフロントには通常のAPIがないため、画面全体の確認には`mock=all`を使います。部分指定で未選択の機能にアクセスするとエラーになります。

mockはセットアップ完了状態で始まり、サンプルタスクとAIの固定提案を使えます。mock上の変更はメモリ内に保持され、ページの再読み込みで初期状態に戻ります。mockの指定を変えるときも、URLを変更してページを再読み込みします。

空の指定、未対応の機能名、`mock`パラメータの重複、`all`と個別機能名の混在はエラーになります。

Electronでは`electron-vite`の引数を介してRenderer URLへmock指定を渡します。

```sh
pnpm run dev -- --mock=all
pnpm run dev -- --mock=asana,readModel
```

検証とローカル梱包には次のコマンドを使います。

```sh
pnpm run lint
pnpm run typecheck
pnpm run build
pnpm run package:dir
pnpm run package
```

`package`と`package:dir`はローカル梱包用で、中央の署名済みRelease成果物の生成・公開手順ではなく、配布には中央の`sign-release`が公開した成果物を使います。

## 署名版の公開

公開には中央の[GitHubの初期設定](https://github.com/Hiroshiba/oreore-codesigner/blob/main/docs/github-setup.md)と[ソースの要件](https://github.com/Hiroshiba/oreore-codesigner/blob/main/docs/source-requirements.md)を満たす必要があります。GitHub AppのSelected repositoriesに`Hiroshiba/hiho-task-management-ai`を含め、署名用Secretsを中央へ設定してください。

以下の手順は、中央の`sign-release`への`version`入力追加が中央の既定ブランチへ反映されてから実行してください。

1. 検証を済ませ、公開するコミットが中央のソースの要件を満たすことを確認します。配布する`version`は、先頭に`v`を付けないSemVerで、既に配布した版より大きい値を決めます。edge配布ではprereleaseの先頭識別子を`edge`にし、たとえば`0.1.1-edge.0`の次は`0.1.1-edge.1`にします。ルートの`package.json`の`version`と一致させる必要はなく、配布版を変えるためだけのソース更新は不要です。中央は既存版との大小を検証しません。
2. `edge`タグを公開するコミットへ向けます。同じタグの[edge Release](https://github.com/Hiroshiba/hiho-task-management-ai/releases/tag/edge)を用意し、prereleaseで、assetを追加・置換できる状態であることを確認します。Immutable Releaseは使えません。
3. 中央の[sign-release](https://github.com/Hiroshiba/oreore-codesigner/actions/workflows/sign-release.yml)を既定ブランチから手動実行し、`repository`に`Hiroshiba/hiho-task-management-ai`、`tag`に`edge`、`version`に手順1で決めた版を指定します。3つとも必須入力です。ビルド・署名・公開中は`edge`タグとReleaseを変更しないでください。次の配布でタグを移動する場合も、前の実行を完了させてから行います。
4. 両OSの署名と公開が完了したら、同じコミットSHAを使ったことと、中央が新たに公開する更新メタデータを含む8件のassetを確認します。メタデータのサイズ・hash・versionが公開ファイルと一致することを確認します。更新メタデータの`path`と`files.url`が公開後のasset名と大文字小文字を含めて一致することを確認します。
5. 両OSの実機で、[インストールと更新](#インストールと更新)の手順に沿って初回導入と次の署名版への手動更新を行い、起動・版・設定保持を確認します。確認結果とOSの警告・許可操作は、中央の[記録する内容](https://github.com/Hiroshiba/oreore-codesigner/blob/main/docs/verification.md#記録する内容)に沿って残します。未実装の自動更新・差分更新と、未検証の旧未署名版からの移行を成功扱いにしないでください。

手順3はGitHub CLIでも実行できます。

```sh
gh workflow run sign-release.yml --repo Hiroshiba/oreore-codesigner --ref main -f repository=Hiroshiba/hiho-task-management-ai -f tag=edge -f version=0.1.1-edge.1
```

更新メタデータのchannelは指定した`version`から決まり、`0.1.1-edge.1`なら`edge`、通常版の`1.2.3`なら`latest`です。タグ名やReleaseのprerelease設定からは決まりません。通常版を公開する場合は、たとえば`v1.2.3`タグと同名のReleaseを用意し、`tag=v1.2.3`、`version=1.2.3`で実行します。更新メタデータを公開しても、TaskHubの更新方法は手動更新です。

中央は同名assetを置換しますが、異なる名前の既存assetは削除しません。固定のedge Releaseでは、旧版を名前に含むassetは別名なら残り、同名の`edge.yml`と`edge-mac.yml`は置換されます。初回の署名公開が成功して整合を確認した後、旧未署名版の次の5件だけをReleaseから削除してください。後続版の署名済みblockmapは、中央の更新用成果物として保持してください。

- `TaskHub-0.1.0-arm64-mac.zip`
- `TaskHub-0.1.0-arm64.dmg`
- `TaskHub-0.1.0-win.zip`
- `taskhub-0.1.0-x64.nsis.7z`
- `TaskHub-Setup-0.1.0.exe`

公開途中で失敗すると、新旧のファイルが混在する場合があります。中央の[公開と再実行](https://github.com/Hiroshiba/oreore-codesigner/blob/main/docs/operations.md)に従い、タグと公開先を維持して原因を解消し、同じActions実行の`Re-run failed jobs`で再実行してください。成功後にReleaseのファイルと更新メタデータの整合を再確認します。

## エラーログ

エラーは `app.getPath('logs')/taskhub-error.log` にJSONL形式で保存します。Windows版の通常の保存先は `%APPDATA%\TaskHub\logs\taskhub-error.log` です。ローテーションしたログも同じディレクトリに残ります。

発生日時と処理区分に加え、`error_message` にエラーメッセージ、`stack_trace` にスタックトレース、`cause_chain` と `aggregate_errors` に元の例外を記録します。外部連携の失敗などは共通の `app.error` として記録されるため、診断コードだけでなくエラーメッセージと元の例外を確認してください。

## Asana接続

1. Asana Developer Consoleで個人用の非公開OAuthアプリを作成します。
2. 権限はFull permissionsを選びます。
3. Redirect URLへ`urn:ietf:wg:oauth:2.0:oob`を正確に登録します。
4. TaskHubへClient IDとClient Secretを入力します。
5. ブラウザでAsanaの利用を許可します。
6. Asanaに表示された認可コードを有効期限内にTaskHubへ貼り付けます。
7. 再認証も同じ方式で行います。

認証待ち時間やローカルコールバックURLの入力は不要です。Client Secretは会話、Issue、ログへ貼らないでください。

## Obsidian連携

初回設定でVaultの登録をスキップした場合も、後から設定できます。

1. ヘッダーの「設定」を開きます。
2. Obsidianの設定で、Vault IDとフォルダの絶対パスを入力します。
3. 保存します。

登録済みのVaultは、同じVault IDのまま参照先を変更できます。AIは登録したVaultのノートを読み取り専用で参照します。

## 外部Codexからの利用

Windowsでは同じPCのWSL、macOSでは同じMacのターミナルから利用します。TaskHubを起動し、Asanaの初回設定と同期を済ませてください。

1. ヘッダーの「設定」を開き、外部連携を有効にします。
2. 表示された登録コマンドを、Codexを使うターミナルで実行します。
3. Codexから `$taskhub 今着手できるタスクを5件教えて` のように呼び出します。

Codexの権限設定で実行が制限される場合は、画面にある実行許可を設定するコマンドを利用し、Codexを再起動します。

TaskHub内のAIと同じタスク参照と変更案の提出ができます。新規作成のほか、タイトルや説明、期限、状態、親子関係、依存関係の変更、タスクの分割、完了、取り下げなどを依頼できます。

変更案はTaskHubの「外部からの提案」で確認します。適用するグループや操作を選び、必要に応じて内容を編集して承認すると、選んだ変更をAsanaへ反映します。完了、取り下げ、分割では依頼の原文と対象も確認してください。

SkillとCLIはTaskHubの起動時に更新されます。詳しい動作と更新方針は[要件・設計書の外部Codex連携](docs/requirements_and_design.md#128-外部codexからの利用)にまとめています。
