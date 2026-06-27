# Chrome Web Store 公開手順書

目的: 手作業で迷わない。上から順番にチェックして、通常リリースは
`vX.Y.Z` タグを押すだけにする。

## まず守ること

- 本線は「サービスアカウント + GitHub OIDC」。refresh token は使わない。
- 通常リリースでは GitHub Actions の `workflow_dispatch` を使わない。
- 通常リリースでは Chrome Web Store の手動 Publish ボタンを押さない。
- `extension/` の中身はこの手順では触らない。
- Chrome Web Store の審査が終わるまでは待つ。却下されたら下の「失敗時」へ進む。

## 必要なもの

- Chrome Web Store Developer Dashboard に入れるGoogleアカウント
- Google Cloud project 1つ
- GitHub repository の Secrets を編集できる権限
- ローカルに `node`, `npm`, `git`, `gh`, `gcloud`

## ターミナルで最初にやること

この手順書のコマンドは `bash` 用。`fish` や `zsh` を使っていても、先にこれを
1回だけ実行する。

```sh
bash -l
```

以後、この手順書のコマンドはその `bash` の中へ貼る。

注意:

- Markdown のコード枠の ``` は貼らない。
- `fish: Unknown command: \`\`` が出た場合は、``` を貼っただけ。無視して続ける。
- 作業が終わったら `exit` で元のshellに戻る。

確認:

```sh
node --version
npm --version
git --version
gh --version
gcloud --version
gh auth status
gcloud auth list
```

## 使う値をここで決める

このブロックを自分の値に置き換えて、以後のターミナルで使う。

```sh
export GCP_PROJECT_ID="YOUR_GCP_PROJECT_ID"
export SA_NAME="syc-cws-publisher"
export WIF_POOL_ID="github"
export WIF_PROVIDER_ID="smart-youtube-comment"
export GITHUB_OWNER="$(gh repo view --json owner -q .owner.login)"
export GITHUB_REPO="$(gh repo view --json name -q .name)"
```

確認:

```sh
printf 'GCP_PROJECT_ID=%s\nGITHUB=%s/%s\n' "$GCP_PROJECT_ID" "$GITHUB_OWNER" "$GITHUB_REPO"
```

## 初回だけ 1: Chrome Web Store item を作る

1. ローカルでzipを作る。

```sh













npm ci
npm run release:zip
```

2. Chrome Web Store Developer Dashboard を開く。

```text
https://chrome.google.com/webstore/devconsole
```

3. `New item` を押す。
4. `.release/smart-youtube-comment-vX.Y.Z.zip` の最新ファイルをアップロードする。
5. item 作成後、URLまたは画面から extension ID を控える。
6. publisher ID を控える。

控えた値をターミナルへ入れる。

```sh
export CHROME_WEBSTORE_EXTENSION_ID="YOUR_EXTENSION_ID"
export CHROME_WEBSTORE_PUBLISHER_ID="YOUR_PUBLISHER_ID"
```

## 初回だけ 2: Store listing を埋める

Dashboard で次をコピペする。

Name:

```text
Smart YouTube Comment Overlay
```

Summary:

```text
Nico-style YouTube live chat overlay with local, on-device comment scoring.
```

Detailed description:

```text
Smart YouTube Comment Overlay displays YouTube live chat as a Nico-style overlay on top of the video.

The extension scores comments locally in the browser and uses that score to adjust how quickly comments move across the screen. Short repeated reactions and emoji-heavy bursts move faster, while longer or more informative comments can remain visible longer.

All scoring and filtering runs on device. The extension does not download remote code, does not use WebAssembly, and does not send chat text to an external server.

Permissions:
- storage: saves overlay, display, performance, and filter settings.
- https://www.youtube.com/*: reads YouTube live chat and renders the overlay on YouTube video pages.
```

Category:

```text
Productivity
```

Language:

```text
English
```

Support URL:

このコマンドで出たURLを貼る。

```sh
printf 'https://github.com/%s/%s/issues\n' "$GITHUB_OWNER" "$GITHUB_REPO"
```

画像アセットは迷ったらこれを入れる:

- icon: `extension/icons/icon128.png`
- screenshot 1: YouTube live stream 上でコメントが動画に重なっている画面
- screenshot 2: extension options 画面
- screenshot 3: コメント表示/非表示トグルが見える画面

Dashboard が画像サイズを要求した場合は、その画面に表示されたサイズへ合わせる。

## 初回だけ 3: Privacy / Data use を埋める

Single purpose:

```text
Display YouTube live chat as an on-video comment overlay and let the user tune local display, performance, and filter settings.
```

Data collection:

```text
No user data is collected by the developer.
```

Privacy explanation:

```text
The extension processes YouTube live chat text locally in the browser only for overlay rendering and local scoring. Chat text is not sent to the developer or to an external server. User settings and block lists are saved with Chrome extension storage.
```

Permission justification:

```text
storage: Saves user settings such as overlay enabled state, display options, performance limits, and local block lists.

