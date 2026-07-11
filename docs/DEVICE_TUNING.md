<!-- i18n: language-switcher -->
[English](DEVICE_TUNING.md) | [日本語](DEVICE_TUNING.ja.md)

# Device Tuning Checklist

Use this checklist before enabling heavier renderer work such as OffscreenCanvas.
Run it against the deployed PWA on real devices, not desktop emulation.

## Devices

- iOS Safari: current stable iOS, low-power mode off and then on.
- Android Chrome: current stable Chrome on a mid-range device.
- Optional: older Android Chrome if frame p95 is close to the threshold.

## Smoke Flow

1. Open the deployed PWA.
2. Launch a live stream through the URL field and through the Web Share Target.
3. Confirm tap-to-play, pause, and custom controls remain usable.
4. Confirm LIVE mode hides the seekbar and replay mode enables it.
5. Confirm Media Session metadata appears and play/pause actions work where supported.
6. Confirm Wake Lock keeps the screen awake while foregrounded and releases on stop.
7. Open `?perf=1` and watch at least 3 minutes on an active chat.

## Performance Gate

Record `fps`, `frameP95`, `frameP99`, `longTasks`, `active`, and `dropped` from
the HUD. Keep current Canvas2D rendering unless a real device shows either:

- `frameP95 > 33ms` for more than 30 seconds while `active < maxActive`, or
- repeated long-task growth during normal chat bursts, or
- touch/video controls become visibly delayed while comments are flowing.

Only then prototype OffscreenCanvas or worker-side rasterization. The prototype
must include before/after HUD captures on the devices above and must not regress
emoji rendering, Super Chat color, or list scrolling.

## Tuning Defaults

- Prefer lowering `renderScalePct`, `spawnPerFrame`, or `maxActive` before adding
  a new renderer architecture.
- Keep `renderScalePct` default device-specific only if both iOS and Android
  measurements support the split.
- Document final values and screenshots in release notes for the candidate.
