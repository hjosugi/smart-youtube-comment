<!-- i18n: language-switcher -->
[English](ARCHITECTURE.md) | [日本語](ARCHITECTURE.ja.md)

# アーキテクチャ

このリポジトリは、YouTube のライブチャットをニコニコ風の弾幕として動画に重ねる成果物を 2 つ含みます。

| 成果物 | 場所 | コメントの取得方法 | サーバーとの通信 |
| --- | --- | --- | --- |
| Chrome 拡張 | `extension/`(デスクトップ、Chrome ウェブストアで公開中) | YouTube が描画済みのチャット iframe の DOM を読む(`MutationObserver`) | なし |
| モバイル PWA | `web/` + `worker/`(iOS Safari、Android Chrome) | YouTube の InnerTube API(`youtubei/v1`)を Cloudflare Worker 経由でポーリング | 中継のみ |

どちらもライブチャットとチャットリプレイ(過去ライブのチャット)が対象です。通常動画の下にあるコメント欄は読みません。

最後は同じ処理に合流します。データの形は [docs/CONTRACT.ja.md](docs/CONTRACT.ja.md) にあります。

```text
ChatMessage -> NG フィルタ (filter.js) -> 採点 (scoring.js) -> buildRenderPlan() -> DanmakuOverlay.push() (danmaku.js)
```

採点・フィルタ・描画は常に端末側で動きます。Worker はチャットを中継するだけで、採点・重複排除・描画はしません。

---

## 1. Chrome 拡張

### 1.1 フレーム構成

YouTube の視聴ページには、この拡張の部品が 3 つ載ります。これにバックグラウンドの service worker が加わります。

```text
www.youtube.com/watch?v=…  (トップフレーム)    content.js -> initRenderer()
 ├─ ytd-live-chat-frame > iframe /live_chat     content.js -> initChatExtractor()
 │    (YouTube のチャット。チャットを閉じている間は拡張が置く不可視の代役)
 └─ .html5-video-player > iframe stage.html     stage.js + danmaku.js
      (拡張のオリジン。専用のレンダラープロセス)

バックグラウンド service worker                  background.mjs -> background.js
```

`manifest.json` は `content.js` を 2 か所に注入します。`/watch*` と `/live/*` のトップフレーム(描画側)と、`all_frames: true` の `/live_chat*`(抽出側)です。役割は `content.js` の末尾で `location.pathname` を見て決めます。

### 1.2 コメントの取得方法

拡張は自分でチャットを取りに行きません。YouTube 自身のチャット iframe がチャットを取得して DOM に描画し、拡張はその DOM ノードを読みます。そのため API キーも CORS 回避も要らず、拡張から YouTube へのリクエストもありません。視聴者が YouTube 上でブロックしたユーザーは DOM に来ないので、弾幕にも出ません。

```text
/live_chat iframe  (content.js, initChatExtractor)
  yt-live-chat-item-list-renderer #items を MutationObserver で監視
  + 2.5 秒ごとの scan(): #items が作り直されていれば付け直し、末尾 80 件を読み直す
        |
  processChatNode(node)
    isUserChatMessageNode   バナー・ティッカー・固定メッセージ・削除済みを除外
    extractMessageParts     テキストとカスタム絵文字 <img> を parts に分解
    author / kind / authorType / amount / paidColor / チャンネル ID
    isOfficialChatText      YouTube 自身の案内文を除外
    SYCFilter.apply         NG リスト: 除外、または伏せ字/置換
    scorer.score -> buildRenderPlan
        |  chrome.runtime.sendMessage({ type: "smart-comment:chat-message" })
        v
background.js
    送信元が www.youtube.com のタブか確認; sanitizeRenderPayload
        |  chrome.tabs.sendMessage(tabId, { type: "smart-comment:render-message" }, { frameId: 0 })
        v
トップフレーム  (content.js, initRenderer)
    sanitizeRenderPayload; 端末内翻訳(任意、translate.js)
        |  stage.push -> postMessage({ type: "push" }) をステージへ
        v
stage.html  (stage.js)
    event.source と origin を確認; sanitizeRenderPayload
    DanmakuOverlay.push -> canvas
```

