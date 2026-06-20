// Thin orchestrator: wires player + chat source + scoring + danmaku + list +
// settings. All real logic lives in the small modules it composes.

import { readParams } from "./config.js";
import { makeRenderer } from "./pipeline.js";
import { makeFate, isSeek } from "./playback.js";
import { mountPlayer } from "./player.js";
import { startMock } from "./mock.js";
import { createWakeLock, setMediaSession } from "./lifecycle.js";
import { mountSettings } from "./ui.js";
import { mountPerfHud } from "./perf.js";
import { mountControls } from "./videoctl.js";
import { createCommentList } from "./commentlist.js";
import { createLiveChatClient } from "./chat-client.js";

const { createFallbackScorer, buildRenderPlan } = globalThis.SYCScoring;
const { DanmakuOverlay } = globalThis.SYCDanmaku;
const settings = globalThis.SYCSettings;
const filter = globalThis.SYCFilter;

const $ = (id) => document.getElementById(id);
const setStatus = (s) => ($("status").textContent = s);

const overlay = new DanmakuOverlay();
const list = createCommentList($("list"));
const render = makeRenderer(createFallbackScorer(), buildRenderPlan);

// Live-updated user settings (drives danmaku config + which views are visible).
let cfg = settings.DEFAULTS;
const applySettings = (s) => {
  cfg = s;
  overlay.setConfig(settings.toEngineConfig(s));
  list.setVisible(s.listEnabled);
};

// Current playback position (ms) — Infinity for live/mock (no replay gating).
let playbackMs = () => Infinity;

// --- message pipeline: gate once, fan out to danmaku (scored) + list (raw) ---
const seen = new Set();
const remember = (id) => {
  if (seen.size > 4000) seen.clear();
  seen.add(id);
};
const fate = makeFate({ seen, shouldDrop: (a, t) => filter.shouldDrop(a, t) });

const onMessages = (msgs) => {
  const now = playbackMs();
  for (const m of msgs) {
    const f = fate(m, now);
    if (f === "skip") continue; // future replay msg — revisit when playback reaches it
    remember(m.id);
    if (f !== "show") continue;
    globalThis.SYCEmoji?.preload(m.parts); // start loading member-emoji images
    if (cfg.listEnabled) list.push(m);
    if (cfg.enabled) {
      const payload = render(m); // scoring may drop low-signal comments from danmaku
      if (payload) overlay.push(payload);
    }
  }
};

// --- sources ---
const wakeLock = createWakeLock();
let stop = () => {};

const startMockMode = () => {
  overlay.attach($("stage"));
  setStatus("mock");
  const stopMock = startMock(onMessages, { ratePerSec: 30 });
  stop = () => {
    stopMock();
    overlay.detach();
    list.clear();
  };
};

const startLive = async (videoId, relay) => {
  stop();
  seen.clear();
  setStatus("loading…");
  const client = createLiveChatClient({ base: relay, getOffsetMs: () => playbackMs() });

  let playing = false;
  const player = await mountPlayer("player", videoId, (state) => {
    playing = state === "playing";
    playing ? client.resume() : client.pause();
  });
  playbackMs = () => (player.getCurrentTime?.() ?? 0) * 1000;

  // Seek detection: on a scrub, clear both views, forget shown ids, re-fetch now.
  let lastT = playbackMs();
  let lastWall = performance.now();
  const seekTimer = setInterval(() => {
    const t = playbackMs();
    const wall = performance.now();
    if (playing && isSeek(t - lastT, wall - lastWall)) {
      overlay.clear();
      list.clear();
      seen.clear();
      client.refresh();
    }
    lastT = t;
    lastWall = wall;
  }, 700);

  const onVisibility = () => (document.hidden ? client.pause() : client.resume());
  document.addEventListener("visibilitychange", onVisibility);

  overlay.attach($("stage"));
  const unmountCtl = mountControls($("stage"), player);
  wakeLock.acquire();
  setMediaSession({ title: videoId });

  client.start(videoId, {
    onMessages,
    onState: ({ healthy, failures, replay }) => {
      const mode = replay ? "replay" : "live";
      setStatus(healthy || failures < 2 ? mode : "reconnecting…");
    },
    onEnded: ({ reason }) => setStatus(reason === "ended" ? "ended" : "stopped"),
  });

  stop = () => {
    clearInterval(seekTimer);
    document.removeEventListener("visibilitychange", onVisibility);
    client.stop();
    overlay.detach();
    unmountCtl();
    list.clear();
    wakeLock.release();
    playbackMs = () => Infinity;
    player.destroy?.();
  };
};

// --- toggles: 💬 danmaku, 📋 comment list (both persist via settings) ---
const danmakuBtn = $("toggle");
const listBtn = $("listToggle");
const reflectToggles = () => {
  danmakuBtn.classList.toggle("off", !cfg.enabled);
  danmakuBtn.setAttribute("aria-pressed", String(cfg.enabled));
  listBtn.classList.toggle("off", !cfg.listEnabled);
  listBtn.setAttribute("aria-pressed", String(cfg.listEnabled));
};
danmakuBtn.addEventListener("click", () => settings.save({ ...cfg, enabled: !cfg.enabled }));
listBtn.addEventListener("click", () => settings.save({ ...cfg, listEnabled: !cfg.listEnabled }));

// --- launch form ---
$("launch").addEventListener("submit", (e) => {
  e.preventDefault();
  const { video } = readParams(`?v=${encodeURIComponent($("video").value)}`);
  if (video) startLive(video, readParams(location.search).relay);
  else setStatus("invalid video URL/ID");
});

// --- init ---
if ("serviceWorker" in navigator) {
  addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}

(async () => {
  applySettings(await settings.load());
  await filter.load();
  settings.onChange((s) => {
    applySettings(s);
    reflectToggles();
  });
  mountSettings({ settings, filter, button: $("settings") });
  reflectToggles();

  const params = readParams(location.search);
  if (params.perf) mountPerfHud(overlay);
  if (params.mock) startMockMode();
  else if (params.video) startLive(params.video, params.relay);
})();

// Exposed for tests / debugging.
globalThis.SYCApp = { overlay, list, startMockMode, startLive, stop: () => stop() };
