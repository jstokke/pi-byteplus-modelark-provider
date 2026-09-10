/**
 * BytePlus ModelArk provider — core logic (pure, testable, no Pi imports).
 *
 * BytePlus ModelArk Coding Plan API contract
 * (https://docs.byteplus.com/en/docs/ModelArk/1925115):
 *   base (OpenAI protocol)    https://ark.ap-southeast.bytepluses.com/api/coding/v3
 *       POST /chat/completions   — OpenAI Chat Completions wire
 *       GET  /models             — best-effort catalog (availability not documented)
 *   base (Anthropic protocol) https://ark.ap-southeast.bytepluses.com/api/coding
 *
 * The Coding Plan base URL must be used instead of the pay-as-you-go data
 * plane (`/api/v3`); requests sent to the data plane do not consume the
 * plan quota and are billed separately.
 *
 * Invariant: this module never invents request parameters. Compatibility
 * flags below are limited to what BytePlus documents for the Chat API.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Shared root for both protocol bases (`/api`). */
export const API_ROOT = "https://ark.ap-southeast.bytepluses.com/api";
/** Coding Plan root. Anthropic-protocol tools target `{root}/v1/messages`. */
export const CODING_ROOT = `${API_ROOT}/coding`;
/** OpenAI SDK appends /chat/completions to baseUrl. */
export const OPENAI_BASE_URL = `${CODING_ROOT}/v3`;
/** Provider id stored in auth.json and used as the `provider/id` prefix. */
export const PROVIDER_ID = "byteplus";

/**
 * Conservative defaults for fields the Coding Plan does not publish.
 * They exist because Pi's model definition requires them; they are not
 * claims about any model. Curated per-model values live in MODEL_HINTS,
 * and users can raise either cap with
 * ~/.pi/agent/byteplus-model-overrides.json (see loadModelOverrides()).
 *
 * `contextWindow` defaults below what most plan models actually support so
 * Pi compacts early rather than sending an over-long request the model
 * rejects. `maxTokens` is deliberately conservative: an over-large
 * max_tokens is rejected by the API, while an over-small one only costs a
 * retry with a raised override.
 */
export const DEFAULT_CONTEXT_WINDOW = 262144;
export const DEFAULT_MAX_TOKENS = 32768;

/**
 * Reasoning-model output ceiling. Reasoning burns output tokens before the
 * answer starts, so Pi raises "Response was truncated before completion."
 * when the cap is too tight (see the same issue in the Command Code
 * provider). 128k matches what BytePlus publishes for the reasoning models
 * this extension knows about, and is never applied to a model whose real
 * ceiling is smaller (MODEL_HINTS wins, overrides are raise-only).
 */
export const DEFAULT_MAX_TOKENS_REASONING = 131072;

/** Discovery must stay bounded: single attempt, no meaningful retry delay. */
export const DISCOVERY_TIMEOUT_MS = 8000;

/**
 * `compat` block applied to every model this extension publishes.
 *
 * All four flags are required, and all four are grounded in BytePlus docs:
 *
 *   maxTokensField: "max_tokens"
 *     Pi's auto-detection only picks `max_tokens` for a known list of
 *     vendors (deepseek, moonshot, zai, together, …). A custom provider id
 *     like "byteplus" falls through to `max_completion_tokens`, which the
 *     ModelArk Chat API does not accept. BytePlus examples always send
 *     `max_tokens`.
 *
 *   supportsDeveloperRole: false
 *     Pi sends a `developer` role for reasoning models when this is true.
 *     ModelArk expects `system`; only OpenAI's own models use `developer`.
 *
 *   supportsReasoningEffort: true + thinkingFormat: "openai"
 *     The ModelArk Chat API documents `reasoning_effort` on chat/completions
 *     with the values none | minimal | low | medium | high | xhigh | max
 *     (https://docs.byteplus.com/en/docs/ModelArk/1449737), which is exactly
 *     Pi's OpenAI-style reasoning field. "openai" is the format that emits a
 *     bare top-level `reasoning_effort`, so no `thinking` wrapper is sent to
 *     models that do not accept one.
 *
 * `reasoning_effort: "none"` is only documented for glm-5-2-260617; it is
 * therefore emitted per model via thinkingLevelMap (see MODEL_HINTS) and
 * never provider-wide.
 */
