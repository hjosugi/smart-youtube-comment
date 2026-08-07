<!-- i18n: language-switcher -->
[English](STORE_AUTOMATION.md) | [日本語](STORE_AUTOMATION.ja.md)

# Chrome Web Store 自動化

このリポジトリは、一度のストア設定が完了した後に、Chrome Web Store の更新を自動化できます。拡張機能のソースは JavaScript のみで、ストアのアップロードパスは既存の `extension/` ディレクトリをパッケージ化し、zip を提出します。

思考不要のステップバイステップの日本語ランブックについては、`docs/STORE_RELEASE_RUNBOOK_JA.md` を参照してください。

## 現在のアイテム

ストアのアイテムは作成済みで、公開されています：

```text
https://chromewebstore.google.com/detail/nkphcfhnfjceplpgcjccnpfdkheafohp
```

`CHROME_WEBSTORE_EXTENSION_ID` は `nkphcfhnfjceplpgcjccnpfdkheafohp`、`CHROME_WEBSTORE_PUBLISHER_ID` はそのアイテムを所有するパブリッシャーである必要があります。以下の「一度限りの手動設定」はすでに完了済みで、アイテムを作り直す場合や設定を監査する場合の参考として残しています。

## 自動化できること

- バージョンの整合性チェック
- セキュリティチェックとローカルテスト
- zip、チェックサム、リリースメタデータ、ノート、およびテスターガイドの生成
- Chrome Web Store パッケージのアップロード
- アップロード処理のポーリング
- 公開/レビューの提出
- GitHub Actions のアーティファクト保持

## 一度限りの手動設定

これらのステップは、Chrome Web Store の所有権、OAuth、ストアリスティング、およびプライバシー宣言がアカウントに結びついているため、ブラウザが必要です：

1. Chrome Web Store 開発者アカウントを作成または選択します。
2. Chrome Web Store 開発者ダッシュボードで拡張機能アイテムを作成します。
3. リスティングコピー、スクリーンショット、カテゴリ、サポート、プライバシー、およびデータ使用の宣言を記入します。
4. Google Cloud で Chrome Web Store API を有効にします。
5. CI 認証パスを選択します。

推奨：サービスアカウントと GitHub OIDC / Workload Identity Federation。サービスアカウントを Chrome Web Store パブリッシャーに追加し、これらの GitHub リポジトリシークレットを保存します：

```text
CHROME_WEBSTORE_PUBLISHER_ID
CHROME_WEBSTORE_EXTENSION_ID
GCP_WORKLOAD_IDENTITY_PROVIDER
GCP_SERVICE_ACCOUNT
```

フォールバック：OAuth リフレッシュトークン。OAuth 認証情報を作成し、`https://www.googleapis.com/auth/chromewebstore` スコープでパブリッシャーアカウントを認証し、リフレッシュトークンを生成し、これらの GitHub リポジトリシークレットを保存します：

```text
CHROME_WEBSTORE_PUBLISHER_ID
CHROME_WEBSTORE_EXTENSION_ID
CHROME_WEBSTORE_CLIENT_ID
CHROME_WEBSTORE_CLIENT_SECRET
CHROME_WEBSTORE_REFRESH_TOKEN
```

`CHROME_WEBSTORE_ACCESS_TOKEN` は、クライアント/シークレット/リフレッシュトークンのトリオの代わりにローカルで使用できますが、GitHub Actions はリフレッシュトークンフローまたは Workload Identity Federation によって生成された短命トークンを優先するべきです。

## ローカルリリースコマンド

すべてのチェックを実行し、リリース zip をビルドし、アップロードして提出します：

```sh
npm run release:store
```

公開せずにアップロード：

```sh
npm run release:zip
npm run release:store:upload
```

成功したアップロード後に公開：

```sh
npm run release:store:publish
```

ストアのステータスを確認：

```sh
npm run release:store:status
```

ネットワークアクセスなしで API コールの形状をドライラン：

```sh
node scripts/chrome-webstore.mjs submit --dry-run
```

## GitHub Actions リリース

ワークフローは `.github/workflows/chrome-webstore-release.yml` にあります。

通常のパス：

```sh
npm run version:set -- 0.1.1
git commit -am "Release 0.1.1"
git tag v0.1.1
git push origin main --tags
```

`vX.Y.Z` タグをプッシュすると、チェックが実行され、拡張機能がパッケージ化され、リリースアーティファクトがアップロードされ、zip が Chrome Web Store にアップロードされ、レビュー/公開のために提出されます。ワークフローは、`npm run version:set` と `extension/manifest.json` によって更新されたパッケージルートと一致しないタグを拒否します。

手動の緊急パス：

1. `Chrome Web Store Release` ワークフローを開きます。
2. オプションのバージョンを入力します。
3. バージョンを消費せずにアクセスをテストするために `status_only: true` を使用するか、アップロード/公開の実行のために `status_only: false` を使用します。
4. すぐに公開するか、アップロードのみを選択します。
5. ワークフローを実行します。

手動のバージョンオーバーライドは、リポジトリにバージョンのバンプをコミットしないため、緊急時にのみ使用されることを意図しています。

## オプションのコントロール

- `CHROME_WEBSTORE_SKIP_REVIEW=1`：該当する場合にレビューのスキップをリクエストします。
- `CHROME_WEBSTORE_DEPLOY_PERCENTAGE=25`：段階的ロールアウトのパーセンテージをリクエストします。
- `CHROME_WEBSTORE_BLOCK_ON_WARNINGS=0`：API 警告にもかかわらず公開を許可します。
- `CHROME_WEBSTORE_UPLOAD_POLL_ATTEMPTS=24`：アップロード処理のポーリング回数。
- `CHROME_WEBSTORE_UPLOAD_POLL_DELAY_MS=5000`：ステータスポーリング間の遅延。

デフォルトでは、公開は Chrome Web Store API 警告でブロックされます。これにより、自動化がポリシーや検証の警告を誤って公開リリースに変えることを防ぎます。

## 失敗パターン

`publishers/<publisher>/items/<item>` に対する `403 PERMISSION_DENIED` は、認証自体は成功したものの、その主体がアイテムを所有するパブリッシャーのメンバーでないか、ID の組み合わせが存在しないアイテムを指していることを意味します。シークレットかダッシュボードのメンバー設定を修正してください。バージョンを上げて回避しようとしないでください。詳しいチェックリストは `docs/RELEASE.ja.md` にあります。

アップロードに失敗しても公開中のリスティングは変更されないため、審査済みの既存バージョンはそのまま残り、同じタグをやり直せます。

## ロールバック

Chrome Web Store は、このリポジトリからの即時のソースレベルのロールバックを提供していません。悪いバージョンがレビューまたは公開に達した場合：

1. 可能な場合は、開発者ダッシュボードでリリースを停止または一時停止します。
2. パッチバージョンを上げます。
3. 修正を加えた自動リリースを再実行します。
4. アーティファクトがすでに共有されている場合は、監査/デバッグのために悪い `.release/*.release.json` メタデータを保持します。