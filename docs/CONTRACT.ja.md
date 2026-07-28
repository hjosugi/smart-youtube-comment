<!-- i18n: language-switcher -->
[English](CONTRACT.md) | [日本語](CONTRACT.ja.md)

# インターフェース契約

このファイルは、拡張機能内で使用されるメッセージおよびスコアリングの形状を文書化しています。

契約バージョン: `2`

## 所有権

- Claudeは、`extension/`（デスクトップChrome）および`web/`（モバイルPWA）内のライブチャット抽出、オーバーレイレンダリング、設定、フィルタリング、ブラウザUXを所有し、`worker/`（Cloudflare Worker）内のInnerTube CORSリレーも所有しています。
- 以下の`ChatMessage` / `ScoreInput` / `ScoreResult`の形状は、すべての表面で共有されています。モバイルの`web/`ビルドは、スコアラー/レンダラーの最適化された独自のコピーを保持することができます（`extension/`とバイト単位で同一である必要はありません）が、これらの形状を生成/消費し続ける必要があります。
- 共有される動作の変更は、ここおよび`docs/PLAN.md`に反映されなければなりません。

## 現在のトランスポート

スコアリングはJavaScript専用で、`extension/scoring.js`を通じてローカルのみで行われます。

ホットパスは次の通りです：

```text
ChatMessage -> SYCScoring.createFallbackScorer().score(ScoreInput) -> ScoreResult -> render plan
```

新しいスコアラーのトランスポートを追加しないでください。測定されたChrome/V8の利点があり、両側がそれに依存する前に契約が更新される必要があります。

## ChatMessage

ライブチャットリーダーによって生成され、オーバーレイレンダラーによって消費されます。

```jsonc
{
  "id": "string",
  "ts": 0,
  "kind": "text",          // "text" | "paid" | "membership"
  "author": "string",
  "authorType": "normal",  // "normal" | "member" | "moderator" | "owner"
  "authorColor": null,
  "text": "string",
  "parts": [
    { "t": "plain text" },
    { "u": "https://yt3.ggpht.com/custom-emoji=s24", "a": ":emoji:" }
  ],
  "amount": null,
  "paidColor": null,      // オプション "#rrggbb" スーパーチャットティアカラー
  "offsetMs": 0            // リプレイ/VODのみ: メッセージのビデオタイムスタンプ（ライブの場合は省略）
}
```

`parts[].u`は信頼できないリレーデータです。Web消費者は、`img.src`に割り当てる前にそれを検証する必要があります。受け入れられる画像ソースは、`yt3.ggpht.com`または`googleusercontent.com`のサブドメインからのHTTPS YouTube絵文字アセット、およびローカルモックデータで使用されるラスターデータ`data:image/...`のURLです。安全でない画像部分は、利用可能な場合はその代替テキストにフォールバックするか、無視されるべきです。

## LiveChatポールエンベロープ

`worker/`リレーは、各ポールでデバイスにこのエンベロープを返します。デバイスは`messages`をスコアラーに供給し、`continuation` / `timeoutMs`を使用して次のポールを駆動します。

```jsonc
{
  "messages": [],          // ChatMessage[]
  "continuation": "string",// 次のポールのためのトークン、または終了時はnull
  "timeoutMs": 1000,       // デバイスは次のポールまでこの時間待機する必要があります
  "ended": false,          // true => ストリーム/チャットは終了; ポーリングを停止
  "isReplay": false        // true => VODリプレイチャット（以下を参照）
}
```

端末信号: ストリームが終了するとYouTubeは継続トークンの発行を停止するため、リレーは`ended: true`および`continuation: null`を設定します。この信号でデバイスはポーリングを停止しなければなりません（前のトークンを再ポーリングしないでください — それは無効です）。

リプレイ（VOD）モード: ビデオが過去のライブ録画である場合、リレーは`isReplay: true`を報告します。デバイスは次に`GET /api/livechat?cont=<token>&offset=<ms>&replay=1`をポーリングします。ここで`offset`は現在のプレイヤー位置です。各リプレイメッセージは`offsetMs`（そのビデオタイムスタンプ）を持ちます。明示的な`replay=1`フラグは、リプレイ継続ポールをライブ継続ポールから区別します。古い`cont + offset`リクエストは`replay=1`なしで拒否され、`400 { "error": "offset requires replay=1" }`が返されます。

同じリプレイ継続が再利用されます — リプレイはオフセットによってシークされ、進行しません。デバイスは再生の周りのウィンドウにメッセージを制限します。リプレイエンベロープは`ended: false`を保持します。埋め込まれたプレイヤーが、リレーではなくVOD端末状態の権威です。なぜなら、リプレイエンドポイントは任意のプレイヤーオフセットによってクエリ可能だからです。

`timeoutMs`はリレーによって`[250, 30000]`に制限されます。デバイスは独自の追加のフロアを適用することができます。

## ScoreInput

JSスコアラーへの入力。

```jsonc
{
  "text": "string",
  "authorType": "normal",  // "normal" | "member" | "moderator" | "owner"
  "kind": "text"           // "text" | "paid" | "membership"
}
```

## ScoreResult

スコアラーからの出力。数値は`[0.0, 1.0]`の範囲です。

```jsonc
{
  "quality": 0.5,
  "spam": 0.0,
  "toxicity": 0.0,
  "emphasis": 0.0,
  "show": true,
  "reasons": []
}
```

デフォルトの助言判決：

```jsonc
{
  "minQuality": 0.15,
  "maxSpam": 0.85,
  "maxToxicity": 0.90
}
```

`show`は次のように等しいべきです：

```text
quality >= minQuality && spam <= maxSpam && toxicity <= maxToxicity
```

拡張機能は、これをライブユーザー設定に対して再確認することができます。

## レンダープラン

`SYCScoring.buildRenderPlan(text, result)`は、`ScoreResult`をレンダラーのスピードペイロードにマッピングします：

```jsonc
{
  "tier": 1,          // 0=速い, 1=普通, 2=遅い
  "durationMs": 6000,
  "score": 0.5,
  "emphasis": 0.0,
  "reasons": []
}
```

有料メッセージのレンダーペイロードは、追加で`amount`および`paidColor`を持つことがあります。これらのフィールドは表示専用のメタデータです：`amount`はスーパーチャット通貨テキストをラベル付けし、`paidColor`はオプションのサニタイズされた`#rrggbb`ティアカラーです。これらはスコアラーの`tier`値に影響を与えません。

## 理由タグ

理由タグは安定したケバブケースの文字列です。既存のタグは名前を変更しないでください。

現在のタグ：

- `fallback-fast`