# hiho-task-ai

AIが僕のタスクを管理してくれたりする仕組みやGUI

## インストールと更新

署名済み通常版を導入する前に、[Release一覧](https://github.com/Hiroshiba/hiho-task-management-ai/releases)からタグが`v<version>`の公開済みReleaseを選びます。macOSのZIP・blockmap・`latest-mac.yml`、Windowsの通常NSIS・blockmap・`latest.yml`・NSIS Web・`.nsis.7z`の8件が揃い、両方の更新メタデータの`version`がタグの版と一致し、`path`と`files.url`が配布ファイルを指すことを確認してください。条件に合うReleaseがない場合、通常版の導入は進めないでください。

通常版は中央リポジトリの[oreore-codesigner](https://github.com/Hiroshiba/oreore-codesigner)で自己署名します。未署名の開発版は固定の[edge Release](https://github.com/Hiroshiba/hiho-task-management-ai/releases/tag/edge)から取得してください。edgeはmainへのpushで自動公開し、prereleaseとして扱います。

アプリ内の自動更新・差分更新は未実装で、更新は手動で行います。TaskHubの署名済み通常版の公開、macOSとWindowsの実機での導入・更新は未確認です。

### 署名済み通常版

初回は中央の[端末の初期設定](https://github.com/Hiroshiba/oreore-codesigner/blob/main/docs/device-setup.md)に従い、公開証明書のfingerprintを別の信頼できる経路で照合してから、OSに応じた証明書の登録を行ってください。その後、ブラウザーで通常版Releaseから次のファイルを取得します。ファイル名の`<version>`は、そのReleaseの配布版に置き換えてください。

| OS          | 配布ファイルの選び方                                               | 導入方法                                                                                        |
| ----------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| macOS x64   | `latest-mac.yml`の`path`と`files.url`が参照するZIP                 | 隔離属性を保持したまま展開し、TaskHub.appをアプリケーションフォルダーへ移す                     |
| Windows x64 | `latest.yml`が参照する通常NSISの`TaskHub-Setup-<version>-full.exe` | ダウンロード元の情報を保持し、デジタル署名を確認して実行する                                    |
| Windows x64 | NSIS Webの`TaskHub-Setup-<version>.exe`                            | 初回導入用。署名を確認して実行すると、同じReleaseの`.nsis.7z`パッケージを追加でダウンロードする |

導入する版と、`latest-mac.yml`または`latest.yml`の`version`が一致することを確認してください。通常版はmacOS arm64ネイティブ版、DMG、Windows ZIPを生成しません。`.blockmap`と更新メタデータは導入時に開くファイルではありません。

自己署名のため、証明書の登録後もmacOSのGatekeeperやWindowsのSmartScreenの警告が残る場合があります。macOSでは配布元と署名を確認して個別アプリの許可操作を行います。詳しい操作は端末の初期設定を参照し、隔離属性の削除やOSの保護設定全体の無効化は行わないでください。Smart App Controlが強制されているWindows端末は対象外です。

通常版同士の手動更新では、更新前の版と設定を下記の方法で記録してから、次の操作を行います。

- macOS x64では、通常版Releaseから次版の署名済みZIPを取得します。TaskHubを終了し、隔離属性を保持したままZIPを展開して、`/Applications/TaskHub.app`を置き換えます。置き換えたアプリを起動します。
- Windows x64では、通常版Releaseから次版の署名済み通常NSISを取得します。ダウンロード元の情報を保持してデジタル署名を確認し、TaskHubを終了して通常NSISを再実行します。インストール先のTaskHubを起動します。

### 未署名のedge

edge Releaseには次の5件を公開します。ファイル名の`<version>`はソースの`package.json`の版です。mainの更新ごとに同じReleaseのファイルを入れ替えるため、同じ版表記でも中身が変わります。

| OS          | 配布ファイル                                                     | 導入方法                                                                                  |
| ----------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| macOS arm64 | `TaskHub-<version>-arm64.dmg`、`TaskHub-<version>-arm64-mac.zip` | どちらかを取得し、DMGを開くかZIPを展開して、TaskHub.appをアプリケーションフォルダーへ移す |
| Windows x64 | `TaskHub-<version>-win.zip`                                      | フォルダーへ展開し、TaskHub.exeを起動する                                                 |
| Windows x64 | `TaskHub-Setup-<version>.exe`、`taskhub-<version>-x64.nsis.7z`   | NSIS Webのexeを実行する。7zはインストーラーが取得する追加パッケージで、直接開く必要はない |

edgeは未署名のため、通常版の証明書登録によって署名済みにはなりません。配布元を確認し、OSが案内する個別アプリの許可操作で導入してください。OSの保護設定全体は無効化しないでください。

edgeを更新するときは、TaskHubを終了してから新しい配布ファイルでアプリを置き換えるか、NSIS Webを再実行します。利用したファイル名に加えて、edgeタグのコミットSHAを更新前後で記録してください。未署名のedgeから署名済み通常版への移行は未検証です。Windows ZIPから通常版へ移行するときは通常NSISでインストールし、macOSでは通常版のZIPでアプリを置き換えます。

### 版と設定の確認

初回導入後と更新前後に、実際に起動するアプリの版表記を記録します。macOSでは`/Applications/TaskHub.app/Contents/Info.plist`の`CFBundleShortVersionString`、Windowsではインストール先の`TaskHub.exe`のプロパティの「詳細」にあるファイルバージョンを確認します。prereleaseを含む版表記は実成果物で未確認です。配布版と実際の成果物の版表記の対応を確かめてから照合し、表記から次版を識別できない場合は版の確認を未完了として記録してください。

設定保持の検証では、初回導入後にObsidianのVaultを登録し、ヘッダーの「設定」に表示されるVault IDと絶対パスを更新前後で比較します。更新後に初回設定をやり直さず起動でき、登録値が保持されることを確認してください。Asanaのタスクが表示されることだけでは、ローカルデータの保持を確認したことにはなりません。設定・データの保存先は配布形式によって変えませんが、更新・移行時の保持は実機で未検証です。

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

`package`と`package:dir`はローカル梱包用です。署名済み通常版の生成・公開には中央の`sign-release`を使います。

## 通常版の公開

公開には中央の[GitHubの初期設定](https://github.com/Hiroshiba/oreore-codesigner/blob/main/docs/github-setup.md)と[ソースの要件](https://github.com/Hiroshiba/oreore-codesigner/blob/main/docs/source-requirements.md)を満たす必要があります。GitHub AppのSelected repositoriesに`Hiroshiba/hiho-task-management-ai`を含め、署名用Secretsを中央へ設定してください。

配布版の正本は、公開するタグが指すコミットのルートの`package.json`の`version`です。担当者が版を更新してコミットし、中央のworkflowを手動実行します。

1. main上の公開対象コミットの検証を済ませ、中央のソースの要件を満たすことを確認します。そのコミットを基点に、通常版の公開専用ブランチを作成します。以下は`0.1.1`を公開する例です。TaskHubの作業ディレクトリで`MAIN_COMMIT_SHA`を検証済みのコミットSHAに置き換えて実行します。

   ```sh
   git switch -c release/v0.1.1 MAIN_COMMIT_SHA
   ```

2. ルートの`package.json`の`version`を、先頭に`v`を付けず、prerelease識別子を含まないSemVerへ更新します。既に配布した版より大きい値を選び、この例では`0.1.1`にします。中央は既存版との大小を検証しません。`pnpm install --lockfile-only`でロックファイルを同期し、`pnpm run lint`、`pnpm run typecheck`、`pnpm run build`を実行します。`package.json`をコミットし、`pnpm-lock.yaml`に差分が出た場合は併せてコミットします。この版更新コミットはmainへマージしません。mainへのpushはedgeの自動公開を起動するため、通常版の版名で未署名のedgeが公開されるのを避けます。
3. 版更新コミットに`v<version>`のタグを付け、対象リポジトリへpushします。タグの版は、そのコミットの`package.json`の`version`と一致させます。`RELEASE_COMMIT_SHA`を手順2のコミットSHAに置き換えて実行し、最後に表示されるGitHub上のSHAと一致することを確認します。

   ```sh
   git tag v0.1.1 RELEASE_COMMIT_SHA
   git push https://github.com/Hiroshiba/hiho-task-management-ai.git refs/tags/v0.1.1
   gh api repos/Hiroshiba/hiho-task-management-ai/commits/v0.1.1 --jq '.sha'
   ```

4. TaskHubのGitHub Releasesで、そのタグを選びdraft Releaseを作成します。prereleaseは指定せず、assetを追加・置換できる状態にします。Immutable Releaseは使えません。中央は既存Releaseに成果物を追加し、draftとprereleaseの状態は変更しません。
5. 中央の[sign-release](https://github.com/Hiroshiba/oreore-codesigner/actions/workflows/sign-release.yml)を既定ブランチから手動実行します。入力は`repository`と`tag`の2つです。GitHub CLIでは次を実行します。ビルド・署名・公開中は対象タグとReleaseを変更しないでください。

   ```sh
   gh workflow run sign-release.yml --repo Hiroshiba/oreore-codesigner --ref main -f repository=Hiroshiba/hiho-task-management-ai -f tag=v0.1.1
   ```

6. 両OSの署名とアップロードが成功したら、両OSが手順2の版更新コミットSHAを使ったことを確認します。draft Releaseに、macOSのZIP・blockmap・`latest-mac.yml`、Windowsの通常NSIS・blockmap・`latest.yml`・NSIS Web・`.nsis.7z`の合計8件が揃っていることを確認します。更新メタデータの`version`がタグ先の`package.json`の`version`とタグの版に一致し、`path`と`files.url`が実ファイル名と大文字小文字を含めて一致し、サイズ・Base64のSHA-512・blockmapが実ファイルと一致することを確認します。
7. draft ReleaseからmacOSのZIPとWindowsの通常NSISを取得し、実機で[インストールと更新](#インストールと更新)に沿って署名・起動・版・設定保持を確認します。更新の検証では、前の通常版から今回の通常版へ手動更新します。初回公開などで確認できない項目は未検証として記録します。
8. 成果物の整合と実機での確認結果を確かめたら、draftを解除してReleaseを公開し、prereleaseを外した状態でLatest Releaseに指定します。[最新の通常版Release](https://github.com/Hiroshiba/hiho-task-management-ai/releases/latest)が今回のReleaseを指し、配布ファイルを取得できることを確認します。NSIS Webは公開後に追加パッケージを取得して初回導入できることを確認します。確認結果とOSの警告・許可操作は、中央の[記録する内容](https://github.com/Hiroshiba/oreore-codesigner/blob/main/docs/verification.md#記録する内容)に沿って残してください。

中央はタグ先の`package.json`の`version`を配布版として採用し、更新メタデータのchannelもその値から決めます。通常版の`0.1.1`は`latest`です。タグ名やReleaseのprerelease設定ではchannelは変わりません。更新メタデータを公開しても、TaskHubの更新方法は手動更新です。

公開途中で失敗すると、新旧のファイルが混在する場合があります。中央の[公開と再実行](https://github.com/Hiroshiba/oreore-codesigner/blob/main/docs/operations.md)に従い、タグと公開先を維持して原因を解消し、同じActions実行の`Re-run failed jobs`で再実行してください。成功後にReleaseのファイルと更新メタデータの整合を再確認します。

## edgeの自動公開

[edgeリリースworkflow](.github/workflows/edge-release.yml)はmainへのpushで未署名の5件を生成し、固定の[edge Release](https://github.com/Hiroshiba/hiho-task-management-ai/releases/tag/edge)へ公開します。公開時はprereleaseを有効にし、Latest Releaseには指定しません。同名ファイルを置換し、今回の5件に含まれないファイルを削除します。edgeタグも公開対象のコミットへ移動します。

署名済み通常版は独立した版タグとReleaseへ公開します。edgeへの署名成果物の追加や手動でのタグ移動は、自動公開と競合するため行わないでください。

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
