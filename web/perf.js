// Optional on-device performance HUD (?perf=1). Surfaces the danmaku renderer's
// live stats so you can MEASURE whether heavier optimization (e.g. moving render
// to an OffscreenCanvas worker) is actually warranted before adding that
// complexity. Watch fps, frameP95, and longTasks under a busy stream.

export const mountPerfHud = (overlay, root = document.body) => {
  const hud = document.createElement("div");
  hud.className = "perf";
  root.append(hud);

  const tick = () => {
    const s = overlay.stats?.() ?? {};
    hud.textContent = `fps ${s.fps ?? 0} · active ${s.active ?? 0}/${s.cap ?? 0} · drop ${s.dropped ?? 0} · p95 ${s.frameP95 ?? 0}ms · long ${s.longTasks ?? 0}`;
  };

  tick();
  const id = setInterval(tick, 1000);
  return () => {
    clearInterval(id);
    hud.remove();
  };
};
