<!-- i18n: language-switcher -->
[English](RELEASE.md) | [日本語](RELEASE.ja.md)

# リリース

Chrome 拡張を `main` から Chrome ウェブストアへ出す手順です。PWA と Worker は `main` から自動でデプロイされます(`.github/workflows/deploy-web-worker.yml`)。

## 掲載情報

- ストアのページ: <https://chromewebstore.google.com/detail/nkphcfhnfjceplpgcjccnpfdkheafohp>
- 拡張 ID: `nkphcfhnfjceplpgcjccnpfdkheafohp`
- カテゴリ: エンターテイメント。掲載言語: 英語と日本語
- プライバシーポリシー: `docs/PRIVACY.md`。掲載ページが GitHub の URL でリンクしているので、移動や改名をしないこと
- サポート: GitHub の issue

ストアは審査を通ってから更新されるので、公開中のバージョンは `main` より古いことがあります。

## 通常のリリース

バージョンを上げたコミットが `main` に入ることがリリースです。手作業はこれだけです。

```sh
npm run version:set -- X.Y.Z                # ルート、web/、worker/、lockfile、extension/manifest.json
SYC_REQUIRE_E2E=1 npm run release:zip       # 全チェックの後に zip を作る
SYC_EXTENSION_HEADLESS=1 npm run test:ext   # 展開した拡張を Chromium で確認
git switch -c release-X.Y.Z
git commit -am "Release X.Y.Z"
git push -u origin HEAD                     # PR を作り、チェックを待ってマージ
```

`main` への push で `.github/workflows/chrome-webstore-release.yml` が次を行います。

1. `Resolve release target` が、`vX.Y.Z` のタグがまだないので `publish=true` にする(タグ済みのバージョンなら zip を作るだけ)
2. チェックを実行して zip を作り、実行の成果物として残す
3. zip をストアにアップロードして審査に出す
4. ストアが受け付けた後でだけ、`github-release` ジョブがコミットに `vX.Y.Z` のタグを付け、zip・チェックサム・テスター向けガイド付きの GitHub Release を作る

`gh run watch` で見守り、ダッシュボードで「審査待ち」になったことを確認します。

守ること:

- `main` がリリースするバージョンのタグを手で push しない。自動で付いたタグで 2 回目の実行は起きません。手で push した `vX.Y.Z` タグもそのタグをリリースしますが、`npm run version:set` が書いたバージョンと一致している必要があります。
- ストアに出せる提出は一度に 1 つです。審査待ちのバージョンを置き換えるときは、ワークフローを `cancel_submission: true` で手動実行(または `npm run release:store:cancel`)してから、いつも通りバージョンを上げてマージします。
- 通常のリリースでダッシュボードの「公開」ボタンを押さない。

## バージョン

`package.json`、`web/package.json`、`worker/package.json`、`extension/manifest.json` は常に同じバージョンにします。食い違うとワークフローが失敗します。`npm run version:set -- X.Y.Z` がこれらと lockfile のルート情報をまとめて書き換えます。

- パッチ: 修正、しきい値の調整、ドキュメント
- マイナー: 利用者に見える設定・描画・フィルタ・UI の機能
- メジャー: 互換性を壊す契約やストレージの変更

## チェック

```sh
npm ci && npm --prefix web ci && npm --prefix worker ci
npm run release:check
```

`release:check` は lint、フォーマットの確認、セキュリティゲート([SECURITY.ja.md](SECURITY.ja.md))、型チェック、web のビルド、ユニット・決定論・ブラウザ e2e のテスト、サンドボックスのスモークテストを実行します。`SYC_REQUIRE_E2E=1` を付けると、Chromium がないときにスキップではなく失敗にします。

次のものは YouTube に届くことと配信中であることに依存するので、`release:check` には入れていません。

- `SYC_REAL_YOUTUBE_URL="https://www.youtube.com/watch?v=…" npm run test:ext:youtube`: チャットが動いている実際のライブ配信で拡張を確認
- `node worker/test/probe.mjs`: 既知の動画で中継を 1 回試す
- `node worker/test/loadtest.mjs`: 負荷をかけたときの中継の遅延と再試行
- `node web/test/chat-client-live.mjs`: PWA のチャットクライアントを実際のライブチャットで確認

