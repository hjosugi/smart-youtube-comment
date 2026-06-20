// Minimal i18n. Locale from navigator.language; Japanese strings provided, other
// locales fall back to the English defaults already embedded in the code/schema.

const JA = {
  play: "再生",
  settings: "設定",
  close: "閉じる",
  presets: "プリセット",
  ngFilter: "NG フィルタ",
  ngUsers: "NG ユーザー",
  ngWords: "NG ワード",
  ngSave: "NG リスト保存",
  urlPlaceholder: "YouTube URL",
  danmakuToggle: "弾幕 表示/非表示",
  listToggle: "コメント一覧 表示/非表示",
  help: "使い方",
  helpItems: [
    ["URLを入れて再生", "YouTube のライブ配信、または録画（チャットリプレイ有り）の URL/動画ID を入れて「再生」。URL の &t= で開始位置も指定できます。"],
    ["弾幕 / コメント一覧", "💬 で弾幕、📋 で動画下のコメント一覧を個別にオン/オフ。"],
    ["動画操作", "動画をタップで再生/一時停止。下のバーをドラッグでシーク。シークすると その位置のコメントを取り直します。"],
    ["設定", "⚙ で速度・文字サイズ・表示数・NG ユーザー/ワードなどを調整（自動保存）。"],
    ["メモ", "背景再生は不可（前面で視聴する前提）。非表示中はコメント取得を止めて無料枠を節約します。"],
  ],
  groups: { General: "全般", Display: "表示", Speed: "速度", Performance: "パフォーマンス", Layout: "レイアウト", Behavior: "挙動" },
  status: {
    idle: "待機",
    loading: "読み込み中…",
    live: "ライブ",
    replay: "録画",
    reconnecting: "再接続中…",
    ended: "配信終了",
    stopped: "停止",
    mock: "デモ",
    invalid: "URL/ID が不正です",
  },
  labels: {
    enabled: "弾幕（オーバーレイ）",
    listEnabled: "コメント一覧",
    hideDefaultChat: "YouTube チャットを隠す",
    opacity: "不透明度",
    fontPx: "文字サイズ",
    fontFamily: "フォント",
    textColor: "文字色",
    roleColors: "役職で色分け",
    fontWeight: "文字の太さ",
    outlineWidth: "縁取りの太さ",
    outlineOpacity: "縁取りの濃さ",
    speedPct: "スクロール速度",
    fastMs: "速い段の表示時間",
    normalMs: "普通段の表示時間",
    slowMs: "遅い段の表示時間",
    maxActive: "最大表示数",
    maxQueue: "待機キュー",
    spawnPerFrame: "1フレーム準備数",
    renderScalePct: "描画解像度",
    maxTextChars: "最大文字数",
    lineHeight: "行の高さ",
    topPct: "上の余白",
    bottomPct: "下の余白",
    lengthSpread: "長さで速度を変える",
    spreadStrength: "長さ→速度の強さ",
    dedup: "重複を間引く",
    dedupThreshold: "重複判定の厳しさ",
  },
};

const locale = (typeof navigator !== "undefined" ? navigator.language : "en") || "en";
export const lang = locale.toLowerCase().startsWith("ja") ? "ja" : "en";
const D = lang === "ja" ? JA : {};

export const T = {
  play: D.play ?? "Play",
  settings: D.settings ?? "Settings",
  close: D.close ?? "Close",
  presets: D.presets ?? "Presets",
  ngFilter: D.ngFilter ?? "NG filter",
  ngUsers: D.ngUsers ?? "NG users",
  ngWords: D.ngWords ?? "NG words",
  ngSave: D.ngSave ?? "Save NG list",
  urlPlaceholder: D.urlPlaceholder ?? "YouTube URL",
  danmakuToggle: D.danmakuToggle ?? "Toggle danmaku",
  listToggle: D.listToggle ?? "Toggle comment list",
  help: D.help ?? "Help",
  helpItems: D.helpItems ?? [
    ["Paste a URL & play", "Enter a YouTube live or VOD-with-replay-chat URL/ID and press Play. A &t= in the URL sets the start time."],
    ["Danmaku / list", "💬 toggles the flying danmaku, 📋 the comment list below the video — independently."],
    ["Player", "Tap the video to play/pause. Drag the bar to seek; seeking re-fetches chat at that position."],
    ["Settings", "⚙ adjusts speed, font size, density, NG users/words, etc. (auto-saved)."],
    ["Notes", "No background playback (foreground viewing). Polling pauses while hidden to save the free tier."],
  ],
};

export const groupName = (g) => D.groups?.[g] ?? g;
export const settingLabel = (key, fallback) => D.labels?.[key] ?? fallback;
export const statusText = (key) => D.status?.[key] ?? key;
