/**
 * Unit tests for native-provider.mjs.
 *
 * Every dependency is injected: no network, no docs page, no auth.json, no
 * Pi runtime. The provider object is exercised the way Pi drives it —
 * `auth.apiKey.login/check/resolve` and `refreshModels(context)`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { EXTRA_PLAN_MODELS, OPENAI_BASE_URL, PROVIDER_ID, SEED_CATALOG } from "./core.mjs";
import { createBytePlusProvider, formatCatalogChange, isEnrichmentDisabled, knownModelCount, resolveKey, resolveSource } from "./native-provider.mjs";

const SECRET = "ark-secret-do-not-log-4b7c";
const BARE_ENV = {};

/** A successful plan scrape also carries the ids BytePlus documents outside the list. */
const planIds = (...ids) => [...ids, ...EXTRA_PLAN_MODELS];

/** Capture console.error for the duration of `fn`. */
async function captureErrors(fn) {
  const original = console.error;
  const lines = [];
  console.error = (...args) => lines.push(args.map(String).join(" "));
  try {
    await fn();
  } finally {
    console.error = original;
  }
  return lines;
}

/** Drive refreshModels the way Pi's Models collection does. */
function makeContext({ stored, credential, allowNetwork = true, signal, publish } = {}) {
  const publications = [];
  const context = {
    credential,
    stored,
    allowNetwork,
    signal: signal ?? new AbortController().signal,
    publish:
      publish ??
      (async (publication) => {
        publications.push(publication);
        // Pi runs the update callback as part of a committed publication.
        if (typeof publication.update === "function") publication.update();
        return true;
      }),
  };
  return { context, publications };
}

/** A provider wired entirely to fakes. */
function makeProvider({
  planModels,
  planError,
  liveModels = [],
  liveError,
  cache = null,
  overrides,
  validate,
  storedKey,
  env = BARE_ENV,
  calls = {},
  probeModelSupportFn,
  ambientKey,
  ambientCalls = {},
} = {}) {
  return createBytePlusProvider({
    fetchPlanModelsFn: async () => {
      calls.plan = (calls.plan ?? 0) + 1;
      if (planError) throw planError;
      return planModels ?? [];
    },
    fetchCatalogFn: async (options) => {
      calls.live = (calls.live ?? 0) + 1;
      calls.liveApiKey = options?.apiKey;
      calls.liveUrl = options?.url;
      if (liveError) throw liveError;
      return liveModels;
    },
    loadPlanCacheFn: () => cache,
    savePlanCacheFn: (models, meta) => {
      calls.save = (calls.save ?? 0) + 1;
      calls.savedModels = models;
      calls.savedMeta = meta;
    },
    loadModelOverridesFn: () => overrides ?? new Map(),
    validateApiKeyFn: validate ?? (async () => ({ ok: true, verified: true })),
    readStoredApiKeyFn: () => storedKey,
    createAmbientKeySourceFn: () => async () => {
      ambientCalls.spawns = (ambientCalls.spawns ?? 0) + 1;
      return ambientKey;
    },
    probeModelSupportFn:
      probeModelSupportFn ??
      (async (opts) => {
        calls.probed = calls.probed ?? [];
        calls.probed.push(opts?.modelId);
        return false;
      }),
    env,
  });
}

// ─── configuration helpers ───────────────────────────────────────────────────

test("isEnrichmentDisabled only accepts exactly \"1\"", () => {
  assert.equal(isEnrichmentDisabled({ env: { BYTEPLUS_NO_ENRICHMENT: "1" } }), true);
  for (const value of ["0", "true", "", "yes", " 1 "]) {
    assert.equal(isEnrichmentDisabled({ env: { BYTEPLUS_NO_ENRICHMENT: value } }), false, JSON.stringify(value));
  }
  assert.equal(isEnrichmentDisabled({ env: {} }), false);
});

test("knownModelCount matches the curated table", () => {
  assert.equal(knownModelCount(), SEED_CATALOG.length);
});

// ─── key resolution ──────────────────────────────────────────────────────────

test("resolveKey prefers Pi's credential, then auth.json, then env vars", () => {
  assert.equal(
    resolveKey({
      credential: { type: "api_key", key: "from-pi" },
      readStoredApiKeyFn: () => "from-auth-json",
      env: { BYTEPLUS_API_KEY: "from-env", ARK_API_KEY: "from-ark-env" },
    }),
    "from-pi"
  );
  assert.equal(
    resolveKey({ readStoredApiKeyFn: () => "from-auth-json", env: { BYTEPLUS_API_KEY: "from-env" } }),
    "from-auth-json"
  );
  assert.equal(resolveKey({ readStoredApiKeyFn: () => undefined, env: { BYTEPLUS_API_KEY: "from-env" } }), "from-env");
  assert.equal(resolveKey({ readStoredApiKeyFn: () => undefined, env: { ARK_API_KEY: " from-ark " } }), "from-ark");
  assert.equal(resolveKey({ readStoredApiKeyFn: () => undefined, env: { BYTEPLUS_API_KEY: "  ", ARK_API_KEY: "" } }), undefined);
  assert.equal(resolveKey({ credential: { type: "api_key", key: "" }, readStoredApiKeyFn: () => undefined, env: {} }), undefined);
});

