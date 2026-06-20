# Smart YouTube Comment — アーキテクチャ / 実装方針

最終更新: 2026-06-20

このリポジトリは「YouTube のライブチャットを内容評価しながら niconico 風の弾幕で
流す」プロジェクトの **単一の完成品リポジトリ**。**Chrome 拡張(デスクトップ)** と
**モバイル PWA** の **両方** を成果物として含む。

- **Chrome 拡張(`extension/`)**: デスクトップ www.youtube.com に弾幕を重ねる。既存実装。
- **モバイル PWA(`web/` + `worker/`)**: モバイルブラウザ向け伴走 Web アプリ。新規実装。

評価・描画の中核(`scoring.js` / `danmaku.js`)は両者で共有するが、**過度な共通化は
しない**(複雑になるなら最小限に留める方針 — 詳細は §5)。

モバイル対応ターゲット: **iOS Safari / Android Chrome / iPhone(Safari)**。
YouTube 純正アプリへの適用は行わない(技術的に不可)。

---

## 1. なぜ「拡張機能」ではなく「伴走 Web アプリ」なのか

決定的な制約があり、これが全アーキテクチャを規定する。

| 環境 | 拡張機能 | ユーザースクリプト | 素の Web アプリ |
|---|---|---|---|
| iOS Safari | △ Safari Web Extension(Xcode でネイティブアプリ化＋App Store 配布が必須) | △ Userscripts アプリ経由 | ◎ |
| Android Chrome(素) | **✕ 不可**(Google 仕様) | **✕ 不可** | ◎ |
| Firefox / Edge Android | ○ | ○ | ◎ |

→ **素の Android Chrome と iOS Safari を 1 つの仕組みで満たせるのは Web アプリだけ。**
よって「自前サイトに YouTube IFrame Player を埋め込み、その上に弾幕 Canvas を重ねる」
**伴走 Web アプリ(PWA)** 方式を採用する。

### 採用しなかった案

- **Safari 拡張 + userscript**: 素の Android Chrome が必ず落ちる。iOS は App Store 配布が必要。
- **userscript 一本化**: ユーザーがスクリプトマネージャ導入必須。素の Android Chrome 非対応。

---

## 2. 割り切った制約(重要・仕様)

### バックグラウンド再生は非対応

YouTube IFrame Player を埋め込む方式では、**画面ロック/アプリ切替時の再生は原理的に
不可能**(OS と YouTube 双方の制限)。これを超えられるのは純正アプリ(Premium)だけ。

できる対策のみ実施する:
- **Wake Lock API**: 前面にいる間は画面スリープを抑止する。
- **Media Session API**: ロック画面/通知に再生メタとコントロールを出す(操作のみ。
  実再生継続は保証しない)。

弾幕視聴は本質的に「画面を見ている＝前面」の用途なので実害は小さい、という前提で割り切る。

---

## 3. サーバー負荷を避ける設計(デバイス側オフロード)

方針: **重い処理は全てデバイス側。サーバーは CORS 中継だけの極小プロキシ。**

| 処理 | 実行場所 | 理由 |
|---|---|---|
| コメント評価(scoring) | デバイス | 純 JS・ローカル完結。ネットワーク不要 |
| 重複排除 / 過負荷制御 | デバイス | Canvas レンダラ内で完結 |
| 弾幕描画(Canvas) | デバイス | GPU/CPU はクライアント資源 |
| **ライブチャット取得** | **極小 CF Worker** | InnerTube は CORS で**ブラウザから直接叩けない**ため中継が必須 |

### なぜチャット取得だけサーバーが要るのか

- ブラウザから `youtubei` (InnerTube) を直接 fetch すると **CORS で弾かれる**
  (これがデスクトップ版で拡張機能が必要だった本質的理由)。
- 公式 YouTube Data API は CORS 可だが、ライブチャットのポーリングで**無料割当が
  すぐ枯渇**するため不採用。
- **Cloudflare Worker**: 無料枠・ステートレス・スケール 0。CORS 中継のみを担い、
  評価・描画は一切載せない。実質ゼロ運用負荷で「サーバー負荷を避ける」要件を満たす。