export const OPENAI_COMPAT = Object.freeze({
  supportsDeveloperRole: false,
  maxTokensField: "max_tokens",
  supportsReasoningEffort: true,
  thinkingFormat: "openai",
});

/**
 * Curated metadata for the models on the Coding Plan.
 *
 * Sources, in order of preference:
 *   - BytePlus Coding Plan docs (model ids, per
 *     https://docs.byteplus.com/en/docs/ModelArk/2556056)
 *   - BytePlus / Volcengine Ark model catalog context + output limits
 *     (mirrored by https://models.dev → provider `volcengine`, which is the
 *     same Ark catalog)
 *   - BytePlus "deep reasoning" parameter docs for reasoning support
 *     (https://docs.byteplus.com/en/docs/ModelArk/1449737)
 *
 * Rules that keep these numbers safe rather than optimistic:
 *   - `contextWindow` is the published value, except where a plan-specific
 *     limit is smaller, in which case the smaller value wins (compacting a
 *     little early is harmless; an over-long request hard-fails).
 *   - `maxTokens` is capped at DEFAULT_MAX_TOKENS_REASONING (131072) even
 *     where a model advertises more, because an over-large max_tokens is
 *     rejected outright.
 *   - `vision` is only true where the Ark catalog lists image input.
 *
 * Everything here is overridable per model at runtime
 * (`byteplus-model-overrides.json`) or as a whole
 * (`BYTEPLUS_DEFAULT_MAX_TOKENS`).
 */
export const MODEL_HINTS = Object.freeze({
  "ark-code-latest": {
    name: "Ark Code Latest (auto)",
    contextWindow: 262144,
    maxTokens: 65536,
    reasoning: true,
    vision: false,
  },
  "dola-seed-2.0-pro": {
    name: "Seed 2.0 Pro",
    contextWindow: 262144,
    maxTokens: 131072,
    reasoning: true,
    vision: true,
  },
  "dola-seed-2.0-lite": {
    name: "Seed 2.0 Lite",
    contextWindow: 262144,
    maxTokens: 32768,
    reasoning: true,
    vision: true,
  },
  "dola-seed-2.0-code": {
    name: "Seed 2.0 Code",
    contextWindow: 262144,
    maxTokens: 131072,
    reasoning: true,
    vision: true,
  },
  "bytedance-seed-code": {
    name: "ByteDance Seed Code",
    contextWindow: 131072,
    maxTokens: 32768,
    reasoning: true,
    vision: false,
  },
  "glm-5.2": {
    name: "GLM-5.2",
    contextWindow: 200000,
    maxTokens: 131072,
    reasoning: true,
    vision: false,
    // Ark documents `xhigh` and `none` for glm-5-2-260617 only. `off: "none"`
    // gives the user a real "off" that disables deep reasoning server-side.
    thinkingLevelMap: { off: "none", xhigh: "xhigh" },
  },
  "glm-5.1": {
    name: "GLM-5.1",
    contextWindow: 200000,
    maxTokens: 131072,
    reasoning: true,
    vision: false,
  },
  "kimi-k2.5": {
    name: "Kimi K2.5",
    contextWindow: 262144,
    maxTokens: 65536,
    reasoning: true,
    vision: true,
  },
  "gpt-oss-120b": {
    name: "GPT-OSS 120B",
    contextWindow: 131072,
    maxTokens: 32768,
    reasoning: true,
    vision: false,
  },
  "deepseek-v4-flash": {
    name: "DeepSeek V4 Flash",
    contextWindow: 1000000,
    maxTokens: 131072,
    reasoning: true,
    vision: false,
  },
  "deepseek-v4-pro": {
    name: "DeepSeek V4 Pro",
    contextWindow: 1000000,
    maxTokens: 131072,
    reasoning: true,
    vision: false,
  },
});

/**
 * Bundled fallback catalog. Used when both the docs scrape and the live
 * `/models` call fail (offline first run, docs restructure, endpoint
 * removal), so the provider is never empty for an authenticated user.
 */
export const SEED_CATALOG = Object.freeze(Object.keys(MODEL_HINTS));

/**
 * Model ids BytePlus documents for the Coding Plan *outside* the
 * "The following models are supported:" bullet list, so the docs scrape does
 * not pick them up.
 *
 * `ark-code-latest` is the plan's auto-router ("Auto mode is supported, and
 * the model is automatically selected using an intelligent algorithm"); the
 * same docs page quotes it as a value to put in a tool's config
 * (https://docs.byteplus.com/en/docs/ModelArk/2556056). It is appended to a
 * successful scrape rather than replacing it.
 */