test("resolveSource labels the credential for /login", () => {
  assert.equal(resolveSource({ credential: { type: "api_key", key: SECRET }, readStoredApiKeyFn: () => undefined, env: {} }), "stored credential");
  assert.equal(resolveSource({ readStoredApiKeyFn: () => SECRET, env: {} }), "stored credential");
  assert.equal(resolveSource({ readStoredApiKeyFn: () => undefined, env: { BYTEPLUS_API_KEY: SECRET } }), "BYTEPLUS_API_KEY");
  assert.equal(resolveSource({ readStoredApiKeyFn: () => undefined, env: { ARK_API_KEY: SECRET } }), "ARK_API_KEY");
});

// ─── provider shape ──────────────────────────────────────────────────────────

test("the provider advertises the Coding Plan endpoint and wire", () => {
  const provider = makeProvider();
  assert.equal(provider.id, PROVIDER_ID);
  assert.equal(provider.name, "BytePlus ModelArk");
  assert.equal(provider.baseUrl, OPENAI_BASE_URL);
  assert.ok(provider.baseUrl.includes("/api/coding/v3"));
  assert.equal(provider.api, "openai-completions");
  assert.deepEqual(provider.getModels(), []);
  assert.equal(typeof provider.stream, "function");
  assert.equal(typeof provider.streamSimple, "function");
  assert.equal(typeof provider.refreshModels, "function");
});

test("the provider exposes the auth.apiKey block Pi's /login drives", () => {
  const provider = makeProvider();
  assert.equal(typeof provider.auth.apiKey.name, "string");
  assert.equal(typeof provider.auth.apiKey.login, "function");
  assert.equal(typeof provider.auth.apiKey.check, "function");
  assert.equal(typeof provider.auth.apiKey.resolve, "function");
});

test("extraHeaders are attached to the provider and its resolved auth", async () => {
  const provider = createBytePlusProvider({
    extraHeaders: { "x-test": "1" },
    fetchCatalogFn: async () => [],
    loadPlanCacheFn: () => null,
    loadModelOverridesFn: () => new Map(),
    readStoredApiKeyFn: () => SECRET,
    env: BARE_ENV,
  });
  assert.deepEqual(provider.headers, { "x-test": "1" });
  const resolved = await provider.auth.apiKey.resolve({ ctx: {}, credential: { type: "api_key", key: SECRET } });
  assert.deepEqual(resolved.auth, { apiKey: SECRET, headers: { "x-test": "1" } });
});

test("BYTEPLUS_BASE_URL style overrides flow through the constructor", () => {
  const provider = createBytePlusProvider({ baseUrl: "https://mirror.test/api/coding/v3" });
  assert.equal(provider.baseUrl, "https://mirror.test/api/coding/v3");
});

test("a base URL override is normalized and drives the models URL", async () => {
  const calls = {};
  const provider = createBytePlusProvider({
    baseUrl: "https://mirror.test/api/coding/v3///",
    fetchPlanModelsFn: async () => [{ id: "glm-5.2" }],
    fetchCatalogFn: async (options) => {
      calls.liveUrl = options?.url;
      return [];
    },
    loadPlanCacheFn: () => null,
    savePlanCacheFn: () => {},
    loadModelOverridesFn: () => new Map(),
    readStoredApiKeyFn: () => SECRET,
    env: BARE_ENV,
  });
  assert.equal(provider.baseUrl, "https://mirror.test/api/coding/v3");

  const { context } = makeContext({});
  await provider.refreshModels(context);
  assert.equal(calls.liveUrl, "https://mirror.test/api/coding/v3/models");
  assert.equal(provider.getModels()[0].baseUrl, "https://mirror.test/api/coding/v3");
});

// ─── auth: login ─────────────────────────────────────────────────────────────

test("login prompts with a masked secret and validates against /models", async () => {
  const seen = {};
  const provider = makeProvider({
    validate: async (key, options) => {
      seen.key = key;
      seen.options = options;
      return { ok: true, verified: true };
    },
  });
  const prompts = [];
  const credential = await provider.auth.apiKey.login({
    prompt: async (prompt) => {
      prompts.push(prompt);
      return `  ${SECRET}  `;
    },
    signal: new AbortController().signal,
    notify: () => {},
  });

  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].type, "secret");
  assert.equal(seen.key, SECRET, "the key is trimmed before validation");
  assert.equal(seen.options.url, `${OPENAI_BASE_URL}/models`);
  assert.deepEqual(credential, { type: "api_key", key: SECRET });
});

