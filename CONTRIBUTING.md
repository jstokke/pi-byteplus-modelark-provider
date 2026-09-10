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

113 tests, fully mocked HTTP and filesystem, no live API. `node --test` runs
them in about 0.6s. `--test-force-exit` in the `test` script is a safety net
in case a test leaves an unawaited handle; `npm run test:ci` omits it.

## Type-checking

```bash
npm run typecheck
```

`tsc --noEmit`, strict mode, over `src/index.ts` and the three `.d.mts`
declaration files. Please don't turn strict mode off.

What it does **not** cover is worth understanding, because the JavaScript is not
what gets checked:

- **The declaration files are not verified.** `skipLibCheck` is on, so TypeScript
  uses `core.d.mts` as the types for `core.mjs` without checking the contents of
  the declaration against the implementation. Turning it off is not an option:
  it reports 44 errors inside `@earendil-works/pi-ai`'s generated declarations,
  because `module: nodenext` rejects their JSON import attributes.
- **The `.mjs` modules are not type-checked.** `allowJs`/`checkJs` are off, and
  the modules carry no JSDoc, so enabling `checkJs` reports 91 errors. Doing this
  properly is a real piece of work (annotate the `.mjs`, then drop the
  hand-written declarations), not a config change.

So `npm run typecheck` checks that `src/index.ts` uses the declared interfaces
correctly. It does not check that the declarations match the implementations.
`src/declarations.test.mjs` closes the gap that matters most — every declared
value export must exist at runtime, and every runtime export must be declared —
but it cannot check argument or return types.

If you change what a `.mjs` module exports, or change a signature, update the
matching `.d.mts` by hand. Nothing will remind you except that test.

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

## Release process

Releases go through one script, which is deliberately paranoid because the only
irreversible step is `npm publish` — a published `name@version` can never be
reused, not even after `npm unpublish`.

1. Move the `[Unreleased]` notes in `CHANGELOG.md` under a new
   `## [X.Y.Z] — YYYY-MM-DD` heading. Don't commit it; the release script
   includes it in the release commit. It refuses to run without that heading.
2. Run it, and keep the tree otherwise clean:
   ```bash
   npm run release -- patch --dry-run   # checks everything, changes nothing
   npm run release -- patch             # 0.1.0 -> 0.1.1
   ```
   `minor`, `major` and an exact `X.Y.Z` work too.

The script, in order: verifies the branch is `main` and in sync with
`origin/main`; verifies the tag and the npm version are both unused; runs
`test`, `typecheck` and `check:pack`; rehearses the publish; asks you to type
the version to confirm; bumps via `npm version --no-git-tag-version`, commits
and tags; publishes; **then** pushes with `--follow-tags`; and creates a GitHub
release.

Publishing last-but-one is intentional. If `npm publish` fails, the script rolls
back the local commit and tag, so a failed release leaves no tag claiming a
release that never happened. If publishing succeeds but the push fails, the
commit and tag are still local and you can just push.

There is no build step, so what you tag is what gets published.

`prepublishOnly` re-runs the gates on any `npm publish`, so a manual publish
doesn't skip them. It does not run on install.

Installs go through Pi's package manager, from npm
(`pi install npm:pi-byteplus-modelark-provider`) or git
(`pi install git:github.com/jstokke/pi-byteplus-modelark-provider`).

`publishConfig.access` is already `public`, so no flag is needed.

The first `npm publish` has to be manual: npm's
[trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC) needs the
package to exist before a trusted publisher can be bound to it. Once `0.1.0` is
on npm, bind the package to this repository and the publish workflow on
npmjs.com, add `.github/workflows/publish.yml` triggered by
`release: [published]` with `permissions: { contents: read, id-token: write }`,
and delete any `NPM_TOKEN` secret. Trusted publishing requires npm CLI >= 11.5.1
and Node >= 22.14.0, and generates provenance automatically — so do not set
`provenance: true` in `publishConfig`.

Note that npm sessions now last two hours and 2FA is required to publish, so
expect a login or a one-time-password prompt during a release.
