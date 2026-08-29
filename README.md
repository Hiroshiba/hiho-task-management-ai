# hiho-task-ai

AIが僕のタスクを管理してくれたりする仕組みやGUI

## 開発

```sh
pnpm install
pnpm run dev
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
