# Contributing

Use small, reviewable changes that preserve the local-only extension boundary.

## Setup

```sh
npm ci
npm --prefix web ci
npm --prefix worker ci
```

## Checks

```sh
npm run format:check
npm run typecheck
npm test
npm run security
```

Browser e2e tests require Chromium:

```sh
npx playwright install chromium
SYC_REQUIRE_E2E=1 npm test
```

## Boundaries

- Keep extension permissions minimal.
- Do not add remote code execution or remote script/style loading.
- Update `docs/CONTRACT.md` when message, scoring, or relay shapes change.
- Update package and manifest versions with `npm run version:set -- X.Y.Z`.
