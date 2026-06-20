// Pure transform: ChatMessage -> danmaku push payload (or null to drop).
//
// Mirrors the extension hot path (content.js): score -> buildRenderPlan -> push.
// `makeRenderer` closes over the scorer + buildRenderPlan so the orchestrator
// stays free of scoring details; the returned function is a clean message->payload
// map. (The scorer keeps a small recency buffer, so it is not strictly pure, but
// the wiring is.)

export const makeRenderer = (scorer, buildRenderPlan) => (msg) => {
  const result = scorer.score({ text: msg.text, authorType: msg.authorType, kind: msg.kind });
  const plan = buildRenderPlan(msg.text, result);
  if (!plan) return null;
  return {
    text: msg.text,
    parts: msg.parts,
    author: msg.author,
    kind: msg.kind,
    authorType: msg.authorType,
    tier: plan.tier,
    durationMs: plan.durationMs,
    score: plan.score,
    emphasis: plan.emphasis,
  };
};

// Render a batch into the overlay; returns how many were admitted.
export const renderBatch = (renderer, overlay, messages = []) =>
  messages.reduce((shown, msg) => {
    const payload = renderer(msg);
    return payload && overlay.push(payload) ? shown + 1 : shown;
  }, 0);