ペイロードは中継のたびに(background、トップフレーム、ステージで)サニタイズし直します。どの段も別のコンテキストから受け取るからです。

`processChatNode()` が読む要素:

| YouTube の要素 | `kind` |
| --- | --- |
| `yt-live-chat-text-message-renderer` | `text` |
| `yt-live-chat-paid-message-renderer` | `paid` |
| `yt-live-chat-membership-item-renderer` | `membership` |

| 要素の中 | 変換先 |
| --- | --- |
| `#message`(テキストノードと `<img>` 絵文字) | `text`、`parts`(`{t}` がテキスト、`{u, a}` が画像) |
| `#author-name` | `author`。その `external-channel-id`(なければ要素の `author-external-channel-id`)が NG リストで使うチャンネル ID |
| `author-type` 属性、なければバッジの `[type=…]` | `authorType`: `owner` / `moderator` / `member` / `normal` |
| `#purchase-amount`、`--yt-live-chat-paid-message-*-color` | `amount`、`paidColor`(スーパーチャット) |

補足:

- **重複.** 処理済みノードは `processedChatNodes`(`WeakSet`)が覚えます。テキストが入ってから初めて記録するので、YouTube が後から中身を埋めるプレースホルダも `characterData` の変化で拾えます。
- **チャット iframe の中だけで監視する理由.** 視聴ページ全体を監視するとカクつきの原因になっていました。トップフレームにはチャットのノードがありません。
- **チャットを閉じたとき.** YouTube はチャットを閉じると iframe を破棄します。そこで `createChatSource()` が 1×1 の不可視 iframe を追加します。URL は YouTube の iframe が最後に表示していたもの(リプレイは continuation が必要なため)、チャットを閉じた状態で開いたライブなら `/live_chat?is_popout=1&v=<id>` です。リプレイでは動画の `timeupdate` を、YouTube のページが自分のチャット iframe に送るのと同じ `yt-player-video-progress` メッセージとして転送します。`ytd-live-chat-frame` の `collapsed` 属性を見る `MutationObserver` が代役を出し入れします。
- **「デフォルトのチャットを隠す」.** この設定は CSS で YouTube のチャットを 1px に縮めるだけです。iframe は読み込まれたままなので、抽出は続きます。

コードの場所:

| ファイル | 関数 | 役割 |
| --- | --- | --- |
| `extension/manifest.json` | `content_scripts` | どのフレームで何を動かすか |
| `extension/content.js` | `initChatExtractor`, `findChatItemsRoot` | 監視と定期的な付け直し |
| | `processChatNode`, `isUserChatMessageNode`, `isOfficialChatText` | ノード 1 件からペイロード 1 件へ |
| | `extractMessageParts`, `extractAuthorType`, `extractAmount`, `extractPaidColor`, `extractAuthorChannelId` | DOM の読み取り |
| | `safeRuntimeSend` | チャット iframe から background へ |
| | `createChatSource` | 不可視の代役チャット iframe |
| | `initRenderer`, `createStage` | トップフレーム: トグルボタン、ステージ、ポインタ入力、PiP |
| `extension/background.js` | `onMessage` リスナー, `isAllowedSender` | チャット iframe からトップフレームへの中継 |
| `extension/stage.js` | `message` リスナー | ステージ側: push、clear、start/stop、当たり判定、ピン留め、ユーザー非表示 |
| `extension/sanitize.js` | `sanitizeRenderPayload`, `sanitizeMessageParts` | ペイロードと絵文字 URL の検証 |
| `extension/filter.js` | `SYCFilter.apply` | NG ユーザー・チャンネル・語句・正規表現 |
| `extension/scoring.js` | `createFallbackScorer`, `buildRenderPlan` | 段と優先度([docs/SCORING.ja.md](docs/SCORING.ja.md)) |
| `extension/danmaku.js` | `DanmakuOverlay` | canvas エンジン |

### 1.3 ステージフレームでの描画

