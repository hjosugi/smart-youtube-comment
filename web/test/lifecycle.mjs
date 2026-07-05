// Pure test: the lifecycle helpers degrade gracefully when the APIs are absent
// (as in Node — no wakeLock, no MediaMetadata). They must never throw.

if (typeof globalThis.navigator === "undefined") {
  Object.defineProperty(globalThis, "navigator", { value: {}, configurable: true })
}

const { createWakeLock, setMediaSession } = await import("../lifecycle.ts")

const checks = []
const assert = (name, cond, extra = "") => checks.push({ name, ok: !!cond, extra })

const wl = createWakeLock()
assert("wakeLock reports unsupported in node", wl.supported === false)
assert("wakeLock starts inactive", wl.active === false)

let threw = false
try {
  await wl.acquire() // no-op when unsupported
  await wl.release()
} catch {
  threw = true
}
assert("acquire/release never throw", !threw)
assert("still inactive after no-op acquire", wl.active === false)

assert("setMediaSession returns false when unsupported", setMediaSession({ title: "x" }) === false)

let threw2 = false
try {
  setMediaSession() // no args, unsupported env
} catch {
  threw2 = true
}
assert("setMediaSession never throws", !threw2)

// Supported Wake Lock behavior: browser auto-release may be re-acquired while
// watching, but an explicit app release must disable future visibility reacquire.
{
  const listeners = new Map()
  globalThis.document = {
    visibilityState: "visible",
    addEventListener: (type, fn) => listeners.set(type, fn),
  }

  const sentinels = []
  let requests = 0
  Object.defineProperty(globalThis.navigator, "wakeLock", {
    configurable: true,
    value: {
      request: async () => {
        requests += 1
        const releaseListeners = []
        const sentinel = {
          released: false,
          addEventListener: (type, fn) => {
            if (type === "release") releaseListeners.push(fn)
          },
          release: async () => {
            if (sentinel.released) return
            sentinel.released = true
            for (const fn of releaseListeners) fn()
          },
        }
        sentinels.push(sentinel)
        return sentinel
      },
    },
  })

  const fireVisible = async () => {
    globalThis.document.visibilityState = "visible"
    listeners.get("visibilitychange")?.()
    await Promise.resolve()
  }

  const supported = createWakeLock()
  assert("wakeLock reports supported when API exists", supported.supported === true)
  await supported.acquire()
  assert("wakeLock acquires once", requests === 1 && supported.active === true)

  await sentinels[0].release()
  assert("browser release clears active lock", supported.active === false)
  await fireVisible()
  assert("visible reacquires while still wanted", requests === 2 && supported.active === true)

  await supported.release()
  assert("explicit release clears active lock", supported.active === false)
  await fireVisible()
  assert(
    "explicit release prevents visible reacquire",
    requests === 2 && supported.active === false,
  )
}

let allOk = true
for (const c of checks) {
  console.log(`${c.ok ? "✅" : "❌"} ${c.name}${c.ok ? "" : "  -> " + c.extra}`)
  if (!c.ok) allOk = false
}
console.log(
  allOk
    ? `\nRESULT: ✅ lifecycle degrades gracefully (${checks.length} checks)`
    : "\nRESULT: ❌ FAILURES",
)
process.exit(allOk ? 0 : 1)
