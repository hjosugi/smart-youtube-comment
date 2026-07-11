<!-- i18n: language-switcher -->
[English](README.md) | [日本語](README.ja.md)

# スマートYouTubeコメントオーバーレイ

NicoスタイルのYouTubeライブチャットオーバーレイのためのChrome MV3拡張機能プロトタイプです。メッセージをJavaScriptでローカルにスコアリングし、そのスコアを使用してコメントがビデオ上を速く、通常、または遅く移動するかを決定します。

目的は、有用なコメントを目立たせ、短い繰り返し反応、絵文字の洪水、または低価値のバーストが他のすべてを埋め尽くさないようにすることです。

## ステータス

実装済み:

- Chrome MV3拡張機能のスキャフォールド
- `web/`内のモバイルPWA
- `worker/`内のCloudflare Workerライブチャットリレー
- すべてのフレームからのYouTubeライブチャット抽出
- トップフレームキャンバスの弾幕レンダラー
- `extension/scoring.js`内のJavaScriptのみのローカルスコアラー
- 設定およびフィルターUI
- ローカルサンドボックスおよびレンダラーのパフォーマンスプローブ
- リリースZIPパッケージング
- セキュリティ/サプライチェーンチェック

ブラウザの抽出とレンダリングが実際のボトルネックであるため、スコアリングは小さくローカルに保たれています。

## 仕組み

拡張機能は、すべてのYouTubeフレームで`extension/content.js`を実行します。

1. チャットフレームはYouTubeライブチャットレンダラーノードを監視します。
2. 各新しいチャットメッセージは`ScoreInput`に正規化されます。
3. `extension/scoring.js`はローカル`ScoreResult`を返します。
4. `buildRenderPlan()`は結果を速い/通常/遅い表示タイミングにマッピングします。
5. バックグラウンドサービスワーカーがチャットフレームからトップビデオフレームにメッセージを中継します。
6. トップフレームがYouTubeプレーヤー上にコメントをレンダリングします。

拡張機能はリモートコードを取得しません。

## プライバシーとストレージ

拡張機能は、ブラウザ内でローカルにコメントをスコアリング、フィルタリング、レンダリングします。表示、動作、およびパフォーマンス設定は、利用可能な場合、Chrome Syncストレージに保存されるため、Chromeはサインインしたプロファイル間でそれらの設定を同期できます。ブロックされたユーザーとブロックされた単語は、現在のデバイスのローカル拡張ストレージにのみ保存されます。チャットテキスト、著者名、およびブロックリストは開発者に送信されません。

## 要件

- 拡張機能を読み込むためのChromeまたはChromium
- スクリプト用のNode.js 22+およびnpm 10+
- オプション: より高速なローカルスクリプトのためのBun 1.3+

JSツールをインストールします:

```sh
npm install
```

## テスト

セキュリティゲート、型チェック、ウェブビルド、ユニットスイート、ブラウザe2eスイートを実行します。Chromiumがインストールされている場合、サンドボックスのスモークチェックも実行します:

```sh
npm test
```

セキュリティゲートを直接実行します:

```sh
npm run security
```

Bunの同等コマンド:

```sh
bun run test:bun
bun run security:bun
```

レンダラーパフォーマンスプローブ:

```sh
npm run test:e2e
```

Chromiumでの実際の拡張機能スモークテスト:

```sh
npm run test:ext
```

オプトインの実際のYouTubeスモーク:

```sh
SYC_REAL_YOUTUBE_URL="https://www.youtube.com/watch?v=..." npm run test:ext:youtube
```

`test:ext`はローカルで実際のブラウザを開きます。CIでは、デフォルトでスキップされますが、`SYC_REQUIRE_EXTENSION_E2E=1`が設定されている場合は実行されます。`npm test`がChromiumの欠如でスキップするのではなく失敗するようにするには、`SYC_REQUIRE_E2E=1`を設定します。

## ワーカーレイ

`worker/`内のCloudflare WorkerはYouTube InnerTubeライブチャットコールを中継します。デフォルトでは、チェックインされたWEBクライアントバージョンを使用しますが、プロダクションではコード変更なしに上書きできます:

```sh
wrangler deploy --var INNERTUBE_CLIENT_VERSION:2.20260705.00.00
```

