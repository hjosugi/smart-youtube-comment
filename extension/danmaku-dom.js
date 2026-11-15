(() => {
  "use strict";

  // Compositor-driven danmaku renderer (the default).
  //
  // Each comment is one DOM element moved by a Web Animations transform
  // animation. Chrome runs such an animation on its compositor thread: every
  // vsync the compositor places the comment for that frame's display time and
  // draws it from an already rasterized layer. No script runs per frame, so
  // motion does not depend on requestAnimationFrame arriving on time, on a
  // canvas being redrawn and presented in step with the page, or on anything
  // else the main thread is doing. This is how the DOM danmaku players this
  // project was compared with move their comments (CSS keyframes on transform
  // in YoutubeLiveChatFlusher, CSS transitions in weizhenye/Danmaku), and it
  // is why they stay smooth.
  //
  // The canvas renderer in danmaku.js redraws every comment on every frame
  // from the main thread. Each of those frames has to be scripted, rasterized
  // and presented within one vsync, and every one that is late shows as a
  // hitch. It remains selectable for chats too dense for one layer per comment.
  //
  // Everything that is not drawing is inherited from DanmakuOverlay: the
  // queue, liveness gate, near-duplicate drop, priority and eviction, lanes,
  // pinning and "hide this user".
  //
  // What the main thread still does is add and remove elements, and every
  // frame in which it does so is a frame the compositor has to wait for and
  // commit. Those are the frames that can still arrive late. So the DOM is
  // touched in batches: comments that arrive within BATCH_MS are added in one
  // frame, each starting as far off-stage as keeps its own entry time, and
  // comments that have left are removed in that same frame.

  const { DanmakuOverlay, LONG_GAP_MS, withAlpha } = globalThis.SYCDanmaku;

  const DEFAULT_FAMILY = 'system-ui, -apple-system, "Segoe UI", sans-serif';
  const GLOW_SHADOW = "0 0 6px rgba(255,255,255,.55)";
  // One compositor layer per comment costs the compositor thread 7 to 9 µs
  // per frame (measured on a Xeon E-2244G, 3.8 GHz): 400 comments is about 3 ms of
  // a 16.7 ms frame, before the GPU has drawn them. There is no cap here: how
  // many may be on screen is the "Max comments on screen" setting, whose note
  // warns that more can stutter.
  const EXIT_SLACK_PX = 8; // measured width is an estimate: clear the edge fully
  // Every comment enters BATCH_MS after it arrived. The DOM work for all
  // comments of one such window happens in a single frame.
  const BATCH_MS = 250;
  const BATCH_ADMIT_MAX = 40; // comments added per batch; the rest wait for the next
  // A comment keeps moving off-stage for this long after it has left, so that
  // the next batch can remove it. An animation that is left to finish costs a
  // main-thread frame of its own.
  const LINGER_MS = 1500;
  const STYLE_ID = "syc-danmaku-style";
  const STYLE = `
    .syc-danmaku-layer {
      position: absolute; inset: 0; overflow: hidden; contain: strict;
      pointer-events: none; z-index: 2147483646;
      user-select: none; -webkit-user-select: none;
    }
    .syc-danmaku-layer > .syc-c {
      position: absolute; left: 0; top: 0; margin: 0; box-sizing: border-box;
      white-space: pre; contain: layout style; will-change: transform;
      paint-order: stroke fill;
      -webkit-text-stroke: var(--syc-stroke-width, 0px) var(--syc-stroke-color, transparent);
      text-shadow: var(--syc-shadow, none);
    }
    .syc-danmaku-layer > .syc-c > img {
      width: 1.15em; height: 1.15em; margin: 0 1px; vertical-align: middle;
      object-fit: contain; -webkit-user-drag: none;
    }
    .syc-danmaku-hud {
      position: absolute; left: 8px; top: 8px; z-index: 2147483647; margin: 0; padding: 6px;
      background: rgba(0,0,0,.72); color: #7CFC8C; opacity: .86; pointer-events: none;
      font: 11px/14px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre;
    }
  `;

  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

  function ensureStyle(doc) {
    if (doc.getElementById(STYLE_ID)) return;
    const style = doc.createElement("style");
    style.id = STYLE_ID;
    style.textContent = STYLE;
    (doc.head || doc.documentElement).appendChild(style);
  }

  class CompositorOverlay extends DanmakuOverlay {
    constructor(cfg) {
      super(cfg);
      this.layer = null;
      this.hud = null;
      this._timer = 0;
      this._onTimer = this._onTimer.bind(this);
    }

    get attached() {
      return Boolean(this.layer);
    }

    attach(player) {
      if (!player || (this.player === player && this.layer && this.layer.isConnected)) return;
      this.detach();
      this.player = player;
      const doc = player.ownerDocument;
      ensureStyle(doc);
      if (getComputedStyle(player).position === "static") player.style.position = "relative";
      const layer = doc.createElement("div");
      layer.className = "syc-danmaku-layer";
      player.appendChild(layer);
      this.layer = layer;
      this._resize();
      this._ro = new ResizeObserver(() => this._resize());
      this._ro.observe(player);
      this._startLongTaskObserver();
      this.start();
    }

    detach() {
      for (const sprite of this.active) this._releaseSlot(sprite);
      this._removeHud();
      this.layer?.remove();
      this.layer = null;
      super.detach();
    }

    clear() {
      for (const sprite of this.active) this._releaseSlot(sprite);
      super.clear();
    }

    setConfig(partial) {
      super.setConfig(partial);
      this._applyLayerStyle();
      this._wake(); // the HUD may have been switched on
    }

    _setSize(width, height) {
      if (!this.layer) return;
      const before = this.w;
      this._setGeometry(width, height);
      this._applyLayerStyle();
      // Left-to-right comments leave at the right edge, which just moved.
      if (this.w !== before && this.cfg.flowDirection === "ltr") {
        for (const sprite of this.active) {
          if (!sprite.pinned && sprite.anim) this._run(sprite, this._spriteX(sprite), this.w);
        }
      }
    }

    // Text style shared by every comment lives on the layer, so a settings
    // change restyles the comments already on screen too.
    _applyLayerStyle() {
      const layer = this.layer;
      if (!layer) return;
      const cfg = this.cfg;
      const style = layer.style;
      const width = (cfg.outlineWidth ?? 3) * this.scale;
      const color = withAlpha(cfg.outlineColor || "#000000", cfg.outlineAlpha ?? 0.85);
      const blur = (cfg.outlineBlur ?? 0) * this.scale;
      style.opacity = String(cfg.opacity ?? 1);
      style.fontFamily = cfg.fontFamily || DEFAULT_FAMILY;
      style.fontWeight = String(cfg.fontWeight || 700);
      style.setProperty("--syc-stroke-width", `${width}px`);
      style.setProperty("--syc-stroke-color", width > 0 ? color : "transparent");
      style.setProperty("--syc-shadow", blur > 0 && width > 0 ? `0 0 ${blur}px ${color}` : "none");
    }

    // The next batch is overdue: its timer or its frame did not arrive. With
    // nothing scheduled no batch is due at all, and that is not a stall.
    _stalled(now) {
      return this.running && (this.raf !== 0 || this._timer !== 0) && now - this._frameAt > LONG_GAP_MS;
    }

    start() {
      const wasRunning = this.running;
      super.start();
      if (wasRunning) return;
      for (const sprite of this.active) {
        if (!sprite.pinned) sprite.anim?.play();
      }
    }

    stop() {
      super.stop();
      clearTimeout(this._timer);
      this._timer = 0;
      for (const sprite of this.active) sprite.anim?.pause();
    }

    push(payload) {
      const accepted = super.push(payload);
      if (accepted) this._wake();
      return accepted;
    }

    // Schedule the next batch, BATCH_MS from now, if there is work for one and
    // none is scheduled. _frameAt is when that batch is due.
    _wake() {
      if (!this.running || !this.layer || this.raf || this._timer || !this._hasWork()) return;
      this._frameAt = performance.now() + BATCH_MS;
      this._timer = setTimeout(this._onTimer, BATCH_MS);
    }

    // The batch itself runs in an animation frame: a frame is only produced
    // while the stage is actually being rendered, which is what tells a live
    // stage from a hidden one.
    _onTimer() {
      this._timer = 0;
      if (!this.running || this.raf || !this.layer) return;
      this.raf = requestAnimationFrame(this._loop);
    }

    _hasWork() {
      return this.pendingHead < this.pending.length || Boolean(this.cfg.debugHud);
    }

    // One batch: remove the comments that have left, add the ones that arrived.
    // Comments on screen are moved by the compositor, not here.
    _loop() {
      this.raf = 0;
      if (!this.running) return;
      const now = performance.now();
      // This long after the batch was due, the stage was not rendering. What
      // queued up meanwhile is no longer current.
      if (now - this._frameAt > LONG_GAP_MS) this._dropBacklog();
      this._frameAt = now;

      this._sweep();
      this._updateDynamicCap();
      this._drainPending();
      this._drawn = this.active.length;
      if (this.cfg.debugHud) this._updateHud();
      else this._removeHud();
      this._wake();
    }

    // Remove every comment that has left the stage.
    _sweep() {
      const arr = this.active;
      for (let i = arr.length - 1; i >= 0; i--) {
        const sprite = arr[i];
        if (sprite.anim && (Number(sprite.anim.currentTime) || 0) >= sprite.doneMs) this._swapRemoveActive(i);
      }
    }

    // Add the queued comments. Measuring is cheap (no rasterization), so there
    // is no separate prepared queue. Each comment enters BATCH_MS after it
    // arrived, whenever within the batch window that was.
    _drainPending() {
      const now = performance.now();
      const staleBefore = now - (this.cfg.maxWaitMs || Infinity);
      let room = BATCH_ADMIT_MAX;
      while (room > 0 && this.pendingHead < this.pending.length) {
        const next = this.pending[this.pendingHead++];
        if (next.at < staleBefore) { this.dropped++; continue; } // waited too long to still be live
        const prep = this._prepare(next.payload, next.priority);
        prep.delay = Math.min(BATCH_MS, Math.max(0, next.at + BATCH_MS - now));
        if (this._admit(prep)) this.shown++;
        room--;
      }
      this._compactPending();
    }

    // Measure a comment instead of rasterizing it. Widths come from canvas
    // measureText with the same font, so no layout is forced.
    _prepare(payload, priority) {
      const look = this._look(payload);
      const view = this._measure(look);
      return { payload, priority, slot: null, w: view.w, h: view.h, dur: this._duration(payload), view };
    }

    _measure(look) {
      const { parts, fontPx, glow } = look;
      const cfg = this.cfg;
      const strokeWidth = (cfg.outlineWidth ?? 3) * this.scale;
      const blur = (cfg.outlineBlur ?? 0) * this.scale;
      const pad = (glow ? 10 : 6) + Math.ceil(strokeWidth / 2) + Math.ceil(blur);
      const lineH = Math.max(Math.round(cfg.lineHeight * this.scale), fontPx + 8);
      const emojiW = Math.round(fontPx * 1.15) + 2;

      let lines;
      let contentW = 0;
      if (parts.some((part) => part.u)) {
        // Emoji messages stay on one line, as in the canvas renderer.
        this._setMeasureFont(fontPx);
        for (const part of parts) {
          contentW += part.u ? emojiW : this.measure.measureText(part.t).width;
        }
        lines = [parts];
      } else {
        const texts = this._layoutLines(parts.map((part) => part.t).join(""), fontPx);
        lines = texts.map((t) => [{ t }]);
        for (const t of texts) contentW = Math.max(contentW, this.measure.measureText(t).width);
      }
      return {
        lines, fontPx, lineH, pad, glow, blur, strokeWidth,
        color: look.color, band: look.band,
        w: Math.ceil(Math.max(1, contentW)) + pad * 2,
        h: lineH * lines.length
      };
    }

    _setMeasureFont(fontPx) {
      if (!this.measure) this.measure = document.createElement("canvas").getContext("2d");
      this.measure.font = `${this.cfg.fontWeight || 700} ${fontPx}px ${this.cfg.fontFamily || DEFAULT_FAMILY}`;
    }

    // Build a comment's element. Text goes in as text nodes and every style
    // through a single property setter: nothing here parses untrusted markup.
    _build(view) {
      const doc = this.layer.ownerDocument;
      const el = doc.createElement("div");
      el.className = "syc-c";
      const style = el.style;
      style.fontSize = `${view.fontPx}px`;
      style.lineHeight = `${view.lineH}px`;
      style.color = view.color;
      style.padding = `0 ${view.pad}px`;
      if (view.band) {
        style.background = withAlpha(view.band, 0.92);
        style.borderRadius = `${Math.min(8, view.h / 2)}px`;
      }
      if (view.glow) {
        const outline = view.blur > 0 && view.strokeWidth > 0 ? ", var(--syc-shadow)" : "";
        style.textShadow = GLOW_SHADOW + outline;
      }
      const lines = view.lines;
      if (lines.length === 1 && lines[0].length === 1 && lines[0][0].t != null) {
        el.textContent = lines[0][0].t;
        return el;
      }
      const emoji = globalThis.SYCEmoji;
      for (let i = 0; i < lines.length; i++) {
        if (i) el.appendChild(doc.createTextNode("\n"));
        for (const part of lines[i]) {
          const url = part.u && emoji?.sanitizeUrl ? emoji.sanitizeUrl(part.u) : "";
          if (url) {
            const img = doc.createElement("img");
            img.alt = "";
            img.decoding = "async";
            img.draggable = false;
            img.src = url;
            el.appendChild(img);
          } else if (part.t != null) {
            el.appendChild(doc.createTextNode(part.t));
          }
        }
      }
      return el;
    }

    // Put an admitted comment on the layer and start it moving.
    _mount(sprite, prep, dir) {
      const el = this._build(prep.view);
      sprite.el = el;
      sprite.anim = null;
      this.layer.appendChild(el);
      this._run(sprite, dir < 0 ? this.w : -sprite.w - EXIT_SLACK_PX, dir < 0 ? -sprite.w - EXIT_SLACK_PX : this.w, prep.delay);
    }

    // Lane y is snapped to the device pixel grid so the layer's text stays
    // crisp; x is animated and never snapped.
    _top(sprite) {
      const dpr = self.devicePixelRatio || 1;
      return Math.round((sprite.y - sprite.h / 2) * dpr) / dpr;
    }

    // Move a sprite at its own speed, on the compositor, so that it is at fromX
    // leadMs from now and then travels until it has left the stage at toX.
    //
    // This is one linear animation with no delay and no end the page waits for:
    // the lead is covered by starting that much farther back (off-stage, for a
    // comment that is entering), and the animation runs on past toX for
    // LINGER_MS so that a batch removes the comment (_sweep). An animation
    // delay or an animation finishing would each cost a main-thread frame per
    // comment, which is what batching is there to avoid.
    _run(sprite, fromX, toX, leadMs = 0) {
      const old = sprite.anim;
      const top = this._top(sprite);
      const step = (toX < fromX ? -1 : 1) * sprite.vx; // px per ms, signed
      const travel = Math.max(1, Math.abs(toX - fromX) / sprite.vx);
      const startX = fromX - step * leadMs;
      const endX = toX + step * LINGER_MS;
      const duration = leadMs + travel + LINGER_MS;
      const anim = sprite.el.animate(
        [
          { transform: `translate(${startX}px, ${top}px)` },
          { transform: `translate(${endX}px, ${top}px)` }
        ],
        { duration, easing: "linear", fill: "both" }
      );
      anim.onfinish = () => this._removeActive(sprite); // no batch came by in time
      sprite.anim = anim;
      sprite.x0 = startX;
      sprite.x1 = endX;
      sprite.durMs = duration;
      sprite.doneMs = leadMs + travel; // animation time at which it has left the stage
      if (old) {
        old.onfinish = null;
        old.cancel();
      }
      if (!this.running) anim.pause();
    }

    // Where a sprite is right now. A moving one is placed by the compositor;
    // its position follows from the animation's clock.
    _spriteX(sprite) {
      const anim = sprite.anim;
      if (!anim) return sprite.x;
      const t = Number(anim.currentTime) || 0;
      return sprite.x0 + (sprite.x1 - sprite.x0) * clamp01(t / sprite.durMs);
    }

    // Hold a sprite where it is (pinned).
    _place(sprite) {
      if (sprite.el) sprite.el.style.transform = `translate(${sprite.x}px, ${this._top(sprite)}px)`;
    }

    // Remove a sprite's element. Called for every sprite that leaves the stage;
    // a comment that was prepared but never admitted has no element.
    _releaseSlot(ref) {
      if (!ref || !ref.el) return;
      if (ref.anim) {
        ref.anim.onfinish = null;
        ref.anim.cancel();
        ref.anim = null;
      }
      ref.el.remove();
      ref.el = null;
    }

    _hitTest(x, y) {
      const arr = this.active;
      for (let i = arr.length - 1; i >= 0; i--) {
        const a = arr[i];
        if (y < a.y - a.h / 2 || y > a.y + a.h / 2) continue;
        const ax = this._spriteX(a);
        if (x >= ax && x <= ax + a.w) return a;
      }
      return null;
    }

    _togglePin(sprite) {
      if (!sprite.pinned) {
        sprite.x = this._spriteX(sprite);
        sprite.pinned = true;
        this._place(sprite);
        if (sprite.anim) {
          sprite.anim.onfinish = null;
          sprite.anim.cancel();
          sprite.anim = null;
        }
        return;
      }
      // Released: carry on to the far edge from wherever it was dragged.
      sprite.pinned = false;
      const exit = this.cfg.flowDirection === "ltr" ? this.w : -sprite.w - EXIT_SLACK_PX;
      this._run(sprite, sprite.x, exit);
    }

    dragTo(x, y) {
      super.dragTo(x, y);
      if (this.drag) this._place(this.drag.sprite);
    }

    stats() {
      return Object.assign(super.stats(), { renderer: "compositor" });
    }

    // Refreshed once per batch.
    _updateHud() {
      if (!this.hud) {
        const doc = this.layer.ownerDocument;
        this.hud = doc.createElement("pre");
        this.hud.className = "syc-danmaku-hud";
        this.player.appendChild(this.hud);
      }
      const s = this.stats();
      this.hud.textContent =
        `active ${s.active}/${s.cap}  queued ${s.queued}\n` +
        `shown ${s.shown}  dropped ${s.dropped}`;
    }

    _removeHud() {
      this.hud?.remove();
      this.hud = null;
    }
  }

  globalThis.SYCDanmaku.CompositorOverlay = CompositorOverlay;
})();