test("login rejects an empty key without validating", async () => {
  const provider = makeProvider({
    validate: async () => {
      throw new Error("should not be called");
    },
  });
  await assert.rejects(
    () => provider.auth.apiKey.login({ prompt: async () => "   ", signal: new AbortController().signal, notify: () => {} }),
    /empty API key/
  );
});

test("login rejects a key BytePlus itself refuses", async () => {
  const provider = makeProvider({ validate: async () => ({ ok: false, verified: true, reason: "401" }) });
  await assert.rejects(
    () => provider.auth.apiKey.login({ prompt: async () => SECRET, signal: new AbortController().signal, notify: () => {} }),
    (err) => {
      assert.match(err.message, /HTTP 401\/403/);
      assert.ok(!err.message.includes(SECRET), "the rejected key must not be echoed back");
      return true;
    }
  );
});

test("login keeps a key when the check is inconclusive (undocumented /models)", async () => {
  const provider = makeProvider({ validate: async () => ({ ok: true, verified: false }) });
  const credential = await provider.auth.apiKey.login({
    prompt: async () => SECRET,
    signal: new AbortController().signal,
    notify: () => {},
  });
  assert.deepEqual(credential, { type: "api_key", key: SECRET });
});

// ─── auth: check / resolve ───────────────────────────────────────────────────

test("check reports the credential source and is undefined when unconfigured", async () => {
  const configured = makeProvider({ storedKey: SECRET });
  assert.deepEqual(await configured.auth.apiKey.check({ ctx: {}, credential: undefined }), {
    type: "api_key",
    source: "stored credential",
  });
  assert.deepEqual(
    await configured.auth.apiKey.check({ ctx: {}, credential: { type: "api_key", key: "x" } }),
    { type: "api_key", source: "stored credential" }
  );

  const viaEnv = makeProvider({ storedKey: undefined, env: { ARK_API_KEY: SECRET } });
  assert.deepEqual(await viaEnv.auth.apiKey.check({ ctx: {}, credential: undefined }), {
    type: "api_key",
    source: "ARK_API_KEY",
  });

  const unconfigured = makeProvider({ storedKey: undefined });
  assert.equal(await unconfigured.auth.apiKey.check({ ctx: {}, credential: undefined }), undefined);
});

test("resolve returns request auth, or undefined when unconfigured", async () => {
  const provider = makeProvider({ storedKey: SECRET });
  const resolved = await provider.auth.apiKey.resolve({ ctx: {}, credential: undefined });
  assert.equal(resolved.auth.apiKey, SECRET);
  assert.equal(resolved.source, "stored credential");

  const empty = makeProvider({ storedKey: undefined });
  assert.equal(await empty.auth.apiKey.resolve({ ctx: {}, credential: undefined }), undefined);
});

// ─── refreshModels ───────────────────────────────────────────────────────────

test("refreshModels republishes a persisted catalog before any network work", async () => {
  let networkCalls = 0;
  const provider = createBytePlusProvider({
    fetchCatalogFn: async () => {
      networkCalls += 1;
      return [];
    },
    fetchPlanModelsFn: async () => {
      networkCalls += 1;
      return [];
    },
    loadPlanCacheFn: () => null,
    loadModelOverridesFn: () => new Map(),
    readStoredApiKeyFn: () => SECRET,
    env: BARE_ENV,
  });

  const { context, publications } = makeContext({
    allowNetwork: false,
    stored: {
      models: [
        { id: "glm-5.2", name: "GLM-5.2", api: "openai-completions", baseUrl: OPENAI_BASE_URL },
        { id: "foreign", provider: "someone-else" },
        { id: "" },
      ],
    },
  });

  await provider.refreshModels(context);

  assert.equal(networkCalls, 0, "the offline phase must not touch the network");
  assert.equal(publications.length, 1);
  assert.deepEqual(provider.getModels().map((m) => m.id), ["glm-5.2"]);
  assert.equal(provider.getModels()[0].provider, PROVIDER_ID);
});

test("refreshModels does nothing without a key", async () => {
  const calls = {};
  const provider = makeProvider({ storedKey: undefined, calls });
  const { context, publications } = makeContext({});
  await provider.refreshModels(context);
  assert.deepEqual(publications, []);
  assert.equal(calls.plan, undefined);
  assert.equal(calls.live, undefined);
});

test("refreshModels stops early when the signal is already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  const calls = {};
  const provider = makeProvider({ storedKey: SECRET, calls });
  const { context, publications } = makeContext({ signal: controller.signal });
  await provider.refreshModels(context);
  assert.deepEqual(publications, []);
  assert.equal(calls.plan, undefined);
});