エンジンは YouTube のページ内では動きません。`stage.html` は拡張のページで、`content.js` がプレイヤーの上に iframe として重ねます。`web_accessible_resources` はこの 1 件だけで、`https://www.youtube.com/*` に限り、`use_dynamic_url` で配信します。ページ内で動かしていた頃は、エンジンのフレームループが YouTube 自身のページ処理を毎 vsync 走らせ、YouTube が日常的に出す 0.5 秒級のタスクのたびに止まっていました。ステージでは専用のプロセスとフレームクロックを持ちます([docs/PERFORMANCE.ja.md](docs/PERFORMANCE.ja.md) の「ステージフレーム」)。

- ステージは設定を `chrome.storage` から直接読みます(`SYCSettings.load` / `onChange`)。トップフレームが送るのはコメントとポインタ入力だけです。
- ステージはポインタイベントを受けません。トップフレームがプレイヤー上でイベントを(キャプチャフェーズで)受け、`hover` / `select` / `drag*` を送り、ステージがポインタの下に何があるかを返します。右クリックメニューはページ側で DOM API と `textContent` だけで組み立てます。「このユーザーを非表示」はステージが投稿者を NG リストへ書き込み、チャット iframe の `SYCFilter` がストレージの変更を受けて以後そのユーザーを除外します。
- ピクチャーインピクチャー(ベータ)は `<video>` 要素を Document Picture-in-Picture のウィンドウへ移し、そこに専用のステージを置きます。このためステージは `parent.opener` からのメッセージも受け付けます。
- エンジン内部ではコメントを共有のスプライトアトラスに描くので、定常状態では何も確保しません([docs/PERFORMANCE.ja.md](docs/PERFORMANCE.ja.md) の「スプライトアトラス」)。

### 1.4 設定・保存・その他のページ

- `settings.js` はスキーマです。`options.html` と `popup.html` はここからフォームを描き、`toEngineConfig()` がエンジン用の設定に変換します。設定は `chrome.storage.sync` に保存します。
- `filter.js` は NG リスト(ユーザー、チャンネル ID、語句、正規表現、除外/伏せ字/置換のモード)を `chrome.storage.local` にだけ保存します。
- `background.js` はキーボードコマンド `toggle-overlay` と `open-options` も扱います。

---

## 2. モバイル PWA

### 2.1 拡張ではなく伴走 Web アプリにした理由

| 環境 | 拡張機能 | ユーザースクリプト | 素の Web アプリ |
| --- | --- | --- | --- |
| iOS Safari | Xcode でアプリ化し App Store 配布が必要 | Userscripts アプリ経由 | 可 |
| Android Chrome | 不可 | 不可 | 可 |

両方を満たせるのは Web アプリだけです。PWA は自前のサイトに YouTube IFrame Player を埋め込み、その上に弾幕 canvas を重ねます。YouTube 公式アプリは拡張できません。

バックグラウンド再生はしません。埋め込みプレイヤーは画面ロックやアプリ切り替えで止まります(OS と YouTube の制約)。PWA が使うのは Wake Lock API(前面にいる間は画面を点けておく)と Media Session API(ロック画面のメタ情報と操作)だけです。弾幕は画面を見ているときに使うものなので、これで割り切ります。

### 2.2 中継サーバーが要る理由

ページから InnerTube(`youtubei/v1`)を直接呼ぶと CORS で弾かれます。公式の YouTube Data API は CORS 可ですが、ライブチャットのポーリングで無料枠がすぐ尽きます。そこでステートレスな Cloudflare Worker が InnerTube の呼び出しを中継し、CORS ヘッダを付けます。それ以外はすべて端末側です。

### 2.3 コメントの取得方法

```text
端末 (PWA)                           Cloudflare Worker                     YouTube InnerTube
----------                           -----------------                     -----------------
app.ts  client.start(videoId)
chat-client.ts
  GET /api/livechat?video=<id> --->  index.ts handle() -> fetchEnvelope()
                                       resolveLiveChat()  ----------------> POST youtubei/v1/next
                                                          <---------------- conversationBar.liveChatRenderer
                                                                            .continuations[]
                                       pollLiveChat(cont) ----------------> POST live_chat/get_live_chat
                                                          <---------------- actions[]
                                       parseAction() -> ChatMessage[]
                               <---  { messages, continuation, timeoutMs, ended, isReplay }
  onMessages(messages)
  待つ(待ち時間は step() が決める)
  GET /api/livechat?cont=<token> ->  (以後 continuation で繰り返し)
```

