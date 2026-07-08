import { clamp } from "./math.js";
import { AUTHOR_ROLE_COLORS } from "./theme.js";

(() => {
  "use strict";

  // Canvas-cached danmaku renderer. Each unique comment is rasterized to an
  // offscreen canvas ONCE, then blitted with drawImage every frame — that is the
  // difference between ~300 concurrent (DOM) and 1000–2000 concurrent (here).
  //
  // Overload handling (the "過負荷" requirement):
  //   * hard cap (maxActive) — never let the active set grow unbounded
  //   * adaptive cap — if frames run long, lower the cap; recover when fast
  //   * priority admission — at the cap, a high-value comment evicts the lowest
  //     value one; a low-value comment is dropped instead of melting the frame
  //   * near-duplicate drop — keep variety (serves communication quality)

  const SYCScoring = globalThis.SYCScoring ?? {};
  const signatureDistance = SYCScoring.signatureDistance;
  const textSignature = SYCScoring.textSignature;

  const DEFAULTS = {
    maxActive: 250,       // hard ceiling on concurrent sprites
    minActive: 80,        // adaptive floor (weak machines still usable)
    fontPx: 18,
    lineHeight: 24,       // lane height incl. gap
    topPct: 0.08,         // keep top 8% clear
    bottomPct: 0.14,      // keep bottom 14% clear (controls)
    gapPx: 28,            // min horizontal gap between same-lane comments
    dedup: true,          // drop near-duplicates of recently shown comments
    simThreshold: 3,      // Hamming distance <= this => near-duplicate
    recentMax: 400,
    lengthSpread: true,   // gently widen scorer timing by length
    durationScale: 1,     // user speed multiplier (0.5=2x faster .. 2=2x slower)
    tierDurations: [6000, 7500, 10000],
    opacity: 1,           // global comment opacity (0.2–1.0)
    textColor: "#ffffff", // base comment color for normal authors
    roleColors: true,     // owner/mod/member use role colors; else textColor
    fontFamily: "",       // "" => system default stack
    fontWeight: 700,      // 100..900
    outlineWidth: 3,      // text outline px (0 = none)
    outlineAlpha: 0.85,   // outline opacity 0..1
    spreadStrength: 0.35, // how strongly length affects speed (0..1)
    cacheMax: 900,        // max cached bitmaps
    maxQueue: 1000,       // pending comments waiting for rasterization
    spawnPerFrame: 6,     // cap expensive canvas text rasterization per frame
    maxTextChars: 260,    // prevent giant one-off bitmaps from stalling video
    dpr: Math.max(0.5, Math.min(2, (self.devicePixelRatio || 1) * 0.6))
  };

  const RASTER_CONFIG_KEYS = [
    "dpr",
    "fontPx",
    "fontFamily",
    "fontWeight",
    "outlineWidth",
    "outlineAlpha",
    "lineHeight",
    "textColor",
    "roleColors"
  ];
  const GEOMETRY_CONFIG_KEYS = ["dpr", "lineHeight", "topPct", "bottomPct"];

  const AUTHOR_BOOST = { owner: 0.40, moderator: 0.25, member: 0.10, normal: 0 };
  const TARGET_FRAME_MS = 1000 / 60;
  const MIN_CAP_FRAME_MS = 50;
  const DEDUP_BUCKET_BITS = 8;
  const DEDUP_BUCKET_MASKS = Array.from({ length: DEDUP_BUCKET_BITS + 1 }, (_, threshold) => {
    const masks = [];
    for (let mask = 0; mask < (1 << DEDUP_BUCKET_BITS); mask++) {
      if (popCount(mask) <= threshold) masks.push(mask);
    }
    return masks;
  });

  function popCount(value) {
    let count = 0;
    for (let n = value; n; n &= n - 1) count++;
    return count;
  }

  function signatureBucket(sig) {
    return (sig >>> (32 - DEDUP_BUCKET_BITS)) & ((1 << DEDUP_BUCKET_BITS) - 1);
  }

  function truncateText(text, maxChars) {
    const chars = [...String(text || "")];
    if (chars.length <= maxChars) return text;
    return `${chars.slice(0, Math.max(1, maxChars - 3)).join("")}...`;
  }

  class DanmakuOverlay {
    constructor(cfg) {
      this.cfg = Object.assign({}, DEFAULTS, cfg);
      this.active = [];
      this.nextActive = [];
      this.activeMinHeap = [];
      this.nextSpriteId = 1;
      this.pending = [];
      this.pendingHead = 0;     // ring head index — avoids O(n) Array.shift()
      this.lanes = [];          // per-lane "free at" timestamps
      this.cache = new Map();   // text -> rasterized bitmap
      this.recent = new Int32Array(this.cfg.recentMax); // dedup signatures (ring)
      this.recentBuckets = new Uint8Array(this.cfg.recentMax);
      this.recentBucketMap = new Map();
      this.recentLen = 0;
      this.recentPos = 0;
      this.player = null;
      this.canvas = null;
      this.ctx = null;
      this.measure = null;
      this.raf = 0;
      this.running = false;
      this.lastTs = 0;
      this.frameEMA = 16;
      this.dynamicCap = this.cfg.maxActive;
      this.dropped = 0;
      this.shown = 0;
      this.queued = 0;
      this._ro = null;
      // --- dev/debug jank metrics ---
      this._drawn = 0;
      this.longTasks = 0;
      this.frameSamples = new Float64Array(180); // recent frame deltas (p50/p95/p99)
      this.frameSampleLen = 0;
      this.frameSamplePos = 0;
      this._lto = null;
      this._loop = this._loop.bind(this);
      this.w = 1; this.h = 1; this.laneCount = 1; this.laneTop = 0; this.laneH = this.cfg.lineHeight;
    }

    attach(player) {
      if (!player || (this.player === player && this.canvas && this.canvas.isConnected)) return;
      this.detach();
      this.player = player;
      if (getComputedStyle(player).position === "static") player.style.position = "relative";
      const c = document.createElement("canvas");
      c.className = "syc-danmaku-canvas";
      Object.assign(c.style, {
        position: "absolute", inset: "0", width: "100%", height: "100%",
        pointerEvents: "none", zIndex: "2147483646"
      });
      player.appendChild(c);
      this.canvas = c;
      this.ctx = c.getContext("2d", { alpha: true, desynchronized: true });
      this._resize();
      this._ro = new ResizeObserver(() => this._resize());
      this._ro.observe(player);
      this._startLongTaskObserver();
      this.start();
    }

    detach() {
      this.stop();
      this._stopLongTaskObserver();
      this._ro?.disconnect();
      this._ro = null;
      this.canvas?.remove();
      this.canvas = null; this.ctx = null;
      this.active.length = 0;
      this.nextActive.length = 0;
      this.activeMinHeap.length = 0;
      this.pending.length = 0;
      this.pendingHead = 0;
      this.recentLen = 0;
      this.recentPos = 0;
      this.recentBucketMap.clear();
      this.player = null;
    }

    _startLongTaskObserver() {
      if (this._lto) return;
      try {
        this._lto = new PerformanceObserver((list) => { this.longTasks += list.getEntries().length; });
        this._lto.observe({ entryTypes: ["longtask"] });
      } catch { this._lto = null; }
    }

    _stopLongTaskObserver() {
      this._lto?.disconnect?.();
      this._lto = null;
    }

    // Drop all on-screen + pending comments (used on seek). Keeps the canvas.
    clear() {
      this.active.length = 0;
      this.nextActive.length = 0;
      this.activeMinHeap.length = 0;
      this.pending.length = 0;
      this.pendingHead = 0;
      this.recentLen = 0;
      this.recentPos = 0;
      this.recentBucketMap.clear();
    }

    setConfig(partial) {
      const shouldClearRasterCache = RASTER_CONFIG_KEYS.some((key) =>
        partial[key] != null && partial[key] !== this.cfg[key]
      );
      const shouldResize = GEOMETRY_CONFIG_KEYS.some((key) =>
        partial[key] != null && partial[key] !== this.cfg[key]
      );
      Object.assign(this.cfg, partial);
      if (shouldClearRasterCache) this.cache.clear();
      if (partial.maxActive != null || partial.minActive != null) this._updateDynamicCap();
      if (this.canvas && shouldResize) this._resize();
    }

    _updateDynamicCap() {
      const max = Math.max(0, Math.floor(this.cfg.maxActive));
      const min = Math.floor(clamp(0, max, this.cfg.minActive));
      const load = clamp(0, 1, (this.frameEMA - TARGET_FRAME_MS) / (MIN_CAP_FRAME_MS - TARGET_FRAME_MS));
      this.dynamicCap = Math.round(max - (max - min) * load);
    }

    stats() {
      const sorted = Array.prototype.slice.call(this.frameSamples, 0, this.frameSampleLen).sort((a, b) => a - b);
      const pct = (p) => (sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] * 10) / 10 : 0);
      return {
        active: this.active.length, cap: this.dynamicCap, dropped: this.dropped,
        shown: this.shown, queued: this.pending.length - this.pendingHead,
        fps: Math.round(1000 / this.frameEMA), cache: this.cache.size,
        drawn: this._drawn, longTasks: this.longTasks,
        frameP50: pct(0.50), frameP95: pct(0.95), frameP99: pct(0.99)
      };
    }

    _resize() {
      if (!this.player || !this.canvas) return;
      const r = this.player.getBoundingClientRect();
      this.w = Math.max(1, Math.round(r.width));
      this.h = Math.max(1, Math.round(r.height));
      const dpr = this.cfg.dpr;
      this.canvas.width = Math.round(this.w * dpr);
      this.canvas.height = Math.round(this.h * dpr);
      const usable = this.h * (1 - this.cfg.topPct - this.cfg.bottomPct);
      this.laneH = this.cfg.lineHeight;
      this.laneCount = Math.max(3, Math.floor(usable / this.laneH));
      this.laneTop = this.h * this.cfg.topPct;
      this.lanes = new Array(this.laneCount).fill(0);
    }

    start() { if (this.running) return; this.running = true; this.lastTs = 0; this.raf = requestAnimationFrame(this._loop); }
    stop() { this.running = false; cancelAnimationFrame(this.raf); }

    // Admission control + spawn. Returns true if the comment was accepted.
    push(payload) {
      if (!this.canvas || !payload || !payload.text) return false;
      const text = truncateText(payload.text, this.cfg.maxTextChars);
      const safePayload = text === payload.text ? payload : Object.assign({}, payload, { text });

      if (this.cfg.dedup && textSignature && signatureDistance) {
        const sig = textSignature(safePayload.text) | 0;
        const th = this.cfg.simThreshold;
        if (this._hasRecentSimilar(sig, th)) { this.dropped++; return false; }
        this._rememberSignature(sig);
      }

      const priority = this._priority(safePayload);

      if (this.pending.length - this.pendingHead >= this.cfg.maxQueue) {
        let mi = -1, mp = Infinity;
        for (let i = this.pendingHead; i < this.pending.length; i++) {
          if (this.pending[i].priority < mp) { mp = this.pending[i].priority; mi = i; }
        }
        if (mi >= 0 && priority > mp) this._swapRemove(this.pending, mi);
        else { this.dropped++; return false; }
      }

      this.pending.push({ payload: safePayload, priority });
      this.queued++;
      return true;
    }

    _hasRecentSimilar(sig, threshold) {
      const bucket = signatureBucket(sig);
      const masks = DEDUP_BUCKET_MASKS[Math.min(DEDUP_BUCKET_BITS, Math.max(0, threshold | 0))];
      for (const mask of masks) {
        const set = this.recentBucketMap.get(bucket ^ mask);
        if (!set) continue;
        for (const pos of set) {
          if (pos < this.recentLen && signatureDistance(sig, this.recent[pos]) <= threshold) return true;
        }
      }
      return false;
    }

    _rememberSignature(sig) {
      const pos = this.recentPos;
      if (this.recentLen === this.recent.length) {
        const oldBucket = this.recentBuckets[pos];
        const oldSet = this.recentBucketMap.get(oldBucket);
        oldSet?.delete(pos);
        if (oldSet?.size === 0) this.recentBucketMap.delete(oldBucket);
      }
      const bucket = signatureBucket(sig);
      this.recent[pos] = sig;
      this.recentBuckets[pos] = bucket;
      let set = this.recentBucketMap.get(bucket);
      if (!set) {
        set = new Set();
        this.recentBucketMap.set(bucket, set);
      }
      set.add(pos);
      this.recentPos = (pos + 1) % this.recent.length;
      if (this.recentLen < this.recent.length) this.recentLen++;
    }

    _priority(payload) {
      return (
        (payload.emphasis ?? 0) * 0.55 +
        (payload.score ?? 0) * 0.30 +
        (AUTHOR_BOOST[payload.authorType] ?? 0) +
        (payload.kind === "paid" ? 0.5 : 0)
      );
    }

    _drainPending() {
      if (this.pendingHead >= this.pending.length) { this._compactPending(); return; }
      let budget = this.cfg.spawnPerFrame;
      if (this.frameEMA > 28) budget = Math.max(1, Math.ceil(budget / 3));
      else if (this.frameEMA > 20) budget = Math.max(1, Math.ceil(budget / 2));

      while (budget > 0 && this.pendingHead < this.pending.length) {
        const next = this.pending[this.pendingHead++];
        if (this._spawn(next.payload, next.priority)) this.shown++;
        budget--;
      }
      this._compactPending();
    }

    _compactPending() {
      if (this.pendingHead === 0) return;
      if (this.pendingHead >= this.pending.length) { this.pending.length = 0; this.pendingHead = 0; return; }
      // Reclaim the consumed prefix once it dominates the array.
      if (this.pendingHead > 256 && this.pendingHead * 2 >= this.pending.length) {
        this.pending = this.pending.slice(this.pendingHead);
        this.pendingHead = 0;
      }
    }

    _spawn(payload, priority) {
      if (this.active.length >= this.dynamicCap) {
        const weakest = this._peekActiveMin();
        if (weakest && priority > weakest.priority) this._removeActive(weakest); // evict weakest
        else { this.dropped++; return false; }                  // drop incoming
      }

      const emphasis = payload.emphasis ?? 0;
      const scale = emphasis >= 0.62 ? 1.12 : emphasis <= 0.18 ? 0.9 : 1.0;
      const fontPx = Math.round(this.cfg.fontPx * scale);
      const color = (this.cfg.roleColors && payload.authorType && payload.authorType !== "normal")
        ? (AUTHOR_ROLE_COLORS[payload.authorType] ?? this.cfg.textColor)
        : this.cfg.textColor;
      const paidColor = payload.kind === "paid" && payload.paidColor ? payload.paidColor : "";
      const msgParts = this._displayParts(payload);
      const parts = (
        payload.author && payload.kind && payload.kind !== "text"
          ? [{ t: `${payload.author}: ` }, ...msgParts]
          : msgParts
      ).slice(0, 60);
      const glow = emphasis >= 0.62 && this.frameEMA < 24; // skip glow when frames are heavy
      const bmp = this._rasterize(parts, paidColor || color, fontPx, glow);

      const td = this.cfg.tierDurations;
      const baseMs = (td && td[payload.tier] != null) ? td[payload.tier] : (payload.durationMs || 8000);
      let dur = baseMs * (this.cfg.durationScale || 1);
      if (this.cfg.lengthSpread) {
        const len = [...payload.text].length;
        const raw = clamp(0.8, 1.45, 0.82 + len / 110);
        dur *= 1 + (raw - 1) * (this.cfg.spreadStrength ?? 0.5); // scale length->speed coupling
      }

      const now = performance.now();
      const lane = this._pickLane(now);
      const startX = this.w;
      const dist = startX + bmp.w + this.cfg.gapPx;
      const vx = dist / dur; // px per ms (long text => larger dist => already slower via dur)
      this.lanes[lane] = now + (bmp.w + this.cfg.gapPx) / vx; // lane reusable after tail clears entry

      const entry = {
        bmp: bmp.bmp, w: bmp.w, h: bmp.h,
        x: startX, y: this.laneTop + lane * this.laneH + this.laneH / 2,
        vx, ttlMs: dur + 600, priority,
        id: this.nextSpriteId++,
        index: this.active.length,
        active: true
      };
      this.active.push(entry);
      this._heapPush(entry);
      return true;
    }

    _removeActive(entry) {
      if (!entry?.active) return;
      entry.active = false;
      const index = this.active[entry.index] === entry ? entry.index : this.active.indexOf(entry);
      if (index >= 0) this._swapRemoveActive(index);
    }

    _swapRemoveActive(index) {
      const last = this.active.length - 1;
      const removed = this.active[index];
      removed.active = false;
      if (index !== last) {
        const moved = this.active[last];
        this.active[index] = moved;
        moved.index = index;
      }
      this.active.pop();
    }

    _peekActiveMin() {
      const heap = this.activeMinHeap;
      while (heap.length && !heap[0].active) this._heapPop();
      return heap[0] || null;
    }

    _heapPush(entry) {
      const heap = this.activeMinHeap;
      heap.push(entry);
      let index = heap.length - 1;
      while (index > 0) {
        const parent = (index - 1) >> 1;
        if (this._heapLess(heap[parent], entry)) break;
        heap[index] = heap[parent];
        index = parent;
      }
      heap[index] = entry;
    }

    _heapPop() {
      const heap = this.activeMinHeap;
      const root = heap[0];
      const last = heap.pop();
      if (heap.length && last) {
        heap[0] = last;
        this._heapDown(0);
      }
      return root;
    }

    _heapDown(index) {
      const heap = this.activeMinHeap;
      const item = heap[index];
      for (;;) {
        let child = index * 2 + 1;
        if (child >= heap.length) break;
        const right = child + 1;
        if (right < heap.length && this._heapLess(heap[right], heap[child])) child = right;
        if (this._heapLess(item, heap[child])) break;
        heap[index] = heap[child];
        index = child;
      }
      heap[index] = item;
    }

    _heapLess(a, b) {
      return a.priority < b.priority || (a.priority === b.priority && a.id < b.id);
    }

    _displayParts(payload) {
      const parts = payload.parts && payload.parts.length ? payload.parts : [{ t: payload.text }];
      const amount = payload.kind === "paid" ? (payload.amount || "") : "";
      if (!amount || String(payload.text || "").trim() === amount.trim()) return parts;
      return [{ t: `${amount} ` }, ...parts];
    }

    _swapRemove(arr, index) {
      const last = arr.length - 1;
      if (index !== last) arr[index] = arr[last];
      arr.pop();
    }

    _pickLane(now) {
      // Prefer a lane that is already clear; otherwise the one that frees soonest.
      let best = 0, bestFree = Infinity;
      for (let i = 0; i < this.laneCount; i++) {
        const f = this.lanes[i];
        if (f <= now) return i;
        if (f < bestFree) { bestFree = f; best = i; }
      }
      return best;
    }

    // parts: [{ t: text } | { u: emojiUrl }]. Text is drawn with outline/glow;
    // custom-emoji parts are drawn as images. A bitmap referencing an emoji image
    // that has not loaded yet is NOT cached, so it re-rasterizes (with the image)
    // next time the same comment appears.
    _rasterize(parts, color, fontPx, glow) {
      const family = this.cfg.fontFamily || 'system-ui, -apple-system, "Segoe UI", sans-serif';
      const weight = this.cfg.fontWeight || 700;
      const ow = this.cfg.outlineWidth ?? 3;
      const oa = this.cfg.outlineAlpha ?? 0.85;
      const sig = parts.map((p) => (p.u ? "" + p.u : p.t)).join("");
      const key = `${fontPx}|${weight}|${ow}|${oa}|${glow ? 1 : 0}|${color}|${family}|${sig}`;
      const hit = this._cacheGet(key);
      if (hit) return hit;

      const font = `${weight} ${fontPx}px ${family}`;
      if (!this.measure) this.measure = document.createElement("canvas").getContext("2d");
      this.measure.font = font;
      const pad = (glow ? 10 : 6) + Math.ceil(ow / 2);
      const h = Math.max(this.cfg.lineHeight, fontPx + 8);
      const emojiSize = Math.round(fontPx * 1.15);
      const emoji = globalThis.SYCEmoji;

      // Measure each segment; track whether every emoji image is ready.
      let allReady = true;
      let w = 0;
      const segs = parts.map((p) => {
        if (p.u) {
          const img = emoji ? emoji.get(p.u) : null;
          const ready = !!(img && img.complete && img.naturalWidth);
          if (!ready) allReady = false;
          return { img: ready ? img : null, w: emojiSize + 2 };
        }
        return { text: p.t, w: this.measure.measureText(p.t).width };
      });
      for (const s of segs) w += s.w;
      w = Math.ceil(w) + pad * 2;

      const dpr = this.cfg.dpr;
      const oc = document.createElement("canvas");
      oc.width = Math.max(1, Math.ceil(w * dpr));
      oc.height = Math.ceil(h * dpr);
      const o = oc.getContext("2d");
      o.scale(dpr, dpr);
      o.font = font;
      o.textBaseline = "middle";
      o.lineJoin = "round";

      let x = pad;
      for (const s of segs) {
        if (s.text != null) {
          if (ow > 0) {
            o.shadowBlur = 0;
            o.lineWidth = ow;
            o.strokeStyle = `rgba(0,0,0,${oa})`;
            o.strokeText(s.text, x, h / 2);
          }
          if (glow) { o.shadowColor = "rgba(255,255,255,.55)"; o.shadowBlur = 6; } else o.shadowBlur = 0;
          o.fillStyle = color;
          o.fillText(s.text, x, h / 2);
        } else if (s.img) {
          o.shadowBlur = 0;
          o.drawImage(s.img, x, h / 2 - emojiSize / 2, emojiSize, emojiSize);
        }
        x += s.w;
      }

      const entry = { bmp: oc, w, h };
      if (allReady) {
        this._cacheSet(key, entry);
      }
      return entry;
    }

    _cacheGet(key) {
      const hit = this.cache.get(key);
      if (hit) {
        this.cache.delete(key);
        this.cache.set(key, hit);
      }
      return hit;
    }

    _cacheSet(key, entry) {
      if (this.cache.size >= this.cfg.cacheMax) {
        this.cache.delete(this.cache.keys().next().value); // drop least recently used
      }
      this.cache.set(key, entry);
    }

    _loop(ts) {
      if (!this.running) return;
      const dt = this.lastTs ? Math.min(ts - this.lastTs, 50) : 16;
      this.lastTs = ts;
      this.frameEMA = this.frameEMA * 0.9 + dt * 0.1;
      const fs = this.frameSamples;
      fs[this.frameSamplePos] = dt;
      this.frameSamplePos = (this.frameSamplePos + 1) % fs.length;
      if (this.frameSampleLen < fs.length) this.frameSampleLen++;

      this._updateDynamicCap();
      this._drainPending();

      const ctx = this.ctx, dpr = this.cfg.dpr, arr = this.active, next = this.nextActive;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, this.w, this.h);
      ctx.globalAlpha = this.cfg.opacity;
      next.length = 0;
      let drawn = 0;
      for (let i = 0; i < arr.length; i++) {
        const a = arr[i];
        a.x -= a.vx * dt;
        a.ttlMs -= dt;
        if (a.x + a.w < 0 || a.ttlMs <= 0) { a.active = false; continue; } // expired -> dropped by compaction
        ctx.drawImage(a.bmp, Math.round(a.x), Math.round(a.y - a.h / 2), a.w, a.h);
        a.index = next.length;
        next.push(a);
        drawn++;
      }
      this._drawn = drawn;
      this.active = next;
      this.nextActive = arr;
      this.raf = requestAnimationFrame(this._loop);
    }
  }

  globalThis.SYCDanmaku = { DanmakuOverlay, DEFAULTS };
})();