test("refreshModels publishes the plan list and persists it", async () => {
  const calls = {};
  const provider = makeProvider({
    storedKey: SECRET,
    calls,
    planModels: [{ id: "glm-5.2" }, { id: "brand-new-plan-model" }],
    liveModels: [{ id: "glm-5.2", name: "GLM 5.2", contextLength: 200000, maxTokens: 131072 }],
  });

  const { context, publications } = makeContext({});
  await provider.refreshModels(context);

  const models = provider.getModels();
  assert.deepEqual(models.map((m) => m.id), planIds("glm-5.2", "brand-new-plan-model"));
  assert.equal(models[0].name, "GLM-5.2", "curated name wins over the live catalog's");
  assert.equal(models[0].provider, PROVIDER_ID);
  assert.equal(models[0].api, "openai-completions");
  assert.equal(models[0].baseUrl, OPENAI_BASE_URL);
  assert.equal(models[0].maxTokensField, undefined);
  assert.equal(models[0].compat.maxTokensField, "max_tokens");
  assert.equal(models[0].compat.supportsDeveloperRole, false);
  assert.equal(models[0].compat.supportsReasoningEffort, true);
  assert.equal(models[0].reasoning, true);
  assert.equal(calls.save, 1, "a successful scrape is cached");

  assert.equal(publications.length, 2);
  assert.equal(typeof publications[0].update, "function");
  assert.deepEqual(publications[1].persist.models.map((m) => m.id), planIds("glm-5.2", "brand-new-plan-model"));
  assert.equal(typeof publications[1].persist.checkedAt, "number");
});

test("refreshModels applies per-model overrides", async () => {
  const provider = makeProvider({
    storedKey: SECRET,
    planModels: [{ id: "glm-5.2" }],
    overrides: new Map([["glm-5.2", { maxTokens: 250000, contextWindow: 2000000 }]]),
  });
  await provider.refreshModels(makeContext({}).context);
  assert.equal(provider.getModels()[0].maxTokens, 250000);
  assert.equal(provider.getModels()[0].contextWindow, 2000000);
});

test("refreshModels uses a fresh cache without refetching the docs", async () => {
  const calls = {};
  const cache = { models: [{ id: "kimi-k2.5" }], fetchedAt: Date.now(), stale: false };
  const provider = makeProvider({ storedKey: SECRET, calls, planModels: [{ id: "ignored" }], cache });
  await provider.refreshModels(makeContext({}).context);
  assert.equal(calls.plan, undefined, "a fresh cache must not trigger a docs fetch");
  assert.equal(calls.save, undefined);
  assert.deepEqual(provider.getModels().map((m) => m.id), planIds("kimi-k2.5"));
});

test("refreshModels refreshes and re-caches a stale plan list", async () => {
  const calls = {};
  const cache = { models: [{ id: "stale-model" }], fetchedAt: 1, stale: true };
  const provider = makeProvider({ storedKey: SECRET, calls, planModels: [{ id: "fresh-model" }], cache });
  await provider.refreshModels(makeContext({}).context);
  assert.equal(calls.plan, 1);
  assert.equal(calls.save, 1);
  assert.deepEqual(provider.getModels().map((m) => m.id), planIds("fresh-model"));
});

test("refreshModels falls back to the cached plan list when the docs fail", async () => {
  const cache = { models: [{ id: "cached-model" }], fetchedAt: 1, stale: true };
  const provider = makeProvider({
    storedKey: SECRET,
    cache,
    planError: new Error("BytePlus ModelArk: Coding Plan docs page no longer contains a list"),
  });

  let logs;
  const { context } = makeContext({});
  logs = await captureErrors(() => provider.refreshModels(context));

  assert.deepEqual(provider.getModels().map((m) => m.id), planIds("cached-model"));
  assert.equal(logs.length, 1);
  assert.match(logs[0], /no longer contains/);
  assert.match(logs[0], /using the cached plan list/);
});

test("refreshModels uses the live catalog when the docs fail and no cache exists", async () => {
  const provider = makeProvider({
    storedKey: SECRET,
    planError: new Error("docs down"),
    liveModels: [
      { id: "glm-5.2", contextLength: 200000 },
      { id: "doubao-embedding-large" },
      { id: "dola-seedance-2-0" },
    ],
  });

  const { context } = makeContext({});
  const logs = await captureErrors(() => provider.refreshModels(context));

  assert.deepEqual(provider.getModels().map((m) => m.id), ["glm-5.2"]);
  assert.match(logs[0], /falling back to the live catalog/);
});

test("refreshModels falls back to the bundled list when every source fails", async () => {
  const provider = makeProvider({
    storedKey: SECRET,
    planError: new Error("docs down"),
    liveError: new Error("models endpoint down"),
  });

  const { context } = makeContext({});
  const logs = await captureErrors(() => provider.refreshModels(context));

  assert.deepEqual(provider.getModels().map((m) => m.id), [...SEED_CATALOG]);
  assert.ok(logs.some((line) => /models endpoint down/.test(line)));
  assert.ok(logs.some((line) => /bundled model list/.test(line)));
});