https://www.youtube.com/*: Required to read YouTube live chat elements and render the comment overlay on YouTube video pages.
```

Remote code:

```text
No remote code is used.
```

Data use:

チェックする:

- 個人を特定できる情報
- 個人的コミュニケーション
- ウェブサイトのコンテンツ

チェックしない:

- 健康に関する情報
- 財務状況や支払いに関する情報
- 認証に関する情報
- 位置情報
- ウェブ履歴
- ユーザーのアクティビティ

3つの開示:

- 3つともチェックする。

Privacy policy URL:

```text
https://github.com/hjosugi/smart-youtube-comment/blob/main/docs/PRIVACY.md
```

## 初回だけ 4: Google Cloud を設定する

このブロックをそのまま実行する。

```sh
set -eu

gcloud config set project "$GCP_PROJECT_ID"

gcloud services enable \
  chromewebstore.googleapis.com \
  iam.googleapis.com \
  iamcredentials.googleapis.com \
  sts.googleapis.com \
  --project "$GCP_PROJECT_ID"

export SA_EMAIL="${SA_NAME}@${GCP_PROJECT_ID}.iam.gserviceaccount.com"

if ! gcloud iam service-accounts describe "$SA_EMAIL" --project "$GCP_PROJECT_ID" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$SA_NAME" \
    --project "$GCP_PROJECT_ID" \
    --display-name "Smart YouTube Comment Chrome Web Store Publisher"
fi

if ! gcloud iam workload-identity-pools describe "$WIF_POOL_ID" \
  --project "$GCP_PROJECT_ID" \
  --location "global" >/dev/null 2>&1; then
  gcloud iam workload-identity-pools create "$WIF_POOL_ID" \
    --project "$GCP_PROJECT_ID" \
    --location "global" \
    --display-name "GitHub Actions"
fi

if ! gcloud iam workload-identity-pools providers describe "$WIF_PROVIDER_ID" \
  --project "$GCP_PROJECT_ID" \
  --location "global" \
  --workload-identity-pool "$WIF_POOL_ID" >/dev/null 2>&1; then
  gcloud iam workload-identity-pools providers create-oidc "$WIF_PROVIDER_ID" \
    --project "$GCP_PROJECT_ID" \
    --location "global" \
    --workload-identity-pool "$WIF_POOL_ID" \
    --display-name "smart-youtube-comment GitHub" \
    --issuer-uri "https://token.actions.githubusercontent.com" \
    --attribute-mapping "google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.repository_owner=assertion.repository_owner,attribute.ref=assertion.ref" \
    --attribute-condition "assertion.repository == '${GITHUB_OWNER}/${GITHUB_REPO}'"
fi

export PROJECT_NUMBER="$(gcloud projects describe "$GCP_PROJECT_ID" --format 'value(projectNumber)')"
export WIF_POOL_NAME="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${WIF_POOL_ID}"

gcloud iam service-accounts add-iam-policy-binding "$SA_EMAIL" \
  --project "$GCP_PROJECT_ID" \
  --role "roles/iam.workloadIdentityUser" \
  --member "principalSet://iam.googleapis.com/${WIF_POOL_NAME}/attribute.repository/${GITHUB_OWNER}/${GITHUB_REPO}"

export GCP_WORKLOAD_IDENTITY_PROVIDER="$(gcloud iam workload-identity-pools providers describe "$WIF_PROVIDER_ID" \
  --project "$GCP_PROJECT_ID" \
  --location "global" \
  --workload-identity-pool "$WIF_POOL_ID" \
  --format 'value(name)')"

printf '\nGCP_SERVICE_ACCOUNT=%s\nGCP_WORKLOAD_IDENTITY_PROVIDER=%s\n' \
  "$SA_EMAIL" \
  "$GCP_WORKLOAD_IDENTITY_PROVIDER"
```

## 初回だけ 5: Chrome Web Store に service account を追加する

1. Chrome Web Store Developer Dashboard を開く。
2. Account / Publisher settings を開く。
3. Service account の欄に、さっき出た `GCP_SERVICE_ACCOUNT` を追加する。
4. 保存する。

もし既に別の service account が入っている場合:

- 自分が過去に作った古い自動公開用なら置き換える。
- 誰のものか分からなければここで止める。

## 初回だけ 6: GitHub Secrets を入れる

このブロックをそのまま実行する。

```sh
set -eu

gh secret set CHROME_WEBSTORE_PUBLISHER_ID -b "$CHROME_WEBSTORE_PUBLISHER_ID"
gh secret set CHROME_WEBSTORE_EXTENSION_ID -b "$CHROME_WEBSTORE_EXTENSION_ID"
gh secret set GCP_WORKLOAD_IDENTITY_PROVIDER -b "$GCP_WORKLOAD_IDENTITY_PROVIDER"
gh secret set GCP_SERVICE_ACCOUNT -b "$SA_EMAIL"

gh secret list | grep -E 'CHROME_WEBSTORE_|GCP_'
```

表示にこれがあればOK:

```text
CHROME_WEBSTORE_PUBLISHER_ID
CHROME_WEBSTORE_EXTENSION_ID
GCP_WORKLOAD_IDENTITY_PROVIDER
GCP_SERVICE_ACCOUNT
```

## 初回だけ 7: 自動公開の疎通確認

ローカルでドライランする。

```sh
node scripts/chrome-webstore.mjs submit --dry-run \
  --publisher-id "$CHROME_WEBSTORE_PUBLISHER_ID" \
  --extension-id "$CHROME_WEBSTORE_EXTENSION_ID"
