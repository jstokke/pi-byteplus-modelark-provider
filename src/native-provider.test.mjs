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
import { createBytePlusProvider, isEnrichmentDisabled, knownModelCount, resolveKey, resolveSource } from "./native-provider.mjs";

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
    savePlanCacheFn: () => {
      calls.save = (calls.save ?? 0) + 1;
    },
    loadModelOverridesFn: () => overrides ?? new Map(),
    validateApiKeyFn: validate ?? (async () => ({ ok: true, verified: true })),
    readStoredApiKeyFn: () => storedKey,
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
  assert.equal(models[0].name, "GLM 5.2");
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
    overrides: new Map([["glm-5.2", { maxTokens: 250000, contextWindow: 400000 }]]),
  });
  await provider.refreshModels(makeContext({}).context);
  assert.equal(provider.getModels()[0].maxTokens, 250000);
  assert.equal(provider.getModels()[0].contextWindow, 400000);
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