抽出や描画を変えたリリースの前には手で確認します。`extension/` を展開状態で読み込み、チャットの多いライブ配信を開いて、数分間コメントが動画の上を流れ続けること、プレイヤーのトグルと「デフォルトのチャットを隠す」設定が効くこと、YouTube 自身の案内や警告が流れないこと、プレイヤーの操作が重くならないことを見ます。

## zip

`npm run release:zip` は `.release/`(Git では無視)に出力します。

- `smart-youtube-comment-vX.Y.Z.zip`、`.sha256`、`.release.json`
- `smart-youtube-comment-vX.Y.Z-notes.md`、`-tester-install.md`

zip に入るのは `scripts/package-extension.mjs` に並べたファイルだけで、ビルド工程はありません。展開して読み込むテスターの手順: 解凍し、`chrome://extensions` でデベロッパーモードをオンにして「パッケージ化されていない拡張機能を読み込む」からフォルダを選ぶ。不具合のときは Chrome のバージョン、OS、配信の URL、コンソールのエラーをもらいます。

## ワークフローとローカルのコマンド

`Chrome Web Store Release` ワークフローの手動実行(`workflow_dispatch`):

| 入力 | 動作 |
| --- | --- |
| `status_only: true` | ストアの状態を取るだけ(認証情報の確認) |
| `cancel_submission: true` | 審査待ちの提出を取り消す |
| `publish_only: true` | 既存の下書きを公開する。アップロードはしない |
| `publish: false` | アップロードだけして、公開は後で |
| `version` | パッケージ前にバージョンを設定する。リポジトリに書き戻さないので緊急時のみ |
| `skip_review`, `deploy_percentage` | 可能なら審査の省略を依頼、段階的な公開 |
| `dry_run: true` | 検証して API 呼び出しを表示するだけ。通信しない |

認証情報を環境変数に入れれば、シェルからも同じことができます。

```sh
npm run release:store:status
npm run release:store:upload
npm run release:store:publish
npm run release:store:cancel
npm run release:store            # release:zip の後にアップロードと提出
node scripts/chrome-webstore.mjs submit --dry-run
```

環境変数での制御: `CHROME_WEBSTORE_SKIP_REVIEW=1`、`CHROME_WEBSTORE_DEPLOY_PERCENTAGE=25`、`CHROME_WEBSTORE_BLOCK_ON_WARNINGS=0`(既定では API の警告があると公開を止めるので、ポリシー上の警告がそのまま公開につながることはありません)、`CHROME_WEBSTORE_UPLOAD_POLL_ATTEMPTS=24`、`CHROME_WEBSTORE_UPLOAD_POLL_DELAY_MS=5000`。

### 認証情報

GitHub リポジトリの secrets に入れます。推奨はサービスアカウントと GitHub OIDC(Workload Identity Federation)です。

```text
CHROME_WEBSTORE_PUBLISHER_ID
CHROME_WEBSTORE_EXTENSION_ID
GCP_WORKLOAD_IDENTITY_PROVIDER
GCP_SERVICE_ACCOUNT
```

代替: パブリッシャーのアカウントで `https://www.googleapis.com/auth/chromewebstore` スコープの OAuth リフレッシュトークンを発行し、`CHROME_WEBSTORE_CLIENT_ID`、`CHROME_WEBSTORE_CLIENT_SECRET`、`CHROME_WEBSTORE_REFRESH_TOKEN` に入れます。ローカルでは `CHROME_WEBSTORE_ACCESS_TOKEN` も使えます。

`scripts/chrome-webstore.mjs` はパブリッシャー ID、サービスアカウント、OAuth の秘密情報を `***` で表示するので、出力はそのまま issue に貼れます。これらの値を手で書き戻さないこと。パブリッシャー ID は UUID で、公開リポジトリでは GitHub のシークレットスキャンが裸の UUID を `OpenVSX Access Token` として検出します。

## 失敗したとき

アップロードに失敗しても掲載は変わらず、最後に承認されたバージョンが公開されたままです。タグもまだ付いていません。