```

GitHub Actions の画面を開く。

このコマンドで出たURLを開く。

```sh
printf 'https://github.com/%s/%s/actions/workflows/chrome-webstore-release.yml\n' "$GITHUB_OWNER" "$GITHUB_REPO"
```

`Run workflow` を押して、次で実行する。

```text
version: 空欄
publish: false
status_only: true
publish_only: false
skip_review: false
deploy_percentage: 空欄
```

成功条件:

- `Fetch Chrome Web Store status` が成功
- `Build release zip` は実行されない
- `Upload to Chrome Web Store` は実行されない
- `Publish in Chrome Web Store` は実行されない

## 初回ドラフトを公開提出する

Chrome Web Store Dashboard で最初のzipを手動アップロード済みの場合は、同じ
versionを再アップロードしない。GitHub Actions の `Run workflow` を押して次で
実行する。

```text
version: 空欄
publish: false
status_only: false
publish_only: true
skip_review: false
deploy_percentage: 空欄
```

成功条件:

- `Publish existing Chrome Web Store draft` が成功
- `Build release zip` は実行されない
- `Upload to Chrome Web Store` は実行されない

## 毎回の通常リリース

このブロックだけ使う。

```sh
set -eu

export VERSION="0.1.1"

npm run version:set -- "$VERSION"
npm run release:zip

git status --short
git add package.json extension/manifest.json
git commit -m "Release ${VERSION}"
git tag "v${VERSION}"
git push origin HEAD
git push origin "v${VERSION}"
```

GitHub Actions の成功条件:

- `Validate tag version` が成功
- `Build release zip` が成功
- `Upload release artifacts` が成功
- `Upload to Chrome Web Store` が成功
- `Publish in Chrome Web Store` が成功

その後:

1. Chrome Web Store Developer Dashboard を開く。
2. 審査中または公開済みになっていることだけ確認する。
3. 審査メールを待つ。

## 手動アップロードだけしたい場合

GitHub Actions の `Run workflow` を押して次で実行する。

```text
version: 空欄
publish: false
status_only: false
publish_only: false
skip_review: false
deploy_percentage: 空欄
```

公開提出したくなったら同じ画面で次を実行する。

```text
version: 空欄
publish: true
status_only: false
publish_only: false
skip_review: false
deploy_percentage: 空欄
```

## 失敗時

### `Tag vX.Y.Z does not match`

やること:

```sh
export VERSION="X.Y.Z"
npm run version:set -- "$VERSION"
git add package.json extension/manifest.json
git commit -m "Release ${VERSION}"
git tag -d "v${VERSION}" || true
git tag "v${VERSION}"
git push origin HEAD
git push origin ":refs/tags/v${VERSION}" || true
git push origin "v${VERSION}"
```

### `Missing required configuration`

やること:

```sh
gh secret list | grep -E 'CHROME_WEBSTORE_|GCP_'
```

足りないSecretを「初回だけ 6」で入れ直す。

### Chrome Web Store API が `403`

やること:

1. Dashboard の service account 欄に `GCP_SERVICE_ACCOUNT` が入っているか見る。
2. `CHROME_WEBSTORE_PUBLISHER_ID` が正しいか見る。
3. `CHROME_WEBSTORE_EXTENSION_ID` が正しいか見る。
4. `GCP_WORKLOAD_IDENTITY_PROVIDER` がこのrepositoryを指しているか見る。

再設定:

```sh
gh secret set CHROME_WEBSTORE_PUBLISHER_ID -b "$CHROME_WEBSTORE_PUBLISHER_ID"
gh secret set CHROME_WEBSTORE_EXTENSION_ID -b "$CHROME_WEBSTORE_EXTENSION_ID"
gh secret set GCP_WORKLOAD_IDENTITY_PROVIDER -b "$GCP_WORKLOAD_IDENTITY_PROVIDER"
gh secret set GCP_SERVICE_ACCOUNT -b "$SA_EMAIL"
```

### `Upload to Chrome Web Store` は成功、`Publish` が失敗

やること:

1. GitHub Actions の失敗ログを読む。
2. Chrome Web Store Dashboard の警告を直す。
3. 直したら patch version を上げて通常リリースをやり直す。

`--allow-warnings` は通常使わない。

### 審査で却下された

やること:

1. 却下メールの理由を `docs/PLAN.md` に1行メモする。
2. 指摘されたコード、権限、説明文、画像、privacyを直す。
3. patch version を上げる。
4. 通常リリースをやり直す。

## 公式リンク

- Chrome Web Store Developer Dashboard: `https://chrome.google.com/webstore/devconsole`
- Chrome Web Store API: `https://developer.chrome.com/docs/webstore/api`
- Chrome Web Store service accounts: `https://developer.chrome.com/docs/webstore/service-accounts`
- Google GitHub Actions auth: `https://github.com/google-github-actions/auth`