test("refreshModels stays quiet when only the undocumented /models call fails", async () => {
  const provider = makeProvider({
    storedKey: SECRET,
    planModels: [{ id: "glm-5.2" }],
    liveError: new Error("BytePlus ModelArk: model discovery failed: HTTP 404"),
  });

  const { context } = makeContext({});
  const logs = await captureErrors(() => provider.refreshModels(context));

  assert.deepEqual(provider.getModels().map((m) => m.id), planIds("glm-5.2"));
  assert.deepEqual(logs, [], "/models failing alongside a good plan list is expected");
});

test("BYTEPLUS_NO_ENRICHMENT skips the docs scrape", async () => {
  const calls = {};
  const provider = makeProvider({
    storedKey: SECRET,
    calls,
    env: { BYTEPLUS_NO_ENRICHMENT: "1" },
    liveModels: [{ id: "glm-5.2" }, { id: "kimi-k2.5" }],
  });
  await provider.refreshModels(makeContext({}).context);
  assert.equal(calls.plan, undefined, "the docs scrape must be skipped");
  assert.deepEqual(provider.getModels().map((m) => m.id), ["glm-5.2", "kimi-k2.5"]);
});

test("BYTEPLUS_NO_ENRICHMENT still prefers a cached plan list", async () => {
  const calls = {};
  const cache = { models: [{ id: "cached-model" }], fetchedAt: 1, stale: true };
  const provider = makeProvider({
    storedKey: SECRET,
    calls,
    cache,
    env: { BYTEPLUS_NO_ENRICHMENT: "1" },
    liveModels: [{ id: "live-model" }],
  });
  await provider.refreshModels(makeContext({}).context);
  assert.equal(calls.plan, undefined);
  assert.deepEqual(provider.getModels().map((m) => m.id), planIds("cached-model"));
});

test("refreshModels does not persist when publish cancels the update", async () => {
  const provider = makeProvider({ storedKey: SECRET, planModels: [{ id: "glm-5.2" }] });
  const { context, publications } = makeContext({
    publish: async (publication) => {
      publications.push(publication);
      return false;
    },
  });
  await provider.refreshModels(context);
  assert.equal(publications.length, 1);
  assert.equal(publications[0].persist, undefined);
});

test("refreshModels keeps the previous catalog when the plan list is empty and live fails", async () => {
  const provider = makeProvider({ storedKey: SECRET, planModels: [], liveError: new Error("offline") });
  const { context } = makeContext({});
  await captureErrors(() => provider.refreshModels(context));
  // buildCatalog falls back to the seed list rather than producing nothing.
  assert.equal(provider.getModels().length, SEED_CATALOG.length);
});

test("refreshModels resolves the key from the Pi credential first and targets the Coding Plan base", async () => {
  const calls = {};
  const env = { BYTEPLUS_API_KEY: "from-env" };
  const provider = makeProvider({ storedKey: "from-auth-json", env, calls, planModels: [{ id: "glm-5.2" }] });
  await provider.refreshModels(makeContext({ credential: { type: "api_key", key: "from-pi" } }).context);
  assert.equal(calls.liveApiKey, "from-pi");
  assert.equal(calls.liveUrl, `${OPENAI_BASE_URL}/models`);
  assert.deepEqual(provider.getModels().map((m) => m.id), planIds("glm-5.2"));
});

test("refreshModels falls back to env keys for headless setups", async () => {
  const calls = {};
  const provider = makeProvider({ storedKey: undefined, env: { ARK_API_KEY: SECRET }, calls, planModels: [{ id: "glm-5.2" }] });
  await provider.refreshModels(makeContext({}).context);
  assert.equal(calls.liveApiKey, SECRET);
});

// ─── dynamic discovery & probing ─────────────────────────────────────────────

test("refreshModels probes unlisted live chat models and includes verified ones in catalog", async () => {
  const calls = {};
  const provider = makeProvider({
    storedKey: SECRET,
    calls,
    planModels: [{ id: "glm-5.2" }],
    liveModels: [
      { id: "glm-5.2" },
      { id: "glm-5.3-flash", name: "glm-5.3-flash", contextLength: 128000, maxTokens: 8192 },
      { id: "unsupported-chat-model", name: "unsupported-chat-model" },
      { id: "doubao-embedding-large" },
    ],
    probeModelSupportFn: async ({ modelId, apiKey, baseUrl }) => {
      calls.probed = calls.probed ?? [];
      calls.probed.push({ modelId, apiKey, baseUrl });
      return modelId === "glm-5.3-flash";
    },
  });

  const { context } = makeContext({});
  await provider.refreshModels(context);

  assert.deepEqual(calls.probed.map((p) => p.modelId), ["glm-5.3-flash", "unsupported-chat-model"]);
  assert.equal(calls.probed[0].apiKey, SECRET);
  assert.equal(calls.probed[0].baseUrl, OPENAI_BASE_URL);

  const modelIds = provider.getModels().map((m) => m.id);
  assert.deepEqual(modelIds, [...planIds("glm-5.2"), "glm-5.3-flash"]);
  assert.ok(!modelIds.includes("unsupported-chat-model"));

  assert.equal(calls.save, 1);
  assert.deepEqual(calls.savedMeta.verifiedModels, ["glm-5.3-flash"]);
  assert.deepEqual(calls.savedMeta.unsupportedModels, ["unsupported-chat-model"]);
});

