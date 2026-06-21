// Synthetic chat source — drives the same onMessages handler as the live client,
// for development and deterministic Playwright tests (no network, no IFrame).

const POOL = [
  { text: "888888888888", authorType: "normal", kind: "text" },
  {
    text: "this stream is incredible, the production quality keeps getting better",
    authorType: "member",
    kind: "text",
  },
  { text: "kusa", authorType: "normal", kind: "text" },
  { text: "Thank you for the amazing content today!", authorType: "moderator", kind: "text" },
  { text: "🎉🎉🎉", authorType: "normal", kind: "text" },
  { text: "Welcome everyone to the stream", authorType: "owner", kind: "text" },
  { text: "Super Thanks!", authorType: "normal", kind: "paid", amount: "¥1,000" },
  { text: "new member here, happy to join", authorType: "member", kind: "membership" },
  { text: "ggwp", authorType: "normal", kind: "text" },
  { text: "that play was actually insane, replay it", authorType: "normal", kind: "text" },
  // a custom (member) emoji message — exercises image rendering in both views
  {
    text: "love this :emote:",
    authorType: "member",
    kind: "text",
    parts: [
      { t: "love this " },
      {
        u: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
        a: ":emote:",
      },
    ],
  },
]

const makeMessage = i => {
  const base = POOL[i % POOL.length]
  return { ...base, id: `mock-${i}`, ts: i, author: `@user${i % 37}` }
}

// startMock(onBatch, { ratePerSec, batchEverySec }) -> stop()
export const startMock = (onBatch, { ratePerSec = 25, batchEverySec = 0.5 } = {}) => {
  let i = 0
  const perBatch = Math.max(1, Math.round(ratePerSec * batchEverySec))
  const timer = setInterval(() => {
    onBatch(Array.from({ length: perBatch }, () => makeMessage(i++)))
  }, batchEverySec * 1000)
  return () => clearInterval(timer)
}