- **`does not match`**: パッケージのファイル、マニフェスト、手で push したタグのバージョンが食い違っています。`npm run version:set -- X.Y.Z` を実行してコミットします。間違ったタグは `git push origin ":refs/tags/<tag>"` で消します。
- **アップロードや公開が一時的に失敗した**: 失敗したジョブを再実行すると、同じバージョンで再試行します。`github-release` だけが失敗したならそのジョブだけ再実行します。ストアへの提出は繰り返されません。
- **`Missing required configuration`**: secret が足りません(`gh secret list | grep -E 'CHROME_WEBSTORE_|GCP_'`)。
- **`publishers/<id>/items/<id>` への `403 PERMISSION_DENIED`**: トークンは有効ですが、その ID にアイテムを扱う権限がありません。`CHROME_WEBSTORE_EXTENSION_ID` が `nkphcfhnfjceplpgcjccnpfdkheafohp` であること、`CHROME_WEBSTORE_PUBLISHER_ID` がそのアイテムを持つパブリッシャーであること、`GCP_SERVICE_ACCOUNT` のサービスアカウントがダッシュボードでそのパブリッシャーに追加され招待が承認済みであること、`GCP_WORKLOAD_IDENTITY_PROVIDER` がこのリポジトリを指していること、Google Cloud プロジェクトで Chrome Web Store API が有効なことを確認します。確認し直すには `npm run release:store:status`。バージョンを上げて回避しようとしないこと。
- **アップロードは成功し、警告で公開に失敗した**: ログを読み、ダッシュボードで警告を直し、パッチバージョンを上げてリリースし直します。
- **審査で却下された**: 理由を [PLAN.ja.md](PLAN.ja.md) に書き、コード・権限・掲載文・プライバシーの回答を直し、パッチバージョンを上げてリリースし直します。

## ロールバック

すぐに戻す手段はありません。できるならダッシュボードで公開を止め、ソースを直し、パッチバージョンを上げてリリースし直します。zip をすでに配っていたなら、問題のあった `.release/*.release.json` を残しておきます。展開して使っているテスターには、古いものを削除して新しいフォルダを読み込んでもらいます。

---

## 付録: ストアのアイテムの初期設定

一度だけ行う作業です。アイテムの監査や作り直し、掲載文を変えるときの貼り付け元として残しています。

### 掲載文

- 名前: `Smart YouTube Comment Overlay`
- 概要: `Nico-style YouTube live chat overlay.`(ロケール文字列 `ext_desc`)
- 詳細な説明:

  ```text
  Smart YouTube Comment Overlay displays YouTube live chat as a Nico-style overlay on top of the video.

  The extension scores each comment and uses that score to adjust how quickly comments move across the screen. Short repeated reactions and emoji-heavy bursts move faster, while longer or more informative comments can remain visible longer.

  The extension does not download remote code, does not use WebAssembly, and does not send chat text to an external server.

  Permissions:
  - storage: saves overlay, display, and performance settings. Blocked users and
    words are stored locally on the current device.

  Site access:
  - https://www.youtube.com/*: content scripts read YouTube live chat and render the overlay on YouTube video pages.
  ```

- サポート URL: `https://github.com/hjosugi/smart-youtube-comment/issues`
- 画像: `extension/icons/icon128.png`。スクリーンショットはライブ配信にコメントが重なった画面、設定ページ、プレイヤーのトグル。`npm run release:store:assets` で `.release/store-assets/` に宣伝用画像を出力できます。

### プライバシーとデータの使用

- 単一用途: `Display YouTube live chat as an on-video comment overlay and let the user tune local display, performance, and filter settings.`
- データ収集: `No user data is collected by the developer.`
- プライバシーの説明: `The extension processes YouTube live chat text locally in the browser only for overlay rendering and local scoring. Chat text is not sent to the developer or to an external server. Display, behavior, and performance settings are saved with Chrome Sync storage when available. Blocked users and blocked words are saved only in local extension storage on the current device and are not synced.`
- 権限の理由:
  - `storage: Saves user settings such as overlay enabled state, display options, and performance limits. It also saves blocked users and blocked words locally on the current device.`
  - `https://www.youtube.com/* site access: Required for content scripts to read YouTube live chat elements and render the comment overlay on YouTube video pages.`