1. **解決.** `?video=<id>` のとき、`resolveLiveChat()` が `next` を POST し、`contents.twoColumnWatchNextResults.conversationBar.liveChatRenderer` を読みます。ここで最初の continuation と、リプレイかどうかが分かります。最初のポーリングも同じリクエスト内で行います。
2. **ライブのポーリング.** `pollLiveChat()` が continuation 付きで `live_chat/get_live_chat` を POST し、`continuationContents.liveChatContinuation` を読みます。

   ```text
   actions[]
     addChatItemAction.item                 (新しいメッセージ)
     replaceChatItemAction.replacementItem  (プレースホルダの差し替え)
       liveChatTextMessageRenderer                          -> text
       liveChatPaidMessageRenderer, liveChatPaidStickerRenderer -> paid
       liveChatMembershipItemRenderer                       -> membership
       liveChatSponsorshipsGiftPurchaseAnnouncementRenderer -> membership
       それ以外(バナー、投票など)                           -> 捨てる
   continuations[]
     次の token と timeoutMs(250〜30000 ms にクランプ)
     token がない -> ended: true、端末は停止
   ```

   投稿者バッジから `authorType` を決め、メッセージの runs をテキストと絵文字の `parts` にします。
3. **リプレイのポーリング.** `?cont=<token>&offset=<ms>&replay=1` のとき、`pollReplay()` が `currentPlayerState.playerOffsetMs` 付きで `live_chat/get_live_chat_replay` を POST し、`replayChatItemAction` を展開して各メッセージに `offsetMs` を付けます。continuation は使い回し、再生位置で読む範囲が動きます。リプレイの終わりはプレイヤーが判断するので、中継はリプレイに対して常に `ended: false` を返します。端末は再生位置の 8 秒前から 1.5 秒先までのメッセージだけを表示し(`playback.ts` の `makeFate`)、後ろへシークしたらリセットします。
4. **端末のループ.** `chat-client.ts` の `createLiveChatClient()` が、純粋な状態機械 `step()` を中心にポーリングを回します。
   - 正常: サーバーの `timeoutMs` だけ待つ
   - 静か(0 件が続く): 1 回ごとに `quietGrowth` 倍に延ばし、最大 40 秒
   - エラー: ジッタ付き指数バックオフ、最大 30 秒
   - 4 回続けて失敗、または `410` を受けたら即: 動画 ID から解決し直す(continuation の失効)
   - タブが非表示、または動画が一時停止中: ポーリングしない
   - `ended`、または `404`(ライブチャットなし): 停止
5. **処理の流れ.** `app.ts` の `onMessages()`: `sanitizeChatMessage`(URL 検証)→ リプレイの時間窓と既読 ID の確認 → `filter.apply` → コメント一覧と `makeRenderer()`(`pipeline.ts`: 採点、`buildRenderPlan`)→ `overlay.push()`。

コードの場所:

| ファイル | 関数 | 役割 |
| --- | --- | --- |
| `worker/src/index.ts` | `handle`, `readParams`, `fetchEnvelope` | ルーティング、入力検証、エッジキャッシュ、同時リクエストの集約、レート制限 |
| `worker/src/innertube.ts` | `resolveLiveChat`, `pollLiveChat`, `pollReplay` | InnerTube 呼び出し |
| | `postWithRetry`, `postOnce` | 1 回 3.5 秒、タイムアウト/5xx のみ 1 回再試行 |
| | `extractContinuation`, `parseAction`, `RENDERERS`, `runsToParts`, `authorTypeFromBadges` | レスポンスの純粋変換 |
| `web/chat-client.ts` | `createLiveChatClient`, `step`, `buildUrl` | 適応ポーリング |
| `web/app.ts` | `onMessages` | 結線: プレイヤー、クライアント、フィルタ、一覧、オーバーレイ |
| `web/pipeline.ts` | `makeRenderer`, `renderBatch` | ChatMessage から弾幕ペイロードへ |
| `web/playback.ts` | `makeFate`, `createSeenTracker` | リプレイの時間窓、ID での重複排除 |
| `web/player.ts`, `web/lifecycle.ts` | | YouTube IFrame API、Wake Lock、Media Session |

