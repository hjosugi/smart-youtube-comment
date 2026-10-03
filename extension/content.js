(() => {
  "use strict";

  const { buildRenderPlan, createFallbackScorer } = globalThis.SYCScoring;
  const {
    MAX_TEXT_LENGTH,
    MAX_AUTHOR_LENGTH,
    sanitizeText,
    sanitizeMessageParts,
    sanitizeRenderPayload
  } = globalThis.SYCSanitize;

  // Localized UI strings (content scripts can use chrome.i18n).
  const t = (name, fallback) => chrome.i18n?.getMessage(name) || fallback;

  let processedChatNodes = new WeakSet();
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

  function ensureRuntimeStyles(doc = document) {
    if (doc.getElementById("syc-runtime-styles")) return;
    const style = doc.createElement("style");
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
        display: block;
        width: 100%;
        height: 100%;
      }
      /* YouTube's player pads its own button SVGs (8px 12px); on ours that
         padding pushed the bubble down and right of the other icons. */
      .syc-danmaku-toggle-mark svg {
        display: block;
        box-sizing: border-box;
        width: 100%;
        height: 100%;
        padding: 0 !important;
        margin: 0 !important;
        filter: drop-shadow(0 1px 2px rgba(0,0,0,.6));
      }
      .syc-danmaku-toggle[aria-pressed="false"] .syc-danmaku-toggle-bubble {
        opacity: .55;
      }
      .syc-danmaku-toggle[aria-pressed="true"] .syc-danmaku-toggle-slash {
        display: none;
      }
      .syc-danmaku-menu {
        position: absolute;
        z-index: 2147483647;
        min-width: 180px;
        max-width: 320px;
        padding: 6px 0;
        border-radius: 8px;
        background: rgba(28,28,28,.95);
        box-shadow: 0 4px 16px rgba(0,0,0,.5);
        font: 500 13px/1.4 "YouTube Sans", Roboto, Arial, sans-serif;
        color: #fff;
      }
      .syc-danmaku-menu button {
        display: block;
        width: 100%;
        padding: 8px 16px;
        border: 0;
        background: none;
        color: inherit;
        font: inherit;
        text-align: left;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        cursor: pointer;
      }
      .syc-danmaku-menu button:hover,
      .syc-danmaku-menu button:focus-visible {
        background: rgba(255,255,255,.14);
        outline: none;
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
    (doc.head || doc.documentElement).appendChild(style);
  }

  function applyLayerCss(css) {
    const text = typeof css === "string" ? css.slice(0, 4000) : "";
    let el = document.getElementById("syc-layer-css");
    if (!text) { el?.remove(); return; }
    if (!el) {
      el = document.createElement("style");
      el.id = "syc-layer-css";
      (document.head || document.documentElement).appendChild(el);
    }
    el.textContent = text;
  }

  // Player-control glyph: a speech bubble with two text lines punched out,
  // drawn at the same scale as YouTube's own 36-unit control icons so it reads
  // as "comments" next to them. Off state = dimmed bubble + a keylined slash.
  function makeBubbleIcon() {
    const ns = "http://www.w3.org/2000/svg";
    const el = (tag, attrs) => {
      const node = document.createElementNS(ns, tag);
      for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
      return node;
    };
    const svg = el("svg", { viewBox: "0 0 36 36", "aria-hidden": "true" });
    svg.appendChild(el("path", {
      class: "syc-danmaku-toggle-bubble",
      fill: "currentColor",
      "fill-rule": "evenodd",
      d: "M10 7.5h16a4 4 0 0 1 4 4v9a4 4 0 0 1-4 4H15.5L10 29.3v-4.8A4 4 0 0 1 6 20.5v-9a4 4 0 0 1 4-4Z" +
         "M11.5 12.8v2.4h13v-2.4ZM11.5 17.6v2.4h8.5v-2.4Z"
    }));
    const slash = el("g", { class: "syc-danmaku-toggle-slash", fill: "none", "stroke-linecap": "round" });
    slash.appendChild(el("path", { d: "M8 28 28 8", stroke: "rgba(0,0,0,.8)", "stroke-width": "6" }));
    slash.appendChild(el("path", { d: "M8 28 28 8", stroke: "currentColor", "stroke-width": "2.6" }));
    svg.appendChild(slash);
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
      const nextEnabled = !getSettings().enabled;
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
    return { attach, update, remove: () => button.remove() };
  }

  // Player-control glyph for picture-in-picture: a small window in a frame.
  function makePipIcon() {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 36 36");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(ns, "path");
    path.setAttribute("fill", "currentColor");
    path.setAttribute("d", "M25 17h-8v6h8zm4 8V11a2 2 0 0 0-2-2H9a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h18a2 2 0 0 0 2-2zm-2 0H9V11h18z");
    svg.appendChild(path);
    return svg;
  }

  function createPipButton(open) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ytp-button syc-pip-button";
    const label = t("pip_open", "Picture-in-picture with comments (beta)");
    button.setAttribute("aria-label", label);
    button.title = label;
    const mark = document.createElement("span");
    mark.className = "syc-danmaku-toggle-mark";
    mark.setAttribute("aria-hidden", "true");
    mark.appendChild(makePipIcon());
    button.appendChild(mark);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      open();
    });
    return {
      attach(after) {
        if (after?.parentElement && button.previousElementSibling !== after) after.after(button);
      },
      remove: () => button.remove()
    };
  }

  function applyDefaultChatSuppression(settings) {
    document.documentElement.classList.toggle(
      "syc-hide-default-chat",
      Boolean(settings.enabled && settings.hideDefaultChat)
    );
  }

  // The danmaku engine runs in stage.html, an extension-origin frame laid over
  // the player. Run from this content script, its rAF loop made YouTube's page
  // lifecycle (style, IntersectionObservers, paint) run every vsync and froze
  // whenever YouTube's own main thread did — 0.5 s chat/player tasks are
  // routine. The stage has its own process and frame clock. This side only
  // forwards comments and the player's pointer input; the stage reads settings
  // from storage itself. See docs/PERFORMANCE.md "Stage Frame".
  function createStage() {
    let frame = null;
    let player = null;
    let win = null; // the player's window: the page, or a Picture-in-Picture window
    let origin = "";
    let ready = false;
    let queue = [];
    let hit = 0; // what the stage reports under the pointer: 0 none, 1 comment, 2 pinned
    let dragging = false;
    let menu = null;
    let menuAt = null;

    const send = (message) => {
      if (!frame) return;
      if (ready) frame.contentWindow?.postMessage(message, origin);
      else if (queue.length < 200) queue.push(message);
    };
    const local = (event) => {
      const r = frame.getBoundingClientRect();
      return { x: event.clientX - r.left, y: event.clientY - r.top };
    };
    const inMenu = (event) => Boolean(menu && menu.contains(event.target));
    const stop = (event) => event.stopPropagation();

    // Right-click menu, drawn in the page (the stage takes no pointer events).
    // Built with DOM APIs and textContent only: the author name is untrusted.
    const closeMenu = (chosen) => {
      if (!menu) return;
      const doc = menu.ownerDocument;
      menu.remove();
      menu = null;
      doc.removeEventListener("pointerdown", onOutside, true);
      doc.removeEventListener("keydown", onMenuKey, true);
      if (!chosen) send({ type: "menu", action: "close" });
    };
    const onOutside = (event) => {
      if (!inMenu(event)) closeMenu(false);
    };
    const onMenuKey = (event) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      closeMenu(false);
    };
    const showMenu = (at, pinned, author) => {
      closeMenu(false);
      const doc = player.ownerDocument;
      menu = doc.createElement("div");
      menu.className = "syc-danmaku-menu";
      menu.setAttribute("role", "menu");
      const item = (label, action) => {
        const button = doc.createElement("button");
        button.type = "button";
        button.setAttribute("role", "menuitem");
        button.textContent = label;
        button.addEventListener("click", (event) => {
          event.preventDefault();
          send({ type: "menu", action });
          closeMenu(true);
        });
        menu.appendChild(button);
      };
      item(pinned ? t("menu_unpin", "Unpin") : t("menu_pin", "Pin this comment"), pinned ? "unpin" : "pin");
      if (author) {
        item(chrome.i18n?.getMessage("menu_hide_user", [author]) || `Hide comments from ${author}`, "hide");
      }
      // Keep YouTube's player from treating clicks on the menu as play/pause.
      for (const type of ["pointerdown", "mousedown", "mouseup", "click", "dblclick", "contextmenu"]) {
        menu.addEventListener(type, stop);
      }
      player.appendChild(menu);
      const x = Math.min(at.x, player.clientWidth - menu.offsetWidth - 4);
      const y = Math.min(at.y, player.clientHeight - menu.offsetHeight - 4);
      menu.style.left = `${Math.max(4, x)}px`;
      menu.style.top = `${Math.max(4, y)}px`;
      doc.addEventListener("pointerdown", onOutside, true);
      doc.addEventListener("keydown", onMenuKey, true);
      menu.querySelector("button")?.focus();
    };

    const onMessage = (event) => {
      if (!frame || event.source !== frame.contentWindow || event.origin !== origin) return;
      const data = event.data;
      if (data?.type === "ready") {
        ready = true;
        for (const message of queue) frame.contentWindow.postMessage(message, origin);
        queue = [];
      } else if (data?.type === "hit") {
        hit = data.state | 0;
      } else if (data?.type === "selected" && data.ok && menuAt) {
        showMenu(menuAt, Boolean(data.pinned), typeof data.author === "string" ? data.author.slice(0, 80) : "");
      }
    };
    const onHover = (event) => {
      if (!dragging && !inMenu(event)) send({ type: "hover", ...local(event) });
    };
    const onLeave = () => {
      hit = 0;
      send({ type: "hover" });
    };
    // Capture phase so we run before YouTube's own player handlers, and swallow
    // the event only when the stage reported a comment under the pointer. The
    // stage holds that comment still until the menu closes.
    const onContextMenu = (event) => {
      if (!hit || inMenu(event)) return;
      event.preventDefault();
      event.stopPropagation();
      menuAt = local(event);
      send({ type: "select", ...menuAt });
    };
    const onDragMove = (event) => send({ type: "dragTo", ...local(event) });
    const onDragEnd = () => {
      dragging = false;
      win?.removeEventListener("pointermove", onDragMove);
      win?.removeEventListener("pointerup", onDragEnd);
      send({ type: "dragEnd" });
    };
    const onPointerDown = (event) => {
      if (event.button !== 0 || hit !== 2 || inMenu(event)) return;
      event.preventDefault();
      event.stopPropagation();
      dragging = true;
      send({ type: "dragStart", ...local(event) });
      win.addEventListener("pointermove", onDragMove);
      win.addEventListener("pointerup", onDragEnd);
    };

    return {
      get attached() {
        return Boolean(frame?.isConnected);
      },
      get player() {
        return player;
      },
      attach(nextPlayer) {
        if (player === nextPlayer && frame?.isConnected) return;
        this.detach();
        player = nextPlayer;
        const doc = player.ownerDocument;
        win = doc.defaultView;
        if (win.getComputedStyle(player).position === "static") player.style.position = "relative";
        frame = doc.createElement("iframe");
        // Keeps the canvas's old class so user layer CSS still targets the layer.
        frame.className = "syc-danmaku-canvas";
        frame.tabIndex = -1;
        frame.setAttribute("aria-hidden", "true");
        frame.src = chrome.runtime.getURL("stage.html");
        // The src carries the per-session dynamic id; the loaded document's
        // origin is still the extension's own id.
        origin = `chrome-extension://${chrome.runtime.id}`;
        Object.assign(frame.style, {
          position: "absolute", inset: "0", width: "100%", height: "100%", border: "0",
          // A color-scheme differing from the stage document's would paint an opaque backdrop.
          colorScheme: "normal", background: "transparent",
          pointerEvents: "none", zIndex: "2147483646"
        });
        win.addEventListener("message", onMessage);
        player.addEventListener("pointermove", onHover, { passive: true });
        player.addEventListener("pointerleave", onLeave);
        player.addEventListener("contextmenu", onContextMenu, true);
        player.addEventListener("pointerdown", onPointerDown, true);
        player.appendChild(frame);
      },
      detach() {
        if (dragging) onDragEnd();
        closeMenu(true);
        win?.removeEventListener("message", onMessage);
        player?.removeEventListener("pointermove", onHover, { passive: true });
        player?.removeEventListener("pointerleave", onLeave);
        player?.removeEventListener("contextmenu", onContextMenu, true);
        player?.removeEventListener("pointerdown", onPointerDown, true);
        frame?.remove();
        frame = null;
        player = null;
        win = null;
        ready = false;
        queue = [];
        hit = 0;
        menuAt = null;
      },
      push: (payload) => send({ type: "push", payload }),
      clear: () => send({ type: "clear" }),
      start: () => send({ type: "start" }),
      stop: () => send({ type: "stop" })
    };
  }

  // Comments keep flowing while YouTube's chat is closed. Closing it unloads
  // the chat frame, so a hidden chat frame of our own stands in until the chat
  // is opened again. Its URL is the one YouTube's frame last showed (a replay
  // needs its continuation token), or, for a live stream opened with the chat
  // already closed, the live chat of this video. A replay frame follows the
  // player through the same "yt-player-video-progress" messages YouTube's page
  // sends its own chat frame.
  function createChatSource() {
    let frame = null;
    let video = null;
    let known = { id: "", url: "" };
    const watched = new WeakSet();

    const videoId = () =>
      new URL(location.href).searchParams.get("v") ||
      location.pathname.match(/^\/live\/([\w-]{11})/)?.[1] ||
      "";
    const chatShell = () => document.querySelector("ytd-live-chat-frame");
    const remember = (iframe) => {
      try {
        const href = iframe.contentWindow?.location.href || "";
        const url = new URL(href);
        if (url.origin === location.origin && /^\/live_chat(_replay)?$/.test(url.pathname)) {
          known = { id: videoId(), url: url.href };
        }
      } catch {
        // Not loaded yet, or not a chat page.
      }
    };
    const progress = () => {
      if (frame && video) frame.contentWindow?.postMessage({ "yt-player-video-progress": video.currentTime }, location.origin);
    };
    const remove = () => {
      video?.removeEventListener("timeupdate", progress);
      video = null;
      frame?.remove();
      frame = null;
    };

    return {
      update(enabled) {
        const shell = chatShell();
        const ytFrame = shell?.querySelector("iframe");
        if (ytFrame && !watched.has(ytFrame)) {
          watched.add(ytFrame);
          ytFrame.addEventListener("load", () => remember(ytFrame));
        }
        if (ytFrame) remember(ytFrame);
        const id = videoId();
        if (!enabled || !shell || !shell.hasAttribute("collapsed") || !id) {
          remove();
          return;
        }
        const url = known.id === id ? known.url : `${location.origin}/live_chat?is_popout=1&v=${encodeURIComponent(id)}`;
        if (frame?.isConnected && frame.dataset.src === url) return;
        remove();
        frame = document.createElement("iframe");
        frame.className = "syc-chat-source";
        frame.tabIndex = -1;
        frame.setAttribute("aria-hidden", "true");
        frame.dataset.src = url;
        frame.src = url;
        Object.assign(frame.style, {
          position: "fixed", left: "0", bottom: "0", width: "1px", height: "1px",
          border: "0", opacity: "0", pointerEvents: "none", zIndex: "-1"
        });
        if (/\/live_chat_replay\?/.test(url)) {
          video = document.querySelector("video");
          video?.addEventListener("timeupdate", progress);
          frame.addEventListener("load", progress);
        }
        document.body.appendChild(frame);
      },
      remove
    };
  }

  async function initRenderer() {
    const overlay = createStage();
    const chatSource = createChatSource();
    let pip = null; // { win, stage, video, parent, next } while picture-in-picture is open

    const Settings = globalThis.SYCSettings;
    let settings = Settings ? await Settings.load() : { enabled: true, hideDefaultChat: false };
    ensureRuntimeStyles();
    applyLayerCss(settings.layerCss);
    let trackedVideo = null;

    // Picture-in-picture with comments (beta). Document Picture-in-Picture moves
    // the video element itself into an always-on-top window, with a stage
    // frame over it; closing the window puts the video back where it was.
    const closePip = () => {
      if (!pip) return;
      const { video, parent, next } = pip;
      pip = null;
      if (parent?.isConnected) parent.insertBefore(video, next?.parentNode === parent ? next : null);
      overlay.detach();
      attach();
    };
    const openPip = async () => {
      /** @type {HTMLVideoElement | null} */
      const video = document.querySelector("#movie_player video") || document.querySelector("video");
      if (pip || !video || !globalThis.documentPictureInPicture) return;
      const ratio = video.videoWidth && video.videoHeight ? video.videoHeight / video.videoWidth : 9 / 16;
      const win = await globalThis.documentPictureInPicture.requestWindow({ width: 640, height: Math.round(640 * ratio) });
      const doc = win.document;
      const style = doc.createElement("style");
      // !important beats the inline sizes YouTube keeps writing onto the video.
      style.textContent = `
        html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: #000; }
        #syc-pip { position: relative; width: 100%; height: 100%; }
        #syc-pip video {
          position: absolute !important; inset: 0 !important; left: 0 !important; top: 0 !important;
          width: 100% !important; height: 100% !important; object-fit: contain !important;
        }`;
      doc.head.appendChild(style);
      ensureRuntimeStyles(doc);
      const stage = doc.createElement("div");
      stage.id = "syc-pip";
      doc.body.appendChild(stage);
      pip = { win, stage, video, parent: video.parentNode, next: video.nextSibling };
      stage.appendChild(video);
      // The window has none of YouTube's controls: a click plays or pauses.
      stage.addEventListener("click", () => (video.paused ? video.play().catch(() => {}) : video.pause()));
      win.addEventListener("pagehide", closePip, { once: true });
      if (settings.enabled) overlay.attach(stage);
    };
    let pipButton = null;

    const applyVideoPauseState = () => {
      if (!settings.enabled || !settings.pauseWithVideo || !overlay.attached) return;
      if (trackedVideo?.paused) overlay.stop();
      else overlay.start();
    };

    const bindVideoPause = () => {
      // In picture-in-picture the tracked video lives in the other window.
      const nextVideo = pip ? pip.video : document.querySelector("video");
      if (nextVideo === trackedVideo) {
        applyVideoPauseState();
        return;
      }
      trackedVideo?.removeEventListener?.("pause", applyVideoPauseState);
      trackedVideo?.removeEventListener?.("play", applyVideoPauseState);
      trackedVideo = nextVideo;
      trackedVideo?.addEventListener?.("pause", applyVideoPauseState);
      trackedVideo?.addEventListener?.("play", applyVideoPauseState);
      applyVideoPauseState();
    };

    const attach = () => {
      if (!hasLiveChatShell()) {
        toggle?.remove();
        pipButton?.remove();
        pip?.win.close();
        overlay.detach();
        chatSource.remove();
        applyDefaultChatSuppression({ ...settings, enabled: false });
        return;
      }
      if (!toggle) {
        toggle = createOverlayToggle(
          () => settings,
          (enabled) => saveSettings({ ...settings, enabled })
        );
      }
      toggle.attach();
      if (globalThis.documentPictureInPicture) {
        pipButton ??= createPipButton(() => openPip().catch(() => {}));
        pipButton.attach(document.querySelector(".syc-danmaku-toggle"));
      }
      applyDefaultChatSuppression(settings);
      observeChatShell();
      chatSource.update(settings.enabled);
      if (!settings.enabled) return;
      const player = pip ? pip.stage : findPlayer();
      if (player && player !== document.body) overlay.attach(player);
      bindVideoPause();
    };

    // Opening and closing the chat only flips an attribute on its shell.
    let chatShellObserver = null;
    let observedChatShell = null;
    const observeChatShell = () => {
      const shell = document.querySelector("ytd-live-chat-frame");
      if (shell === observedChatShell) return;
      chatShellObserver?.disconnect();
      observedChatShell = shell;
      if (!shell) return;
      chatShellObserver = new MutationObserver(() => chatSource.update(settings.enabled));
      chatShellObserver.observe(shell, { attributes: true, attributeFilter: ["collapsed"] });
    };

    const applySettings = (next) => {
      const wasEnabled = settings.enabled;
      settings = next;
      applyLayerCss(next.layerCss);
      toggle?.update();
      applyDefaultChatSuppression(next);
      if (next.enabled && !wasEnabled) attach();
      else if (!next.enabled && wasEnabled) {
        overlay.detach();
        chatSource.remove();
      }
      else if (next.enabled && next.pauseWithVideo) bindVideoPause();
      else if (next.enabled && !next.pauseWithVideo && overlay.attached) overlay.start();
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

    let toggle = null;

    let attachTimer = 0;
    const scheduleAttach = () => {
      clearTimeout(attachTimer);
      attachTimer = setTimeout(attach, 250);
    };
    // A document-wide subtree observer is expensive on YouTube's watch page,
    // which mutates constantly (player chrome, tooltips, chat). Watch only the
    // watch-flexy shell and re-target it on SPA navigation. There is deliberately
    // NO polling interval: a periodic attach() tick showed up as a ~2s jolt on
    // the render thread, and the observer + navigation events already cover
    // player/chat replacement.
    let pageObserver = null;
    let observedShell = null;
    const observeShell = () => {
      const shell = document.querySelector("ytd-watch-flexy") || document.body;
      if (!shell || shell === observedShell) return;
      pageObserver?.disconnect();
      observedShell = shell;
      pageObserver = new MutationObserver(scheduleAttach);
      pageObserver.observe(shell, { childList: true, subtree: true });
    };

    observeShell();
    attach();
    for (const event of ["yt-navigate-finish", "yt-page-data-updated", "yt-player-updated"]) {
      window.addEventListener(event, () => {
        if (event === "yt-navigate-finish") pip?.win.close();
        overlay.clear();
        observeShell();
        scheduleAttach();
      });
    }

    Settings?.onChange((next) => {
      applySettings(next);
    });

    chrome.runtime.onMessage.addListener((message) => {
      if (message?.type !== "smart-comment:render-message") return false;
      const payload = sanitizeRenderPayload(message.payload);
      if (settings.enabled && payload) pushPayload(payload);
      return false;
    });

    // On-device translation happens here (top frame), before the stage. The
    // engine keeps its raster cache keyed on text, so repeated messages reuse
    // bitmaps. translate() never throws and returns the source when unavailable.
    const pushPayload = (payload) => {
      const target = settings.translateTo;
      const T = globalThis.SYCTranslate;
      if (!target || !T?.translate) {
        overlay.push(payload);
        return;
      }
      T.translate(payload.text, target).then((text) => {
        if (!settings.enabled || !overlay.attached || settings.translateTo !== target) return;
        overlay.push(text && text !== payload.text ? { ...payload, text } : payload);
      });
    };
  }

  function hasLiveChatShell() {
    return Boolean(
      document.querySelector?.("ytd-live-chat-frame, #chat iframe[src*='live_chat'], ytd-watch-flexy #chat")
    );
  }

  // --- Chat extraction (all frames) -----------------------------------------

  function initChatExtractor() {
    const filterReady = Promise.resolve(globalThis.SYCFilter?.load?.()).catch(() => {});
    globalThis.SYCFilter?.onChange?.();
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

    const start = () => {
      observe();
      scan();
      window.setInterval(() => {
        observe();
        scan();
      }, 2500);
    };

    filterReady.then(start);
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
    if (processedChatNodes.has(node)) return;

    const rawParts = extractMessageParts(node);
    const text = sanitizeText(partsToText(rawParts) || extractMessageText(node), MAX_TEXT_LENGTH);
    if (!text) return;
    processedChatNodes.add(node);

    const author = sanitizeText(extractText(node, "#author-name"), MAX_AUTHOR_LENGTH);
    const kind = extractKind(node);
    const amount = kind === "paid" ? sanitizeText(extractAmount(node), 40) : "";
    const paidColor = kind === "paid" ? extractPaidColor(node) : null;
    const authorChannelId = extractAuthorChannelId(node);
    const authorType = extractAuthorType(node);
    if (isOfficialChatText({ author, text, kind })) return;
    const filtered = globalThis.SYCFilter?.apply
      ? globalThis.SYCFilter.apply(author, text, authorChannelId)
      : null;
    if (filtered?.drop) return;
    const shownText = filtered?.text ?? text;
    if (!shownText.trim()) return;

    // Parts are dropped when filtering rewrote the text, so a censored message is
    // not reassembled from its original emoji.
    const parts = shownText === text ? sanitizeMessageParts(rawParts) : [];

    // The scorer counts each emoji image once (not by its alt-text name).
    const scorer = getScorer();
    const result = scorer.score({ text: shownText, parts, authorType, kind });
    const renderPlan = buildRenderPlan(shownText, result);
    if (!renderPlan) return;

    safeRuntimeSend({
      type: "smart-comment:chat-message",
      payload: {
        text: shownText,
        parts,
        author,
        authorChannelId,
        kind,
        authorType,
        amount: amount || null,
        paidColor,
        tier: renderPlan.tier,
        durationMs: renderPlan.durationMs,
        score: renderPlan.score,
        emphasis: renderPlan.emphasis
      }
    });
  }

  function extractKind(node) {
    if (node.matches?.("yt-live-chat-paid-message-renderer")) return "paid";
    if (node.matches?.("yt-live-chat-membership-item-renderer")) return "membership";
    return "text";
  }

  function extractAmount(node) {
    return normalizeDisplayText(
      node.querySelector?.("#purchase-amount, #purchase-amount-column")?.textContent || ""
    );
  }

  function extractPaidColor(node) {
    const style = globalThis.getComputedStyle?.(node);
    const candidates = [
      style?.getPropertyValue?.("--yt-live-chat-paid-message-primary-color"),
      style?.getPropertyValue?.("--yt-live-chat-paid-message-secondary-color"),
      style?.backgroundColor
    ];
    for (const color of candidates) {
      const safe = globalThis.SYCSanitize?.sanitizeCssColor?.(color);
      if (safe) return safe;
    }
    return null;
  }

  function extractAuthorChannelId(node) {
    return normalizeDisplayText(
      node.getAttribute?.("author-external-channel-id") ||
      node.querySelector?.("#author-name")?.getAttribute?.("external-channel-id") ||
      ""
    );
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
    if (!author && kind === "text") return OFFICIAL_TEXT_PATTERNS.some((pattern) => pattern.test(text));
    if (OFFICIAL_AUTHORS.has(normalizedAuthor)) return true;
    return false;
  }

  function extractAuthorType(node) {
    const value = node.getAttribute("author-type");
    if (["owner", "moderator", "member", "normal"].includes(value)) return value;
    if (node.querySelector('[type="owner"]')) return "owner";
    if (node.querySelector('[type="moderator"]')) return "moderator";
    if (node.querySelector('[type="member"]')) return "member";
    return "normal";
  }

  function extractMessageText(node) {
    const message = node.querySelector("#message");
    if (message) return normalizeDisplayText(extractDisplayText(message));

    const body = node.querySelector("#message-container, #content, #card");
    return normalizeDisplayText(body ? extractDisplayText(body) : "");
  }

  // Message as render parts: text runs and custom-emoji images. Images keep
  // their `src`/`alt`; the sanitizer validates the URL before rendering.
  function extractMessageParts(node) {
    const root = node.querySelector("#message") || node.querySelector("#message-container, #content, #card");
    if (!root) return [];
    const parts = [];
    const pushText = (text) => {
      const clean = String(text || "").replace(/\s+/g, " ");
      if (!clean.trim()) return;
      const last = parts[parts.length - 1];
      if (last && last.t != null) last.t += clean;
      else parts.push({ t: clean });
    };
    const visit = (el) => {
      if (!el) return;
      if (el.nodeType === 3) {
        pushText(el.textContent);
        return;
      }
      if (el.nodeType !== 1) return;
      const tag = String(el.localName || el.tagName || "").toLowerCase();
      if (tag === "img") {
        const src = el.getAttribute?.("src") || "";
        const alt = el.getAttribute?.("alt") || el.getAttribute?.("aria-label") || "";
        if (src) parts.push({ u: src, a: alt });
        else pushText(alt);
        return;
      }
      for (const child of el.childNodes || []) visit(child);
    };
    visit(root);
    return parts;
  }

  function partsToText(parts) {
    if (!Array.isArray(parts) || !parts.length) return "";
    return parts.map((p) => (p.t != null ? p.t : p.a || "")).join("");
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
      extractMessageParts,
      partsToText,
      extractAmount,
      extractPaidColor,
      extractAuthorChannelId,
      extractDisplayText,
      normalizeDisplayText,
      hasLiveChatShell,
      extractAuthorType,
      isOfficialChatText,
      isUserChatMessageNode,
      processChatNode,
      resetProcessedNodes() {
        processedChatNodes = new WeakSet();
      },
      resetSeenKeys() {
        processedChatNodes = new WeakSet();
      }
    };
  }

  if (isTopFrame() && !location.pathname.startsWith("/live_chat")) initRenderer();
  // Extraction only runs inside the live-chat iframe. A document-wide
  // MutationObserver on the heavy watch page caused jank for no benefit — there
  // are no chat nodes in the top frame.
  if (location.pathname.startsWith("/live_chat")) initChatExtractor();
})();