---

## 4. システム構成

```
┌─────────────────────────── デバイス(ブラウザ / PWA) ───────────────────────────┐
│                                                                                │
│   [YouTube IFrame Player]  ◄── 動画再生(純正埋め込み)                          │
│          ▲                                                                      │
│          │ 重ねる(pointer-events:none の Canvas)                              │
│   [Danmaku Canvas Overlay] ◄── danmaku.js(再利用)                            │
│          ▲                                                                      │
│          │ push(renderPlan)                                                     │
│   [Orchestrator app.js] ──► scoring.js(評価) / filter.js(NG) / settings.js  │
│          ▲                                                                      │
│          │ poll(ChatMessage[])                                                  │
│   [chat-client.js]                                                              │
│          │ fetch(JSON, CORS OK)                                                 │
└──────────┼─────────────────────────────────────────────────────────────────────┘
           │ HTTPS
┌──────────▼──────────── Cloudflare Worker(極小・ステートレス) ─────────────────┐
│   /api/livechat?video=<id>&cont=<token>                                         │
│     1. InnerTube `next` で初回 continuation を解決                              │
│     2. InnerTube `get_live_chat` をポーリング中継                               │
│     3. CORS ヘッダ付与して JSON を返す(整形は最小限、評価は載せない)          │
└────────────────────────────────────────────────────────────────────────────────┘
           │
┌──────────▼──────────── YouTube InnerTube(youtubei/v1) ────────────────────────┘
```

---

## 5. ディレクトリ構成(拡張 + モバイル 共存)

```
.
├── ARCHITECTURE.md          # 本ファイル(直下に配置)
├── extension/               # 【既存・維持】Chrome 拡張(デスクトップ)
│   ├── manifest.json / background.js / content.js / options.*
│   ├── scoring.js           # ← 中核(web の出発点)
│   ├── danmaku.js           # ← 中核(web の出発点)
│   ├── settings.js / filter.js
│   └── icons/ _locales/
├── web/                     # 【新規】モバイル PWA(静的配信。CF Pages 等)
│   ├── index.html / styles.css
│   ├── app.js               # オーケストレーション(player+chat+scoring+danmaku)
│   ├── player.js            # YT IFrame ラッパ + Wake Lock + Media Session
│   ├── chat-client.js       # CF Worker をポーリングし ChatMessage[] を返す
│   ├── store.js             # localStorage シム(chrome.storage の置換)
│   ├── scoring.js           # ← extension 由来 / モバイル最適化で分岐可(§5.1)
│   ├── danmaku.js           # ← extension 由来 / モバイル最適化で分岐可(§5.1)
│   ├── settings.js / filter.js  # 流用(localStorage 化)
│   ├── ui.js                # モバイル向け設定パネル(タッチ UI)
│   ├── sw.js / manifest.webmanifest / icons/
├── worker/                  # 【実装済・検証済】Cloudflare Worker(CORS 中継, JS)
│   ├── src/index.js         # Worker エントリ(CORS/ルーティング/キャッシュ)
│   ├── src/innertube.js     # InnerTube 中継ロジック(純粋・ランタイム非依存)
│   ├── test/probe.mjs       # node 実機検証ハーネス
│   └── wrangler.jsonc / package.json
└── docs/                    # 補足ドキュメント(契約・性能ノート等)
```

### 5.1 端末コードは「モバイル独立・最適化優先」

`scoring.js` と `danmaku.js` は extension を出発点にするが、**拡張とのバイト一致は
要求しない**。`web/` 側はモバイル最適化のために自由に分岐してよい。方針:

- **`shared/` 抽象化やビルドパイプラインは作らない**(複雑さに見合わない)。
- `web/` 側はモバイル特化で最適化する(例: モバイル GPU 向けに弾幕の間引き・
  `renderScalePct` 既定低下、スコアリング閾値・表示密度の調整)。extension を壊さず
  独立して進化できる。
