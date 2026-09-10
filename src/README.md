# BytePlus ModelArk provider for Pi — technical notes

This is the longer-form documentation: how discovery works, what is
discovered versus curated, which request parameters are sent and why, and
what every environment variable does. The repository README is the short
version.

## Setup, in one line

```
/login byteplus
```

Pi prompts with a masked secret input, checks the key, and writes it to
`~/.pi/agent/auth.json`. No environment variable is required, and there is
nothing to edit by hand.

## Which endpoint is used

| Purpose | URL | Source |
| :--- | :--- | :--- |
| Chat Completions (used) | `https://ark.ap-southeast.bytepluses.com/api/coding/v3` | BytePlus Coding Plan docs |
| Anthropic protocol (not used) | `https://ark.ap-southeast.bytepluses.com/api/coding` | BytePlus Coding Plan docs |

The Coding Plan base URL is **required**. BytePlus bills the pay-as-you-go
data plane (`…/api/v3`) separately: requests sent there do not consume the
plan quota and are charged on top of the subscription. This extension
defaults to the Coding Plan URL and never falls back to the data plane.

The Anthropic-protocol base URL exists so Claude Code and similar tools can
talk to the plan; Pi speaks the Anthropic wire natively too, but registering
a second provider here would list every model twice — the plan serves the
same models on both protocols, and none of them are Claude models — so this
extension registers one OpenAI-compatible provider. If you want the
Anthropic wire, that is a `models.json` entry, not an extension.

## How the model list is discovered

Small correction to the usual blog-post framing: the Coding Plan does not
publish a documented model-listing endpoint for plan models. BytePlus
documents the endpoint only for the pay-as-you-go data plane, and the
Coding Plan's supported models are a *subset* of the platform catalog. So
discovery is layered, and each layer degrades into the next:

1. **BytePlus' own docs page** (primary, TTL-cached 24h). The Coding Plan
   integration pages publish the plan's model aliases in a
   "The following models are supported:" list. That page is server-rendered,
   so the extension parses the article markdown out of `window._ROUTER_DATA`
   rather than scraping the DOM. This is the layer that makes new plan models
   show up without a new extension release.
2. **The live `/models` call** (secondary). Used to fill in context window and
   output limits for models the docs list, and as a source of model ids when
   the docs page cannot be parsed. When the docs scrape succeeded, the live
   catalog is *only* consulted for metadata: ModelArk's catalog is a platform
   catalog that also lists embedding, rerank, image/video/3D, speech and
   translation models, and none of those belong in a Pi model picker. On the
   fallback path those are filtered out by name.
3. **The bundled seed catalog** (last resort). Ten known-good ids, so an
   authenticated user is never left with an empty provider after an offline
   first run or a docs restructure.

This call is marked **best-effort on purpose**. BytePlus does not document
`GET /api/coding/v3/models`, and the gateway authenticates *before* routing,
so an unauthenticated probe returns `401` for a real path and for a nonsense
one alike — the endpoint's existence cannot be verified without a live key.
Consequently a failure there is never treated as fatal, and it is not logged
when the docs scrape already produced a model list.

One id is not in the docs list but is documented on the same page as a valid
config value: `ark-code-latest`, the plan's auto-router. It is appended to a
successful scrape and is present in the seed list.

### Checking the scrape against the live page

```bash
npm run smoke
```

It fetches the docs page, parses it, converts every model for Pi, and reports
which plan models have no curated hint (and which hints are no longer
served). Use `node scripts/check-plan-docs.mjs --strict` to make drift fail.

## Discovered versus curated

Ids, and which models exist, are discovered. Everything Pi *must* know up
front — context window, output cap, vision, reasoning support — is curated in
`MODEL_HINTS` (`src/core.mjs`) with a comment naming its source.

