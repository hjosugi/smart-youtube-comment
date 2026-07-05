(() => {
  "use strict";

  const { buildRenderPlan, createFallbackScorer } = globalThis.SYCScoring;

  // Localized UI strings (content scripts can use chrome.i18n).
  const t = (name, fallback) => chrome.i18n?.getMessage(name) || fallback;

  const seenKeys = new Set();
  const seenKeyQueue = [];
  const MAX_SEEN_KEYS = 3000;
  const MAX_TEXT_LENGTH = 500;
  const MAX_AUTHOR_LENGTH = 80;
  const VALID_KINDS = new Set(["text", "paid", "membership"]);
  const VALID_AUTHOR_TYPES = new Set(["normal", "member", "moderator", "owner"]);
  const OFFICIAL_CHAT_CONTAINER_SELECTOR = [
    "yt-live-chat-banner-renderer",
    "yt-live-chat-banner-manager",
    "yt-live-chat-viewer-engagement-message-renderer",
    "yt-live-chat-mode-change-message-renderer",
    "yt-live-chat-restricted-participation-renderer",
    "yt-live-chat-pinned-message-renderer",
    "yt-live-chat-ticker-renderer",
    "yt-live-chat-ticker-paid-message-item-renderer",
    "yt-live-chat-ticker-sponsor-item-renderer",
    "yt-live-chat-action-panel-renderer"
  ].join(",");
  const OFFICIAL_AUTHORS = new Set(["youtube", "teamyoutube"]);
  const OFFICIAL_TEXT_PATTERNS = [
    /welcome to (live )?chat/i,
    /remember to guard your privacy/i,
    /community guidelines/i,
    /チャットへようこそ/,
    /プライバシー/,
    /コミュニティ\s*ガイドライン/
  ];

  let fallbackScorer;

  function isTopFrame() {
    return window.top === window;
  }

  function safeRuntimeSend(message) {
    try {
      chrome.runtime.sendMessage(message, () => {
        void chrome.runtime.lastError;
      });
    } catch {
      // The page may outlive the extension context during reloads.
    }
  }

  function sanitizeText(value, maxLength) {
    if (typeof value !== "string") return "";
    return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
  }

  function sanitizeNumber(value, fallback, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  function sanitizeRenderPayload(payload) {
    if (!payload || typeof payload !== "object") return null;
    const text = sanitizeText(payload.text, MAX_TEXT_LENGTH);
    if (!text) return null;
    return {
      text,
      author: sanitizeText(payload.author, MAX_AUTHOR_LENGTH),
      kind: VALID_KINDS.has(payload.kind) ? payload.kind : "text",
      authorType: VALID_AUTHOR_TYPES.has(payload.authorType) ? payload.authorType : "normal",
      tier: sanitizeNumber(payload.tier, 1, 0, 2),
      durationMs: sanitizeNumber(payload.durationMs, 8500, 1000, 30000),
      score: sanitizeNumber(payload.score, 0, 0, 1),
      emphasis: sanitizeNumber(payload.emphasis, 0, 0, 1),
      reasons: Array.isArray(payload.reasons)
        ? payload.reasons.filter((reason) => typeof reason === "string").slice(0, 10)
        : [],
      createdAt: sanitizeNumber(payload.createdAt, Date.now(), 0, Date.now() + 60000)
    };
  }

  function getScorer() {
    fallbackScorer ??= createFallbackScorer();
    return fallbackScorer;
  }

  // --- Rendering (top frame): canvas-cached danmaku engine -------------------

  function findPlayer() {
    return (
      document.querySelector(".html5-video-player") ||
      document.querySelector("#movie_player") ||
      document.querySelector("video")?.parentElement ||
      document.body
    );
  }

  function ensureRuntimeStyles() {
    if (document.getElementById("syc-runtime-styles")) return;
    const style = document.createElement("style");
    style.id = "syc-runtime-styles";
    style.textContent = `
      .syc-danmaku-toggle {
        position: relative;
        display: inline-flex !important;
        align-items: center;
        justify-content: center;
        color: #fff !important;
        opacity: .92;
      }
      .syc-danmaku-toggle:hover,
      .syc-danmaku-toggle:focus-visible {
        opacity: 1;
      }
      .syc-danmaku-toggle-mark {
        display: inline-grid;
        place-items: center;
        width: 24px;
        height: 24px;
        border: 2px solid currentColor;
        border-radius: 999px;
        font: 700 15px/1 system-ui, -apple-system, "Segoe UI", sans-serif;
        text-shadow: 0 1px 2px rgba(0,0,0,.8);
      }
      .syc-danmaku-toggle[aria-pressed="false"] .syc-danmaku-toggle-mark {
        opacity: .55;
      }
      .syc-danmaku-toggle[aria-pressed="false"]::after {
        content: "";
        position: absolute;
        width: 28px;
        height: 2px;
        background: currentColor;
        transform: rotate(-38deg);
        box-shadow: 0 1px 2px rgba(0,0,0,.8);
      }
      .syc-danmaku-toggle.syc-floating {
        position: absolute !important;
        right: 78px;
        bottom: 46px;
        z-index: 2147483647;
        width: 36px;
        height: 36px;
        padding: 0;
        border: 0;
        background: rgba(0,0,0,.35);
        border-radius: 999px;
      }
      html.syc-hide-default-chat ytd-watch-flexy #chat,
      html.syc-hide-default-chat ytd-watch-flexy ytd-live-chat-frame,
      html.syc-hide-default-chat #chat-container.ytd-watch-flexy {
        position: absolute !important;
        width: 1px !important;
        min-width: 0 !important;
        height: 1px !important;
        min-height: 0 !important;
        overflow: hidden !important;
        opacity: 0 !important;
        pointer-events: none !important;
        clip-path: inset(50%) !important;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function makeBubbleIcon() {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "14");
    svg.setAttribute("height", "14");
    svg.setAttribute("fill", "currentColor");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", "M5 4h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H10l-4 3v-3H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z");
    svg.appendChild(path);
    return svg;
  }

  function createOverlayToggle(getSettings, setEnabled) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ytp-button syc-danmaku-toggle";
    const mark = document.createElement("span");
    mark.className = "syc-danmaku-toggle-mark";
    mark.setAttribute("aria-hidden", "true");
    mark.appendChild(makeBubbleIcon());
    button.appendChild(mark);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const nextEnabled = !Boolean(getSettings().enabled);
      setEnabled(nextEnabled);
    });

    const update = () => {
      const enabled = Boolean(getSettings().enabled);
      const label = enabled ? t("toggle_hide", "Hide comments") : t("toggle_show", "Show comments");
      button.setAttribute("aria-label", label);
      button.setAttribute("aria-pressed", String(enabled));
      button.title = label;
    };

    const attach = () => {
      const controls =
        document.querySelector(".ytp-right-controls") ||
        document.querySelector(".ytp-left-controls");
      if (controls) {
        button.classList.remove("syc-floating");
        if (button.parentElement !== controls) controls.insertBefore(button, controls.firstChild);
        update();
        return;
      }

      const player = findPlayer();
      if (player && player !== document.body) {
        button.classList.add("syc-floating");
        if (button.parentElement !== player) player.appendChild(button);
      }
      update();
    };

    attach();
    return { attach, update };
  }

  function applyDefaultChatSuppression(settings) {
    document.documentElement.classList.toggle(
      "syc-hide-default-chat",
      Boolean(settings.enabled && settings.hideDefaultChat)
    );
  }

  async function initRenderer() {
    const overlay = new globalThis.SYCDanmaku.DanmakuOverlay();
    globalThis.__sycOverlay = overlay; // exposed for debugging / e2e perf checks

    const Settings = globalThis.SYCSettings;
    let settings = Settings ? await Settings.load() : { enabled: true, hideDefaultChat: false };
    if (Settings) overlay.setConfig(Settings.toEngineConfig(settings));
    ensureRuntimeStyles();

    const attach = () => {
      toggle?.attach();
      applyDefaultChatSuppression(settings);
      if (!settings.enabled) return;
      const player = findPlayer();
      if (player && player !== document.body &&
          (player !== overlay.player || !overlay.canvas || !overlay.canvas.isConnected)) {
        overlay.attach(player);
      }
    };

    const applySettings = (next) => {
      const wasEnabled = settings.enabled;
      settings = next;
      overlay.setConfig(Settings ? Settings.toEngineConfig(next) : {});
      toggle?.update();
      applyDefaultChatSuppression(next);
      if (next.enabled && !wasEnabled) attach();
      else if (!next.enabled && wasEnabled) overlay.detach();
    };

    const saveSettings = async (next) => {
      applySettings(next);
      if (!Settings) return;
      try {
        await Settings.save(next);
      } catch {
        // The page may outlive the extension context during reloads.
      }
    };

    const toggle = createOverlayToggle(
      () => settings,
      (enabled) => saveSettings({ ...settings, enabled })
    );

    attach();
    window.setInterval(attach, 1500);
    window.addEventListener("yt-navigate-finish", attach);

    Settings?.onChange((next) => {
      applySettings(next);
    });

    chrome.runtime.onMessage.addListener((message) => {
      if (message?.type !== "smart-comment:render-message") return false;
      const payload = sanitizeRenderPayload(message.payload);
      if (settings.enabled && payload) overlay.push(payload);
      return false;
    });
  }

  // --- Chat extraction (all frames) -----------------------------------------

  function initChatExtractor() {
    globalThis.SYCFilter?.load();
    globalThis.SYCFilter?.onChange();
    let observer = null;
    let observedRoot = null;

    const scan = () => {
      const selectors = [
        "yt-live-chat-text-message-renderer",
        "yt-live-chat-paid-message-renderer",
        "yt-live-chat-membership-item-renderer"
      ];

      const nodes = [...document.querySelectorAll(selectors.join(","))];
      for (const node of nodes.slice(-80)) {
        processChatNode(node);
      }
    };

    const observe = () => {
      const root = findChatItemsRoot() || document.documentElement;
      // Re-attach if the chat list was replaced OR the observed node detached —
      // YouTube recreates #items after a while, which would silently stop the feed.
      if (root === observedRoot && observedRoot?.isConnected) return;
      observer?.disconnect();
      observedRoot = root;
      observer = new MutationObserver(handleMutations);
      observer.observe(root, {
        childList: true,
        characterData: true,
        subtree: true
      });
    };

    const handleMutations = (mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === "characterData") {
          const node = mutation.target.parentElement?.closest?.(MESSAGE_SELECTOR);
          if (node) processChatNode(node);
          continue;
        }
        for (const node of mutation.addedNodes) {
          if (node instanceof Element) {
            processChatNode(node);
            node
              .querySelectorAll?.("yt-live-chat-text-message-renderer, yt-live-chat-paid-message-renderer, yt-live-chat-membership-item-renderer")
              .forEach(processChatNode);
          }
        }
      }
    };

    observe();
    scan();
    window.setInterval(() => {
      observe();
      scan();
    }, 2500);
  }

  const MESSAGE_SELECTOR =
    "yt-live-chat-text-message-renderer, yt-live-chat-paid-message-renderer, yt-live-chat-membership-item-renderer";

  function findChatItemsRoot() {
    return (
      document.querySelector("yt-live-chat-item-list-renderer #items") ||
      document.querySelector("#items.yt-live-chat-item-list-renderer")
    );
  }

  async function processChatNode(node) {
    if (!isUserChatMessageNode(node)) return;

    const text = sanitizeText(extractMessageText(node), MAX_TEXT_LENGTH);
    if (!text) return;

    const author = sanitizeText(extractText(node, "#author-name"), MAX_AUTHOR_LENGTH);
    const kind = extractKind(node);
    const authorType = extractAuthorType(node);
    if (isOfficialChatText({ author, text, kind })) return;
    if (globalThis.SYCFilter?.shouldDrop(author, text)) return;
    const key = `${kind}:${authorType}:${author}:${text}`;
    if (seenKeys.has(key)) return;
    rememberKey(key);

    const scorer = getScorer();
    const result = scorer.score({ text, authorType, kind });
    const renderPlan = buildRenderPlan(text, result);
    if (!renderPlan) return;

    safeRuntimeSend({
      type: "smart-comment:chat-message",
      payload: {
        text,
        author,
        kind,
        authorType,
        tier: renderPlan.tier,
        durationMs: renderPlan.durationMs,
        score: renderPlan.score,
        emphasis: renderPlan.emphasis,
        reasons: renderPlan.reasons,
        createdAt: Date.now()
      }
    });
  }

  function rememberKey(key) {
    seenKeys.add(key);
    seenKeyQueue.push(key);
    while (seenKeyQueue.length > MAX_SEEN_KEYS) {
      seenKeys.delete(seenKeyQueue.shift());
    }
  }

  function extractKind(node) {
    if (node.matches?.("yt-live-chat-paid-message-renderer")) return "paid";
    if (node.matches?.("yt-live-chat-membership-item-renderer")) return "membership";
    return "text";
  }

  function isUserChatMessageNode(node) {
    if (!node.matches?.(MESSAGE_SELECTOR)) return false;
    if (node.closest?.(OFFICIAL_CHAT_CONTAINER_SELECTOR)) return false;
    if (node.hasAttribute?.("is-deleted") || node.hasAttribute?.("is-retracted")) return false;
    if (!node.querySelector?.("#message")) return false;
    if (!node.querySelector?.("#author-name")) return false;

    const itemList = node.closest?.("yt-live-chat-item-list-renderer #items, #items.yt-live-chat-item-list-renderer");
    if (itemList) return true;

    // Paid and membership renderers may move under specialized containers. Keep
    // them only if they still carry the normal author/message shape above.
    return node.matches?.("yt-live-chat-paid-message-renderer, yt-live-chat-membership-item-renderer");
  }

  function isOfficialChatText({ author, text, kind }) {
    const normalizedAuthor = author.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
    if (!author && kind === "text") return true;
    if (OFFICIAL_AUTHORS.has(normalizedAuthor)) return true;
    return OFFICIAL_TEXT_PATTERNS.some((pattern) => pattern.test(text));
  }

  function extractAuthorType(node) {
    const value = node.getAttribute("author-type");
    if (["owner", "moderator", "member", "normal"].includes(value)) return value;
    if (node.querySelector('[type="owner"], [aria-label*="Owner"], [aria-label*="owner"]')) return "owner";
    if (node.querySelector('[type="moderator"], [aria-label*="Moderator"], [aria-label*="moderator"]')) return "moderator";
    if (node.querySelector('[type="member"], [aria-label*="Member"], [aria-label*="member"]')) return "member";
    return "normal";
  }

  function extractMessageText(node) {
    const message = node.querySelector("#message");
    if (message) return normalizeDisplayText(extractDisplayText(message));

    const body = node.querySelector("#message-container, #content, #card");
    return normalizeDisplayText(body ? extractDisplayText(body) : "");
  }

  function extractText(node, selector) {
    return normalizeDisplayText(node.querySelector(selector)?.textContent || "");
  }

  function extractDisplayText(root) {
    const pieces = [];
    const visit = (node) => {
      if (!node) return;
      if (node.nodeType === 3) {
        pieces.push(node.textContent || "");
        return;
      }
      if (node.nodeType !== 1) return;
      const tag = String(node.localName || node.tagName || "").toLowerCase();
      if (tag === "img") {
        pieces.push(node.getAttribute?.("alt") || node.getAttribute?.("aria-label") || "");
        return;
      }
      for (const child of node.childNodes || []) visit(child);
    };
    visit(root);
    return pieces.join("");
  }

  function normalizeDisplayText(text) {
    return text.replace(/\s+/g, " ").trim();
  }

  if (globalThis.__SYC_TEST__) {
    globalThis.__SYCContentTest = {
      extractMessageText,
      extractDisplayText,
      normalizeDisplayText
    };
  }

  if (isTopFrame()) initRenderer();
  // Extraction only runs inside the live-chat iframe. A document-wide
  // MutationObserver on the heavy watch page caused jank for no benefit — there
  // are no chat nodes in the top frame.
  if (location.pathname.startsWith("/live_chat")) initChatExtractor();
})();
