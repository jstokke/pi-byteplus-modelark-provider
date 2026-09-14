# Changelog

Notes on what changed. Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Automatic dynamic discovery and live probing of new models whenever an API
  key is set. The extension queries the live `/models` catalog and probes any
  chat-capable models not documented in the docs list against
  `chat/completions`: models BytePlus enables plan-side (returning 200) are
  dynamically added to the published catalog and cached, keeping the catalog
  current without waiting for new extension releases or docs updates.
- `probeModelSupport` utility to verify Coding Plan endpoint model routing.
- `deepseek-v4-flash-ga` and `deepseek-v4-pro-ga` to the curated hints and
  the seed catalog. BytePlus added the GA successors of the V4 pair to the
  plan without updating the docs "supported models" list; both ids were
  verified against the Coding Plan endpoint (200 on `chat/completions`, while
  platform-active but non-plan models answer `404 UnsupportedModel`).

### Fixed

- The live `/models` metadata enrichment never worked: the parser read flat
  `context_length`/`max_tokens` fields, but BytePlus' actual payload nests
  limits under `token_limits` and input modalities under
  `modalities.input_modalities`. Both shapes are now parsed, plus `status`.
- Plan aliases could not match the catalog's versioned platform ids
  (`glm-5.2` vs `glm-5-2-260617`), so live metadata never merged onto plan
  models. Matching now normalizes both sides (dots → hyphens, trailing
  date-like version suffix dropped); ids themselves are still never
  substituted, and live ids still never enter a successful plan list.
- Curated limits corrected against BytePlus' Subscription overview and the
  live catalog: `glm-5.2` context window 200 000 → 1 048 576 (the old value
  compacted far too early), `kimi-k2.5` output cap 65 536 → 32 768 (the docs
  cap includes the chain of thought; the old value risked rejection), and
  `bytedance-seed-code` now declared vision-capable.
- The live-catalog fallback no longer offers models BytePlus has marked
  `Shutdown` or `Retiring`.

## [0.1.0] — 2026-09-10

First release. A Pi extension for the BytePlus ModelArk **Coding Plan**,
written as a replacement for `pi-byteplus-modelark` (which pinned a
hand-maintained model list and required an exported environment variable).

### Added

- Native Pi provider `byteplus` (`BytePlus ModelArk`) on the Coding Plan
  OpenAI-compatible endpoint `https://ark.ap-southeast.bytepluses.com/api/coding/v3`.
- `/login byteplus` support: masked secret prompt, key validation, persistence
  to `~/.pi/agent/auth.json`, and a credential-source label in the selector.
  `BYTEPLUS_API_KEY` and `ARK_API_KEY` remain as headless fallbacks.
- Layered model discovery, so new plan models appear without an extension
  release:
  1. the Coding Plan's published model list, parsed out of the
     server-rendered BytePlus docs page (`window._ROUTER_DATA` → article
     markdown → the "supported models" bullet list), cached 24h;
  2. `GET {base}/models`, used for context/output metadata and as a fallback
     source of ids, filtered to chat models;
  3. a bundled seed catalog of ten known-good ids.
- Curated per-model limits (`contextWindow`, `maxTokens`, vision, reasoning)
  for the plan line-up, taking the more conservative value whenever sources
  disagree.
- Correct request shaping for ModelArk's Chat API:
  `maxTokensField: "max_tokens"`, `supportsDeveloperRole: false`,
  `supportsReasoningEffort: true`, `thinkingFormat: "openai"`.
- Reasoning-effort support that matches BytePlus' documented vocabulary, with
  `glm-5.2` exposing the `off` (`none`) and `xhigh` levels BytePlus
  documents for that model version alone.
- `~/.pi/agent/byteplus-model-overrides.json` for raise-only per-model
  `maxTokens` / `contextWindow` overrides, matched by id or by normalized
  display name.
- Environment escape hatches: `BYTEPLUS_BASE_URL`, `BYTEPLUS_PLAN_DOC_URL`,
  `BYTEPLUS_NO_ENRICHMENT`, `BYTEPLUS_DEFAULT_MAX_TOKENS`.
- `npm run smoke` (`scripts/check-plan-docs.mjs`), which parses the live
  BytePlus docs page and reports drift between it and the curated hints.
- `npm run check:pack` (`scripts/check-pack-contents.mjs`), which asserts what
  `npm publish` would upload. It runs in CI, so a change to `files` fails the
  build instead of shipping something unintended.
- `npm run release -- patch|minor|major|X.Y.Z` (`scripts/release.mjs`), which
  bumps, tags and publishes. It verifies the git state, that the tag and the npm
  version are both unused, and that this file has a section for the version
  before touching anything; runs the test, typecheck and pack checks; rehearses
  the publish; and publishes *before* pushing, rolling the local commit and tag
  back if the registry rejects the tarball. `--dry-run` runs every check and
  changes nothing.
- `prepublishOnly` re-runs the test, typecheck and pack checks on any
  `npm publish`, so a manual publish cannot skip them. It does not run on
  install.
- 113 unit tests with fully mocked HTTP, filesystem and Pi runtime, including
  a secret-hygiene test asserting the API key never appears in an error path
  or log line, and `src/declarations.test.mjs`, which asserts that every value
  export declared in the hand-written `.d.mts` files exists at runtime and that
  every runtime export is declared.
- GitHub Actions CI across Node 20, 22 and 24, plus Dependabot configuration.

### Fixed

- `CONTRIBUTING.md` claimed `npm run typecheck` checks the `.d.mts`
  declarations. It does not: `skipLibCheck` means the declaration contents are
  not verified, and the `.mjs` modules are not type-checked at all. The section
  now states what is and is not covered, with the measured numbers, and points
  at the declaration test.

### Documentation

- The README states its requirements (Pi 0.85.x, Node 20+), makes npm the
  primary install path with a pinned-tag git alternative, and carries a
  trademark and non-affiliation disclaimer.
- `SECURITY.md`, a pull request template, and an `.github/ISSUE_TEMPLATE` pair
  covering the diagnostics worth collecting in a bug report.
- Publishing and release steps live in `CONTRIBUTING.md`; `PUBLISHING.md` was
  removed so the repository only documents what users and contributors need.
