// Thin orchestrator: wires player + chat source + scoring + danmaku + settings.
// All real logic lives in the small modules it composes.

import { readParams } from "./config.js";
import { makeRenderer, renderBatch } from "./pipeline.js";
import { mountPlayer } from "./player.js";
import { startMock } from "./mock.js";
import { createWakeLock, setMediaSession } from "./lifecycle.js";
import { mountSettings } from "./ui.js";
import { createLiveChatClient } from "./chat-client.js";

const { createFallbackScorer, buildRenderPlan } = globalThis.SYCScoring;
const { DanmakuOverlay } = globalThis.SYCDanmaku;
const settings = globalThis.SYCSettings;
const filter = globalThis.SYCFilter;

const stage = document.getElementById("stage");
const statusEl = document.getElementById("status");
const setStatus = (s) => statusEl && (statusEl.textContent = s);

const overlay = new DanmakuOverlay();
const render = makeRenderer(createFallbackScorer(), buildRenderPlan);

let current = settings.DEFAULTS;
const applySettings = (s) => {
  current = s;
  overlay.setConfig(settings.toEngineConfig(s));
};

// Drop NG-filtered authors/words, honor the enabled toggle, then render the batch.
const onMessages = (msgs) => {
  if (!current.enabled) return;
  renderBatch(render, overlay, msgs.filter((m) => !filter.shouldDrop(m.author, m.text)));
};

const wakeLock = createWakeLock();
let stop = () => {}; // teardown for the current source

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
  setStatus("loading player…");
  const client = createLiveChatClient({ base: relay });

  // Pause polling when not actively watching — the key free-tier request saver.
  const player = await mountPlayer("player", videoId, (state) =>
    state === "playing" ? client.resume() : client.pause()
  );
  const onVisibility = () => (document.hidden ? client.pause() : client.resume());
  document.addEventListener("visibilitychange", onVisibility);

  overlay.attach(stage);
  wakeLock.acquire();
  setMediaSession({ title: `Live · ${videoId}` });
  setStatus("live");

  client.start(videoId, {
    onMessages,
    onState: ({ healthy }) => setStatus(healthy ? "live" : "reconnecting…"),
    onError: () => setStatus("reconnecting…"),
    onEnded: ({ reason }) => setStatus(reason === "ended" ? "stream ended" : "stopped"),
  });

  stop = () => {
    document.removeEventListener("visibilitychange", onVisibility);
    client.stop();
    overlay.detach();
    wakeLock.release();
    player.destroy?.();
  };
};

// --- init + wiring ---
const params = readParams(location.search);

if ("serviceWorker" in navigator) {
  addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}

(async () => {
  applySettings(await settings.load());
  await filter.load();
  settings.onChange(applySettings);
  mountSettings({ settings, filter });
})();

const form = document.getElementById("launch");
const input = document.getElementById("video");
form?.addEventListener("submit", (e) => {
  e.preventDefault();
  const { video } = readParams(`?v=${encodeURIComponent(input.value)}`);
  if (video) startLive(video, params.relay);
  else setStatus("invalid video URL/ID");
});

if (params.mock) startMockMode();
else if (params.video) startLive(params.video, params.relay);

// Exposed for tests / debugging.
globalThis.SYCApp = { overlay, startMockMode, startLive, stop: () => stop() };
