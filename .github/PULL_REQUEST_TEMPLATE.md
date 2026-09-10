## What this changes

<!-- One or two sentences. -->

## Why

<!-- The motivation: an issue, a BytePlus docs change, upstream Pi behavior. -->

## Public surface

Does this change anything users depend on? Tick what applies, or "none".

- [ ] Provider id (`byteplus`)
- [ ] Environment variables
- [ ] The override file shape (`~/.pi/agent/byteplus-model-overrides.json`)
- [ ] Model ids or curated limits (`MODEL_HINTS`)
- [ ] None

## Checklist

- [ ] `npm test` passes
- [ ] `npm run typecheck` passes
- [ ] `CHANGELOG.md` updated under `[Unreleased]` if user-visible
- [ ] No secrets in code, tests, logs, error messages, or this description

If this touches `src/enrich.mjs` or a model list, also run `npm run smoke` and
paste the summary.
