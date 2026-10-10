<!-- i18n: language-switcher -->
[English](RELEASE.md) | [日本語](RELEASE.ja.md)

# Release

How the Chrome extension gets from `main` to the Chrome Web Store. The PWA and
the Worker deploy from `main` on their own
(`.github/workflows/deploy-web-worker.yml`).

## Listing

- store page: <https://chromewebstore.google.com/detail/nkphcfhnfjceplpgcjccnpfdkheafohp>
- extension ID: `nkphcfhnfjceplpgcjccnpfdkheafohp`
- category: Entertainment; listing languages: English and Japanese
- privacy policy: `docs/PRIVACY.md`. The listing links to its GitHub URL, so do
  not move or rename that file.
- support: the GitHub issue tracker

The store only moves after review, so the published version can trail `main`.

## Normal release

A version bump that lands on `main` is a release. Nothing else is manual.

```sh
npm run version:set -- X.Y.Z                # root, web/, worker/, lockfiles, extension/manifest.json
SYC_REQUIRE_E2E=1 npm run release:zip       # all checks, then the zip
SYC_EXTENSION_HEADLESS=1 npm run test:ext   # the unpacked extension in Chromium
git switch -c release-X.Y.Z
git commit -am "Release X.Y.Z"
git push -u origin HEAD                     # open a PR, wait for checks, merge
```

On the push to `main`, `.github/workflows/chrome-webstore-release.yml`:

1. `Resolve release target` sets `publish=true` because `vX.Y.Z` has no tag yet
   (a push whose version is already tagged only builds the zip);
2. runs the checks, builds the zip, and keeps it as a run artifact;
3. uploads the zip to the store and submits it for review;
4. only after the store accepts it, the `github-release` job tags the commit
   `vX.Y.Z` and creates the GitHub Release with the zip, checksum, and tester
   guide.

Watch it with `gh run watch`, then check the dashboard for "pending review".

Rules:

- Do not push a tag by hand for a version that `main` releases; the auto-created
  tag does not start a second run. A hand-pushed `vX.Y.Z` tag still releases
  that tag, and must match the versions `npm run version:set` wrote.
- The store holds one submission at a time. To replace a version still waiting
  for review, run the workflow by hand with `cancel_submission: true` (or
  `npm run release:store:cancel`), then bump and merge as usual.
- Do not press Publish in the dashboard for a normal release.

## Versioning

`package.json`, `web/package.json`, `worker/package.json`, and
`extension/manifest.json` always carry the same version; the workflow fails when
they disagree. `npm run version:set -- X.Y.Z` writes all of them and the
lockfile root metadata.

- patch: fixes, threshold tuning, docs
- minor: user-visible settings, rendering, filtering, or UI features
- major: contract or storage changes that break compatibility

## Checks

```sh
npm ci && npm --prefix web ci && npm --prefix worker ci
npm run release:check
```

`release:check` runs lint, format check, the security gate
([SECURITY.md](SECURITY.md)), typechecks, the web build, the unit,
deterministic, and browser e2e suites, and the sandbox smoke test.
`SYC_REQUIRE_E2E=1` makes missing Chromium a failure instead of a skip.

Outside `release:check`, because they depend on YouTube being reachable and a
stream being live:

- `SYC_REAL_YOUTUBE_URL="https://www.youtube.com/watch?v=…" npm run test:ext:youtube`:
  the extension on a real live stream with active chat
- `node worker/test/probe.mjs`: one relay probe for a known video
- `node worker/test/loadtest.mjs`: relay latency and retry under pressure
- `node web/test/chat-client-live.mjs`: the PWA chat client against live chat

Manual smoke before a release that changes extraction or rendering: load
`extension/` unpacked, open a busy live stream, and confirm that comments flow
over the video for several minutes, that the player toggle and the
"hide default chat" setting work, that YouTube's own guide and warning lines do
not appear, and that the player controls stay responsive.

## The zip

`npm run release:zip` writes to `.release/` (ignored by Git):

- `smart-youtube-comment-vX.Y.Z.zip`, `.sha256`, `.release.json`
- `smart-youtube-comment-vX.Y.Z-notes.md`, `-tester-install.md`

The zip holds only the files listed in `scripts/package-extension.mjs`; there is
no build step. Testers who load it unpacked: unzip, open `chrome://extensions`,
turn on Developer mode, `Load unpacked`, pick the folder. Ask for the Chrome
version, OS, stream URL, and console errors when something fails.

## Workflow and local commands

Manual runs of the `Chrome Web Store Release` workflow (`workflow_dispatch`):

| Input | Effect |
| --- | --- |
| `status_only: true` | only fetch the store status (checks credentials) |
| `cancel_submission: true` | cancel the submission waiting for review |
| `publish_only: true` | publish the existing draft, no upload |
| `publish: false` | upload only, publish later |
| `version` | set a version before packaging; emergencies only, it is not committed back |
| `skip_review`, `deploy_percentage` | ask the store to skip review when eligible; staged rollout |
| `dry_run: true` | validate and print the API calls, no network |

The same from a shell, with credentials in the environment:

```sh
npm run release:store:status
npm run release:store:upload
npm run release:store:publish
npm run release:store:cancel
npm run release:store            # release:zip, then upload and submit
node scripts/chrome-webstore.mjs submit --dry-run
```

Environment controls: `CHROME_WEBSTORE_SKIP_REVIEW=1`,
`CHROME_WEBSTORE_DEPLOY_PERCENTAGE=25`, `CHROME_WEBSTORE_BLOCK_ON_WARNINGS=0`
(publishing blocks on API warnings by default, so a policy warning never turns
into a public release), `CHROME_WEBSTORE_UPLOAD_POLL_ATTEMPTS=24`,
`CHROME_WEBSTORE_UPLOAD_POLL_DELAY_MS=5000`.

