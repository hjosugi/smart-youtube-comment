<!-- i18n: language-switcher -->
[English](PLAN.md) | [日本語](PLAN.ja.md)

# プラン

## 現在のアーキテクチャ

`extension/` にあるデスクトップ Chrome 拡張機能は JavaScript のみです。`web/` にあるモバイル PWA は TypeScript モジュールとコピーされた古典的なブラウザスクリプトを使用しており、`worker/` にある CORS リレーは TypeScript Cloudflare Worker です。スコアリング時間はボトルネックではなく、ブラウザのレンダリング、チャットの抽出、およびリレーの耐障害性がボトルネックです。

## 現在の分割

- Claude: `extension/`
- Codex: CI/ツール、`web/`、`worker/`、および変更がエンドツーエンドの検証を必要とする場合の共有リリース自動化
- 共有: `docs/`、リリーススクリプト、パッケージスクリプト、インターフェース契約
- ローカルノート: `.private-discussion/`

## 現在のスコアリングパス

`extension/scoring.js` は以下を提供します：

- `SYCScoring.createFallbackScorer()`
- `SYCScoring.buildRenderPlan(text, result)`
- スピードティア: 高速 / 通常 / 遅い

スコアラーはコンテンツスクリプト内でローカルに実行され、ネットワーク呼び出しは行いません。

## 契約移行ノート

- リレーはYouTubeの継続トークンに含まれるパーセントエスケープを追加で一層デコードしてから検証・キャッシュ検索を行います。ポールエンベロープとクライアントのエンコード方法は同じで、クライアントの移行は不要です。
- `paidColor` は Super Chat ティアカラーのためのオプションの表示専用 `ChatMessage` / レンダーペイロードフィールドです。これがない古いメッセージは有効のままであり、`amount` は以前と同様に nullable です。
- リプレイ継続ポールは、`cont` と `offset` に加えて `replay=1` を使用します。`replay=1` なしの曖昧な `cont + offset` リクエストは 400 レスポンスを受け取ります。リプレイ `ended` はデバイス/プレイヤー所有であり、リレー所有ではありません。

## パフォーマンス作業

現在の実装のステータス：

| アイテム | ステータス | ノート |
| --- | --- | --- |
| 開発フレーム/長タスク診断 | 完了 | `danmaku.js` はフレーム p50/p95/p99、FPS、アクティブカウント、キャッシュサイズ、および長タスクカウンターを `stats()` を通じて公開します。 |
| レンダラーキュー/リングバッファホットスポット | 完了 | 保留中のコメントは `Array.shift()` の代わりに `pendingHead` 圧縮を使用し、スパーン作業はフレームごとに予算化されています。 |
| インタラクティビティガード付きの設定可能な maxActive | 完了 | `maxActive`、`maxQueue`、および `spawnPerFrame` は設定に基づいており、スパーン予算は高フレーム EMA の下にあります。 |
| プレイヤー置き換え後のチャット観察 | 部分的 | ライフサイクルとチャットクライアントテストは再接続動作をカバーしていますが、実際の YouTube DOM 置き換えは手動のスモークアイテムのままです。 |
| 公式ガイド/警告フィルタリング | 完了 | 拡張機能抽出テストは公式メッセージのフィルタリングとサニタイズされたレンダーペイロードをカバーしています。 |
| 実デバイス調整 | チェックリスト準備完了 | `docs/DEVICE_TUNING.md` は iOS/Android のスモークステップ、HUD メトリクス、および調整しきい値を定義しています。 |
| 重いレンダラー最適化 | ゲート | OffscreenCanvas/worker ラスタリゼーションは、実デバイスで最初に失敗する `docs/DEVICE_TUNING.md` パフォーマンスゲートを必要とします。 |

次のパフォーマンス作業はブラウザパスに焦点を当てるべきです：

1. 開発専用の長タスクとフレーム p95/p99 診断を追加します。
2. レンダラーの受け入れにおけるキュー/リングバッファホットスポットを修正します。
3. 動画のインタラクティビティを保護しながら、`maxActive` を 2000 まで設定可能にします。
4. iframe または `#items` 置き換え後も YouTube チャット観察を保持します。
5. danmaku から公式の YouTube ガイド/警告/推奨メッセージを除外します。

これらのコマンドを使用してください：

- `npm run security`
- `npm test`
- `npm run coverage`
- `npm run test:e2e` レンダラーのパフォーマンス用
- `npm run test:ext` 実際の Chromium 拡張機能のスモークテスト用
- `SYC_REAL_YOUTUBE_URL="https://www.youtube.com/watch?v=..." npm run test:ext:youtube`
  実際の YouTube スモークテストのオプトイン用