- 守るのは **`docs/CONTRACT.md` の形(`ChatMessage`/`ScoreInput`/`ScoreResult`)だけ**。
  実装は両者で分岐してよいが、この契約は両surfaceで満たす。
- 出発点として両ファイルは `chrome.*` 非依存・`globalThis.SYC*` 公開なので、初期
  コピーは改変ゼロでそのまま動く。そこからモバイル最適化を加える。

> 言語の選択(なぜ Worker も端末も JS か): Worker は **I/O 中継のみ**(fetch→整形→
> CORS→キャッシュ)で CPU 処理ゼロ。ボトルネックはネットワークとポーリング間隔なので
> Rust/Go(WASM 化・ビルド鎖・cold start 増)にしても速くならない。端末スコアリングも
> 軽量テキスト処理で、本プロジェクトは既に Rust/WASM スコアラを意図的に撤去済み
> (`CONTRACT.md`: 実測で V8 に勝つまで別トランスポート追加禁止)。よって全面 JS が最適。
> サーバーに重い処理を載せる設計に変えるなら、その時に Rust/WASM を再評価する。

### 5.2 拡張側はそのまま維持

`extension/` の `background.js` / `content.js` / `manifest.json` / `options.*` /
`_locales/` は **削除しない**。デスクトップ拡張も完成品の一部として残す。

---

## 6. データ契約(Contract)

評価ロジックは元実装の契約を踏襲する(`docs/CONTRACT.md` 準拠)。chat-client が
InnerTube レスポンスを下記 `ChatMessage` 形に正規化し、scoring へ渡す。

```jsonc
// ChatMessage(worker が生成)
{
  "id": "string",
  "ts": 0,
  "kind": "text",          // "text" | "paid" | "membership"
  "author": "string",
  "authorType": "normal",  // "normal" | "member" | "moderator" | "owner"
  "authorColor": null,
  "text": "string",
  "amount": null           // paid のみ
}

// LiveChat ポーリング・エンベロープ(worker → 端末)
{ "messages": [], "continuation": "string|null", "timeoutMs": 1000, "ended": false }

// ScoreInput(scoring.js への入力)
{ "text": "string", "authorType": "normal", "kind": "text" }
```

正式な契約は `docs/CONTRACT.md`(`ChatMessage` / ポーリング・エンベロープ /
`ScoreInput` / `ScoreResult`)。`SYCScoring.createFallbackScorer().score()` →
`buildRenderPlan()` → `SYCDanmaku.DanmakuOverlay.push()` のホットパスは維持する。

---

## 7. ライブチャット取得フロー(InnerTube)

CF Worker が以下を中継する(クライアントには CORS 制約のため直接叩かせない)。

1. **初回**: `POST youtubei/v1/next` に `{context, videoId}` を送り、
   `conversationBar.liveChatRenderer.continuations[].continuation` を取得。
2. **ポーリング**: `POST youtubei/v1/live_chat/get_live_chat` に
   `{context, continuation}` を送る。レスポンスから:
   - `actions[].addChatItemAction.item.*` / `replaceChatItemAction.replacementItem.*`
     → コメント本体(プレースホルダ差し替えも拾う)
     - `liveChatTextMessageRenderer`(通常)
     - `liveChatPaidMessageRenderer` / `liveChatPaidStickerRenderer`(課金 → kind=paid)
     - `liveChatMembershipItemRenderer` / 各種 Sponsorships(メンバー → kind=membership)
   - `authorBadges[]` → owner / moderator / member 判定
   - 次の `continuation` と `timeoutMs`(`[250,30000]` にクランプ)→ 次ポーリング間隔
3. **終端**: 配信終了で YouTube が continuation を返さなくなったら、relay は
   `ended:true` / `continuation:null` を返す。端末はこのシグナルで停止する
   (古いトークンの無限再ポーリングを防ぐ)。
4. **濫用対策**: relay はエッジキャッシュ(`caches.default`)に URL キーで
   `s-maxage=timeoutMs` 保存。同一配信を見る N 視聴者の同一トークン・ポーリングを
   1 本の上流呼び出しに集約し、Worker IP の BAN リスクを抑える。`video`(11文字ID)/
   `cont`(長さ上限)を上流呼び出し前に検証。
