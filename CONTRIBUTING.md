# Contributing

Thanks for considering a PR. The extension is small: most changes touch one
of three files (`src/core.mjs`, `src/enrich.mjs`, `src/native-provider.mjs`)
plus their `.d.mts` declarations and tests.

I'm a solo dev, so response times are whatever they are. If something is
sitting unanswered for a week, ping me.

## Running the tests

```bash
npm install
npm test
```

109 tests, fully mocked HTTP and filesystem, no live API. `node --test` runs
them in about 0.6s. `--test-force-exit` in the `test` script is a safety net
in case a test leaves an unawaited handle; `npm run test:ci` omits it.

## Type-checking

```bash
npm run typecheck
```

`tsc --noEmit` against the `core.d.mts` / `enrich.d.mts` /
`native-provider.d.mts` declarations. Strict mode is on; please don't turn it
off.

## Smoke-checking the live docs page

```bash
npm run smoke
```

Fetches the BytePlus Coding Plan docs page, parses it, converts every model
for Pi, and reports drift against the curated hints. This is deliberately not
part of `npm test` — it needs the network, and a BytePlus docs outage must
not turn CI red. Run it when you touch `src/enrich.mjs`, when BytePlus
announces a new model, or when a user reports a missing model.

## Project layout

```
src/
  index.ts                 # Pi extension entrypoint (loaded by jiti at startup)
  core.mjs                 # Pure logic: endpoints, keys, /models, model building
  core.d.mts               # Type declarations for core.mjs
  core.test.mjs            # Unit tests for core
  enrich.mjs               # Docs scrape: Coding Plan model list + TTL cache
  enrich.d.mts             # Type declarations for enrich.mjs
  enrich.test.mjs          # Unit tests for enrich
  native-provider.mjs      # Pi provider wiring: /login, refreshModels, streaming
  native-provider.d.mts    # Type declarations for native-provider.mjs
  native-provider.test.mjs # Unit tests for the provider
  README.md                # User-facing technical documentation
scripts/
  check-plan-docs.mjs      # Live docs smoke check (npm run smoke)
```

The three `.mjs` modules are deliberately plain ES module JavaScript so they
load through Pi's jiti runtime *and* run under `node --test` with no compile
step. The hand-written `.d.mts` files give the TypeScript entrypoint real
types.

## Things I care about

- **No new runtime dependencies.** The extension is intentionally tiny.
  Built-in Node APIs are enough; please don't add a runtime dep without a
  really good reason.
- **All HTTP must be mockable.** `fetchCatalog`, `fetchPlanModels`,
  `loadPlanCache`, `savePlanCache`, `loadModelOverrides`, `validateApiKey`
  and `readStoredApiKey` all accept injectable dependencies (`fetchImpl`,
  `fsImpl`, `cachePath`, `path`, `env`, `now`, `ttlMs`, `signal`) so tests run
  without I/O.
- **No secrets in logs, errors, or tests.** The secret-hygiene tests in
  `core.test.mjs` and `native-provider.test.mjs` cover every error path. If
  you add a new one, extend them.
- **Conservative defaults, never optimistic ones.** When two sources
  disagree, take the smaller `contextWindow` and the smaller `maxTokens`: an
  over-large context window fails hard mid-conversation, and an over-large
  `max_tokens` is a request the API rejects. Reasoning and vision are opt-in
  from evidence, never inferred from a model's name.
- **Discovered vs. curated stays separated.** Which models exist is
  discovered. What Pi must know about them is curated in `MODEL_HINTS` with a
  source comment. Don't hardcode a model list, and don't guess at a limit.
- **Failing safe beats failing loudly.** Every discovery layer degrades into
  the next one; an authenticated user should always end up with models.

## Adding a model hint

1. Confirm the model is on the Coding Plan (`npm run smoke`) or documented as
   a plan value on the same docs page.
2. Add an entry to `MODEL_HINTS` in `src/core.mjs` with the provenance
   comment updated if the source is new.
3. Extend the `MODEL_HINTS` assertion in `core.test.mjs` if the shape of the
   table changed, and add the id to the `input`/`reasoning` expectations
   there.
4. Note it in `CHANGELOG.md` under `[Unreleased]`.

## Adding an environment variable

1. Document it in `src/README.md` (the environment-variable table) and in
   `CHANGELOG.md` under `[Unreleased]`.
2. Add a unit test covering the happy path and the rejection cases if the
   variable has non-trivial validation.
3. Document the failure mode — silent fallback (consistent with the existing
   variables) or a hard error.

## Submitting a change

1. Fork, branch, push.
2. `npm test` and `npm run typecheck` locally.
3. Open a PR with:
   - a short summary
   - the motivation (issue, BytePlus docs change, upstream Pi behaviour)
   - whether the public surface changed (env vars, override file shape,
     provider id, model ids)
4. CI must pass on Node 20, 22 and 24.

## Release process (for me)

1. Bump `version` in `package.json`.
2. Move `[Unreleased]` in `CHANGELOG.md` to a dated `[X.Y.Z]` section.
3. Tag and push.

There is no build step. Installs go through Pi's package manager
(`pi install git:github.com/jstokke/pi-byteplus-modelark-provider`) or npm.