### 2.4 中継の堅牢性とコスト

- **入力.** `video` は 11 文字の ID、`cont` は長さと文字種を制限したトークンに限ります。`replay=1` なしの `cont` + `offset` は拒否します。
- **エッジキャッシュ.** エンベロープを `caches.default` に `s-maxage = floor(timeoutMs / 1000)` で保存します。キーは `video` / `cont` / 3 秒単位に丸めた offset だけです。同じ配信を同じ Cloudflare 拠点で見ている視聴者は、上流への呼び出しを 1 本で共有します。`timeoutMs < 1000` のポーリングと終端のエンベロープはキャッシュしません。
- **キャッシュ前の同時リクエスト.** 同じキーで処理中のリクエストは、isolate 内で 1 つの Promise を共有します。
- **上流のエラー.** `429`(YouTube のレート制限)、`reResolve: true` 付きの `410`(continuation への 4xx、つまり失効)、`502` のいずれかで返し、1 秒キャッシュします。上流が詰まったときに全視聴者が一斉に叩かないためです。`404` はライブチャットがないことを表します。
- **再試行.** Worker はタイムアウト/5xx のときだけ 1 回再試行するので、最悪でも 7 秒前後で返ります。`429` は再試行しません。続く不調は端末のバックオフに任せます(2026-06-20 の実測: InnerTube には Cloudflare の egress から 1 回 1 秒ほどで届きます。ときどき数秒止められることがありますが、恒常的な IP ブロックではありません)。
- **任意の制御.** `ALLOWED_ORIGINS` は他のブラウザオリジンを拒否し、`RATE_LIMIT_PER_MINUTE`(既定 120)は isolate ごとにクライアント IP を制限します。
- **クライアントバージョン.** InnerTube には公開の `WEB` クライアントとして、既定ではバージョン `2.20240814.00.00` で呼びます。コードを変えずに `INNERTUBE_CLIENT_VERSION` 変数で上書きできます。`GET /health?deep=1&video=<id>` は `next` を試しに呼び、バージョンが拒否されるようになったことを視聴者より先に検知します。
- **無料枠.** ポーリング 1 回が Worker の 1 リクエストです(キャッシュに当たっても同じ)。10 秒間隔なら 1 視聴者で 1 日 8,640 リクエストなので、Workers Free の 1 日 10 万件では常時視聴で約 11 人、1 時間の視聴なら約 278 回分です。エッジキャッシュが守るのは YouTube と egress IP で、この枠ではありません。リクエストを減らしているのは、非表示中の停止と静かなチャットでの間隔延長です。次の段階の WebSocket + Durable Object による単一化は、[docs/PLAN.ja.md](docs/PLAN.ja.md) の条件を満たしてから行います。

### 2.5 モバイル特有の点

- canvas はラッパー内でプレイヤー iframe の兄弟要素として置き、`pointer-events: none` にします。タップは YouTube の操作部に届きます。
- `sw.js` は静的なシェルだけをキャッシュし、チャット API はキャッシュしません。
- `store.js` は `chrome.storage` と同じ形の `localStorage` シムで、`settings.js` と `filter.js` を無改変で動かします。
- `ui.ts` / `controls.ts` は同じスキーマからタッチ向けの設定シートを描きます。
- `?perf=1` で HUD(`perf.ts`)を出します: fps、表示中のコメント数、取りこぼし、フレーム p95、Long Task。重いレンダラー最適化は、実機が [docs/PLAN.ja.md](docs/PLAN.ja.md) の基準を満たさなかったときだけ入れます。

---

## 3. 共有コード

エンジン類のファイルには `shared/` ディレクトリもビルド工程もありません。`globalThis.SYC*` を公開するクラシックスクリプトを両方のツリーに置いています。

| ファイル | 拡張と web の関係 |
| --- | --- |
| `scoring.js`, `filter.js` | バイト単位で同一。違えば `npm run check:shared-drift` が失敗 |
| `emoji.js` | 同一 |
| `translate.js` | 同じロジック。web 側は `oxfmt` で整形 |
| `danmaku.js` | 意図的な分岐。それぞれ向けに調整 |
| `settings.js` | 意図的な分岐。スキーマは同じで既定値が違う |