### Credentials

GitHub repository secrets. Preferred: a service account through GitHub OIDC
(Workload Identity Federation).

```text
CHROME_WEBSTORE_PUBLISHER_ID
CHROME_WEBSTORE_EXTENSION_ID
GCP_WORKLOAD_IDENTITY_PROVIDER
GCP_SERVICE_ACCOUNT
```

Fallback: an OAuth refresh token for the publisher account with the
`https://www.googleapis.com/auth/chromewebstore` scope, stored as
`CHROME_WEBSTORE_CLIENT_ID`, `CHROME_WEBSTORE_CLIENT_SECRET`, and
`CHROME_WEBSTORE_REFRESH_TOKEN`. `CHROME_WEBSTORE_ACCESS_TOKEN` works for local
runs.

`scripts/chrome-webstore.mjs` prints the publisher ID, the service account, and
OAuth secrets as `***`, so its output is safe to paste into an issue. Never add
those values back by hand: the publisher ID is a UUID, and GitHub secret
scanning reports bare UUIDs as an `OpenVSX Access Token` on a public repository.

## When it fails

A failed upload leaves the listing untouched; the last approved version stays
live, and no tag exists yet.

- **`does not match`**: the package files, the manifest, or a hand-pushed tag
  disagree. Run `npm run version:set -- X.Y.Z` and commit. Delete a wrong tag
  with `git push origin ":refs/tags/<tag>"`.
- **Upload or publish failed transiently**: re-run the failed job; the same
  version is retried. If only `github-release` failed, re-run that job; the
  store submission is not repeated.
- **`Missing required configuration`**: a secret is missing
  (`gh secret list | grep -E 'CHROME_WEBSTORE_|GCP_'`).
- **`403 PERMISSION_DENIED` on `publishers/<id>/items/<id>`**: the token worked
  but its identity cannot touch the item. Check that
  `CHROME_WEBSTORE_EXTENSION_ID` is `nkphcfhnfjceplpgcjccnpfdkheafohp`, that
  `CHROME_WEBSTORE_PUBLISHER_ID` is the publisher that owns it, that the service
  account in `GCP_SERVICE_ACCOUNT` is added to that publisher in the dashboard
  (invitation accepted), that `GCP_WORKLOAD_IDENTITY_PROVIDER` points at this
  repository, and that the Chrome Web Store API is enabled in the Google Cloud
  project. Re-check with `npm run release:store:status`. Do not bump the version
  to work around it.
- **Upload succeeded, publish failed on warnings**: read the log, fix the
  warnings in the dashboard, bump the patch version, release again.
- **Rejected in review**: note the reason in [PLAN.md](PLAN.md), fix the code,
  permissions, listing, or privacy answers, bump the patch version, release
  again.

## Rollback

There is no instant rollback. Pause the release in the dashboard if you can,
fix the source, bump the patch version, and release again. Keep the bad
`.release/*.release.json` if the zip was already shared. Unpacked testers remove
the old copy and load the new folder.

---

## Appendix: store item setup

Done once; kept for auditing or recreating the item, and for pasting the
listing text when it changes.

### Listing text

- Name: `Smart YouTube Comment Overlay`
- Summary: `Nico-style YouTube live chat overlay.` (the `ext_desc` locale string)
- Detailed description:

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

- Support URL: `https://github.com/hjosugi/smart-youtube-comment/issues`
- Images: `extension/icons/icon128.png`; screenshots of comments over a live
  stream, the options page, and the player toggle. `npm run release:store:assets`
  renders promo images into `.release/store-assets/`.

### Privacy and data use

- Single purpose: `Display YouTube live chat as an on-video comment overlay and let the user tune local display, performance, and filter settings.`
- Data collection: `No user data is collected by the developer.`
- Privacy explanation: `The extension processes YouTube live chat text locally in the browser only for overlay rendering and local scoring. Chat text is not sent to the developer or to an external server. Display, behavior, and performance settings are saved with Chrome Sync storage when available. Blocked users and blocked words are saved only in local extension storage on the current device and are not synced.`
- Permission justification:
  - `storage: Saves user settings such as overlay enabled state, display options, and performance limits. It also saves blocked users and blocked words locally on the current device.`
  - `https://www.youtube.com/* site access: Required for content scripts to read YouTube live chat elements and render the comment overlay on YouTube video pages.`
- Remote code: `No remote code is used.`
- Data use: check personally identifiable information, personal communications,
  and website content; leave the rest unchecked; check all three disclosures.
- Privacy policy URL: `https://github.com/hjosugi/smart-youtube-comment/blob/main/docs/PRIVACY.md`

### Google Cloud and GitHub

Run in `bash` with your values:

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

Then:

1. In the dashboard (Account → publisher settings), add `$SA_EMAIL` as the
   service account.
2. Store the secrets:

   ```sh
   gh secret set CHROME_WEBSTORE_PUBLISHER_ID -b "<publisher id>"
   gh secret set CHROME_WEBSTORE_EXTENSION_ID -b "nkphcfhnfjceplpgcjccnpfdkheafohp"
   gh secret set GCP_WORKLOAD_IDENTITY_PROVIDER -b "$GCP_WORKLOAD_IDENTITY_PROVIDER"
   gh secret set GCP_SERVICE_ACCOUNT -b "$SA_EMAIL"
   ```

3. Run the workflow with `status_only: true`; `Fetch Chrome Web Store status`
   must succeed without building or uploading anything.
