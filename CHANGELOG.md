# Changelog

Notes on what changed. Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Documentation

- The README now states its requirements (Pi 0.85.x, Node 20+) and both
  install paths (npm and git).
- Publishing and release steps now live in `CONTRIBUTING.md`; `PUBLISHING.md`
  was removed so the repository only documents what users and contributors
  need.

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
- 110 unit tests with fully mocked HTTP, filesystem and Pi runtime, including
  a secret-hygiene test asserting the API key never appears in an error path
  or log line.
- CI across Node 20, 22 and 24.