test("refreshModels does not re-probe models already cached as verified or unsupported", async () => {
  const calls = {};
  const cache = {
    models: [{ id: "glm-5.2" }],
    fetchedAt: Date.now(),
    stale: false,
    verifiedModels: ["previously-verified-model"],
    unsupportedModels: ["previously-unsupported-model"],
  };
  const provider = makeProvider({
    storedKey: SECRET,
    calls,
    cache,
    liveModels: [
      { id: "glm-5.2" },
      { id: "previously-verified-model", contextLength: 64000 },
      { id: "previously-unsupported-model" },
    ],
    probeModelSupportFn: async (opts) => {
      calls.probed = calls.probed ?? [];
      calls.probed.push(opts.modelId);
      return true;
    },
  });

  await provider.refreshModels(makeContext({}).context);

  assert.equal(calls.probed, undefined);
  assert.equal(calls.save, undefined);

  const modelIds = provider.getModels().map((m) => m.id);
  assert.deepEqual(modelIds, [...planIds("glm-5.2"), "previously-verified-model"]);
  assert.ok(!modelIds.includes("previously-unsupported-model"));
  assert.equal(provider.getModels().find((m) => m.id === "previously-verified-model")?.contextWindow, 64000);
});

test("BYTEPLUS_NO_PROBE skips dynamic model probing", async () => {
  const calls = {};
  const provider = makeProvider({
    storedKey: SECRET,
    calls,
    env: { BYTEPLUS_NO_PROBE: "1" },
    planModels: [{ id: "glm-5.2" }],
    liveModels: [{ id: "unlisted-chat-model" }],
    probeModelSupportFn: async (opts) => {
      calls.probed = calls.probed ?? [];
      calls.probed.push(opts.modelId);
      return true;
    },
  });

  await provider.refreshModels(makeContext({}).context);

  assert.equal(calls.probed, undefined);
  assert.ok(!provider.getModels().some((m) => m.id === "unlisted-chat-model"));
});

test("refreshModels handles probe errors gracefully", async () => {
  const calls = {};
  const provider = makeProvider({
    storedKey: SECRET,
    calls,
    planModels: [{ id: "glm-5.2" }],
    liveModels: [{ id: "failing-model" }],
    probeModelSupportFn: async () => {
      throw new Error("network probe failure");
    },
  });

  await provider.refreshModels(makeContext({}).context);
  assert.deepEqual(provider.getModels().map((m) => m.id), planIds("glm-5.2"));
});

// ─── secret hygiene ──────────────────────────────────────────────────────────

test("no runtime error path includes the API key", async () => {
  const provider = makeProvider({
    storedKey: SECRET,
    planError: new Error("plan failed"),
    liveError: new Error("live failed"),
  });
  const logs = await captureErrors(() => provider.refreshModels(makeContext({}).context));
  for (const line of logs) assert.ok(!line.includes(SECRET), line);

  const rejected = makeProvider({ validate: async () => ({ ok: false, verified: true }) });
  await assert.rejects(
    () => rejected.auth.apiKey.login({ prompt: async () => SECRET, signal: new AbortController().signal, notify: () => {} }),
    (err) => {
      assert.ok(!err.message.includes(SECRET));
      return true;
    }
  );
});

// ─── auth: SSO via arkcli ────────────────────────────────────────────────────

test("the provider exposes the SSO oauth block alongside the API-key block", () => {
  const provider = makeProvider();
  assert.equal(typeof provider.auth.apiKey.login, "function");
  assert.equal(provider.auth.oauth.name, "BytePlus ModelArk (SSO)");
  assert.equal(provider.auth.oauth.loginLabel, "Sign in with BytePlus SSO (arkcli)");
  assert.equal(provider.auth.oauth.isSubscription, true);
  assert.equal(typeof provider.auth.oauth.login, "function");
  assert.equal(typeof provider.auth.oauth.refresh, "function");
  assert.equal(typeof provider.auth.oauth.toAuth, "function");
});