export const EXTRA_PLAN_MODELS = Object.freeze(["ark-code-latest"]);

export class DiscoveryError extends Error {
  constructor(message) {
    super(message);
    this.name = "DiscoveryError";
  }
}

export function defaultAuthPath({ env = process.env } = {}) {
  const base = env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  return join(base, "auth.json");
}

/**
 * Read a stored `api_key` credential for `providerId` from Pi's auth.json.
 * Returns undefined when the file, the entry, or the key is missing. The
 * key is never included in any thrown error.
 */
export function readStoredApiKey(providerId, authPath = defaultAuthPath()) {
  try {
    const data = JSON.parse(readFileSync(authPath, "utf8"));
    const cred = data?.[providerId];
    if (cred && cred.type === "api_key" && typeof cred.key === "string" && cred.key !== "") {
      return cred.key;
    }
  } catch {
    // Missing or unreadable auth.json is not fatal; the caller reports a
    // missing-key diagnostic instead.
  }
  return undefined;
}

/** Environment variable names honored for the API key, in priority order. */
export const API_KEY_ENV_VARS = Object.freeze(["BYTEPLUS_API_KEY", "ARK_API_KEY"]);

/**
 * Resolve the ModelArk API key without ever hardcoding it.
 * Order: BYTEPLUS_API_KEY, then ARK_API_KEY (the name BytePlus' own docs and
 * the Ark CLI use), then the stored "byteplus" credential in Pi's auth.json.
 */
export function resolveApiKey({ env = process.env, authPath } = {}) {
  for (const name of API_KEY_ENV_VARS) {
    const value = env[name];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return readStoredApiKey(PROVIDER_ID, authPath);
}

/**
 * Resolve the global maxTokens default.
 * Order: BYTEPLUS_DEFAULT_MAX_TOKENS env var (positive integer), else the
 * compile-time constant for the model class. Invalid env values fall back
 * silently — the constant is always the floor.
 */
export function getDefaultMaxTokens({ env = process.env, reasoning = false } = {}) {
  const raw = env.BYTEPLUS_DEFAULT_MAX_TOKENS;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    // Reject anything that is not pure digits so "12.5" / "1e3" / "abc"
    // fall back to the per-class default rather than being silently
    // truncated by parseInt.
    if (trimmed !== "" && /^[0-9]+$/.test(trimmed)) {
      const n = Number.parseInt(trimmed, 10);
      if (Number.isInteger(n) && n > 0) return n;
    }
  }
  return reasoning ? DEFAULT_MAX_TOKENS_REASONING : DEFAULT_MAX_TOKENS;
}

/** Path to the optional per-model override file (see README). */
export function defaultOverridesPath({ env = process.env } = {}) {
  const base = env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  return join(base, "byteplus-model-overrides.json");
}

/** Positive integer or undefined; everything else is rejected. */
function validatePositiveInt(value) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** Clean a single override entry. Returns undefined if no usable fields. */
function normalizeOverride(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
  const maxTokens = validatePositiveInt(entry.maxTokens);
  const contextWindow = validatePositiveInt(entry.contextWindow);
  if (maxTokens === undefined && contextWindow === undefined) return undefined;
  return { maxTokens, contextWindow };
}

/**
 * Load per-model overrides from JSON. Keys can be exact model ids or
 * normalized display names (whitespace + punctuation stripped, lowercased)
 * so users do not have to match the catalog's formatting exactly. Exact id
 * wins on conflict. Missing file → empty Map. Malformed JSON or a wrong
 * top-level shape logs one line and returns an empty Map; a single bad
 * entry is silently dropped.
 */
export function loadModelOverrides({ path = defaultOverridesPath(), fsImpl = { readFileSync } } = {}) {
  let raw;
  try {
    raw = fsImpl.readFileSync(path, "utf8");
  } catch {
    return new Map();
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error("BytePlus ModelArk: ignoring " + path + ": not valid JSON.");
    return new Map();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.error("BytePlus ModelArk: ignoring " + path + ": expected a JSON object at the top level.");
    return new Map();
  }
  const out = new Map();
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof key !== "string" || key.trim() === "") continue;
    const cleaned = normalizeOverride(value);
    if (!cleaned) continue;
    const exact = key.trim();
    if (!out.has(exact)) out.set(exact, cleaned);
    const normalized = normalizeName(exact);
    if (normalized && !out.has(normalized)) out.set(normalized, cleaned);
  }
  return out;
}

