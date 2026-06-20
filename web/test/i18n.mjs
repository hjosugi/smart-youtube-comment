// i18n test. Stub navigator.language to "ja" BEFORE importing so the module
// evaluates in Japanese mode; verify localized strings + fallbacks.

Object.defineProperty(globalThis, "navigator", { value: { language: "ja-JP" }, configurable: true });
const { T, settingLabel, groupName, statusText, lang } = await import("../i18n.js");

const checks = [];
const assert = (name, cond, extra = "") => checks.push({ name, ok: !!cond, extra });

assert("ja locale detected", lang === "ja");
assert("ja: play", T.play === "再生");
assert("ja: settings", T.settings === "設定");
assert("ja: setting label by key", settingLabel("maxActive") === "最大表示数");
assert("ja: dedup label", settingLabel("dedup") === "重複を間引く");
assert("ja: group name", groupName("Performance") === "パフォーマンス");
assert("ja: status text", statusText("live") === "ライブ" && statusText("replay") === "録画");
assert("fallback: unknown setting key", settingLabel("zzz", "FALLBACK") === "FALLBACK");
assert("fallback: unknown group", groupName("Nope") === "Nope");
assert("fallback: unknown status", statusText("nope") === "nope");
assert("help present", T.help === "使い方" && Array.isArray(T.helpItems) && T.helpItems.length >= 4);
assert("help items are [title, body]", T.helpItems.every((it) => Array.isArray(it) && it.length === 2));

let allOk = true;
for (const c of checks) {
  console.log(`${c.ok ? "✅" : "❌"} ${c.name}${c.ok ? "" : "  -> " + c.extra}`);
  if (!c.ok) allOk = false;
}
console.log(allOk ? `\nRESULT: ✅ i18n verified (${checks.length} checks)` : "\nRESULT: ❌ FAILURES");
process.exit(allOk ? 0 : 1);