`GET /health`は有効なデフォルトのInnerTubeクライアントバージョンを返します。`GET /health?deep=1&video=<11-char-id>`は、同じ有効なクライアントバージョンでカナリア`next`プローブを実行します。外部のスケジュールされたモニターやCloudflare Cron Triggerから使用して、視聴者がそれにヒットする前にクライアントバージョンの拒否を検出します。

オプションの中継制御:

- `ALLOWED_ORIGINS=https://your-pwa.example`は他のオリジンからのブラウザ呼び出しを拒否します。
- `RATE_LIMIT_PER_MINUTE=120`は各クライアントIPをWorkerアイソレートごとに制限します。`0`を設定すると無効になります。

## ローカルサンドボックス

実行します:

```sh
npm run sandbox
```

次に開きます:

```text
http://127.0.0.1:4173/
```

サンドボックスは`sandbox/index.html`を提供し、共有JSスコアラーを読み込み、ライブチャットをシミュレートし、偽のビデオサーフェス上にコメントをレンダリングします。

## Chromeに読み込む

1. `chrome://extensions`を開きます。
2. 開発者モードを有効にします。
3. `未パッケージの読み込み`をクリックします。
4. `extension`ディレクトリを選択します。
5. ライブチャット付きのYouTubeライブストリームを開きます。

コンテンツスクリプトやマニフェストファイルを変更した後は、`chrome://extensions`で拡張機能を再読み込みし、YouTubeタブを再読み込みします。

期待される動作:

- コメントがビデオ上に弾幕スタイルで表示される
- 短いまたはスパムのメッセージが速く移動する
- 高品質または強調されたメッセージが遅く移動する
- シークバーエリアのトグルで弾幕を隠したり表示したりできる
- デフォルトのYouTubeチャットの隠す/表示は設定に従う

既知の制限:

- YouTubeのポップアウトチャットはビデオプレーヤーなしで別のタブで実行されるため、この拡張機能は元のビデオタブ上にポップアウトチャットメッセージをレンダリングしません。オーバーレイのためには、視聴ページの通常の埋め込みチャットを使用してください。

## リリースビルド

テスターZIPを作成します:

```sh
npm run release:zip
```

Bunパス:

```sh
bun run release:zip:bun
```

アーティファクトは`.release/`に書き込まれ、Gitによって無視されます。詳細は[docs/RELEASE.md](docs/RELEASE.md)を参照してください。

パッケージとマニフェストのバージョンを一緒に設定します:

```sh
npm run version:set -- 0.1.1
```

これにより、ルート、`web/`、`worker/`、それらのロックファイルのルートメタデータ、および`extension/manifest.json`が更新されます。

## プロジェクトレイアウト

```text
.
├── extension/
│   ├── manifest.json
│   ├── background.js
│   ├── scoring.js
│   ├── danmaku.js
│   ├── settings.js
│   ├── filter.js
│   ├── content.js
│   ├── options.html
│   ├── options.js
│   └── icons/
├── bench/
│   ├── danmaku-bench.html
│   └── e2e/
├── web/
│   ├── app.ts
│   ├── test/
│   └── dist/
├── worker/
│   ├── src/
│   ├── test/
│   └── wrangler.jsonc
├── sandbox/
│   └── index.html
├── docs/
│   ├── CONTRACT.md
│   ├── PERFORMANCE.md
│   ├── RELEASE.md
│   └── SECURITY.md
└── scripts/
    ├── check-sandbox.mjs
    ├── package-extension.mjs
    ├── security-check.mjs
    ├── serve-sandbox.mjs
    └── set-version.mjs
```

## 現在のパフォーマンスフォーカス

スコアリングは意図的に小さくローカルです。次の勝利は以下にあります:

- YouTubeチャット抽出の堅牢性
- キュー/リングバッファの動作
- テキストラスタライゼーションの予算
- キャンバス描画ループ
- Long Taskおよびフレームp95/p99診断
- `maxActive=2000`を入場制御を通じて応答性を保つ

詳細は[docs/PERFORMANCE.md](docs/PERFORMANCE.md)にあります。

## ライセンス

0BSD。ほぼすべての目的でこのプロジェクトを使用、コピー、変更、配布できます。