(() => {
  "use strict";

  // The danmaku stage: an extension-origin frame that content.js lays over the
  // player. It runs in the extension's own renderer process, so the frame loop
  // neither drives YouTube's page lifecycle every vsync nor stalls behind
  // YouTube's long main-thread tasks (docs/PERFORMANCE.md "Stage Frame").
  // Comments arrive from content.js over a MessageChannel; settings come
  // straight from extension storage.

  const PARENT_ORIGIN = "https://www.youtube.com";
  const { sanitizeRenderPayload } = globalThis.SYCSanitize;
  const Settings = globalThis.SYCSettings;

  // Two renderers share one engine (see danmaku-dom.js): the compositor-driven
  // one is the default, the canvas one is kept for extremely dense chats. The
  // "renderer" setting picks; switching rebuilds the stage in place.
  const { DanmakuOverlay, CompositorOverlay } = globalThis.SYCDanmaku;
  const stageEl = document.getElementById("stage");
  let overlay = null;
  let renderer = "";
  let stopped = false; // content.js paused the comments with the video

  let port = null; // the channel content.js handed over (see "connect" below)
  const post = (message) => port?.postMessage(message);

  // While the pointer is over the player, keep content.js told what is under
  // it (comments move under a still cursor), so it can decide synchronously
  // whether to swallow a right-click or start a drag.
  let hover = null;
  let hoverState = 0;
  let probe = 0;
  const reportHover = () => {
    probe = 0;
    const state = hover && overlay ? overlay.hitState(hover.x, hover.y) : 0;
    if (state !== hoverState) {
      hoverState = state;
      post({ type: "hit", state });
    }
    if (hover) probe = requestAnimationFrame(reportHover);
  };

  // Right-click menu: "select" picks the comment under the cursor and holds it
  // still while content.js shows the menu; "menu" runs the chosen action.
  let selected = null;

  // Hiding a user adds them to the NG lists (channel ID, else name): the chat
  // frame then stops sending their comments, and the options page can undo it.
  const rememberHidden = async (who) => {
    const Filter = globalThis.SYCFilter;
    if (!who || !Filter) return;
    await Filter.load();
    const lists = Filter.lists;
    await Filter.save({
      ...lists,
      channels: who.channel ? [...lists.channels, who.channel] : lists.channels,
      users: who.channel ? lists.users : [...lists.users, who.author],
      mode: Filter.mode,
      replacement: Filter.replacement
    });
  };

  const point = (message) =>
    Number.isFinite(message.x) && Number.isFinite(message.y) ? { x: message.x, y: message.y } : null;

  // content.js runs in the YouTube tab. In picture-in-picture the stage's
  // parent is the PiP window, opened by that tab.
  const fromPage = (source) => source === parent || (source != null && source === parent.opener);

  const handle = (message) => {
    if (!overlay) return;
    switch (message?.type) {
      case "push": {
        const payload = sanitizeRenderPayload(message.payload);
        if (payload) overlay.push(payload);
        break;
      }
      case "clear":
        overlay.clear();
        break;
      case "start":
        stopped = false;
        overlay.start();
        break;
      case "stop":
        stopped = true;
        overlay.stop();
        break;
      case "hover":
        hover = point(message);
        if (!probe) reportHover();
        break;
      case "select": {
        if (selected?.held) overlay.setPinned(selected.sprite, false);
        const p = point(message);
        const sprite = p && overlay.pick(p.x, p.y);
        selected = sprite ? { sprite, held: !sprite.pinned } : null;
        if (sprite) overlay.setPinned(sprite, true);
        post({ type: "selected", ok: Boolean(sprite), pinned: Boolean(selected && !selected.held), author: sprite?.author || "" });
        break;
      }
      case "menu": {
        if (!selected) break;
        const { sprite, held } = selected;
        selected = null;
        if (message.action === "unpin") overlay.setPinned(sprite, false);
        else if (message.action === "hide") rememberHidden(overlay.hideAuthor(sprite)).catch(() => {});
        else if (message.action !== "pin" && held) overlay.setPinned(sprite, false); // closed: move on
        break;
      }
      case "dragStart": {
        const p = point(message);
        if (p) overlay.dragStart(p.x, p.y);
        break;
      }
      case "dragTo": {
        const p = point(message);
        if (p) overlay.dragTo(p.x, p.y);
        break;
      }
      case "dragEnd":
        overlay.dragEnd();
        break;
    }
  };

  // Any script on the YouTube page can post to this window: it shares the
  // content script's window and origin. So content.js opens a MessageChannel
  // once this document has loaded and hands over one end in a "connect"
  // message, and everything else goes over that port, which only content.js
  // holds. The first connect is the one kept; "ready" goes out once the
  // settings are applied as well.
  addEventListener("message", (event) => {
    if (port || event.data?.type !== "connect" || !event.ports[0]) return;
    if (!fromPage(event.source) || event.origin !== PARENT_ORIGIN) return;
    port = event.ports[0];
    port.onmessage = (portEvent) => handle(portEvent.data);
    if (overlay) post({ type: "ready" });
  });

  const apply = (settings) => {
    const config = Settings.toEngineConfig(settings);
    const wanted = settings.renderer === "canvas" ? "canvas" : "compositor";
    if (wanted === renderer) {
      overlay.setConfig(config);
      return;
    }
    overlay?.detach();
    selected = null;
    hoverState = 0;
    renderer = wanted;
    overlay = wanted === "canvas" ? new DanmakuOverlay(config) : new CompositorOverlay(config);
    globalThis.__sycOverlay = overlay; // exposed for debugging / e2e perf checks
    overlay.attach(stageEl);
    if (stopped) overlay.stop();
  };
  Settings.onChange(apply);
  Settings.load().then((settings) => {
    apply(settings);
    post({ type: "ready" });
  });
})();
