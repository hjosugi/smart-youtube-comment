# Claude Extension Instructions - 2026-06-17

このファイルは Claude に渡すための作業指示書です。Claude の主担当は
`extension/` です。

## まず読む

1. `AGENTS.md`
2. `docs/CONTRACT.md`
3. `docs/PERFORMANCE.md`
4. `docs/SECURITY.md`
5. このファイル

## 現在の前提

現在は `extension/scoring.js` の JS scorer だけを使います。

新しいスコアラのトランスポートを足さないでください。足す場合は、batch/stateful scorer が
Chrome/V8 実測で明確に勝つことを先に証明し、`docs/CONTRACT.md` と `docs/PLAN.md` を
更新してからにしてください。

## Claude の担当領域

主に触ってよい場所:

- `extension/`
- extension の表示・設定・YouTube DOM 読み取り・弾幕 renderer
- extension の manifest / icons / locales

慎重に扱う場所:

- `scripts/`: package/security/release に関係するため、変更時は目的を明記する
- `docs/`: 契約や運用手順を変えた場合だけ更新する

## 最優先タスク

1. カクつき計測を入れる
   - dev/debug 用だけでよいので、Long Task と frame p95/p99 を見られるようにする。
   - 収集したい値:
     `active`, `pending`, `cache`, `dropped`, `shown`, `spawned/frame`,
     `drawn/frame`, `rasterized/frame`, frame delta p50/p95/p99,
     Long Task count。

2. 2000 max に耐える renderer 最適化
   - `pending.shift()` は array 全体を詰めるので、ring buffer または head index に
     変更する。
   - `recent.shift()` も ring buffer 化する。
   - `drawImage` 座標は整数化する。
   - frame が重い時は glow/shadow を自動で切る。
   - DPR は高くしすぎない。高 DPR は bitmap と clear/draw cost を増やす。
   - 2000 件を全部なめらかに描くより、優先度 admission と adaptive quality を
     入れて動画本体を守る。

3. 数分待つとコメントが流れなくなる問題
   - YouTube live chat iframe / `#items` の再生成に追従する。
   - MutationObserver が古い node に張りっぱなしになっていないか確認する。
   - seen set / dedup / recent cache が強すぎて全ドロップになっていないか確認する。
   - YouTube 側の公式メッセージや guide message を chat message として拾わない。

4. NG word preset を削りすぎない
   - `wwwwwww`, `aaaaaaa`, `8888888`, `草草草草` のようなリアクション文字列は
     文化圏ごとの普通の反応でもあるため、starter preset からは外す。
   - ユーザーが手動で NG word に入れることはできてよい。
   - 自動 drop ではなく、過負荷時の priority/admission 側で弱く扱う程度にする。

## セキュリティ要件

extension では以下を禁止してください。

- `innerHTML`
- `outerHTML`
- `insertAdjacentHTML`
- `eval`
- `new Function`
- remote script / remote stylesheet
- 不要な remote fetch
- `data:` / `blob:` / remote origin を CSP に足すこと
- `web_accessible_resources` を空でなくすること

DOM へ出す文字列は原則 `textContent` を使ってください。YouTube のコメント本文、
作者名、動画 metadata、ページ上の文言はすべて untrusted input と扱います。

Chrome extension の permissions は最小化してください。

- permission は基本 `storage`
- host permission は `https://www.youtube.com/*`
- `web_accessible_resources` は空のまま

## Supply-chain 対策

- 依存は exact pin のみ。`^`, `~`, `*`, range は使わない。
- `package-lock.json` の integrity を維持する。
- lifecycle install script 付き dependency を追加しない。
- npm registry 以外に解決しない。
- `package.json` は private のままにする。
- Bun を使っても npm lockfile の auditability は残す。

## ローカル dev 更新手順

拡張を local dev mode で更新したら、次を行います。

1. `chrome://extensions` を開く
2. Developer mode を ON
3. この拡張の reload ボタンを押す
4. YouTube の watch/live tab を再読み込みする
5. content script が古いままなら、その tab を閉じて開き直す

manifest を変えた場合は extension reload が必要です。content script だけの変更でも、
YouTube 側の tab reload が必要です。

## 検証コマンド

変更後に最低限これを実行してください。

```sh
npm run security:bun
npm run test:sandbox:bun
npm run release:zip:bun
```

Chrome 実機では次を確認してください。

- 弾幕 toggle がシークバー付近で効く
- 弾幕 ON 中に default chat が設定どおり隠れる
- 公式の案内/警告/おすすめ文言が弾幕に混ざらない
- 数分待っても新規コメントが流れ続ける
- maxActive 2000 にしても動画操作が固まらない
- options の上限設定が保存され、reload 後も反映される

## Claude に貼る prompt

```text
この repo は /mnt/data/workspace/smart-youtube-comment です。

最初に AGENTS.md, docs/CONTRACT.md, docs/PERFORMANCE.md,
docs/CLAUDE_EXTENSION_INSTRUCTIONS.md を読んでください。

現在は JavaScript-only です。新しいスコアラのトランスポートは足さないでください。

今回の目的:
1. カクつき対策を最優先する。renderer / chat extraction / queue / Long Task を見る。
2. maxActive 2000 でも落ちにくくする。pending/recent の shift を避け、ring buffer/head index 化する。
3. 数分待つとコメントが流れなくなる問題を直す。YouTube chat iframe/#items の再生成、observer 張り替え、dedup 全ドロップを確認する。
4. 公式の案内・警告・おすすめなど、チャット欄以外の余計な公式コメントを弾幕に混ぜない。
5. 弾幕 toggle はシークバー付近に置き、options だけに依存しない。
6. 弾幕表示中は設定により default chat を開かない/隠す。
7. NG word starter preset から wwww/aaaa/8888/草草草草 系のリアクション文字列を外す。ユーザー手動登録は残してよい。

セキュリティ:
- innerHTML/outerHTML/insertAdjacentHTML/eval/new Function/remote script/remote style を使わない。
- YouTube のコメント本文・作者名・metadata はすべて untrusted input。DOM 出力は textContent/setAttribute/DOM API を使う。
- web_accessible_resources は空のままにする。
- permissions は最小のまま。storage と https://www.youtube.com/* を基本にする。
- package 依存を増やす場合は exact pin、lockfile integrity、install script なしを守る。

検証:
- npm run security:bun
- npm run test:sandbox:bun
- npm run release:zip:bun
- Chrome local dev mode で extension reload + YouTube tab reload
- busy live stream で数分確認し、maxActive 2000、toggle、default chat hide、公式コメント除外、カクつき具合を見る。
```