5. Worker は最小整形(ChatMessage 化)のみ。**評価・重複排除・描画はクライアント。**

### 7.1 信頼性 — 2層リトライ + 適応 cadence

実測知見(2026-06-20, 実デプロイ): InnerTube は Cloudflare の egress IP からも到達でき、
ライブ動画で定常的に約1秒・高成功率(キャッシュ無効で 12〜15/15)。ただし**稀に YouTube が
リクエストを一時的にタールピット**し(数秒ハング→タイムアウト)、単発〜短い連続で失敗する。
恒常的な IP ブロックではない。これを2層で吸収する:

- **Worker 側(境界化リトライ)** — `innertubePost` は per-attempt 3.5s タイムアウト
  (fetch とボディ読取の両方をカバー)で、timeout/429/5xx のみ最大2回・ジッタ付きで再試行。
  **単発ブリップを吸収しつつ最悪レイテンシを ~7s に境界化**(ポーリング間隔内)。叩き続けない。
- **端末側(適応バックオフ, `web/chat-client.js`)** — 健全時は server の `timeoutMs`、
  失敗が続くほど**指数バックオフ(ジッタ付き・上限30s)**で間隔を伸ばし、回復で即リセット。
  持続失敗時は `videoId` から**再解決**(continuation 失効対策)。これが「自動可変」本体で、
  タールピット中の上流への負荷を下げて回復を早め、共有 egress IP にも優しい。

> 持続的な不調は端末がバックオフして負荷を下げていなす設計。Worker は単発吸収＋境界化に
> 徹し、リトライで上流を叩き続けない(それが throttling を悪化させるため)。

---

## 8. モバイル特有の実装ポイント

- **Canvas オーバーレイ**: IFrame 内部の DOM は触れない。IFrame を内包する
  ラッパ div に対し、絶対配置・`pointer-events:none` の Canvas を兄弟要素として重ねる。
  タップは IFrame(YouTube コントロール)へ素通りする。
- **DPR / 解像度**: モバイル GPU 負荷を抑えるため `renderScalePct` 既定値を下げる
  方向で調整(設定で可変)。
- **タッチ UI**: 設定は元 `options.js` のスキーマ駆動を踏襲しつつ、ボトムシート等の
  タッチ前提 UI(`ui.js`)に置換。
- **PWA**: `manifest.webmanifest` + `sw.js` でホーム画面追加・静的キャッシュ。
  チャット API はキャッシュしない(常に最新)。
- **ストレージ**: `chrome.storage` → `localStorage`(`store.js` のシムで吸収。
  `settings.js` / `filter.js` はこのシム経由に最小改変)。

---

## 9. 段階的実装ステップ

1. ✅ **CF Worker(InnerTube 中継)を実装し、実ライブで取得確認**(最大リスクの先行検証)。
   多視点レビューで堅牢化(終端シグナル・パース網羅・入力検証・非JSON分岐・エッジキャッシュ)。
   `worker/test/probe.mjs` で実機検証可。
2. ✅ **実デプロイ(`syc-livechat-relay.acofun.workers.dev`)で CF エッジ IP からの取得を確認**。
   タールピット対策の **2層リトライ + 適応 cadence** を実装・検証(§7.1)。
   端末側 `web/chat-client.js`(適応バックオフ)は実ライブ + 決定論テストで検証済み
   (`web/test/chat-client-live.mjs` / `web/test/chat-client-adaptive.mjs`)。
3. `web/` の残りを構築。`scoring.js` / `danmaku.js` を `extension/` から出発点として
   コピーし、以後モバイル最適化で分岐(§5.1)。`settings.js` / `filter.js` を
   localStorage 化。モック chat で弾幕描画を単体確認。
4. `app.js` で player + chat poll(`chat-client.js` → Worker)+ scoring + danmaku を結線。
5. タッチ UI / PWA / Wake Lock / Media Session を実装。
6. 実機(iOS Safari / Android Chrome)で確認・チューニング。
```