| Model id | Context | Max output | Reasoning | Image input |
| :--- | ---: | ---: | :--- | :--- |
| `ark-code-latest` | 262 144 | 65 536 | yes | no |
| `dola-seed-2.0-pro` | 262 144 | 131 072 | yes | yes |
| `dola-seed-2.0-lite` | 262 144 | 32 768 | yes | yes |
| `dola-seed-2.0-code` | 262 144 | 131 072 | yes | yes |
| `bytedance-seed-code` | 131 072 | 32 768 | yes | no |
| `glm-5.2` | 200 000 | 131 072 | yes | no |
| `glm-5.1` | 200 000 | 131 072 | yes | no |
| `kimi-k2.5` | 262 144 | 65 536 | yes | yes |
| `gpt-oss-120b` | 131 072 | 32 768 | yes | no |
| `deepseek-v4-flash` | 1 000 000 | 131 072 | yes | no |
| `deepseek-v4-pro` | 1 000 000 | 131 072 | yes | no |

Where the sources disagree, the table takes the **smaller** value:

- An over-large `contextWindow` means Pi does not compact before the model
  hard-fails; an over-small one only means a little wasted headroom.
- An over-large `maxTokens` is a request the API can reject outright; an
  over-small one costs a retry after raising it (see below).
- `maxTokens` is capped at 131 072 for every model even where the Ark catalog
  advertises more.

Models the extension has never heard of are not guessed at: they load with
conservative defaults (262 144 context, 32 768 output), `reasoning: false`,
and text-only input. `npm run smoke` is how you notice that a hint is
missing.

## Reasoning and thinking levels

BytePlus documents `reasoning_effort` on the ModelArk **Chat API** with the
values `none | minimal | low | medium | high | xhigh | max`, which is the
same vocabulary Pi uses for its OpenAI-style reasoning field. Models
therefore ship with:

```js
compat: {
  supportsDeveloperRole: false,   // ModelArk expects "system"
  maxTokensField: "max_tokens",   // not max_completion_tokens
  supportsReasoningEffort: true,
  thinkingFormat: "openai",       // bare top-level reasoning_effort
}
```

All four flags are load-bearing:

- Pi auto-detects `max_completion_tokens` and the `developer` role for any
  provider it does not recognize, and ModelArk accepts neither.
- `thinkingFormat: "openai"` emits a bare top-level `reasoning_effort`; the
  `thinking: { type: … }` wrapper is only sent to models that accept it, and
  no model in this set is sent one.
- `reasoning_effort: "none"` and `xhigh` are documented for
  `glm-5-2-260617` **only**, so only `glm-5.2` gets a `thinkingLevelMap`
  (`{ off: "none", xhigh: "xhigh" }`). Every other model uses Pi's default
  off/minimal/low/medium/high mapping and never receives `none`.

Choosing a thinking level in Pi sends the matching `reasoning_effort`;
choosing *off* on a model without an `off` mapping sends nothing at all,
so the model's own default applies.

## Raising the output cap

Pi reports `Response was truncated before completion.` when a response ends
because it hit the output cap mid-answer. Reasoning burns output tokens
before the answer starts, so reasoning models hit this first.

`maxTokens` resolves in this order, and is **raise-only** — nothing here can
lower a cap below what BytePlus/Ark publishes:

1. The curated `MODEL_HINTS` value (the floor).
2. A per-model override from `~/.pi/agent/byteplus-model-overrides.json`.
3. `BYTEPLUS_DEFAULT_MAX_TOKENS` (a positive integer), applied to models with
   no curated value.
4. Compile-time defaults: 131 072 for a reasoning model, 32 768 otherwise.

```bash
export BYTEPLUS_DEFAULT_MAX_TOKENS=65536
```

Invalid values (`0`, `-1`, `12.5`, `1e3`, `abc`) fall back silently, like the
rest of the env vars.

### Per-model overrides

Create `~/.pi/agent/byteplus-model-overrides.json` (or the equivalent under
`$PI_CODING_AGENT_DIR`):

```json
{
  "deepseek-v4-pro":    { "maxTokens": 200000 },
  "Seed 2.0 Lite":      { "contextWindow": 262144 },
  "glm-5.2":            { "maxTokens": 131072 }
}
```

