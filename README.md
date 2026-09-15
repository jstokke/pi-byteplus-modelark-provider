# pi-byteplus-modelark-provider

[![test](https://github.com/jstokke/pi-byteplus-modelark-provider/actions/workflows/test.yml/badge.svg)](https://github.com/jstokke/pi-byteplus-modelark-provider/actions/workflows/test.yml)
[![npm](https://img.shields.io/npm/v/pi-byteplus-modelark-provider.svg)](https://www.npmjs.com/package/pi-byteplus-modelark-provider)
[![license](https://img.shields.io/npm/l/pi-byteplus-modelark-provider.svg)](LICENSE)

A Pi extension that registers your **BytePlus ModelArk Coding Plan**
subscription as a model provider in [Pi](https://github.com/earendil-works/pi-coding-agent).

One API key covers the whole plan — Seed, GLM, Kimi, DeepSeek and GPT-OSS —
and the model list is discovered from BytePlus rather than hardcoded, so new
plan models appear without waiting for an extension release.

If you have used [`pi-byteplus-modelark`](https://github.com/irahardianto/pi-byteplus-modelark),
this is the same idea with two changes you might care about:

- **No `export BYTEPLUS_API_KEY=…` in your shell profile.** You sign in with
  Pi's own `/login`, and the key is stored in `~/.pi/agent/auth.json`.
- **No hand-maintained model list.** The extension reads the model list
  BytePlus publishes for the Coding Plan, layers in context/output limits,
  and falls back gracefully when BytePlus changes that page.

---

## Requirements

- Pi **0.85.x** or newer.
- Node **20** or newer (what Pi itself requires).
- A BytePlus ModelArk **Coding Plan** subscription. The Coding Plan endpoint
  rejects a pay-as-you-go-only key.

---

## Quickstart

### 1. Install

From npm:

```bash
pi install npm:pi-byteplus-modelark-provider
```

Or straight from git, pinned to a tag:

```bash
pi install git:github.com/jstokke/pi-byteplus-modelark-provider@v0.1.0
```

Or over HTTPS:

```bash
pi install https://github.com/jstokke/pi-byteplus-modelark-provider@v0.1.0
```

Already have the old `pi-byteplus-modelark` installed? Remove it first —
both register a provider, and the old one pins a stale model list:

```bash
pi remove npm:pi-byteplus-modelark
```

### 2. Sign in

Inside Pi:

```text
/login byteplus
```

Pi offers two options: **Sign in with BytePlus SSO (arkcli)** — approve the
shown URL in any browser, paste the code back, and the extension imports
the Coding Plan API key from your arkcli profile (requires the `arkcli` CLI)
— or the classic **API-key** paste (`ark-…` from the
[BytePlus ARK console](https://console.byteplus.com/ark), region
`ap-southeast-1`). Either way the credential is saved and you only do this
once. Already signed in with `arkcli auth login` in a terminal? Then there
is nothing to do at all: the extension reuses that Coding Plan key
automatically (`BYTEPLUS_NO_ARKCLI=1` opts out).

### 3. Pick a model

```text
/model
```

You should see the current Coding Plan line-up under **BytePlus ModelArk**,
for example `byteplus/glm-5.2`, `byteplus/kimi-k2.5`, `byteplus/deepseek-v4-pro`,
or `byteplus/ark-code-latest` for the plan's auto-router.

---

## What it does

| | |
| :--- | :--- |
| Provider id | `byteplus` |
| Display name | BytePlus ModelArk |
| Endpoint | `https://ark.ap-southeast.bytepluses.com/api/coding/v3` (Coding Plan) |
| Wire | OpenAI Chat Completions |
| Auth | Pi `/login`: SSO via `arkcli` or masked key prompt → `auth.json`; env vars as fallback |

- **Uses the Coding Plan endpoint**, so requests consume your subscription
  instead of being billed on top of it.
- **Discovers the plan's models** from the list BytePlus publishes, cached
  24h, automatically probes and discovers new live models whenever an API key
  is set, and bundles thirteen known-good ids as a last resort.
- **Tells you when that catalog moves.** If BytePlus adds or retires a plan
  model between sessions, one line at startup names what changed, so a
  different `/model` list is explained rather than surprising. It stays quiet
  on a first run and whenever discovery was degraded, so it never cries wolf.
- **Knows each model's limits** — context window, output cap, vision and
  reasoning support — instead of shipping every model as "128k, text only".
- **Sends reasoning correctly.** ModelArk accepts `reasoning_effort`
  (`none | minimal | low | medium | high | xhigh | max`), so Pi's thinking
  picker actually works, and `glm-5.2` gets the extra `off`/`xhigh` levels
  BytePlus documents for it.
- **No runtime dependencies.** Plain Node built-ins; the HTTP surface is
  fully mocked in tests.

### Managing it

```bash
pi update --extensions   # update, whichever source you installed from
pi remove npm:pi-byteplus-modelark-provider
pi remove git:github.com/jstokke/pi-byteplus-modelark-provider
```

---

## Alternatives and escape hatches

Headless / CI setups can skip `/login` and use an environment variable:

```bash
export BYTEPLUS_API_KEY="ark-…"   # or ARK_API_KEY, the name BytePlus uses
```

Raising the output cap if Pi reports `Response was truncated before completion.`:

```bash
export BYTEPLUS_DEFAULT_MAX_TOKENS=65536
```

Per-model caps go in `~/.pi/agent/byteplus-model-overrides.json`:

```json
{
  "deepseek-v4-pro": { "maxTokens": 200000 },
  "Seed 2.0 Lite":   { "contextWindow": 262144 }
}
```

If BytePlus restructures its docs page, point the discovery at a mirror
rather than waiting for a release:

```bash
export BYTEPLUS_PLAN_DOC_URL="https://mirror.example.com/coding-plan"
export BYTEPLUS_NO_ENRICHMENT=1   # or skip the scrape entirely
```

Every environment variable, the discovery layers, the curated limits and
their provenance, and the troubleshooting messages are documented in
[`src/README.md`](src/README.md).

---

## Notes and limitations

- Built and tested against Pi **0.85.x**. `@earendil-works/pi-coding-agent`
  and `@earendil-works/pi-ai` are optional peer dependencies: Pi provides both
  at runtime, and the extension installs no runtime dependencies of its own.
- I only have a Coding Plan subscription, so that is the only tier this has
  been exercised against. A pay-as-you-go-only key will be rejected by the
  Coding Plan endpoint — that is BytePlus' behaviour, not the extension's.
- BytePlus does not document a model-listing endpoint for the Coding Plan.
  The live `/models` call is therefore treated as best-effort: it is used for
  metadata and as a fallback, never as the authority on what the plan serves.
- Only the OpenAI-compatible wire is registered. The plan also exposes an
  Anthropic-protocol endpoint, but it serves the same models, so registering
  it would just duplicate every entry in the picker.
- The model list is parsed out of a public BytePlus documentation page, and
  the Coding Plan endpoint is undocumented. Either can change without notice;
  `npm run smoke` is what reports drift. BytePlus no longer keeps that docs
  list perfectly current — the Subscription overview points at the console
  for availability — so brand-new plan models can take a release to land in
  the curated list even though the docs scrape still works.
- A model you **activated** in the ModelArk console is not necessarily served
  by the Coding Plan. Activating a platform model (say `glm-5.3-flash`) does
  not add it to the plan: the endpoint answers `404 UnsupportedModel` — "the
  requested model does not support the coding plan feature" — until BytePlus
  enables it plan-side. That is BytePlus' gating, not a bug in this
  extension.

---

## Development

```bash
git clone https://github.com/jstokke/pi-byteplus-modelark-provider.git
cd pi-byteplus-modelark-provider
npm install
npm test          # unit tests, fully mocked, ~0.7s
npm run typecheck
npm run smoke     # parses the live BytePlus docs page
```

To iterate without reinstalling, symlink the source into Pi's extension
directory:

```bash
mkdir -p ~/.pi/agent/extensions
ln -s "$(pwd)/src" ~/.pi/agent/extensions/byteplus
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the project layout and the
conventions this repo cares about.

---

## Disclaimer

Not affiliated with, endorsed by, or sponsored by BytePlus, ByteDance or Zhipu
AI. "BytePlus", "ModelArk", "Seed", "GLM", "Kimi", "DeepSeek" and "GPT-OSS" are
trademarks of their respective owners, used here only to describe what this
extension interoperates with.

The extension targets an undocumented Coding Plan endpoint and parses a public
BytePlus documentation page to discover models. Check that this fits BytePlus'
terms for your own use.

---

## License

[MIT](LICENSE) © Joachim Stokke
