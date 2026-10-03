(() => {
  "use strict";

  // The danmaku stage: an extension-origin frame that content.js lays over the
  // player. It runs in the extension's own renderer process, so the frame loop
  // neither drives YouTube's page lifecycle every vsync nor stalls behind
  // YouTube's long main-thread tasks (docs/PERFORMANCE.md "Stage Frame").
  // Comments arrive from content.js over postMessage; settings come straight
  // from extension storage.

  const PARENT_ORIGIN = "https://www.youtube.com";
  const { sanitizeRenderPayload } = globalThis.SYCSanitize;
  const Settings = globalThis.SYCSettings;

  const overlay = new globalThis.SYCDanmaku.DanmakuOverlay();
  globalThis.__sycOverlay = overlay; // exposed for debugging / e2e perf checks
  overlay.attach(document.getElementById("stage"));

  const post = (message) => parent.postMessage(message, PARENT_ORIGIN);

  // While the pointer is over the player, keep content.js told what is under
  // it (comments move under a still cursor), so it can decide synchronously
  // whether a right-click pins a comment or a press starts a drag.
  let hover = null;
  let hoverState = 0;
  let probe = 0;
  const reportHover = () => {
    probe = 0;
    const state = hover ? overlay.hitState(hover.x, hover.y) : 0;
    if (state !== hoverState) {
      hoverState = state;
      post({ type: "hit", state });
    }
    if (hover) probe = requestAnimationFrame(reportHover);
  };

  const point = (message) =>
    Number.isFinite(message.x) && Number.isFinite(message.y) ? { x: message.x, y: message.y } : null;

  addEventListener("message", (event) => {
    if (event.source !== parent || event.origin !== PARENT_ORIGIN) return;
    const message = event.data;
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
        overlay.start();
        break;
      case "stop":
        overlay.stop();
        break;
      case "hover":
        hover = point(message);
        if (!probe) reportHover();
        break;
      case "pin": {
        const p = point(message);
        if (p) overlay.pinAt(p.x, p.y);
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
  });

  const apply = (settings) => overlay.setConfig(Settings.toEngineConfig(settings));
  Settings.onChange(apply);
  Settings.load().then((settings) => {
    apply(settings);
    post({ type: "ready" });
  });
})();
