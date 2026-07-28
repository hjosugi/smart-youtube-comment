<!-- i18n: language-switcher -->
[English](RELEASE.md) | [日本語](RELEASE.ja.md)

# リリースガイド

これはJavaScriptのみのChrome拡張機能のローカルリリースパスです。

## リリース戦略

3つのステージを使用します：

1. **ローカルのアンパックリリース**：`extension/`をChromeに直接読み込みます。
2. **Zipリリース**：`.release/smart-youtube-comment-vX.Y.Z.zip`を作成し、アンパック拡張機能を読み込むことができるテスターと共有します。
3. **Chromeウェブストアリリース**：一度限りのストアリストとOAuth設定の後、`scripts/chrome-webstore.mjs`またはGitHub Actionsを通じてアップロードおよび公開します。

`.release/`ディレクトリはGitによって無視されます。アーティファクトは追跡された拡張機能のソースから再現可能であり、ビルドステップはありません。

## バージョニング

これらのバージョンを同一に保ちます：

- `package.json` -> `version`
- `web/package.json` -> `version`
- `worker/package.json` -> `version`
- `extension/manifest.json` -> `version`

すべてを一度に設定します。ロックファイルのルートメタデータも含めて：

```sh
npm run version:set -- 0.1.1
```

今のところ、シンプルなセマンティックバージョニングを使用します：

- パッチ：ドキュメント、小さなバグ修正、しきい値調整
- マイナー：ユーザーに見える設定、レンダリング、フィルタリング、またはUI機能
- メジャー：互換性を破る契約またはストレージの変更

## プレリリースチェックリスト

ローカルリリースチェックを実行する前に、すべてのパッケージルートをインストールします：

```sh
npm ci
npm --prefix web ci
npm --prefix worker ci
```

実行します：

```sh
npm run release:check
```

これにより、以下が実行されます：

- lintおよびフォーマットチェック
- セキュリティおよびサプライチェーンポリシーチェック
- ルートおよびワーカーの型チェック
- ウェブビルド
- ユニット、決定論的、ブラウザe2eスイート
- ローカルサンドボックスサーバースモークテスト

オプションですが便利です：

```sh
npm run test:e2e
npm run test:ext
```

`test:ext`は、アンパックされた拡張機能を使用して実際のChromiumを開き、デスクトップセッションが必要な場合があります。デフォルトでは、オーバーレイ/チャットパス用に決定論的な偽YouTubeページを使用します。

実際のYouTubeスモークをオプトイン：

```sh
SYC_REAL_YOUTUBE_URL="https://www.youtube.com/watch?v=..." npm run test:ext:youtube
```

アクティブなチャットを持つ公開ライブストリームを使用します。これは、YouTubeの可用性、地理/アカウントの状態、および実行中にチャットがアクティブであるかどうかに依存するため、意図的に`release:check`の外にあります。

手動ネットワークプローブは、実際のYouTubeの可用性とネットワークの動作に依存するため、意図的に`release:check`の一部ではありません：

- `worker/test/probe.mjs`：既知のビデオ/ライブURLのためのワンショットリレープローブ。
- `worker/test/loadtest.mjs`：レイプレッシャーテストによるレイテンシとリトライ調整。
- `web/test/chat-client-live.mjs`：ブラウザ側のライブチャットクライアントスモークチェック。

有効な公開ビデオ/ライブURLが利用可能な場合、リリース候補の前に実行します。CIを決定論的かつフィクスチャに基づいて保ちます。

## Zipをビルド

実行します：

```sh
npm run release:zip
```

出力：

```text
.release/smart-youtube-comment-v0.1.0.zip
```

リリーススクリプトは自動的に以下を作成します：

- `.release/smart-youtube-comment-vX.Y.Z.zip`
- `.release/smart-youtube-comment-vX.Y.Z.sha256`
- `.release/smart-youtube-comment-vX.Y.Z.release.json`
- `.release/smart-youtube-comment-vX.Y.Z-notes.md`
- `.release/smart-youtube-comment-vX.Y.Z-tester-install.md`

Zipには、`scripts/package-extension.mjs`によってリストされた拡張機能ファイルのみが含まれます。

## Chromeウェブストアの自動化

一度限りの設定、OAuthの詳細、およびCIリリースパスについては、`docs/STORE_AUTOMATION.md`を参照してください。

考えずに手動チェックリストを使用するには、`docs/STORE_RELEASE_RUNBOOK_JA.md`を使用します。