test("the OAuth factory is injectable and receives the models URL", () => {
  const seen = {};
  const fakeOAuth = { name: "fake", login: async () => ({}), refresh: async () => ({}), toAuth: async () => ({}) };
  const provider = createBytePlusProvider({
    baseUrl: "https://mirror.test/api/coding/v3",
    createOAuthFn: (options) => {
      seen.options = options;
      return fakeOAuth;
    },
    fetchCatalogFn: async () => [],
    loadPlanCacheFn: () => null,
    loadModelOverridesFn: () => new Map(),
    readStoredApiKeyFn: () => undefined,
    env: BARE_ENV,
  });
  assert.equal(provider.auth.oauth, fakeOAuth);
  assert.equal(seen.options.modelsUrl, "https://mirror.test/api/coding/v3/models");
  assert.equal(typeof seen.options.validateApiKeyFn, "function");
});

test("extraHeaders flow into the OAuth request auth", async () => {
  const captured = {};
  const provider = createBytePlusProvider({
    extraHeaders: { "x-test": "1" },
    createOAuthFn: (options) => {
      captured.options = options;
      return { name: "fake" };
    },
    fetchCatalogFn: async () => [],
    loadPlanCacheFn: () => null,
    loadModelOverridesFn: () => new Map(),
    readStoredApiKeyFn: () => undefined,
    env: BARE_ENV,
  });
  assert.deepEqual(captured.options.extraHeaders, { "x-test": "1" });
  assert.equal(provider.auth.oauth.name, "fake");
});

// ─── auth: ambient arkcli key ────────────────────────────────────────────────

test("resolve falls back to the ambient arkcli key with source arkcli", async () => {
  const ambientCalls = {};
  const provider = makeProvider({ ambientKey: SECRET, ambientCalls });
  const resolved = await provider.auth.apiKey.resolve({ ctx: {}, credential: undefined });
  assert.deepEqual(resolved, { auth: { apiKey: SECRET }, source: "arkcli" });
  assert.equal(ambientCalls.spawns, 1);
});

test("explicit sources win over ambient without consulting it", async () => {
  const ambientCalls = {};
  const provider = makeProvider({
    storedKey: "from-auth-json",
    env: { BYTEPLUS_API_KEY: "from-env" },
    ambientKey: SECRET,
    ambientCalls,
  });
  const resolved = await provider.auth.apiKey.resolve({ ctx: {}, credential: undefined });
  assert.equal(resolved.auth.apiKey, "from-auth-json");
  assert.equal(resolved.source, "stored credential");
  assert.equal(ambientCalls.spawns ?? 0, 0);
});

test("ambient extraHeaders are attached to the resolved auth", async () => {
  const provider = createBytePlusProvider({
    extraHeaders: { "x-test": "1" },
    createAmbientKeySourceFn: () => async () => SECRET,
    fetchCatalogFn: async () => [],
    loadPlanCacheFn: () => null,
    loadModelOverridesFn: () => new Map(),
    readStoredApiKeyFn: () => undefined,
    env: BARE_ENV,
  });
  const resolved = await provider.auth.apiKey.resolve({ ctx: {}, credential: undefined });
  assert.deepEqual(resolved.auth, { apiKey: SECRET, headers: { "x-test": "1" } });
  assert.equal(resolved.source, "arkcli");
});

test("check reports the ambient key, and undefined when absent", async () => {
  const withKey = makeProvider({ ambientKey: SECRET });
  assert.deepEqual(await withKey.auth.apiKey.check({ ctx: {}, credential: undefined }), {
    type: "api_key",
    source: "arkcli",
  });
  const withoutKey = makeProvider({});
  assert.equal(await withoutKey.auth.apiKey.check({ ctx: {}, credential: undefined }), undefined);
  assert.equal(await withoutKey.auth.apiKey.resolve({ ctx: {}, credential: undefined }), undefined);
});

test("BYTEPLUS_NO_ARKCLI=1 disables the ambient fallback", async () => {
  const provider = createBytePlusProvider({
    fetchCatalogFn: async () => [],
    loadPlanCacheFn: () => null,
    loadModelOverridesFn: () => new Map(),
    readStoredApiKeyFn: () => undefined,
    arkCliRunFn: async () => {
      throw new Error("must not spawn");
    },
    env: { BYTEPLUS_NO_ARKCLI: "1" },
  });
  assert.equal(await provider.auth.apiKey.resolve({ ctx: {}, credential: undefined }), undefined);
  assert.equal(await provider.auth.apiKey.check({ ctx: {}, credential: undefined }), undefined);
});

test("refreshModels uses the ambient key for the live catalog", async () => {
  const calls = {};
  const provider = makeProvider({ planModels: [{ id: "glm-5.2" }], ambientKey: SECRET, calls });
  const { context } = makeContext({});
  await provider.refreshModels(context);
  assert.equal(calls.liveApiKey, SECRET);
  assert.ok(provider.getModels().some((m) => m.id === "glm-5.2"));
});

