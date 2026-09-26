# hiho-task-ai

AIが僕のタスクを管理してくれたりする仕組みやGUI

## インストールと更新

署名済み通常版の導入対象は、中央の公開条件を満たして公開された通常版Releaseに限ります。[Release一覧](https://github.com/Hiroshiba/hiho-task-management-ai/releases)からタグが`v<version>`の公開済みReleaseを選びます。macOSのZIP・blockmap・`latest-mac.yml`、Windowsの通常NSIS・blockmap・`latest.yml`・NSIS Web・`.nsis.7z`の8件が揃い、両方の更新メタデータの`version`がタグの版と一致し、`path`と`files.url`が配布ファイルを指すことを確認してください。条件に合うReleaseがない場合、通常版の導入は進めないでください。

通常版を公開する場合は、中央リポジトリの[oreore-codesigner](https://github.com/Hiroshiba/oreore-codesigner)で自己署名します。過去に公開した未署名の開発版は固定の[edge Release](https://github.com/Hiroshiba/hiho-task-management-ai/releases/tag/edge)から取得できます。edgeの更新は停止しており、mainへのpushで新たな配布物は公開しません。

署名済み通常版のmacOS x64とWindows x64では、起動後に最新の通常版を確認し、見つかった更新を自動で取得します。ヘッダーに確認中、取得中、終了時に適用する準備ができた状態、失敗を表示します。取得できた更新はTaskHubを通常終了した時に適用されます。終了時の適用後も版が更新されていなければ、次回起動時に失敗を表示し、ログに記録します。失敗表示は次の更新の確認中も残し、更新版の準備が完了すると切り替わります。更新に失敗してもタスクの閲覧や編集は続けられます。失敗後の確認は次の起動時に行います。

自動更新に初めて対応する版は、それ以前の版から自動取得できません。現在公開済みの`0.1.1`には更新機能がないため、初回対応版は下記の手動更新手順で導入してください。

### 署名済み通常版

初回は中央の[端末の初期設定](https://github.com/Hiroshiba/oreore-codesigner/blob/main/docs/device-setup.md)に従い、公開証明書のfingerprintを別の信頼できる経路で照合してから、OSに応じた証明書の登録を行ってください。その後、ブラウザーで通常版Releaseから次のファイルを取得します。ファイル名の`<version>`は、そのReleaseの配布版に置き換えてください。

| OS          | 配布ファイルの選び方                                               | 導入方法                                                                                        |
| ----------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| macOS x64   | `latest-mac.yml`の`path`と`files.url`が参照するZIP                 | 隔離属性を保持したまま展開し、TaskHub.appをアプリケーションフォルダーへ移す                     |
| Windows x64 | `latest.yml`が参照する通常NSISの`TaskHub-Setup-<version>-full.exe` | ダウンロード元の情報を保持し、デジタル署名を確認して実行する                                    |
| Windows x64 | NSIS Webの`TaskHub-Setup-<version>.exe`                            | 初回導入用。署名を確認して実行すると、同じReleaseの`.nsis.7z`パッケージを追加でダウンロードする |

導入する版と、`latest-mac.yml`または`latest.yml`の`version`が一致することを確認してください。通常版はmacOS arm64ネイティブ版、DMG、Windows ZIPを生成しません。`.blockmap`と更新メタデータは導入時に開くファイルではありません。

自己署名のため、証明書の登録後もmacOSのGatekeeperやWindowsのSmartScreenの警告が残る場合があります。macOSでは配布元と署名を確認して個別アプリの許可操作を行います。詳しい操作は端末の初期設定を参照し、隔離属性の削除やOSの保護設定全体の無効化は行わないでください。Smart App Controlが強制されているWindows端末は対象外です。

自動更新に対応しない版から移るときや、自動更新が失敗したときは、更新前の版と設定を下記の方法で記録してから手動で導入します。

- macOS x64では、通常版Releaseから次版の署名済みZIPを取得します。配布元を確認し、TaskHubを終了して、隔離属性を保持したままZIPを展開します。展開したアプリの署名を確認してから、`/Applications/TaskHub.app`を置き換えて起動します。
- Windows x64では、通常版Releaseから次版の署名済み通常NSISを取得します。ダウンロード元の情報を保持し、配布元とデジタル署名を確認してから、TaskHubを終了して通常NSISを再実行します。インストール先のTaskHubを起動します。

### 未署名のedge

edge Releaseには過去に公開した次の5件を残します。ファイル名の`<version>`は配布時のソースの`package.json`の版です。以前はmainの更新ごとに同じReleaseのファイルを入れ替えていたため、版表記だけで配布物のコミットを判別できません。

| OS          | 配布ファイル                                                     | 導入方法                                                                                  |
| ----------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| macOS arm64 | `TaskHub-<version>-arm64.dmg`、`TaskHub-<version>-arm64-mac.zip` | どちらかを取得し、DMGを開くかZIPを展開して、TaskHub.appをアプリケーションフォルダーへ移す |
| Windows x64 | `TaskHub-<version>-win.zip`                                      | フォルダーへ展開し、TaskHub.exeを起動する                                                 |
| Windows x64 | `TaskHub-Setup-<version>.exe`、`taskhub-<version>-x64.nsis.7z`   | NSIS Webのexeを実行する。7zはインストーラーが取得する追加パッケージで、直接開く必要はない |

edgeは未署名のため、通常版の証明書登録によって署名済みにはなりません。配布元を確認し、OSが案内する個別アプリの許可操作で導入してください。OSの保護設定全体は無効化しないでください。

edgeの新たな配布物は作りません。既存のedge配布物を使う場合は、ファイル名とedgeタグのコミットSHAを記録してください。未署名のedgeから署名済み通常版への移行は未検証です。Windows ZIPから通常版へ移行するときは通常NSISでインストールし、macOSでは通常版のZIPでアプリを置き換えます。

### 版と設定の確認

初回導入後と更新前後に、実際に起動するアプリの版表記を記録します。macOSでは`/Applications/TaskHub.app/Contents/Info.plist`の`CFBundleShortVersionString`、Windowsではインストール先の`TaskHub.exe`のプロパティの「詳細」にあるファイルバージョンを確認します。prereleaseを含む版表記は実成果物で未確認です。配布版と実際の成果物の版表記の対応を確かめてから照合し、表記から次版を識別できない場合は版の確認を未完了として記録してください。

設定保持の検証では、初回導入後にObsidianのVaultを登録し、ヘッダーの「設定」に表示されるVault IDと絶対パスを更新前後で比較します。更新後に初回設定をやり直さず起動でき、登録値が保持されることを確認してください。Asanaのタスクが表示されることだけでは、ローカルデータの保持を確認したことにはなりません。設定・データの保存先は配布形式によって変えませんが、自動更新時の保持は2版間の実機で未検証です。

## 開発

```sh
pnpm install
pnpm run dev
```

WebとElectronのフロントは、URLの`mock`クエリでmockを選べます。対応する機能名は`app`、`appUpdate`、`asana`、`readModel`、`sync`、`setup`、`gui`、`externalAgent`、`ai`、`obsidian`です。

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

TaskHubは、中央の[ソースの要件](https://github.com/Hiroshiba/oreore-codesigner/blob/main/docs/source-requirements.md)に沿ってアプリ内更新に対応した通常版を公開します。

公開時は中央の[GitHubの初期設定](https://github.com/Hiroshiba/oreore-codesigner/blob/main/docs/github-setup.md)と、その時点で適用される公開条件を満たしてください。GitHub AppのSelected repositoriesに`Hiroshiba/hiho-task-management-ai`を含め、署名用Secretsを中央へ設定してください。

中央のworkflowを実行する前に、既存の自動更新対応版から新しいReleaseへ更新できる経路を確認してください。`0.1.1`から初回対応版への導入は手動で行います。

配布版の正本は、公開するタグが指すコミットのルートの`package.json`の`version`です。担当者が版を更新してコミットし、中央のworkflowを手動実行します。

1. main上の公開対象コミットの検証を済ませ、中央のビルド要件を満たすことを確認します。そのコミットを基点に、通常版の公開専用ブランチを作成します。以下は`0.1.2`を公開する例です。TaskHubの作業ディレクトリで`MAIN_COMMIT_SHA`を検証済みのコミットSHAに置き換えて実行します。

   ```sh
   git switch -c release/v0.1.2 MAIN_COMMIT_SHA
   ```

2. ルートの`package.json`の`version`を、先頭に`v`を付けず、prerelease識別子を含まないSemVerへ更新します。既に配布した版より大きい値を選び、この例では`0.1.2`にします。中央は既存版との大小を検証しません。`pnpm install --lockfile-only`でロックファイルを同期し、`pnpm run lint`、`pnpm run typecheck`、`pnpm run build`を実行します。`package.json`をコミットし、`pnpm-lock.yaml`に差分が出た場合は併せてコミットします。
3. 版更新のPRをmainへsquash mergeします。マージ後のmain先端の`package.json`とロックファイルが版更新後の内容であること、mainへのpushで起動するCIが成功したことを確認します。mainへのpushで実行するworkflowはCIのみで、Releaseは自動公開しません。
4. マージ後のmain先端のコミットに`v<version>`のタグを付け、対象リポジトリへpushします。タグの版は、そのコミットの`package.json`の`version`と一致させます。対象リポジトリのmainを取得してから、`RELEASE_COMMIT_SHA`をGitHub上のmain先端のコミットSHAに置き換えて実行し、最後に表示されるタグ先SHAと一致することを確認します。

   ```sh
   git fetch https://github.com/Hiroshiba/hiho-task-management-ai.git main
   gh api repos/Hiroshiba/hiho-task-management-ai/git/ref/heads/main --jq '.object.sha'
   git tag v0.1.2 RELEASE_COMMIT_SHA
   git push https://github.com/Hiroshiba/hiho-task-management-ai.git refs/tags/v0.1.2
   gh api repos/Hiroshiba/hiho-task-management-ai/commits/v0.1.2 --jq '.sha'
   ```

5. TaskHubのGitHub Releasesで、そのタグを選びdraft Releaseを作成します。prereleaseは指定せず、assetを追加・置換できる状態にします。Immutable Releaseは使えません。中央は既存Releaseに成果物を追加し、draftとprereleaseの状態は変更しません。
6. 中央の[sign-release](https://github.com/Hiroshiba/oreore-codesigner/actions/workflows/sign-release.yml)を既定ブランチから手動実行します。入力は`repository`と`tag`の2つです。GitHub CLIでは次を実行します。ビルド・署名・公開中は対象タグとReleaseを変更しないでください。

   ```sh
   gh workflow run sign-release.yml --repo Hiroshiba/oreore-codesigner --ref main -f repository=Hiroshiba/hiho-task-management-ai -f tag=v0.1.2
   ```

7. 両OSの署名とアップロードが成功したら、両OSが手順4のタグ先コミットSHAを使ったことを確認します。draft Releaseに、macOSのZIP・blockmap・`latest-mac.yml`、Windowsの通常NSIS・blockmap・`latest.yml`・NSIS Web・`.nsis.7z`の合計8件が揃っていることを確認します。更新メタデータの`version`がタグ先の`package.json`の`version`とタグの版に一致し、`path`と`files.url`が実ファイル名と大文字小文字を含めて一致し、サイズ・Base64のSHA-512・blockmapが実ファイルと一致することを確認します。
8. draft ReleaseでNSIS Webのinstallerと`.nsis.7z` packageの存在と名前、installerの署名、最終タグのRelease URLから取得する設計を確認します。draft ReleaseからmacOSのZIPとWindowsの通常NSISを取得し、両OSの実機で[インストールと更新](#インストールと更新)に沿って配布元と署名を人手で確認し、導入・起動・主要機能を検証します。初回対応版を公開するときは`0.1.1`から手動導入し、自動更新の未確認範囲を記録します。
9. 成果物の整合と中央の公開前の確認項目を満たしたら、更新方式と公開前の確認結果、OSの警告・許可操作を中央の[記録する内容](https://github.com/Hiroshiba/oreore-codesigner/blob/main/docs/verification.md#記録する内容)に沿って残します。`gh release edit v0.1.2 --repo Hiroshiba/hiho-task-management-ai --draft=false --latest=false`でdraftを解除し、LatestにせずReleaseを公開します。公開直後からURLを知る利用者は取得できます。
10. GitHub認証なしで、最終タグのReleaseから手順7の全8件の配布ファイル・更新メタデータ・blockmapを取得できることを確認します。GitHub認証なしのWindows実機で、取得したNSIS Webのinstallerを実行し、同じReleaseの追加packageの取得・導入・起動・主要機能を確認します。すべての結果を記録し、いずれかに失敗した場合はLatest指定と利用案内を止め、原因の解消と修復、再確認を済ませるまで再開しないでください。
11. 全8件の匿名取得とNSIS Webの確認が成功したら、利用者へ案内してから`gh release edit v0.1.2 --repo Hiroshiba/hiho-task-management-ai --latest`でLatest Releaseに指定します。[最新の通常版Release](https://github.com/Hiroshiba/hiho-task-management-ai/releases/latest)が今回のReleaseを指し、配布ファイルを取得できることを確認します。

Latest指定後、自動更新に対応した旧版を両OSで起動し、自動確認、全量取得、通常終了時の適用、版・設定・利用者データの保持を検証して記録します。差分取得の成功は前回の更新ファイルがキャッシュにある端末で次版への更新を行い、差分取得に失敗した場合の全量取得も別途確認します。初回対応版では自動更新が可能な旧版がないため、この検証は次版以降に行います。

中央はタグ先の`package.json`の`version`を配布版として採用し、更新メタデータのchannelもその値から決めます。通常版の`0.1.2`は`latest`です。タグ名やReleaseのprerelease設定ではchannelは変わりません。アプリはLatest Releaseの更新メタデータと配布ファイルを参照し、旧版のblockmapは現在版のタグから取得します。

Windowsの自動更新には、署名済み成果物の`app-update.yml`に実際の証明書の署名者名と一致する`publisherName`が必要です。欠落するとアプリは更新を開始せず、ヘッダーに設定不備を表示します。公開前に署名済み成果物で署名者名を確かめ、同梱された`app-update.yml`と更新版の署名が一致することを確認してください。署名者名が未確認の間はWindowsの自動更新を検証済みとして扱わないでください。

公開途中で失敗すると、新旧のファイルが混在する場合があります。中央の[公開と再実行](https://github.com/Hiroshiba/oreore-codesigner/blob/main/docs/operations.md)に従い、タグと公開先を維持して原因を解消し、同じActions実行の`Re-run failed jobs`で再実行してください。成功後にReleaseのファイルと更新メタデータの整合を再確認します。

## 既存のedge配布物

固定の[edge Release](https://github.com/Hiroshiba/hiho-task-management-ai/releases/tag/edge)はprereleaseとして、未署名の既存配布物を残すために維持します。Latest Releaseには指定しません。既存のNSIS Web installerはこのReleaseのURLから追加packageを取得するため、edgeタグ、Release、配布ファイルを削除・移動しません。edgeの自動公開は停止し、mainへのpushでは独立した[CI workflow](.github/workflows/ci.yml)だけを実行します。

署名済み通常版は独立した版タグとReleaseへ公開します。edgeへ署名成果物を追加しません。

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