既定値の違い(`SYCSettings.PROFILE` が対象を示し、テストがこの値を固定します。別のテストでエンジンの `DEFAULTS` と `toEngineConfig(DEFAULTS)` の一致も守っています):

| 設定 | 拡張(デスクトップ) | web(モバイル) |
| --- | --- | --- |
| `fontPx` | 24 | 18 |
| `maxActive` | 2000 | 250 |
| `maxQueue` | 2400 | 1000 |
| `spawnPerFrame` | 10 | 6 |
| `renderScalePct` | 75 | 60 |
| `dedup` | オフ | オン |
| `listEnabled` | — | オン(web のみ) |

メッセージや採点の形を変えるときは、必ず [docs/CONTRACT.ja.md](docs/CONTRACT.ja.md) も一緒に変えます。

---

## 4. YouTube 側の変更で壊れうる場所

| 対象 | 依存しているもの | 最初に確かめる方法 |
| --- | --- | --- |
| 拡張・抽出 | 要素名 `yt-live-chat-*-renderer`、`#items`、`#message`、`#author-name`、`author-type` 属性 | ライブ配信で `npm run test:ext:youtube` |
| 拡張・ページ | `ytd-live-chat-frame[collapsed]`、`.html5-video-player`、`.ytp-right-controls`、`yt-player-video-progress` メッセージ | 同上 |
| 中継 | `twoColumnWatchNextResults.conversationBar.liveChatRenderer`、`RENDERERS` のキー、continuation データのキー、クライアントバージョン | `/health?deep=1`、`node worker/test/probe.mjs` |

---

## 5. リポジトリ構成

```text
.
├── extension/        Chrome MV3 拡張(素の JS、ビルド工程なし)
│   ├── manifest.json, background.mjs, background.js
│   ├── content.js    チャット抽出(チャット iframe)+ ステージの管理(トップフレーム)
│   ├── stage.html, stage.js   エンジンが動くフレーム
│   ├── danmaku.js, scoring.js, filter.js, settings.js, sanitize.js, emoji.js, translate.js
│   ├── options.*, popup.*, _locales/, icons/
│   └── test/
├── web/              モバイル PWA(TypeScript モジュール + 共有のクラシックスクリプト)。web/dist にビルド
├── worker/           Cloudflare Worker の中継(src/index.ts, src/innertube.ts, test/)
├── bench/            レンダラーのベンチマーク、カクつきのトレース、ブラウザ e2e(bench/e2e)
├── sandbox/          チャットを模擬するローカルページ(npm run sandbox)
├── scripts/          テスト実行、セキュリティゲート、パッケージング、ストア提出、バージョン更新
└── docs/             下表
```

## 6. ドキュメント

| ドキュメント | 内容 |
| --- | --- |
| [README.ja.md](README.ja.md) | インストール、現状、開発コマンド |
| [docs/CONTRACT.ja.md](docs/CONTRACT.ja.md) | `ChatMessage`、ポーリングのエンベロープ、`ScoreInput`、`ScoreResult`、レンダープラン |
| [docs/SCORING.ja.md](docs/SCORING.ja.md) | コメントの採点方法と例 |
| [docs/PERFORMANCE.ja.md](docs/PERFORMANCE.ja.md) | 計測したボトルネックと対策 |
| [docs/SECURITY.ja.md](docs/SECURITY.ja.md) | 脅威モデルとリリース時のセキュリティゲート |
| [docs/PRIVACY.ja.md](docs/PRIVACY.ja.md) | プライバシーポリシー(ストア掲載からリンク) |
| [docs/RELEASE.ja.md](docs/RELEASE.ja.md) | リリースの流れ、ストア自動化、ストア掲載情報 |
| [docs/PLAN.ja.md](docs/PLAN.ja.md) | 残作業、着手条件、移行メモ |
| [CONTRIBUTING.md](CONTRIBUTING.md), [AGENTS.md](AGENTS.md) | チェック、守る境界、担当 |
