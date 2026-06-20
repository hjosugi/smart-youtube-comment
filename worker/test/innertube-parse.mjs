// Unit test for the PURE InnerTube transforms (no network). Feeds fixture actions
// shaped like real get_live_chat responses and asserts the normalized ChatMessage
// + continuation extraction. Covers every renderer variant the relay claims.

import { _pure } from "../src/innertube.js";

const { parseAction, extractContinuation, authorTypeFromBadges } = _pure;

const checks = [];
const assert = (name, cond, extra = "") => checks.push({ name, ok: !!cond, extra });

const textRenderer = (over = {}) => ({
  addChatItemAction: {
    item: {
      liveChatTextMessageRenderer: {
        id: "t1",
        timestampUsec: "1700000000000000",
        authorName: { simpleText: "@alice" },
        message: { runs: [{ text: "hello " }, { emoji: { shortcuts: [":wave:"] } }] },
        ...over,
      },
    },
  },
});

// --- text message + emoji run reconstruction + ts conversion ---
{
  const m = parseAction(textRenderer());
  assert("text: kind/author", m.kind === "text" && m.author === "@alice");
  assert("text: emoji shortcut joined", m.text === "hello :wave:", m.text);
  assert("text: usec->ms", m.ts === 1700000000000, String(m.ts));
  assert("text: authorColor present (contract)", m.authorColor === null && "authorColor" in m);
}

// --- author badge precedence: owner > moderator > member > normal ---
{
  const badge = (iconType, custom) => ({ liveChatAuthorBadgeRenderer: iconType ? { icon: { iconType } } : { customThumbnail: custom } });
  assert("badge owner", authorTypeFromBadges([badge("OWNER"), badge("MODERATOR")]) === "owner");
  assert("badge moderator", authorTypeFromBadges([badge("MODERATOR"), badge(null, {})]) === "moderator");
  assert("badge member (customThumbnail)", authorTypeFromBadges([badge(null, {})]) === "member");
  assert("badge normal", authorTypeFromBadges([]) === "normal");
}

// --- paid: amount captured; empty text falls back to amount ---
{
  const paid = parseAction({
    addChatItemAction: {
      item: {
        liveChatPaidMessageRenderer: {
          id: "p1",
          timestampUsec: "1700000000000000",
          authorName: { simpleText: "@bob" },
          purchaseAmountText: { simpleText: "¥1,000" },
          // no message -> empty text
        },
      },
    },
  });
  assert("paid: kind=paid + amount", paid.kind === "paid" && paid.amount === "¥1,000");
  assert("paid: empty text falls back to amount", paid.text === "¥1,000", paid.text);
}

// --- super sticker (no text body) ---
{
  const s = parseAction({
    addChatItemAction: { item: { liveChatPaidStickerRenderer: { id: "s1", authorName: { simpleText: "@c" }, purchaseAmountText: { simpleText: "$5.00" } } } },
  });
  assert("sticker: paid + amount fallback text", s.kind === "paid" && s.amount === "$5.00" && s.text === "$5.00");
}

// --- membership + headerSubtext text ---
{
  const mem = parseAction({
    addChatItemAction: { item: { liveChatMembershipItemRenderer: { id: "m1", authorName: { simpleText: "@d" }, headerSubtext: { runs: [{ text: "Member for 3 months" }] } } } },
  });
  assert("membership: kind + header text", mem.kind === "membership" && mem.text === "Member for 3 months");
}

// --- sponsorship gift (text under header.primaryText) ---
{
  const gift = parseAction({
    addChatItemAction: {
      item: {
        liveChatSponsorshipsGiftPurchaseAnnouncementRenderer: {
          id: "g1",
          header: { liveChatSponsorshipsHeaderRenderer: { authorName: { simpleText: "@gifter" }, primaryText: { runs: [{ text: "gifted 5 memberships" }] } } },
        },
      },
    },
  });
  assert("gift: kind=membership + header author/text", gift.kind === "membership" && gift.author === "@gifter" && gift.text === "gifted 5 memberships");
}

// --- replaceChatItemAction unwraps the replacement renderer ---
{
  const r = parseAction({ replaceChatItemAction: { replacementItem: { liveChatTextMessageRenderer: { id: "r1", authorName: { simpleText: "@e" }, message: { runs: [{ text: "now real" }] } } } } });
  assert("replace: unwraps replacementItem", r && r.text === "now real");
}

// --- unknown / placeholder renderers drop to null ---
{
  assert("placeholder -> null", parseAction({ addChatItemAction: { item: { liveChatPlaceholderItemRenderer: { id: "x" } } } }) === null);
  assert("removal action -> null", parseAction({ markChatItemAsDeletedAction: { targetItemId: "z" } }) === null);
}

// --- continuation extraction: precedence + timeout clamp ---
{
  assert("cont: invalidation precedence", extractContinuation([{ invalidationContinuationData: { continuation: "A", timeoutMs: 5000 } }]).token === "A");
  assert("cont: timed", extractContinuation([{ timedContinuationData: { continuation: "B", timeoutMs: 3000 } }]).timeoutMs === 3000);
  assert("cont: empty -> null token", extractContinuation([]).token === null);
  assert("cont: NaN timeout clamps to default", extractContinuation([{ reloadContinuationData: { continuation: "C", timeoutMs: "x" } }]).timeoutMs === 1000);
  assert("cont: huge timeout capped", extractContinuation([{ timedContinuationData: { continuation: "D", timeoutMs: 999999 } }]).timeoutMs === 30000);
  assert("cont: tiny timeout floored to default", extractContinuation([{ timedContinuationData: { continuation: "E", timeoutMs: 10 } }]).timeoutMs === 1000);
}

// --- replay (VOD): isReplay detection + replayChatItemAction unwrapping ---
{
  const headerWith = (titles) => ({
    header: { liveChatHeaderRenderer: { viewSelector: { sortFilterSubMenuRenderer: { subMenuItems: titles.map((title) => ({ title })) } } } },
  });
  assert("isReplay: submenu 'replay' titles", _pure.isReplayChat(headerWith(["Top chat replay", "Live chat replay"])) === true);
  assert("isReplay: live submenu -> false", _pure.isReplayChat(headerWith(["Top chat", "Live chat"])) === false);
  assert("isReplay: isReplay flag", _pure.isReplayChat({ isReplay: true }) === true);

  const items = _pure.replayItems({
    replayChatItemAction: {
      videoOffsetTimeMsec: "123456",
      actions: [{ addChatItemAction: { item: { liveChatTextMessageRenderer: { id: "rp1", authorName: { simpleText: "@v" }, message: { runs: [{ text: "vod comment" }] } } } } }],
    },
  });
  assert("replay: unwraps inner action + offset", items.length === 1 && items[0].off === 123456);
  assert("replay: inner action parses", parseAction(items[0].action)?.text === "vod comment");
  assert("replay: non-replay action -> []", _pure.replayItems({ addChatItemAction: {} }).length === 0);
}

let allOk = true;
for (const c of checks) {
  console.log(`${c.ok ? "✅" : "❌"} ${c.name}${c.ok ? "" : "  -> " + c.extra}`);
  if (!c.ok) allOk = false;
}
console.log(allOk ? `\nRESULT: ✅ innertube parsing verified (${checks.length} assertions)` : "\nRESULT: ❌ FAILURES");
process.exit(allOk ? 0 : 1);