/** Lowercase and strip everything that is not a letter or digit. */
export function normalizeName(name) {
  return String(name ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Create a controller that aborts on the caller's signal OR after
 * `timeoutMs`, so a hung request can never outlive the refresh phase.
 */
function abortScope({ timeoutMs, signal }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
  const onAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    timedOut: () => controller.signal.aborted && !(signal?.aborted ?? false),
    dispose() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

function reasonFor(scope, err) {
  if (scope.timedOut()) return "request timed out";
  if (err instanceof Error && err.message) return err.message;
  return String(err);
}

/**
 * `GET {baseUrl}/models`.
 *
 * BytePlus documents the OpenAI-compatible Chat API for the Coding Plan but
 * does not document a model-listing endpoint, so this call is best-effort:
 * the caller treats a failure as "no metadata available", never as fatal.
 * The gateway authenticates before routing, so 401/403 is the only status
 * that says anything about the key.
 */
export async function fetchCatalog({
  apiKey,
  url = `${OPENAI_BASE_URL}/models`,
  timeoutMs = DISCOVERY_TIMEOUT_MS,
  fetchImpl = fetch,
  signal,
} = {}) {
  if (!apiKey) {
    throw new DiscoveryError(
      "BytePlus ModelArk: no API key resolved (checked BYTEPLUS_API_KEY, ARK_API_KEY, and the stored 'byteplus' credential in auth.json)."
    );
  }

  const scope = abortScope({ timeoutMs, signal });
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: scope.signal,
    });
  } catch (err) {
    throw new DiscoveryError(`BytePlus ModelArk: model discovery failed: ${reasonFor(scope, err)}`);
  } finally {
    scope.dispose();
  }

  if (response.status === 401 || response.status === 403) {
    throw new DiscoveryError(
      `BytePlus ModelArk: authentication failed (HTTP ${response.status}). Check the API key — the key itself is never logged.`
    );
  }
  if (!response.ok) {
    throw new DiscoveryError(`BytePlus ModelArk: model discovery failed: HTTP ${response.status}`);
  }

  let payload;
  try {
    payload = await response.json();
  } catch (err) {
    throw new DiscoveryError(
      `BytePlus ModelArk: model discovery failed: response is not valid JSON (${err instanceof Error ? err.message : String(err)})`
    );
  }
  return parseCatalog(payload);
}

/** Validate and normalize a `GET /models` payload. Throws on malformed input. */
export function parseCatalog(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new DiscoveryError("BytePlus ModelArk: model discovery failed: response is not a JSON object");
  }
  const data = payload.data;
  if (!Array.isArray(data)) {
    throw new DiscoveryError("BytePlus ModelArk: model discovery failed: response is missing a 'data' array");
  }
  const models = [];
  for (const [index, entry] of data.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new DiscoveryError(`BytePlus ModelArk: model discovery failed: data[${index}] is not an object`);
    }
    if (typeof entry.id !== "string" || entry.id.trim() === "") {
      throw new DiscoveryError(`BytePlus ModelArk: model discovery failed: data[${index}] has no model id`);
    }
    models.push({
      id: entry.id.trim(),
      name: typeof entry.name === "string" && entry.name !== "" ? entry.name : undefined,
      contextLength: positiveIntOrUndefined(entry.context_length ?? entry.context_window),
      maxTokens: positiveIntOrUndefined(entry.max_tokens),
    });
  }
  if (models.length === 0) {
    throw new DiscoveryError("BytePlus ModelArk: model discovery failed: catalog is empty");
  }
  return models;
}