- リモートコード: `No remote code is used.`
- データの使用: 「個人を特定できる情報」「個人的なコミュニケーション」「ウェブサイトのコンテンツ」にチェックし、他はチェックしない。3 つの開示にはすべてチェック。
- プライバシーポリシーの URL: `https://github.com/hjosugi/smart-youtube-comment/blob/main/docs/PRIVACY.md`

### Google Cloud と GitHub

`bash` で、値を自分のものに置き換えて実行します。

```sh
set -eu
export GCP_PROJECT_ID="YOUR_GCP_PROJECT_ID"
export SA_NAME="syc-cws-publisher"
export WIF_POOL_ID="github"
export WIF_PROVIDER_ID="smart-youtube-comment"
export GITHUB_OWNER="$(gh repo view --json owner -q .owner.login)"
export GITHUB_REPO="$(gh repo view --json name -q .name)"
export SA_EMAIL="${SA_NAME}@${GCP_PROJECT_ID}.iam.gserviceaccount.com"

gcloud config set project "$GCP_PROJECT_ID"
gcloud services enable chromewebstore.googleapis.com iam.googleapis.com \
  iamcredentials.googleapis.com sts.googleapis.com --project "$GCP_PROJECT_ID"

gcloud iam service-accounts describe "$SA_EMAIL" --project "$GCP_PROJECT_ID" >/dev/null 2>&1 ||
  gcloud iam service-accounts create "$SA_NAME" --project "$GCP_PROJECT_ID" \
    --display-name "Smart YouTube Comment Chrome Web Store Publisher"

gcloud iam workload-identity-pools describe "$WIF_POOL_ID" --project "$GCP_PROJECT_ID" \
  --location global >/dev/null 2>&1 ||
  gcloud iam workload-identity-pools create "$WIF_POOL_ID" --project "$GCP_PROJECT_ID" \
    --location global --display-name "GitHub Actions"

gcloud iam workload-identity-pools providers describe "$WIF_PROVIDER_ID" --project "$GCP_PROJECT_ID" \
  --location global --workload-identity-pool "$WIF_POOL_ID" >/dev/null 2>&1 ||
  gcloud iam workload-identity-pools providers create-oidc "$WIF_PROVIDER_ID" \
    --project "$GCP_PROJECT_ID" --location global --workload-identity-pool "$WIF_POOL_ID" \
    --display-name "smart-youtube-comment GitHub" \
    --issuer-uri "https://token.actions.githubusercontent.com" \
    --attribute-mapping "google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.repository_owner=assertion.repository_owner,attribute.ref=assertion.ref" \
    --attribute-condition "assertion.repository == '${GITHUB_OWNER}/${GITHUB_REPO}'"

PROJECT_NUMBER="$(gcloud projects describe "$GCP_PROJECT_ID" --format 'value(projectNumber)')"
gcloud iam service-accounts add-iam-policy-binding "$SA_EMAIL" --project "$GCP_PROJECT_ID" \
  --role roles/iam.workloadIdentityUser \
  --member "principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${WIF_POOL_ID}/attribute.repository/${GITHUB_OWNER}/${GITHUB_REPO}"

GCP_WORKLOAD_IDENTITY_PROVIDER="$(gcloud iam workload-identity-pools providers describe "$WIF_PROVIDER_ID" \
  --project "$GCP_PROJECT_ID" --location global --workload-identity-pool "$WIF_POOL_ID" --format 'value(name)')"
```

続けて:

1. ダッシュボード(アカウント → パブリッシャーの設定)で `$SA_EMAIL` をサービスアカウントとして追加する。
2. secrets を入れる。

   ```sh
   gh secret set CHROME_WEBSTORE_PUBLISHER_ID -b "<publisher id>"
   gh secret set CHROME_WEBSTORE_EXTENSION_ID -b "nkphcfhnfjceplpgcjccnpfdkheafohp"
   gh secret set GCP_WORKLOAD_IDENTITY_PROVIDER -b "$GCP_WORKLOAD_IDENTITY_PROVIDER"
   gh secret set GCP_SERVICE_ACCOUNT -b "$SA_EMAIL"
   ```

3. ワークフローを `status_only: true` で実行する。`Fetch Chrome Web Store status` が成功し、ビルドやアップロードが走らなければ完了。
