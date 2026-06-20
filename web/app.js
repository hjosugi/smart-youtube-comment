// Thin orchestrator: wires player + chat source + scoring + danmaku + settings.
// All real logic lives in the small modules it composes.

import { readParams } from "./config.js";
import { makeRenderer } from "./pipeline.js";
import { mountPlayer } from "./player.js";
import { startMock } from "./mock.js";
import { createWakeLock, setMediaSession } from "./lifecycle.js";
import { mountSettings } from "./ui.js";
import { mountPerfHud } from "./perf.js";
import { createLiveChatClient } from "./chat-client.js";

const { createFallbackScorer, buildRenderPlan } = globalThis.SYCScoring;
const { DanmakuOverlay } = globalThis.SYCDanmaku;
const settings = globalThis.SYCSettings;
const filter = globalThis.SYCFilter;

const $ = (id) => document.getElementById(id);
const stage = $("stage");
const setStatus = (s) => ($("status").textContent = s);

const overlay = new DanmakuOverlay();
const render = makeRenderer(createFallbackScorer(), buildRenderPlan);

// Live-updated user settings.
let cfg = settings.DEFAULTS;
const applySettings = (s) => {
  cfg = s;
  overlay.setConfig(settings.toEngineConfig(s));
};

// Current playback position in ms — drives replay/VOD sync. Infinity for live or
// mock (no offset gating). Reset by startLive when a player is mounted.
let playbackMs = () => Infinity;

// --- message pipeline ---
// Live chat streams straight through (deduped). Replay (VOD) messages carry an
// offsetMs; we only show those within a window around the current playback, so
// they appear in sync instead of dumping the whole backlog at once.
const seen = new Set();
const remember = (id) => {
  if (seen.size > 4000) seen.clear();
  seen.add(id);
};

// "show" now, "skip" (revisit when playback reaches it), or "drop" (never).
const verdict = (m, now) => {
  if (filter.shouldDrop(m.author, m.text)) return "drop";
  if (m.offsetMs != null) {
    if (m.offsetMs > now + 1500) return "skip"; // future — don't mark seen yet
    if (m.offsetMs < now - 8000) return "drop"; // stale backlog — never show
  }
  return seen.has(m.id) ? "drop" : "show";
};

let lastNow = 0;
const onMessages = (msgs) => {
  if (!cfg.enabled) return;
  const now = playbackMs();
  if (now < lastNow - 5000) seen.clear(); // scrubbed back -> allow re-show
  lastNow = now;
  for (const m of msgs) {
    const v = verdict(m, now);
    if (v === "skip") continue;
    remember(m.id);
    if (v === "show") {
      const payload = render(m);
      if (payload) overlay.push(payload);
    }
  }
};

// --- sources ---
const wakeLock = createWakeLock();
let stop = () => {};

const startMockMode = () => {
  overlay.attach(stage);
  setStatus("mock");
  const stopMock = startMock(onMessages, { ratePerSec: 30 });
  stop = () => {
    stopMock();
    overlay.detach();
  };
};

const startLive = async (videoId, relay) => {
  stop();
  seen.clear();
  setStatus("loading…");
  const client = createLiveChatClient({ base: relay, getOffsetMs: () => playbackMs() });

  // Pause polling when not actively watching (free-tier saver). For a VOD this
  // also feeds the current playback offset back to the chat client for sync.
  const player = await mountPlayer("player", videoId, (state) =>
    state === "playing" ? client.resume() : client.pause()
  );
  playbackMs = () => (player.getCurrentTime?.() ?? 0) * 1000;

  const onVisibility = () => (document.hidden ? client.pause() : client.resume());
  document.addEventListener("visibilitychange", onVisibility);

  overlay.attach(stage);
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
    document.removeEventListener("visibilitychange", onVisibility);
    client.stop();
    overlay.detach();
    wakeLock.release();
    playbackMs = () => Infinity;
    player.destroy?.();
  };
};

// --- danmaku on/off toggle ---
const toggleBtn = $("toggle");
const reflectToggle = () => {
  toggleBtn.setAttribute("aria-pressed", String(cfg.enabled));
  toggleBtn.classList.toggle("off", !cfg.enabled);
};
toggleBtn.addEventListener("click", () => settings.save({ ...cfg, enabled: !cfg.enabled }));

// --- launch form ---
const launchFromInput = (e) => {
  e.preventDefault();
  const { video } = readParams(`?v=${encodeURIComponent($("video").value)}`);
  if (video) startLive(video, readParams(location.search).relay);
  else setStatus("invalid video URL/ID");
};
$("launch").addEventListener("submit", launchFromInput);

// --- init ---
if ("serviceWorker" in navigator) {
  addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}

(async () => {
  applySettings(await settings.load());
  await filter.load();
  settings.onChange((s) => {
    applySettings(s);
    reflectToggle();
  });
  mountSettings({ settings, filter, button: $("settings") });
  reflectToggle();

  const params = readParams(location.search);
  if (params.perf) mountPerfHud(overlay);
  if (params.mock) startMockMode();
  else if (params.video) startLive(params.video, params.relay);
})();

// Exposed for tests / debugging.
globalThis.SYCApp = { overlay, startMockMode, startLive, stop: () => stop() };