// ─── catalog-change notice ───────────────────────────────────────────────────

/** A persisted snapshot shaped the way this extension writes it. */
const storedFrom = (...ids) => ({ models: planIds(...ids).map((id) => ({ id })) });

test("formatCatalogChange lists added and removed ids in one line", () => {
  const both = formatCatalogChange(["new-model"], ["old-model"]);
  assert.match(both, /added new-model/);
  assert.match(both, /removed old-model/);
  assert.match(both, /BytePlus ModelArk:/);
  assert.ok(!both.includes("\n"), "the notice stays a single line");
});

test("formatCatalogChange covers one-sided changes and elides long lists", () => {
  const addedOnly = formatCatalogChange(["a"], []);
  assert.match(addedOnly, /added a/);
  assert.ok(!addedOnly.includes("removed"));

  const removedOnly = formatCatalogChange([], ["b"]);
  assert.match(removedOnly, /removed b/);
  assert.ok(!removedOnly.includes("added"));

  const many = formatCatalogChange(["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8"], []);
  assert.match(many, /added a1, a2, a3, a4, a5, a6 \(\+2 more\)/);
});

test("refreshModels reports a catalog that gained and lost models", async () => {
  const provider = makeProvider({
    storedKey: SECRET,
    planModels: [{ id: "glm-5.2" }, { id: "new-model" }],
    liveModels: [],
  });
  const { context } = makeContext({ stored: storedFrom("glm-5.2", "retired-model") });
  const logs = await captureErrors(() => provider.refreshModels(context));

  assert.equal(logs.length, 1);
  assert.match(logs[0], /added new-model/);
  assert.match(logs[0], /removed retired-model/);
  assert.ok(!logs[0].includes(SECRET));
});

test("refreshModels stays quiet when the catalog is unchanged", async () => {
  const provider = makeProvider({ storedKey: SECRET, planModels: [{ id: "glm-5.2" }], liveModels: [] });
  const { context } = makeContext({ stored: storedFrom("glm-5.2") });
  const logs = await captureErrors(() => provider.refreshModels(context));
  assert.deepEqual(logs, []);
});

test("refreshModels does not announce a catalog on the very first run", async () => {
  const provider = makeProvider({ storedKey: SECRET, planModels: planIds("glm-5.2").map((id) => ({ id })), liveModels: [] });
  const { context } = makeContext({});
  const logs = await captureErrors(() => provider.refreshModels(context));
  assert.deepEqual(logs, [], "no baseline means nothing to compare against");
});

test("refreshModels suppresses the notice when the live catalog failed", async () => {
  // A failed /models call drops dynamically verified ids from the published
  // list, so a diff would report false removals.
  const provider = makeProvider({
    storedKey: SECRET,
    planModels: [{ id: "glm-5.2" }],
    liveError: new Error("models endpoint down"),
  });
  const { context } = makeContext({ stored: storedFrom("glm-5.2", "verified-model") });
  const logs = await captureErrors(() => provider.refreshModels(context));
  assert.deepEqual(logs, []);
});

test("refreshModels suppresses the notice when it fell back to the seed list", async () => {
  const provider = makeProvider({
    storedKey: SECRET,
    planError: new Error("docs down"),
    liveError: new Error("models endpoint down"),
  });
  const { context } = makeContext({ stored: storedFrom("glm-5.2") });
  const logs = await captureErrors(() => provider.refreshModels(context));
  assert.ok(!logs.some((line) => /model list changed/.test(line)));
  assert.ok(logs.some((line) => /bundled model list/.test(line)), "the degraded path still reports itself");
});

test("refreshModels announces a catalog change only once per session", async () => {
  const provider = makeProvider({
    storedKey: SECRET,
    planModels: [{ id: "glm-5.2" }, { id: "new-model" }],
    liveModels: [],
  });
  const { context } = makeContext({ stored: storedFrom("glm-5.2") });
  const logs = await captureErrors(async () => {
    await provider.refreshModels(context);
    await provider.refreshModels(context);
  });
  assert.equal(logs.filter((line) => /model list changed/.test(line)).length, 1);
});

test("the persisted snapshot is republished offline without a change notice", async () => {
  const provider = createBytePlusProvider({
    fetchCatalogFn: async () => [],
    fetchPlanModelsFn: async () => [],
    loadPlanCacheFn: () => null,
    loadModelOverridesFn: () => new Map(),
    readStoredApiKeyFn: () => SECRET,
    env: BARE_ENV,
  });
  const { context } = makeContext({ allowNetwork: false, stored: storedFrom("glm-5.2") });
  const logs = await captureErrors(() => provider.refreshModels(context));
  assert.deepEqual(logs, [], "the offline restore is not a catalog change");
  assert.deepEqual(provider.getModels().map((m) => m.id), planIds("glm-5.2"));
});
