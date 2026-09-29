import { clamp } from "./math.js";
import { AUTHOR_ROLE_COLORS } from "./theme.js";

(() => {
  "use strict";

  // Canvas-cached danmaku renderer. Each comment is rasterized ONCE into a slot
  // of a shared sprite-atlas page, then blitted with drawImage every frame —
  // that is the difference between ~300 concurrent (DOM) and 1000–2000 here.
  //
  // Why a shared atlas and not one <canvas> per comment: every canvas backing
  // store counts toward V8's external memory, and at chat rates (100+ new
  // comments/s) per-comment canvases push that past the GC trigger every
  // second or so. The resulting full mark-compact pauses (measured 10–26 ms on
  // a 2 MB JS heap with a real GPU) were the periodic "jolt". Atlas pages are
  // recycled once nothing on screen references them, so the steady state
  // allocates nothing at all.
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
    lineHeight: 23,       // lane height incl. gap (18px font * 125%)
    topPct: 0.08,         // keep top 8% clear
    bottomPct: 0.14,      // keep bottom 14% clear (controls)
    gapPx: 28,            // min horizontal gap between same-lane comments
    dedup: true,          // drop near-duplicates of recently shown comments
    simThreshold: 3,      // Hamming distance <= this => near-duplicate
    recentMax: 400,
    lengthSpread: true,   // gently widen scorer timing by length
    durationScale: 100 / 120, // user speed multiplier (0.5=2x faster .. 2=2x slower)
    tierDurations: [3000, 4000, 5000],
    opacity: 1,           // global comment opacity (0.2–1.0)
    textColor: "#ffffff", // base comment color for normal authors
    roleColors: true,     // owner/mod/member use role colors; else textColor
    fontFamily: "",       // "" => system default stack
    fontWeight: 700,      // 100..900
    outlineWidth: 3,      // text outline px (0 = none)
    outlineAlpha: 0.85,   // outline opacity 0..1
    outlineColor: "#000000", // outline color
    outlineBlur: 0,       // outline softness px (0 = hard edge)
    authorName: "nontext", // never | nontext | always
    sizeByScore: true,    // vary font size by comment score
    showNormal: true,     // per-type visibility gates (applied in push())
    showMember: true,
    showModerator: true,
    showOwner: true,
    showPaid: true,
    showMembership: true,
    roleScale: { member: 1, moderator: 1, owner: 1, paid: 1 }, // per-type font multipliers
    pinComments: true,    // right-click to pin & drag an individual comment
    spreadStrength: 0.35, // how strongly length affects speed (0..1)
    flowDirection: "rtl", // rtl (right to left) | ltr (left to right)
    density: "top",       // top | bottom | random lane packing
    maxWidthPct: 1,       // clamp a comment's width to a fraction of the stage
    wrapText: false,      // wrap overflowing text instead of trimming it
    cacheMax: 900,        // max cached atlas slots (a slot lives while its page does)
    maxQueue: 1000,       // pending comments waiting for rasterization
    spawnPerFrame: 6,     // cap expensive canvas text rasterization per frame
    maxTextChars: 260,    // prevent giant one-off bitmaps from stalling video
    dpr: Math.max(0.5, Math.min(2, (self.devicePixelRatio || 1) * 0.6)),
    // Frame-loop protection. Rasterization runs in bounded slices OUTSIDE the
    // animation frame, and a long main-thread hitch is repaid gradually instead
    // of teleporting comments in one step.
    rasterBudgetMs: 4,    // max rasterization time per scheduled slice
    maxStepMs: 50,        // max per-frame advance (bounded catch-up; >= 20 fps)
    maxCarryMs: 250       // max accumulated catch-up debt
  };

  const RASTER_CONFIG_KEYS = [
    "dpr",
    "fontPx",
    "fontFamily",
    "fontWeight",
    "outlineWidth",
    "outlineAlpha",
    "outlineColor",
    "outlineBlur",
    "lineHeight",
    "textColor",
    "roleColors"
  ];
  const GEOMETRY_CONFIG_KEYS = ["dpr", "lineHeight", "topPct", "bottomPct"];

  const AUTHOR_BOOST = { owner: 0.40, moderator: 0.25, member: 0.10, normal: 0 };
  const TARGET_FRAME_MS = 1000 / 60;
  const MIN_CAP_FRAME_MS = 50;
  const LONG_GAP_MS = 500; // frame gap above this is a pause, not a hitch
  const MAX_WRAP_LINES = 3; // hard cap on wrapped lines per comment
  // Sprite-atlas geometry (device px). A page is 2 MB RGBA; pages are opened
  // lazily and recycled in ring order, so a light stream touches only a couple.
  const ATLAS_PAGE_W = 2048;
  const ATLAS_PAGE_H = 256;
  const ATLAS_MAX_PAGES = 48;  // hard ceiling (96 MB); beyond it, standalone bitmaps
  const ATLAS_GUTTER = 1;      // transparent px around a slot: no bilinear bleed
  const ATLAS_SHELF_SLACK = 8; // reuse a shelf up to this much taller than needed
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
    const s = String(text || "");
    if (s.length <= maxChars) return text; // fast path: no spread/array for short text
    const chars = [...s];
    if (chars.length <= maxChars) return text;
    return `${chars.slice(0, Math.max(1, maxChars - 3)).join("")}...`;
  }

  // "#rrggbb" + alpha -> "rgba(r,g,b,a)". Falls back to black for bad input.
  function withAlpha(hex, alpha) {
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || ""));
    if (!m) return `rgba(0,0,0,${alpha})`;
    const r = parseInt(m[1], 16), g = parseInt(m[2], 16), b = parseInt(m[3], 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  function createCanvas(width, height) {
    const canvas = document.createElement("canvas");
    if (width) canvas.width = width;
    if (height) canvas.height = height;
    return canvas;
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
      this.ready = [];          // rasterized sprites waiting to be admitted
      this.readyHead = 0;       // ring head index for `ready`
      this.lanes = [];          // per-lane "free at" timestamps
      this.cache = new Map();   // raster key -> atlas slot (validated by page generation)
      this._pages = [];         // sprite-atlas pages, recycled in ring order
      this._pageCursor = 0;     // index of the page currently being filled
      this._scratch = new Map();// CPU scratch canvases by size bucket (text raster)
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
      this.carryMs = 0;         // unspent frame time for smooth catch-up
      this._dirty = true;       // canvas needs a clear+redraw next frame
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
      this.drag = null;         // active pin-drag state
      this._onContextMenu = null;
      this._onPointerDown = null;
      this._onPointerMove = null;
      this._onPointerUp = null;
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
      this.ctx = c.getContext("2d", { alpha: true });
      this._resize();
      this._ro = new ResizeObserver(() => this._resize());
      this._ro.observe(player);
      this._bindPointer(player);
      this._startLongTaskObserver();
      this.start();
    }

    detach() {
      this.stop();
      this._unbindPointer();
      this._stopLongTaskObserver();
      this._ro?.disconnect();
      this._ro = null;
      if (this.canvas && typeof this.canvas.remove === "function") this.canvas.remove();
      this.canvas = null; this.ctx = null;
      this.active.length = 0;
      this.nextActive.length = 0;
      this.activeMinHeap.length = 0;
      this.pending.length = 0;
      this.pendingHead = 0;
      this.ready.length = 0;
      this.readyHead = 0;
      this.recentLen = 0;
      this.recentPos = 0;
      this.recentBucketMap.clear();
      this.cache.clear();
      this._pages.length = 0;
      this._pageCursor = 0;
      this._scratch.clear();
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
      this.ready.length = 0;
      this.readyHead = 0;
      this._dirty = true;
      this.carryMs = 0;
      for (const page of this._pages) page.sprites = 0; // nothing on screen holds a slot now
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
        ready: this._readyCount(),
        fps: Math.round(1000 / this.frameEMA), cache: this.cache.size,
        pages: this._pages.length,
        drawn: this._drawn, longTasks: this.longTasks,
        frameP50: pct(0.50), frameP95: pct(0.95), frameP99: pct(0.99)
      };
    }

    _resize() {
      if (!this.player || !this.canvas) return;
      const r = this.player.getBoundingClientRect();
      this._setSize(r.width, r.height);
    }

    // Apply a stage size in CSS px.
    _setSize(width, height) {
      if (!this.canvas) return;
      this.w = Math.max(1, Math.round(width));
      this.h = Math.max(1, Math.round(height));
      const dpr = this.cfg.dpr;
      this.canvas.width = Math.round(this.w * dpr);
      this.canvas.height = Math.round(this.h * dpr);
      const usable = this.h * (1 - this.cfg.topPct - this.cfg.bottomPct);
      this.laneH = this.cfg.lineHeight;
      this.laneCount = Math.max(3, Math.floor(usable / this.laneH));
      this.laneTop = this.h * this.cfg.topPct;
      this.lanes = new Array(this.laneCount).fill(0);
      this._dirty = true;
    }

    start() { if (this.running) return; this.running = true; this.lastTs = 0; this.carryMs = 0; this.raf = requestAnimationFrame(this._loop); }
    stop() { this.running = false; cancelAnimationFrame(this.raf); }

    // Admission control + spawn. Returns true if the comment was accepted.
    push(payload) {
      if (!this.canvas || !payload || !payload.text) return false;
      if (!this._typeVisible(payload)) return false;
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

    // Per-type visibility gate from settings. Super chats / memberships are keyed
    // by kind; plain messages by author role.
    _typeVisible(payload) {
      if (payload.kind === "paid") return this.cfg.showPaid !== false;
      if (payload.kind === "membership") return this.cfg.showMembership !== false;
      switch (payload.authorType) {
        case "owner": return this.cfg.showOwner !== false;
        case "moderator": return this.cfg.showModerator !== false;
        case "member": return this.cfg.showMember !== false;
        default: return this.cfg.showNormal !== false;
      }
    }

    _roleScale(payload) {
      const scale = this.cfg.roleScale || {};
      if (payload.kind === "paid") return scale.paid ?? 1;
      return scale[payload.authorType] ?? 1;
    }

    // Super Chat text is white on a tier-colored band; other roles keep their
    // role/text color with no band.
    _labelStyle(payload, roleColor) {
      const paidColor = payload.kind === "paid" && payload.paidColor ? payload.paidColor : "";
      if (paidColor) return { labelColor: "#ffffff", band: paidColor };
      return { labelColor: roleColor, band: "" };
    }

    _readyCount() {
      return this.ready.length - this.readyHead;
    }

    // Rasterization runs INSIDE the animation frame under a hard time budget.
    // There are no free-running timers on the render thread: a timer task landing
    // right before a vsync deadline is exactly what shows up as the periodic
    // "jolt", and a dedicated worker stays smooth only while its event loop is
    // idle apart from rAF.
    _drainPending() {
      this._rasterizePending(this.cfg.rasterBudgetMs);

      let budget = this.cfg.spawnPerFrame;
      if (this.frameEMA > 28) budget = Math.max(1, Math.ceil(budget / 3));
      else if (this.frameEMA > 20) budget = Math.max(1, Math.ceil(budget / 2));

      while (budget > 0 && this.readyHead < this.ready.length) {
        const prep = this.ready[this.readyHead++];
        if (this._admit(prep)) this.shown++;
        budget--;
      }
      this._compactReady();
    }

    _compactReady() {
      if (this.readyHead === 0) return;
      if (this.readyHead >= this.ready.length) { this.ready.length = 0; this.readyHead = 0; return; }
      if (this.readyHead > 64 && this.readyHead * 2 >= this.ready.length) {
        this.ready = this.ready.slice(this.readyHead);
        this.readyHead = 0;
      }
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

    // Rasterize queued comments until the time budget is spent (or enough are
    // buffered). Bounded so a burst never blows the frame budget, and driven only
    // from the frame loop so there is no separate task to perturb frame pacing.
    _rasterizePending(budgetMs) {
      if (!this.canvas || this.pendingHead >= this.pending.length) return;
      const highWater = Math.max(this.cfg.spawnPerFrame * 2, 8);
      if (this._readyCount() >= highWater) return;
      const t0 = performance.now();
      while (this.pendingHead < this.pending.length && this._readyCount() < highWater) {
        const next = this.pending[this.pendingHead++];
        const prep = this._prepare(next.payload, next.priority);
        if (prep) this.ready.push(prep);
        if (performance.now() - t0 >= budgetMs) break;
      }
      this._compactPending();
    }

    // Rasterize a payload into a ready-to-admit sprite (no admission policy).
    _prepare(payload, priority) {
      const emphasis = payload.emphasis ?? 0;
      const scoreScale = this.cfg.sizeByScore
        ? (emphasis >= 0.62 ? 1.12 : emphasis <= 0.18 ? 0.9 : 1.0)
        : 1.0;
      const fontPx = Math.round(this.cfg.fontPx * scoreScale * this._roleScale(payload));
      const color = (this.cfg.roleColors && payload.authorType && payload.authorType !== "normal")
        ? (AUTHOR_ROLE_COLORS[payload.authorType] ?? this.cfg.textColor)
        : this.cfg.textColor;
      const { labelColor, band } = this._labelStyle(payload, color);
      const msgParts = this._displayParts(payload);
      const nameMode = this.cfg.authorName || "nontext";
      const named = payload.author && (
        nameMode === "always" || (nameMode === "nontext" && payload.kind && payload.kind !== "text")
      );
      const parts = (named ? [{ t: `${payload.author}: ` }, ...msgParts] : msgParts).slice(0, 60);
      const glow = emphasis >= 0.62 && this.frameEMA < 24; // skip glow when frames are heavy
      const slot = this._rasterize(parts, labelColor, fontPx, glow, band);
      if (slot.page) slot.page.sprites++; // the prep holds its page until admitted or dropped

      const td = this.cfg.tierDurations;
      // Membership (stamp/announcement) items are visual, not readable prose.
      // Keep them snappy regardless of how long the announcement text is.
      const isStamp = payload.kind === "membership";
      const tier = isStamp ? 0 : payload.tier;
      const baseMs = (td && td[tier] != null) ? td[tier] : (payload.durationMs || 8000);
      let dur = baseMs * (this.cfg.durationScale || 1);
      if (this.cfg.lengthSpread && !isStamp) {
        const len = [...payload.text].length;
        const raw = clamp(0.8, 1.45, 0.82 + len / 110);
        dur *= 1 + (raw - 1) * (this.cfg.spreadStrength ?? 0.5); // scale length->speed coupling
      }
      // Super Chats get extra dwell time so the paid message can be read.
      if (payload.kind === "paid") dur *= 1.3;
      return { payload, priority, slot, w: slot.w, h: slot.h, dur };
    }

    // Admit a prepared sprite: cap/eviction policy + lane assignment + push.
    _admit(prep) {
      if (this.active.length >= this.dynamicCap) {
        const weakest = this._peekActiveMin();
        // Pinned comments are user-held and never evicted; drop the newcomer.
        if (weakest && !weakest.pinned && prep.priority > weakest.priority) this._removeActive(weakest); // evict weakest
        else { this.dropped++; this._releaseSlot(prep.slot); return false; } // drop incoming
      }

      const now = performance.now();
      const lane = this._pickLane(now);
      const dir = this.cfg.flowDirection === "ltr" ? 1 : -1;
      const startX = dir < 0 ? this.w : -prep.w;
      const dist = this.w + prep.w + this.cfg.gapPx;
      const vx = dist / prep.dur; // px per ms (long text => larger dist => already slower via dur)
      this.lanes[lane] = now + (prep.w + this.cfg.gapPx) / vx; // lane reusable after tail clears entry

      const slot = prep.slot;
      const entry = {
        img: slot.img, sx: slot.sx, sy: slot.sy, sw: slot.sw, sh: slot.sh, page: slot.page,
        w: prep.w, h: prep.h,
        x: startX, y: this.laneTop + lane * this.laneH + this.laneH / 2,
        vx, ttlMs: prep.dur + 600, priority: prep.priority,
        id: this.nextSpriteId++,
        index: this.active.length,
        active: true
      };
      this.active.push(entry);
      this._heapPush(entry);
      return true;
    }

    // Synchronous prepare+admit for callers that want immediate admission; the
    // frame loop goes through the raster pump so text work stays off the frame.
    _spawn(payload, priority) {
      const prep = this._prepare(payload, priority);
      return prep ? this._admit(prep) : false;
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
      this._releaseSlot(removed);
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

    // --- right-click pin & drag (opt-in via cfg.pinComments) ------------------
    // Capture phase so we run before the player's own handlers and can
    // preventDefault only when a comment was actually hit.
    _bindPointer(player) {
      this._onContextMenu = (e) => this._handleContextMenu(e);
      this._onPointerDown = (e) => this._handlePointerDown(e);
      this._onPointerMove = (e) => this._handlePointerMove(e);
      this._onPointerUp = () => this._endDrag();
      player.addEventListener("contextmenu", this._onContextMenu, true);
      player.addEventListener("pointerdown", this._onPointerDown, true);
    }

    _unbindPointer() {
      const player = this.player;
      this._endDrag();
      if (player) {
        if (this._onContextMenu) player.removeEventListener("contextmenu", this._onContextMenu, true);
        if (this._onPointerDown) player.removeEventListener("pointerdown", this._onPointerDown, true);
      }
      this._onContextMenu = null;
      this._onPointerDown = null;
    }

    _localPoint(event) {
      const rect = this.canvas?.getBoundingClientRect?.();
      if (!rect) return null;
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    }

    // Topmost comment under a canvas-local point, or null.
    _hitTest(x, y) {
      const arr = this.active;
      for (let i = arr.length - 1; i >= 0; i--) {
        const a = arr[i];
        if (x >= a.x && x <= a.x + a.w && y >= a.y - a.h / 2 && y <= a.y + a.h / 2) return a;
      }
      return null;
    }

    _togglePin(sprite) {
      sprite.pinned = !sprite.pinned;
      // A released comment needs enough lifetime to leave the stage again.
      if (!sprite.pinned) sprite.ttlMs = Math.max(sprite.ttlMs, 3000);
    }

    _handleContextMenu(event) {
      if (!this.cfg.pinComments) return;
      const point = this._localPoint(event);
      const sprite = point && this._hitTest(point.x, point.y);
      if (!sprite) return;
      event.preventDefault();
      event.stopPropagation();
      this._togglePin(sprite);
    }

    _handlePointerDown(event) {
      if (!this.cfg.pinComments || event.button !== 0) return;
      const point = this._localPoint(event);
      const sprite = point && this._hitTest(point.x, point.y);
      if (!sprite || !sprite.pinned) return;
      event.preventDefault();
      event.stopPropagation();
      this.drag = {
        sprite,
        offsetX: point.x - sprite.x,
        offsetY: point.y - (sprite.y - sprite.h / 2)
      };
      window.addEventListener("pointermove", this._onPointerMove);
      window.addEventListener("pointerup", this._onPointerUp);
    }

    _handlePointerMove(event) {
      const drag = this.drag;
      if (!drag) return;
      const point = this._localPoint(event);
      if (!point) return;
      drag.sprite.x = point.x - drag.offsetX;
      drag.sprite.y = point.y - drag.offsetY + drag.sprite.h / 2;
    }

    _endDrag() {
      if (!this.drag) return;
      this.drag = null;
      if (typeof window !== "undefined") {
        window.removeEventListener("pointermove", this._onPointerMove);
        window.removeEventListener("pointerup", this._onPointerUp);
      }
    }

    _pickLane(now) {
      const n = this.laneCount;
      const mode = this.cfg.density || "top";
      // Prefer a lane that is already clear; otherwise the one that frees soonest.
      const free = mode === "random" ? [] : null;
      for (let k = 0; k < n; k++) {
        const i = mode === "bottom" ? n - 1 - k : k;
        if (this.lanes[i] <= now) {
          if (free) free.push(i);
          else return i;
        }
      }
      if (free && free.length) return free[Math.floor(Math.random() * free.length)];
      let best = 0, bestFree = Infinity;
      for (let i = 0; i < n; i++) {
        const f = this.lanes[i];
        if (f < bestFree) { bestFree = f; best = i; }
      }
      return best;
    }

    // Break plain text into rendered lines. With wrapText off the text is
    // trimmed to one line with an ellipsis; with it on the text wraps into up to
    // MAX_WRAP_LINES lines and the last one is ellipsized if it still overflows.
    _layoutLines(text, fontPx) {
      const pct = this.cfg.maxWidthPct ?? 1;
      const family = this.cfg.fontFamily || 'system-ui, -apple-system, "Segoe UI", sans-serif';
      const weight = this.cfg.fontWeight || 700;
      if (!this.measure) this.measure = createCanvas(1, 1).getContext("2d");
      this.measure.font = `${weight} ${fontPx}px ${family}`;
      const measure = (s) => this.measure.measureText(s).width;
      if (pct >= 1 || !this.w || !text) return [text];
      const maxPx = this.w * pct;
      if (measure(text) <= maxPx) return [text];
      const chars = [...text];
      if (!this.cfg.wrapText) {
        let lo = 1, hi = chars.length;
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1;
          if (measure(chars.slice(0, mid).join("")) <= maxPx) lo = mid;
          else hi = mid - 1;
        }
        return [`${chars.slice(0, Math.max(1, lo - 1)).join("")}…`];
      }
      const all = [];
      let current = "";
      for (const ch of chars) {
        if (current && measure(current + ch) > maxPx) { all.push(current); current = ch; }
        else current += ch;
      }
      if (current) all.push(current);
      if (all.length <= MAX_WRAP_LINES) return all;
      const kept = all.slice(0, MAX_WRAP_LINES);
      let last = kept[MAX_WRAP_LINES - 1];
      while (last.length > 1 && measure(`${last}…`) > maxPx) last = last.slice(0, -1);
      kept[MAX_WRAP_LINES - 1] = `${last}…`;
      return kept;
    }

    // Trim a plain string to the configured max width (kept for tests/consumers).
    _fitWidth(text, fontPx) {
      return this._layoutLines(text, fontPx).join("");
    }

    // Custom-emoji image lookup (SYCEmoji's HTMLImageElement cache).
    _emojiLookup(url) {
      const emoji = globalThis.SYCEmoji;
      return emoji && emoji.get ? emoji.get(url) : null;
    }

    _emojiReady(img) {
      if (!img || img.complete === false) return false;
      return (img.naturalWidth || img.width || 0) > 0;
    }

    // parts: [{ t: text } | { u: emojiUrl }]. Text is drawn with outline/glow;
    // custom-emoji parts are drawn as images. A bitmap referencing an emoji image
    // that has not loaded yet is NOT cached, so it re-rasterizes (with the image)
    // next time the same comment appears.
    _rasterize(parts, color, fontPx, glow, bg = "") {
      const family = this.cfg.fontFamily || 'system-ui, -apple-system, "Segoe UI", sans-serif';
      const weight = this.cfg.fontWeight || 700;
      const ow = this.cfg.outlineWidth ?? 3;
      const oa = this.cfg.outlineAlpha ?? 0.85;
      const outlineColor = this.cfg.outlineColor || "#000000";
      const ob = this.cfg.outlineBlur ?? 0;
      const sig = parts.map((p) => (p.u ? "" + p.u : p.t)).join("");
      const key = `${fontPx}|${weight}|${ow}|${oa}|${outlineColor}|${ob}|${glow ? 1 : 0}|${color}|${family}|${bg}|${sig}`;
      const hit = this._cacheGet(key);
      if (hit) return hit;

      const font = `${weight} ${fontPx}px ${family}`;
      if (!this.measure) this.measure = createCanvas(1, 1).getContext("2d");
      this.measure.font = font;
      const pad = (glow ? 10 : 6) + Math.ceil(ow / 2) + Math.ceil(ob);
      const lineH = Math.max(this.cfg.lineHeight, fontPx + 8);
      const emojiSize = Math.round(fontPx * 1.15);

      let lines;
      if (parts.some((p) => p.u)) {
        // Emoji messages stay on one line; emoji are measured as fixed squares.
        let width = 0;
        let ready = true;
        const segs = parts.map((p) => {
          if (p.u) {
            const img = this._emojiLookup(p.u);
            const loaded = this._emojiReady(img);
            if (!loaded) ready = false;
            width += emojiSize + 2;
            return { img: loaded ? img : null, text: null, w: emojiSize + 2 };
          }
          const segW = this.measure.measureText(p.t).width;
          width += segW;
          return { img: null, text: p.t, w: segW };
        });
        lines = [{ segs, width, ready }];
      } else {
        lines = this._layoutLines(parts.map((p) => p.t).join(""), fontPx).map((t) => {
          const segW = this.measure.measureText(t).width;
          return { segs: [{ img: null, text: t, w: segW }], width: segW, ready: true };
        });
      }

      const contentW = Math.max(1, ...lines.map((line) => line.width));
      const w = Math.ceil(contentW) + pad * 2;
      const h = lineH * lines.length + Math.ceil(ob);
      const dpr = this.cfg.dpr;
      const sw = Math.max(1, Math.ceil(w * dpr)), sh = Math.max(1, Math.ceil(h * dpr));
      // An atlas slot whenever one fits; a standalone bitmap only for oversized
      // text or when every page is busy (the rare exception, not the rule).
      const slot = this._atlasAlloc(sw, sh);
      // Text is rasterized on the CPU (a reused scratch canvas) and the finished
      // sprite is blitted into the GPU-backed page. Stroking glyph outlines
      // straight onto a large accelerated page was measured to halve the frame
      // rate; an image blit into it is free, and the glyphs look exactly as
      // they always did.
      const scratch = slot ? this._scratchFor(sw, sh) : null;
      const target = scratch ? scratch.canvas : createCanvas(sw, sh);
      const o = scratch ? scratch.ctx : target.getContext("2d", { willReadFrequently: true });
      o.save();
      o.clearRect(0, 0, sw, sh);
      o.scale(dpr, dpr);
      o.font = font;
      o.textBaseline = "middle";
      o.lineJoin = "round";
      // Super Chat tier band: the text is drawn white on top of the tier color.
      if (bg) {
        o.fillStyle = withAlpha(bg, 0.92);
        const radius = Math.min(8, h / 2);
        if (typeof o.roundRect === "function") {
          o.beginPath();
          o.roundRect(0, 0, w, h, radius);
          o.fill();
        } else {
          o.fillRect(0, 0, w, h);
        }
      }

      for (let li = 0; li < lines.length; li++) {
        const centerY = lineH * li + lineH / 2;
        let x = pad;
        for (const s of lines[li].segs) {
          if (s.text != null) {
            if (ow > 0) {
              const stroke = withAlpha(outlineColor, oa);
              o.lineWidth = ow;
              o.strokeStyle = stroke;
              if (ob > 0) { o.shadowColor = stroke; o.shadowBlur = ob; }
              o.strokeText(s.text, x, centerY);
              o.shadowBlur = 0;
            }
            if (glow) { o.shadowColor = "rgba(255,255,255,.55)"; o.shadowBlur = 6; } else o.shadowBlur = 0;
            o.fillStyle = color;
            o.fillText(s.text, x, centerY);
          } else if (s.img) {
            o.shadowBlur = 0;
            o.drawImage(s.img, x, centerY - emojiSize / 2, emojiSize, emojiSize);
          }
          x += s.w;
        }
      }
      o.restore();

      const page = slot ? slot.page : null;
      if (page) page.ctx.drawImage(target, 0, 0, sw, sh, slot.x, slot.y, sw, sh);
      const img = page ? page.canvas : target;
      const sx = slot ? slot.x : 0, sy = slot ? slot.y : 0;
      const entry = { img, sx, sy, sw, sh, w, h, page, gen: page ? page.gen : 0 };
      if (lines.every((line) => line.ready)) this._cacheSet(key, entry);
      return entry;
    }

    _cacheGet(key) {
      const hit = this.cache.get(key);
      if (!hit) return null;
      this.cache.delete(key);
      if (hit.page && hit.page.gen !== hit.gen) return null; // its page was recycled
      this.cache.set(key, hit); // most recently used
      return hit;
    }

    _cacheSet(key, entry) {
      if (this.cache.size >= this.cfg.cacheMax) {
        this.cache.delete(this.cache.keys().next().value); // drop least recently used
      }
      this.cache.set(key, entry);
    }

    // --- sprite atlas ---------------------------------------------------------
    // Shelf-pack a sw×sh device-px slot (plus gutter) into the current page.
    // When it is full, the oldest page with no on-screen sprite is wiped and
    // reused; a new page is opened only while none is free, up to a hard cap.
    // Returns null when the slot is oversized or every page is busy.
    _atlasAlloc(sw, sh) {
      const needW = sw + ATLAS_GUTTER * 2, needH = sh + ATLAS_GUTTER * 2;
      if (needW > ATLAS_PAGE_W || needH > ATLAS_PAGE_H) return null;
      const pages = this._pages;
      let page = pages[this._pageCursor];
      let spot = page ? this._shelfAlloc(page, needW, needH) : null;
      if (!spot) {
        let next = -1;
        for (let k = 1; k <= pages.length; k++) {
          const i = (this._pageCursor + k) % pages.length;
          if (pages[i].sprites === 0) { next = i; break; }
        }
        if (next >= 0) this._resetPage(pages[next]);
        else if (pages.length < ATLAS_MAX_PAGES) { pages.push(this._newPage()); next = pages.length - 1; }
        else return null;
        this._pageCursor = next;
        page = pages[next];
        spot = this._shelfAlloc(page, needW, needH);
        if (!spot) return null;
      }
      return { page, x: spot.x + ATLAS_GUTTER, y: spot.y + ATLAS_GUTTER };
    }

    _shelfAlloc(page, w, h) {
      for (const shelf of page.shelves) {
        if (shelf.h >= h && shelf.h - h <= ATLAS_SHELF_SLACK && shelf.x + w <= ATLAS_PAGE_W) {
          const x = shelf.x;
          shelf.x += w;
          return { x, y: shelf.y };
        }
      }
      if (page.nextY + h > ATLAS_PAGE_H) return null;
      const shelf = { y: page.nextY, h, x: w };
      page.shelves.push(shelf);
      page.nextY += h;
      return { x: 0, y: shelf.y };
    }

    _newPage() {
      const canvas = createCanvas(ATLAS_PAGE_W, ATLAS_PAGE_H);
      return { canvas, ctx: canvas.getContext("2d"), shelves: [], nextY: 0, sprites: 0, gen: 1 };
    }

    // CPU-backed scratch canvas for text rasterization, one per power-of-two
    // size bucket (at most 4x4 of them), so steady state allocates nothing.
    _scratchFor(sw, sh) {
      let bw = 256, bh = 32;
      while (bw < sw) bw *= 2;
      while (bh < sh) bh *= 2;
      const key = bw * 4096 + bh;
      let scratch = this._scratch.get(key);
      if (!scratch) {
        const canvas = createCanvas(bw, bh);
        scratch = { canvas, ctx: canvas.getContext("2d", { willReadFrequently: true }) };
        this._scratch.set(key, scratch);
      }
      return scratch;
    }

    // Wipe a page nothing on screen uses. Bumping `gen` invalidates cache
    // entries that still point into it (checked lazily in _cacheGet).
    _resetPage(page) {
      page.gen++;
      page.shelves.length = 0;
      page.nextY = 0;
      page.ctx.clearRect(0, 0, ATLAS_PAGE_W, ATLAS_PAGE_H);
    }

    // Drop a sprite's (or an un-admitted prep's) hold on its atlas page.
    _releaseSlot(ref) {
      if (ref && ref.page) ref.page.sprites--;
    }

    _loop(ts) {
      if (!this.running) return;
      // A very long gap (hidden/frozen tab) is treated as a pause: no teleport
      // and no expiry, so the scene survives. Shorter main-thread hitches are
      // repaid gradually (bounded catch-up) so comments ease back to real time
      // instead of jumping in a single frame.
      const raw = this.lastTs ? ts - this.lastTs : TARGET_FRAME_MS;
      this.lastTs = ts;
      const gap = raw > LONG_GAP_MS ? 0 : raw;
      let dt;
      if (gap === 0) {
        this.carryMs = 0;
        dt = 0;
      } else {
        this.carryMs = Math.min(this.carryMs + gap, this.cfg.maxCarryMs);
        dt = Math.min(this.carryMs, this.cfg.maxStepMs);
        this.carryMs -= dt;
      }
      const sample = Math.min(raw, MIN_CAP_FRAME_MS);
      this.frameEMA = this.frameEMA * 0.9 + sample * 0.1;
      const fs = this.frameSamples;
      fs[this.frameSamplePos] = sample;
      this.frameSamplePos = (this.frameSamplePos + 1) % fs.length;
      if (this.frameSampleLen < fs.length) this.frameSampleLen++;

      this._updateDynamicCap();
      this._drainPending();

      const ctx = this.ctx, dpr = this.cfg.dpr, invDpr = 1 / dpr;
      const arr = this.active, next = this.nextActive;
      // Idle: nothing on screen and the canvas is already clear, so skip the
      // full-canvas clear+composite entirely.
      if (arr.length === 0 && !this._dirty) {
        this._drawn = 0;
        this.raf = requestAnimationFrame(this._loop);
        return;
      }
      const dir = this.cfg.flowDirection === "ltr" ? 1 : -1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, this.w, this.h);
      ctx.globalAlpha = this.cfg.opacity;
      next.length = 0;
      let drawn = 0;
      for (let i = 0; i < arr.length; i++) {
        const a = arr[i];
        if (!a.pinned) {
          a.x += a.vx * dt * dir;
          a.ttlMs -= dt;
          const gone = dir < 0 ? a.x + a.w < 0 : a.x > this.w;
          if (gone || a.ttlMs <= 0) { a.active = false; this._releaseSlot(a); continue; } // expired
        }
        // Draw x at its exact (fractional) position. Snapping x to the device
        // grid quantises horizontal motion into alternating pixel steps
        // (measured ~18% per-frame velocity swing at dpr 0.75), which reads as
        // constant judder. Sub-pixel filtering is far less noticeable than the
        // stair-step. Lane y never changes, so it stays snapped for crisp edges.
        const dy = Math.round((a.y - a.h / 2) * dpr) * invDpr;
        ctx.drawImage(a.img, a.sx, a.sy, a.sw, a.sh, a.x, dy, a.w, a.h);
        a.index = next.length;
        next.push(a);
        drawn++;
      }
      this._drawn = drawn;
      this._dirty = false;
      this.active = next;
      this.nextActive = arr;
      this.raf = requestAnimationFrame(this._loop);
    }
  }

  globalThis.SYCDanmaku = { DanmakuOverlay, DEFAULTS };
})();
