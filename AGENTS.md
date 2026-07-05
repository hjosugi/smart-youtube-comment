# Agent Coordination

This repo is shared by the human operator, Claude, and Codex.

## Ownership

- Claude owns `extension/`.
- Codex may update shared tooling, CI, docs, `web/`, and `worker/` when a task
  requires end-to-end validation.
- Shared plans, contracts, release notes, and research live in `docs/`.
- Local-only coordination notes live in `.private-discussion/` and are ignored by Git.

## Current Architecture

The extension is JavaScript-only. The mobile PWA in `web/` is TypeScript plus
classic browser scripts, and the Cloudflare live-chat relay in `worker/` is
TypeScript. Browser rendering/extraction is the practical bottleneck, not
scoring.

Scoring lives in `extension/scoring.js` and runs locally in the content script.
Do not add a new scorer transport unless a batched or stateful scorer first
proves a clear Chrome/V8 performance win in benchmarks and the migration is
documented in `docs/CONTRACT.md` and `docs/PLAN.md`.

## Boundary Rule

Read `docs/CONTRACT.md` before changing the message or scoring shapes used by
the extension. If the shape changes:

1. Update `docs/CONTRACT.md`.
2. Note the migration in `docs/PLAN.md`.
3. Keep compatibility only as long as both old and new shapes are actually used.