function positiveIntOrUndefined(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

/**
 * Does this catalog entry look like a chat model?
 *
 * ModelArk's catalog is a platform catalog, not a Coding Plan catalog: it
 * also lists embedding, rerank, image/video/3D generation, TTS/ASR and
 * translation models. Used only on the fallback path where `/models` — not
 * the documented plan list — is the source of ids.
 */
const NON_CHAT_PATTERNS = [
  "embedding",
  "rerank",
  "seedream",
  "seedance",
  "dreamactor",
  "hitem3d",
  "hyper3d",
  "translation",
  "translator",
  "-tts",
  "-asr",
  "speech",
  "image-generation",
  "-ocr",
];

export function isChatModel(id) {
  const value = String(id ?? "").toLowerCase();
  if (value === "") return false;
  return !NON_CHAT_PATTERNS.some((pattern) => value.includes(pattern));
}

/** Exact curated hint for a model id, or undefined for an unknown model. */
export function getModelHint(id) {
  return Object.prototype.hasOwnProperty.call(MODEL_HINTS, id) ? MODEL_HINTS[id] : undefined;
}

/**
 * Best-effort reasoning capability + thinking-level mapping for a model.
 *
 * The Coding Plan only serves reasoning models (BytePlus advertises deep
 * thinking for the whole line-up, and the Ark catalog marks every one of
 * these families as reasoning-capable), so unknown ids are left alone rather
 * than guessed at — conservative defaults, consistent with the rest of this
 * extension.
 *
 * `thinkingLevelMap` entries follow Pi's semantics: an absent level keeps
 * Pi's default, `null` hides it, and a string is the provider value sent as
 * `reasoning_effort`. Only glm-5.2 gets an explicit map because Ark
 * documents `none`/`xhigh` for that model version alone; Pi hides `xhigh`
 * unless the map contains an entry for it.
 *
 * Returns undefined for models this extension has no evidence about.
 */
export function inferThinking(model) {
  const hint = getModelHint(model?.id);
  if (!hint) return undefined;
  return {
    reasoning: hint.reasoning === true,
    ...(hint.thinkingLevelMap ? { thinkingLevelMap: { ...hint.thinkingLevelMap } } : {}),
  };
}

/**
 * Look up a per-model override by exact id, then by any normalized display
 * name we know for the model (the catalog's own name, or the curated one),
 * so `{"Seed 2.0 Lite": {…}}` matches even when the source that produced
 * the entry never supplied a name.
 */
function lookupOverride(overrides, model, hint) {
  if (!(overrides instanceof Map) || overrides.size === 0) return undefined;
  const byId = overrides.get(model.id);
  if (byId) return byId;
  for (const candidate of [model.name, hint?.name, model.id]) {
    if (typeof candidate !== "string" || candidate === "") continue;
    const hit = overrides.get(normalizeName(candidate));
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Resolve a numeric cap (maxTokens / contextWindow):
 *   1. Curated/API value is authoritative on the LOW end.
 *   2. A per-model override may raise the cap if it is larger.
 *   3. Else the per-class fallback.
 */
function pickCap({ fromApi, overrideEntry, field, fallback }) {
  const raised = overrideEntry ? overrideEntry[field] : undefined;
  if (fromApi !== undefined) {
    return raised !== undefined && raised > fromApi ? raised : fromApi;
  }
  return raised !== undefined ? raised : fallback;
}

/**
 * Convert one catalog entry into a Pi model definition.
 *
 * `entry` may come from the docs scrape (id + optional name), from the live
 * `/models` call (id + optional context/maxTokens), or from SEED_CATALOG.
 * Curated hints fill the gaps; the live API only ever adds information.
 *
 * `overrides` (optional Map from loadModelOverrides) raises maxTokens or
 * contextWindow above whatever resolved. `defaultMaxTokens` (optional) pins
 * the fallback for tests; otherwise getDefaultMaxTokens({ reasoning })
 * selects the per-class default.
 */
export function toPiModel(entry, overrides, defaultMaxTokens, meta) {
  const hint = getModelHint(entry.id);
  const hit = lookupOverride(overrides, entry, hint);
  const thinking = inferThinking(entry);

  const reasoning = thinking ? thinking.reasoning : entry.reasoning === true;
  const fallbackMax = defaultMaxTokens ?? getDefaultMaxTokens({ reasoning });

  // Precedence for each field: curated hint → live API value → conservative
  // default. The hint wins because it is the only source that is scoped to
  // the Coding Plan.
  const contextWindow = pickCap({
    fromApi: hint?.contextWindow ?? entry.contextLength,
    overrideEntry: hit,
    field: "contextWindow",
    fallback: DEFAULT_CONTEXT_WINDOW,
  });
  const maxTokens = pickCap({
    fromApi: hint?.maxTokens ?? entry.maxTokens,
    overrideEntry: hit,
    field: "maxTokens",
    fallback: fallbackMax,
  });

  const vision = typeof entry.vision === "boolean" ? entry.vision : hint?.vision === true;

  return {
    id: entry.id, // BytePlus' exact model id is preserved verbatim.
    name: entry.name ?? hint?.name ?? entry.id,
    // `meta` is stamped by native-provider.mjs when converting a live
    // catalog (or restoring a persisted one); tests may omit it.
    ...(meta ? { provider: meta.provider, api: meta.api, baseUrl: meta.baseUrl } : {}),
    reasoning,
    // Only emit when set — Pi treats an absent map as "provider defaults".
    ...(thinking?.thinkingLevelMap ? { thinkingLevelMap: thinking.thinkingLevelMap } : {}),
    input: vision ? ["text", "image"] : ["text"],
    // The Coding Plan bundles these models into one subscription, so unit
    // pricing is not meaningful for usage tracking. Zeros avoid fabricating
    // costs the user does not actually pay per token.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
    compat: { ...OPENAI_COMPAT },
  };
}

export function toPiModels(entries, overrides, defaultMaxTokens, meta) {
  return entries.map((entry) => toPiModel(entry, overrides, defaultMaxTokens, meta));
}

/**
 * Build the model list from whatever sources are available.
 *
 * Precedence:
 *   1. The plan list scraped from BytePlus' own docs — the only source that
 *      is actually scoped to the Coding Plan, and the reason new plan models
 *      show up without an extension update.
 *   2. The live `/models` catalog, filtered to chat models, when the docs
 *      are unreachable. Metadata-only here: the platform catalog lists
 *      models the Coding Plan does not serve, so it is never merged into a
 *      successful plan list.
 *   3. The bundled seed catalog, so an authenticated user is never left with
 *      an empty provider.
 *
 * `liveModels` is consulted for context/maxTokens on the plan path.
 */
export function buildCatalog({ planModels, liveModels } = {}) {
  const plan = Array.isArray(planModels) ? planModels : [];
  const live = Array.isArray(liveModels) ? liveModels : [];

  if (plan.length > 0) {
    // Keep the published order, then append the ids BytePlus documents
    // outside the list (deduplicated).
    const ordered = [];
    const seen = new Set();
    for (const entry of plan) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      ordered.push(entry);
    }
    for (const id of EXTRA_PLAN_MODELS) {
      if (seen.has(id)) continue;
      seen.add(id);
      ordered.push({ id });
    }

    const liveById = new Map(live.map((entry) => [entry.id, entry]));
    return ordered.map((entry) => {
      const fromLive = liveById.get(entry.id);
      if (!fromLive) return entry;
      return {
        ...entry,
        name: entry.name ?? fromLive.name,
        contextLength: entry.contextLength ?? fromLive.contextLength,
        maxTokens: entry.maxTokens ?? fromLive.maxTokens,
      };
    });
  }

  if (live.length > 0) {
    const chat = live.filter((entry) => isChatModel(entry.id));
    if (chat.length > 0) return chat;
  }

  return SEED_CATALOG.map((id) => ({ id }));
}

/**
 * Validate an API key without ever printing it.
 *
 * `/models` is the cheapest authenticated call available, but BytePlus does
 * not document it, so only an explicit 401/403 rejects the key. Any other
 * outcome (404, 405, 5xx, network error) means "cannot tell", and the login
 * flow keeps the key rather than blocking a valid user on a missing
 * endpoint.
 *
 * Returns { ok: true, verified } — verified is true when the endpoint
 * actually answered.
 */
export async function validateApiKey(apiKey, { fetchImpl = fetch, timeoutMs = DISCOVERY_TIMEOUT_MS, url, signal } = {}) {
  if (typeof apiKey !== "string" || apiKey.trim() === "") {
    return { ok: false, verified: false, reason: "empty API key" };
  }
  try {
    await fetchCatalog({ apiKey: apiKey.trim(), fetchImpl, timeoutMs, url, signal });
    return { ok: true, verified: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/authentication failed \(HTTP 40[13]\)/.test(message)) {
      return { ok: false, verified: true, reason: message };
    }
    // Endpoint missing or unreachable: the key was not rejected.
    return { ok: true, verified: false };
  }
}