## スコアラー輸送ゲート

すべてが真でない限り、新しいスコアラー輸送を追加しないでください：

1. バッチまたは状態を持つスコアラーが拡張機能のホットパスの外に存在します。
2. Chrome/V8 ベンチマークが JS スコアラーに対して明確なエンドツーエンドの勝利を示します。
3. `docs/CONTRACT.md` が更新され、拡張機能が新しい形状に依存する前に行われます。
4. マニフェスト CSP とウェブアクセス可能リソースが再度レビューされます。

## リリース自動化

Chrome Web Store の更新公開は以下を通じて自動化されています：

- `scripts/chrome-webstore.mjs`
- `npm run release:store`
- `.github/workflows/chrome-webstore-release.yml`

一度限りの Chrome Web Store デベロッパーダッシュボードのセットアップは完了済みです。アイテムは `nkphcfhnfjceplpgcjccnpfdkheafohp` として公開されており、対応する `vX.Y.Z` タグがチェックを実行し、zip をビルドし、アップロードし、レビュー/公開のために提出します。

リリースごとに残る手動要素は Chrome Web Store の審査そのものなので、公開バージョンは `main` より古いことがあります。リリースワークフローが使うパブリッシャーの認証情報は有効なまま保ってください。`403` でアップロードが失敗する場合のチェックリストは `docs/RELEASE.ja.md` にあります。

## 上流機能の取り込み

参考: `ys-j/YoutubeLiveChatFlusher`（コードはコピーせず、機能のアイディアのみを独自実装）。各フェーズを独立してテスト・リリースできるように分割します。

Phase 1 — 設定・レンダラの調整（v0.2.5 で完了）:

- 種類別の表示ゲート（`showNormal` / `showMember` / `showModerator` / `showOwner` / `showPaid` / `showMembership`）。`DanmakuOverlay.push` で適用。
- 種類別の文字倍率（`scaleMember` / `scaleModerator` / `scaleOwner` / `scalePaid`）と `sizeByScore`。
- `authorName` モード（`never` / `nontext` / `always`）。
- 縁取りの `outlineColor` と `outlineBlur`（ラスタキャッシュキーに含まれる）。
- 絶対値の `lineHeight` 設定を `lineHeightScale` に置換。エンジンへは `fontPx * scale` から算出した px を渡します。
- NGワードに `mode`（`drop` / `censor` / `replace`）と `replacement` を追加（ローカルのフィルターストア）。`SYCFilter.apply()` が `{ drop, text }` を返し、設定に応じて `content.js` / `web/app.ts` が伏字・置換を行います。
- `open-options` コマンド（`Alt+Shift+O`）を `toggle-overlay` と並んで追加。

Phase 2 — 描画表現:

- 完了: `flowDirection`（`rtl` / `ltr`）と `density`（`top` / `bottom` / `random`）をエンジンの生成・レーン処理に追加。
- 完了: `maxWidthPct` でコメント幅を画面比で制限し、省略記号で切り詰め（文字数ではなくピクセル計測）。
- 完了: `layerCss` でオーバーレイ層にユーザーCSSを注入（`<style>` の `textContent`、4000文字上限）。
- 残り: 複数行の折り返し、拡張でのカスタム絵文字画像。

Phase 3 — インタラクション:

- 完了: `timeshiftMs`（web限定）でチャットリプレイの表示タイミングを前倒し/後ろ倒し。拡張はメッセージ単位の時刻が無いためPWA専用。
- 完了: 右クリックでコメントをピン留め（移動停止・時間切れなし・追い出し対象外）し、左ボタンでドラッグ移動。同じ操作で解除。`pinComments` 設定で制御し、capture フェーズで束ねるためコメントに当たったときだけ YouTube 側のハンドラを止めます。
  注意: 拡張（視聴ページの content script）では動作します。PWA では YouTube の iframe がポインタ入力を握るため、ピン留め/ドラッグには専用のキャプチャ層が必要です。
- 残り: オンデバイス翻訳（Translator API）、PiP。

マイグレーション: `lineHeight`（px）設定は読まれなくなり、保存済みの値は新しい `lineHeightScale` の既定値に正規化されます。フィルターストアに `mode` と `replacement` が加わりますが、これらを持たない古いレコードは `drop` と既定の置換文字に正規化されるため、移行作業は不要です。

## ワーカーのロードマップ

`docs/WORKER_ROADMAP.md` は WebSocket + Durable Object のシングルフライト候補を追跡します。これは、キャッシュ/フライト中の崩壊が不十分であることを証明する HTTP リレーのメトリクスにゲートされています。