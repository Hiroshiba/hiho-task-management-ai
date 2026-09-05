# hiho-task-ai

AIが僕のタスクを管理してくれたりする仕組みやGUI

## 開発

```sh
pnpm install
pnpm run dev
```

WebとElectronのフロントは、URLの`mock`クエリでmockを選べます。対応する機能名は`app`、`asana`、`readModel`、`sync`、`setup`、`gui`、`ai`、`obsidian`です。

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

検証と配布には次のコマンドを使います。

```sh
pnpm run lint
pnpm run typecheck
pnpm run build
pnpm run package:dir
pnpm run package
```

## Asana接続

1. Asana Developer Consoleで個人用の非公開OAuthアプリを作成します。
2. 権限はFull permissionsを選びます。
3. Redirect URLへ`urn:ietf:wg:oauth:2.0:oob`を正確に登録します。
4. TaskHubへClient IDとClient Secretを入力します。
5. ブラウザでAsanaの利用を許可します。
6. Asanaに表示された認可コードを有効期限内にTaskHubへ貼り付けます。
7. 再認証も同じ方式で行います。

認証待ち時間やローカルコールバックURLの入力は不要です。Client Secretは会話、Issue、ログへ貼らないでください。