- Keys can be the exact model id, the display name from the catalog, or the
  curated display name — matching is case- and punctuation-insensitive, so
  `Seed 2.0 Lite`, `seed 2.0 lite` and `seed20lite` are the same key. The
  exact id wins on a conflict.
- `maxTokens` and `contextWindow` are supported and must be positive
  integers; anything else is silently dropped.
- Malformed JSON logs one line and the file is treated as empty.

The file is read once, when the provider is created.

## Environment variables

All optional. Every one of them is a fallback or an escape hatch; none is
needed for a normal `/login` setup.

| Variable | Effect |
| :--- | :--- |
| `BYTEPLUS_API_KEY` | Headless fallback key (checked first of the two). |
| `ARK_API_KEY` | Headless fallback key, matching BytePlus' own docs and the Ark CLI. |
| `BYTEPLUS_BASE_URL` | Override the endpoint. Only change this if you know why. |
| `BYTEPLUS_PLAN_DOC_URL` | Point the docs scrape at a mirror if BytePlus restructures the page. |
| `BYTEPLUS_NO_ENRICHMENT` | `1` skips the docs scrape and uses the live catalog plus cache only. |
| `BYTEPLUS_DEFAULT_MAX_TOKENS` | Global output cap for models with no curated value. |
| `PI_CODING_AGENT_DIR` | Pi's own setting; relocates `auth.json`, the cache and the overrides file. |

Key resolution order for every request: the credential Pi resolved for this
provider, then the stored `byteplus` entry in `auth.json`, then
`BYTEPLUS_API_KEY`, then `ARK_API_KEY`. The key is never logged, printed, or
included in an error message; there is a test that asserts that across every
error path.

## Caching

The scraped plan list is cached at
`~/.pi/agent/byteplus-coding-plan-cache.json` (respects
`$PI_CODING_AGENT_DIR`) with a 24-hour TTL, fetched lazily inside
`refreshModels()` — not at extension load — and bounded to 8s. The live
`/models` call runs concurrently with a separate 8s bound. Pi's own models
store persists the resulting catalog across sessions, which is what keeps
`/model` populated offline.

No API key is ever sent to the docs site.

## Troubleshooting

Every diagnostic is one line and none of them contains the key.

- `BytePlus ModelArk: no API key found. Run \`/login byteplus\`…`
  → first-time setup or cleared credentials.
- `BytePlus ModelArk: authentication failed (HTTP 401/403).`
  → the key was rejected. Keys are region-scoped: create one in the ARK
  console for `ap-southeast-1`, and make sure it is not a pay-as-you-go-only
  key.
- `… Coding Plan docs page no longer contains a 'supported models' section (layout may have changed) (using the cached plan list)`
  → BytePlus changed the page. The extension keeps working from cache and the
  live catalog; set `BYTEPLUS_PLAN_DOC_URL` to a working page, or run
  `npm run smoke` and file an issue.
- `… Coding Plan docs page listed no models (falling back to the live catalog)`
  → the list parsed to nothing, e.g. the docs stopped escaping code spans.
  Same handling as above.
- `… model discovery failed: … (using the bundled model list)`
  → both sources failed. The ten bundled ids still work.
- A model is missing → check `npm run smoke`; if it is not in the live list,
  BytePlus has not published it yet. If it *is* listed and Pi still does not
  show it, that is a bug.
- Requests fail with an API-format error → `OPENAI_COMPAT` in `core.mjs` is
  the only place that shapes the request.

## Tests

```bash
npm install
npm test        # unit tests, fully mocked, ~0.6s
npm run typecheck
npm run smoke   # hits the live docs page; not part of npm test
```

`src/core.mjs`, `src/enrich.mjs` and `src/native-provider.mjs` are plain ES
module JavaScript so they load through Pi's jiti runtime *and* run under
`node --test` with no compile step. The `.d.mts` files beside them are hand
written and are what `npm run typecheck` checks.