GitHubリポジトリのシークレットが設定されると、対応する`vX.Y.Z`タグをプッシュすることでチェックが実行され、拡張機能がパッケージ化され、リリースアーティファクトがアップロードされ、ZipがChromeウェブストアにアップロードされ、レビュー/公開のために提出されます。

推奨されるCI認証は、サービスアカウントとGitHub OIDCを使用します：

```text
CHROME_WEBSTORE_PUBLISHER_ID
CHROME_WEBSTORE_EXTENSION_ID
GCP_WORKLOAD_IDENTITY_PROVIDER
GCP_SERVICE_ACCOUNT
```

リフレッシュトークンのフォールバック：

```text
CHROME_WEBSTORE_PUBLISHER_ID
CHROME_WEBSTORE_EXTENSION_ID
CHROME_WEBSTORE_CLIENT_ID
CHROME_WEBSTORE_CLIENT_SECRET
CHROME_WEBSTORE_REFRESH_TOKEN
```

ローカルのワンコマンドストアリリース：

```sh
npm run release:store
```

アップロードのみとアップロード後の公開は、安全な回復のために分割されています：

```sh
npm run release:store:upload
npm run release:store:publish
```

## 手動ブラウザスモークテスト

Zipを共有する前に：

1. `npm run release:zip`を実行します。
2. `npm run sandbox`を実行し、`http://127.0.0.1:4173/`を開きます。
3. ローカルサンドボックスがJSスコアラーでコメントをレンダリングすることを確認します。
4. `chrome://extensions`を開きます。
5. 開発者モードを有効にします。
6. この拡張機能の古い読み込みコピーを削除します。
7. `extension/`ディレクトリをアンパックとして読み込みます。
8. アクティブなチャットを持つYouTubeライブストリームを開きます。
9. コメントがビデオの上にレンダリングされることを確認します。
10. シークバーエリアのダンマクトグルが機能することを確認します。
11. デフォルトのチャット非表示/表示の動作が設定に従うことを確認します。
12. 公式のYouTubeガイド/警告/推奨テキストがレンダリングされないことを確認します。
13. 数分待って、新しいコメントが流れ続けることを確認します。
14. CPU使用率とビデオコントロールが、忙しいチャットの中でも合理的であることを確認します。

## テスターの指示

テスターには、以下を送信することをお勧めします：

- `.release/`からのZipアーティファクト
- 生成された`.sha256`
- 生成されたテスターインストールガイド
- 短いインストール手順
- 既知の制限
- 失敗した場合のChromeバージョン、OS、ストリームURL、およびコンソールエラーのリクエスト

テスターインストールフロー：

1. アーティファクトの圧縮を解除します。
2. `chrome://extensions`を開きます。
3. 開発者モードを有効にします。
4. `アンパックを読み込む`をクリックします。
5. 解凍されたフォルダーを選択します。

## 既知のリリース制限

これをまだ本番準備完了として提示しないでください：

- YouTubeのDOMの変更が抽出を破損する可能性があります
- パフォーマンスはまだ実際の忙しいストリームのプロファイリングが必要です
- YouTubeのポップアウトチャットタブはサポートされていません。なぜなら、レンダラーが元の視聴ページのビデオプレーヤーを必要とするからです
- Chromeウェブストアのリスト資産、プライバシーコピー、およびデータ使用宣言は、まだ一度限りのダッシュボード設定を必要とします
- 実際のYouTubeスモークはオプトインです。なぜなら、現在アクティブな公開ストリームとアクセス可能なチャットに依存するからです

## ストアリリースゲート

これらが完了した後にのみ、ストアリリースを提出してください：

- 複数のストリームでの実際のストリームスモークテスト
- 簡潔なプライバシーノート：すべてのスコアリング/フィルタリングはローカルで行われ、拡張機能によるネットワーク呼び出しは行われません
- YouTubeのDOM破損に対するロールバックプラン
- `docs/STORE_AUTOMATION.md`からの一度限りのChromeウェブストアリストとOAuth設定
- マニフェストバージョンに一致するタグ付きGitリリース

## ロールバック

リリースビルドが不良の場合：

1. Zipの共有を停止します。
2. デバッグに必要な場合を除き、不良アーティファクトは保持しません。
3. ソースを修正します。
4. パッチバージョンを上げます。
5. `npm run release:zip`または`npm run release:store`を再実行します。

アンパックされたテスターには、古い拡張機能を削除し、新しい解凍されたフォルダーを読み込むように依頼します。