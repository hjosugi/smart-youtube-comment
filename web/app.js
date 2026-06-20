// Thin orchestrator: wires player + chat source + scoring + danmaku.
// All real logic lives in the small modules it composes.

import { readParams, mobileDanmaku } from "./config.js";
import { makeRenderer, renderBatch } from "./pipeline.js";
import { mountPlayer } from "./player.js";
import { startMock } from "./mock.js";
import { createLiveChatClient } from "./chat-client.js";

const { createFallbackScorer, buildRenderPlan } = globalThis.SYCScoring;
const { DanmakuOverlay } = globalThis.SYCDanmaku;

const stage = document.getElementById("stage");
const statusEl = document.getElementById("status");
const setStatus = (s) => statusEl && (statusEl.textContent = s);

const overlay = new DanmakuOverlay(mobileDanmaku());
const render = makeRenderer(createFallbackScorer(), buildRenderPlan);
const onMessages = (msgs) => renderBatch(render, overlay, msgs);

let stop = () => {}; // teardown for the current source (mock or live client)

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
  const player = await mountPlayer("player", videoId);
  overlay.attach(stage);
  setStatus("live");

  const client = createLiveChatClient({ base: relay });
  client.start(videoId, {
    onMessages,
    onState: ({ healthy }) => !healthy && setStatus("reconnecting…"),
    onError: () => setStatus("reconnecting…"),
    onEnded: ({ reason }) => setStatus(reason === "ended" ? "stream ended" : "stopped"),
  });
  stop = () => {
    client.stop();
    overlay.detach();
    player.destroy?.();
  };
};

// --- wiring ---
const params = readParams(location.search);
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
