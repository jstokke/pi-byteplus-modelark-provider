/**
 * Unit tests for core.mjs.
 *
 * Everything is mocked — no network, no filesystem, no Pi runtime. The
 * secret-hygiene block at the bottom asserts that no error path ever echoes
 * the API key.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  API_KEY_ENV_VARS,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MAX_TOKENS_REASONING,
  DiscoveryError,
  EXTRA_PLAN_MODELS,
  MODEL_HINTS,
  OPENAI_BASE_URL,
  OPENAI_COMPAT,
  PROVIDER_ID,
  SEED_CATALOG,
  buildCatalog,
  defaultAuthPath,
  defaultOverridesPath,
  diffModelIds,
  fetchCatalog,
  getDefaultMaxTokens,
  getModelHint,
  inferThinking,
  isChatModel,
  isUsableLiveModel,
  loadModelOverrides,
  normalizeModelId,
  normalizeName,
  parseCatalog,
  probeModelSupport,
  readStoredApiKey,
  resolveApiKey,
  toPiModel,
  toPiModels,
  validateApiKey,
} from "./core.mjs";

const SECRET = "ark-secret-do-not-log-9f3a";

function tmpDir() {
  return mkdtempSync(join(tmpdir(), "byteplus-core-"));
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}

function textResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return body;
    },
    async json() {
      return JSON.parse(body);
    },
  };
}

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

// ─── constants ───────────────────────────────────────────────────────────────

test("base URLs point at the Coding Plan, not the pay-as-you-go data plane", () => {
  assert.equal(OPENAI_BASE_URL, "https://ark.ap-southeast.bytepluses.com/api/coding/v3");
  assert.ok(!OPENAI_BASE_URL.includes("/api/v3"), "data-plane URL must not be the default");
  assert.equal(PROVIDER_ID, "byteplus");
});

test("compat block matches what the ModelArk Chat API documents", () => {
  assert.equal(OPENAI_COMPAT.maxTokensField, "max_tokens");
  assert.equal(OPENAI_COMPAT.supportsDeveloperRole, false);
  assert.equal(OPENAI_COMPAT.supportsReasoningEffort, true);
  assert.equal(OPENAI_COMPAT.thinkingFormat, "openai");
});

test("conservative defaults stay below the curated reasoning ceiling", () => {
  assert.ok(DEFAULT_MAX_TOKENS > 0);
  assert.equal(DEFAULT_MAX_TOKENS_REASONING, 131072);
  assert.ok(DEFAULT_CONTEXT_WINDOW >= 128000);
  assert.ok(DEFAULT_MAX_TOKENS < DEFAULT_MAX_TOKENS_REASONING);
});

test("seed catalog mirrors the curated hints", () => {
  assert.deepEqual([...SEED_CATALOG].sort(), Object.keys(MODEL_HINTS).sort());
  assert.ok(SEED_CATALOG.includes("ark-code-latest"));
});

// ─── auth paths ──────────────────────────────────────────────────────────────

test("defaultAuthPath honours PI_CODING_AGENT_DIR", () => {
  const path = defaultAuthPath({ env: { PI_CODING_AGENT_DIR: "/custom/agent" } });
  assert.equal(path, join("/custom/agent", "auth.json"));
});

test("defaultAuthPath falls back to ~/.pi/agent", () => {
  assert.ok(defaultAuthPath({ env: {} }).endsWith(join(".pi", "agent", "auth.json")));
});

test("defaultOverridesPath lives beside auth.json", () => {
  assert.equal(
    defaultOverridesPath({ env: { PI_CODING_AGENT_DIR: "/custom/agent" } }),
    join("/custom/agent", "byteplus-model-overrides.json")
  );
});

test("readStoredApiKey reads a stored byteplus credential", () => {
  const dir = tmpDir();
  const authPath = join(dir, "auth.json");
  writeFileSync(authPath, JSON.stringify({ byteplus: { type: "api_key", key: SECRET } }));
  try {
    assert.equal(readStoredApiKey(PROVIDER_ID, authPath), SECRET);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readStoredApiKey ignores wrong credential shapes and missing files", () => {
  const dir = tmpDir();
  try {
    const cases = {
      "oauth.json": JSON.stringify({ byteplus: { type: "oauth", access: SECRET } }),
      "empty.json": JSON.stringify({ byteplus: { type: "api_key", key: "" } }),
      "other.json": JSON.stringify({ "command-code": { type: "api_key", key: SECRET } }),
      "broken.json": "{ not json",
    };
    for (const [name, body] of Object.entries(cases)) {
      const p = join(dir, name);
      writeFileSync(p, body);
      assert.equal(readStoredApiKey(PROVIDER_ID, p), undefined, name);
    }
    assert.equal(readStoredApiKey(PROVIDER_ID, join(dir, "missing.json")), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveApiKey prefers BYTEPLUS_API_KEY, then ARK_API_KEY, then auth.json", () => {
  const dir = tmpDir();
  const authPath = join(dir, "auth.json");
  writeFileSync(authPath, JSON.stringify({ byteplus: { type: "api_key", key: "stored-key" } }));
  try {
    assert.equal(resolveApiKey({ env: { BYTEPLUS_API_KEY: "b-1", ARK_API_KEY: "a-1" }, authPath }), "b-1");
    assert.equal(resolveApiKey({ env: { ARK_API_KEY: "a-1" }, authPath }), "a-1");
    assert.equal(resolveApiKey({ env: {}, authPath }), "stored-key");
    assert.equal(resolveApiKey({ env: { BYTEPLUS_API_KEY: "   ", ARK_API_KEY: "" }, authPath }), "stored-key");
    assert.equal(resolveApiKey({ env: {}, authPath: join(dir, "nope.json") }), undefined);
    assert.equal(resolveApiKey({ env: { BYTEPLUS_API_KEY: "  padded  " }, authPath }), "padded");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("API_KEY_ENV_VARS documents the supported names", () => {
  assert.deepEqual([...API_KEY_ENV_VARS], ["BYTEPLUS_API_KEY", "ARK_API_KEY"]);
});

// ─── maxTokens defaults ──────────────────────────────────────────────────────

test("getDefaultMaxTokens selects a per-class default", () => {
  assert.equal(getDefaultMaxTokens({ env: {}, reasoning: false }), DEFAULT_MAX_TOKENS);
  assert.equal(getDefaultMaxTokens({ env: {}, reasoning: true }), DEFAULT_MAX_TOKENS_REASONING);
  assert.equal(getDefaultMaxTokens({ env: {} }), DEFAULT_MAX_TOKENS);
});

test("getDefaultMaxTokens honours a valid env override", () => {
  assert.equal(getDefaultMaxTokens({ env: { BYTEPLUS_DEFAULT_MAX_TOKENS: "65536" } }), 65536);
  assert.equal(getDefaultMaxTokens({ env: { BYTEPLUS_DEFAULT_MAX_TOKENS: " 4096 " } }), 4096);
});

test("getDefaultMaxTokens silently rejects invalid env values", () => {
  for (const bad of ["0", "-1", "12.5", "1e3", "abc", "", "   ", "0x10", "99999999999999999999x"]) {
    const value = getDefaultMaxTokens({ env: { BYTEPLUS_DEFAULT_MAX_TOKENS: bad }, reasoning: true });
    assert.equal(value, DEFAULT_MAX_TOKENS_REASONING, `env=${JSON.stringify(bad)}`);
  }
});

// ─── overrides ───────────────────────────────────────────────────────────────

test("loadModelOverrides returns an empty Map for a missing file", () => {
  assert.equal(loadModelOverrides({ path: "/nope/missing.json" }).size, 0);
});

test("loadModelOverrides reads ids and normalizes display-name keys", () => {
  const dir = tmpDir();
  const p = join(dir, "o.json");
  writeFileSync(p, JSON.stringify({ "deepseek-v4-pro": { maxTokens: 200000 }, "Seed 2.0 Lite": { contextWindow: 100000 } }));
  try {
    const map = loadModelOverrides({ path: p });
    assert.deepEqual(map.get("deepseek-v4-pro"), { maxTokens: 200000, contextWindow: undefined });
    assert.deepEqual(map.get("seed20lite"), { maxTokens: undefined, contextWindow: 100000 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadModelOverrides drops invalid entries and reports malformed files", async () => {
  const dir = tmpDir();
  try {
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{ nope");
    let lines = await captureErrors(() => {
      assert.equal(loadModelOverrides({ path: bad }).size, 0);
    });
    assert.equal(lines.length, 1);
    assert.match(lines[0], /not valid JSON/);

    const arr = join(dir, "arr.json");
    writeFileSync(arr, JSON.stringify([1, 2]));
    lines = await captureErrors(() => {
      assert.equal(loadModelOverrides({ path: arr }).size, 0);
    });
    assert.match(lines[0], /expected a JSON object/);

    const mixed = join(dir, "mixed.json");
    writeFileSync(
      mixed,
      JSON.stringify({
        "": { maxTokens: 10 },
        good: { maxTokens: 10 },
        bad: { maxTokens: -5 },
        worse: { maxTokens: 1.5 },
        "no-fields": { other: 1 },
      })
    );
    const map = loadModelOverrides({ path: mixed });
    assert.deepEqual([...map.keys()], ["good"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("normalizeName strips punctuation and case", () => {
  assert.equal(normalizeName("Seed 2.0 Lite"), "seed20lite");
  assert.equal(normalizeName(undefined), "");
});

// ─── catalog parsing ─────────────────────────────────────────────────────────

test("parseCatalog normalizes a well-formed payload", () => {
  const models = parseCatalog({
    data: [
      { id: "glm-5.2", name: "GLM 5.2", context_length: 200000, max_tokens: 131072 },
      { id: " kimi-k2.5 " },
      { id: "seed", context_window: 256000, max_tokens: "big" },
    ],
  });
  assert.deepEqual(models[0], {
    id: "glm-5.2",
    name: "GLM 5.2",
    contextLength: 200000,
    maxTokens: 131072,
  });
  assert.equal(models[1].id, "kimi-k2.5");
  assert.equal(models[1].contextLength, undefined);
  assert.equal(models[2].contextLength, 256000);
  assert.equal(models[2].maxTokens, undefined);
});

test("parseCatalog reads BytePlus' live token_limits/modalities/status shape", () => {
  const models = parseCatalog({
    data: [
      {
        id: "glm-5-2-260617",
        name: "glm-5.2",
        status: "Active",
        modalities: { input_modalities: ["text", "image"], output_modalities: ["text"] },
        token_limits: {
          context_window: 1048576,
          max_input_token_length: 1048576,
          max_output_token_length: 131072,
          max_reasoning_token_length: 131072,
        },
      },
      {
        id: "seedream-4-0-250828",
        domain: "ImageGeneration",
        task_type: ["TextToImage"],
        token_limits: {},
      },
    ],
  });
  assert.deepEqual(models[0], {
    id: "glm-5-2-260617",
    name: "glm-5.2",
    contextLength: 1048576,
    maxTokens: 131072,
    vision: true,
    reasoning: true,
    status: "active",
  });
  // No image input, no reasoning budget, no status → fields omitted.
  assert.deepEqual(models[1], { id: "seedream-4-0-250828", name: undefined });
});

test("normalizeModelId maps plan aliases onto versioned platform ids", () => {
  assert.equal(normalizeModelId("glm-5.2"), "glm-5-2");
  assert.equal(normalizeModelId("glm-5-2-260617"), "glm-5-2");
  assert.equal(normalizeModelId("deepseek-v4-flash"), "deepseek-v4-flash");
  assert.equal(normalizeModelId("deepseek-v4-flash-260425"), "deepseek-v4-flash");
  assert.equal(normalizeModelId("deepseek-v4-flash-ga-260731"), "deepseek-v4-flash-ga");
  // The 'b' in 120b is not a version suffix; the date suffix is.
  assert.equal(normalizeModelId("gpt-oss-120b-250805"), "gpt-oss-120b");
  assert.equal(normalizeModelId(undefined), "");
});

test("isUsableLiveModel drops non-chat and retired entries, keeps unknown status", () => {
  assert.equal(isUsableLiveModel({ id: "glm-5-2-260617", status: "active" }), true);
  assert.equal(isUsableLiveModel({ id: "glm-5-2-260617" }), true, "no status field passes (fixtures)");
  assert.equal(isUsableLiveModel({ id: "deepseek-r1-250120", status: "Shutdown" }), false);
  assert.equal(isUsableLiveModel({ id: "skylark-pro", status: "Retiring" }), false);
  assert.equal(isUsableLiveModel({ id: "doubao-embedding-large", status: "active" }), false);
  assert.equal(isUsableLiveModel(null), false);
});

test("parseCatalog rejects malformed payloads", () => {
  const cases = [
    [null, /not a JSON object/],
    [[], /not a JSON object/],
    [{}, /missing a 'data' array/],
    [{ data: {} }, /missing a 'data' array/],
    [{ data: [null] }, /data\[0\] is not an object/],
    [{ data: [{}] }, /has no model id/],
    [{ data: [{ id: "  " }] }, /has no model id/],
    [{ data: [] }, /catalog is empty/],
  ];
  for (const [payload, pattern] of cases) {
    assert.throws(() => parseCatalog(payload), pattern, JSON.stringify(payload));
  }
});

// ─── fetchCatalog ────────────────────────────────────────────────────────────

test("fetchCatalog requires a key", async () => {
  await assert.rejects(() => fetchCatalog({ apiKey: undefined }), /no API key resolved/);
  await assert.rejects(() => fetchCatalog({ apiKey: "" }), /no API key resolved/);
});

test("fetchCatalog sends a bearer token and parses the payload", async () => {
  let seen;
  const models = await fetchCatalog({
    apiKey: SECRET,
    fetchImpl: async (url, init) => {
      seen = { url, init };
      return jsonResponse(200, { data: [{ id: "glm-5.2" }] });
    },
  });
  assert.equal(seen.url, `${OPENAI_BASE_URL}/models`);
  assert.equal(seen.init.headers.Authorization, `Bearer ${SECRET}`);
  assert.deepEqual(models.map((m) => m.id), ["glm-5.2"]);
});

test("fetchCatalog reports auth failures by status, not by key", async () => {
  for (const status of [401, 403]) {
    await assert.rejects(
      () => fetchCatalog({ apiKey: SECRET, fetchImpl: async () => jsonResponse(status, {}) }),
      (err) => {
        assert.ok(err instanceof DiscoveryError);
        assert.match(err.message, new RegExp(`authentication failed \\(HTTP ${status}\\)`));
        return true;
      }
    );
  }
});

test("fetchCatalog reports HTTP and JSON failures", async () => {
  await assert.rejects(
    () => fetchCatalog({ apiKey: SECRET, fetchImpl: async () => jsonResponse(500, {}) }),
    /HTTP 500/
  );
  await assert.rejects(
    () =>
      fetchCatalog({
        apiKey: SECRET,
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          async json() {
            throw new Error("bad json");
          },
        }),
      }),
    /not valid JSON/
  );
});

test("fetchCatalog surfaces network errors and timeouts", async () => {
  await assert.rejects(
    () => fetchCatalog({ apiKey: SECRET, fetchImpl: async () => { throw new Error("ECONNREFUSED"); } }),
    /ECONNREFUSED/
  );
  await assert.rejects(
    () =>
      fetchCatalog({
        apiKey: SECRET,
        timeoutMs: 10,
        fetchImpl: (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          }),
      }),
    /timed out/
  );
});

test("fetchCatalog honours an external abort signal", async () => {
  const controller = new AbortController();
  const promise = fetchCatalog({
    apiKey: SECRET,
    signal: controller.signal,
    fetchImpl: (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
  });
  controller.abort();
  await assert.rejects(() => promise, /aborted/);
});

// ─── validateApiKey ──────────────────────────────────────────────────────────

test("validateApiKey accepts a working key", async () => {
  const verdict = await validateApiKey(SECRET, { fetchImpl: async () => jsonResponse(200, { data: [{ id: "x" }] }) });
  assert.deepEqual(verdict, { ok: true, verified: true });
});

test("validateApiKey rejects only on 401/403", async () => {
  for (const status of [401, 403]) {
    const verdict = await validateApiKey(SECRET, { fetchImpl: async () => jsonResponse(status, {}) });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.verified, true);
  }
});

test("validateApiKey keeps the key when the check is inconclusive", async () => {
  const cases = [
    async () => jsonResponse(404, {}),
    async () => jsonResponse(405, {}),
    async () => jsonResponse(500, {}),
    async () => {
      throw new Error("network down");
    },
  ];
  for (const fetchImpl of cases) {
    const verdict = await validateApiKey(SECRET, { fetchImpl });
    assert.equal(verdict.ok, true);
    assert.equal(verdict.verified, false);
  }
});

test("validateApiKey rejects an empty key without calling the network", async () => {
  let called = false;
  const verdict = await validateApiKey("", {
    fetchImpl: async () => {
      called = true;
      return jsonResponse(200, {});
    },
  });
  assert.deepEqual(verdict, { ok: false, verified: false, reason: "empty API key" });
  assert.equal(called, false);
});

// ─── probeModelSupport ───────────────────────────────────────────────────────

test("probeModelSupport returns true when chat/completions answers 200", async () => {
  const supported = await probeModelSupport({
    apiKey: SECRET,
    modelId: "glm-5.3-flash",
    fetchImpl: async (url, init) => {
      assert.equal(url, "https://ark.ap-southeast.bytepluses.com/api/coding/v3/chat/completions");
      assert.equal(init.method, "POST");
      assert.equal(init.headers.Authorization, `Bearer ${SECRET}`);
      const body = JSON.parse(init.body);
      assert.equal(body.model, "glm-5.3-flash");
      assert.equal(body.max_tokens, 1);
      return jsonResponse(200, { choices: [{ message: { content: "pong" } }] });
    },
  });
  assert.equal(supported, true);
});

test("probeModelSupport returns false when endpoint returns 404 UnsupportedModel", async () => {
  const supported = await probeModelSupport({
    apiKey: SECRET,
    modelId: "unsupported-platform-model",
    fetchImpl: async () =>
      jsonResponse(404, {
        error: { code: "UnsupportedModel", message: "the requested model does not support the coding plan feature" },
      }),
  });
  assert.equal(supported, false);
});

test("probeModelSupport returns false on network error or empty args", async () => {
  assert.equal(await probeModelSupport({ apiKey: "", modelId: "test" }), false);
  assert.equal(await probeModelSupport({ apiKey: SECRET, modelId: "" }), false);
  const errorSupported = await probeModelSupport({
    apiKey: SECRET,
    modelId: "test",
    fetchImpl: async () => {
      throw new Error("connection reset");
    },
  });
  assert.equal(errorSupported, false);
});

// ─── capability hints ────────────────────────────────────────────────────────

test("isChatModel excludes ModelArk's non-chat catalog entries", () => {
  for (const id of [
    "doubao-embedding-large",
    "bge-rerank-large",
    "dola-seedream-5-0-pro",
    "dola-seedance-2-0",
    "hitem3d-1-0",
    "seed-translation-1-0",
    "doubao-tts-1-0",
    "doubao-asr-1-0",
  ]) {
    assert.equal(isChatModel(id), false, id);
  }
  for (const id of ["ark-code-latest", "glm-5.2", "kimi-k2.5", "deepseek-v4-pro", "dola-seed-2.0-code"]) {
    assert.equal(isChatModel(id), true, id);
  }
  assert.equal(isChatModel(""), false);
});

test("getModelHint only knows curated ids", () => {
  assert.equal(getModelHint("glm-5.2")?.name, "GLM-5.2");
  assert.equal(getModelHint("some-new-model"), undefined);
});

test("inferThinking marks curated models as reasoning and leaves unknowns alone", () => {
  assert.deepEqual(inferThinking({ id: "deepseek-v4-pro" }), { reasoning: true });
  assert.equal(inferThinking({ id: "brand-new-model" }), undefined);
  assert.equal(inferThinking(undefined), undefined);
});

test("inferThinking exposes only the thinking levels BytePlus documents", () => {
  // Ark documents `none` and `xhigh` for glm-5-2-260617 alone.
  assert.deepEqual(inferThinking({ id: "glm-5.2" })?.thinkingLevelMap, { off: "none", xhigh: "xhigh" });
  for (const id of ["glm-5.1", "kimi-k2.5", "gpt-oss-120b", "dola-seed-2.0-pro"]) {
    assert.equal(inferThinking({ id })?.thinkingLevelMap, undefined, id);
  }
});

// ─── toPiModel ───────────────────────────────────────────────────────────────

test("toPiModel stamps the provider metadata Pi's runtime needs", () => {
  const model = toPiModel({ id: "glm-5.2" }, undefined, undefined, {
    provider: "byteplus",
    api: "openai-completions",
    baseUrl: OPENAI_BASE_URL,
  });
  assert.equal(model.provider, "byteplus");
  assert.equal(model.api, "openai-completions");
  assert.equal(model.baseUrl, OPENAI_BASE_URL);
});

test("toPiModel applies the documented compat block", () => {
  const model = toPiModel({ id: "glm-5.2" });
  assert.deepEqual(model.compat, { ...OPENAI_COMPAT });
});

test("toPiModel prefers curated values over the platform catalog", () => {
  const model = toPiModel({ id: "glm-5.2", contextLength: 999999, maxTokens: 5 });
  assert.equal(model.contextWindow, 1048576);
  assert.equal(model.maxTokens, 131072);
});

test("toPiModel uses live metadata for models without a curated hint", () => {
  const model = toPiModel({ id: "mystery-model", contextLength: 64000, maxTokens: 8000 });
  assert.equal(model.contextWindow, 64000);
  assert.equal(model.maxTokens, 8000);
  // Not a curated reasoning family: never guessed at.
  assert.equal(model.reasoning, false);
  assert.equal(model.input.length, 1);
});

test("toPiModel falls back to conservative defaults for an unknown model", () => {
  const model = toPiModel({ id: "mystery-model" });
  assert.equal(model.contextWindow, DEFAULT_CONTEXT_WINDOW);
  assert.equal(model.maxTokens, DEFAULT_MAX_TOKENS);
  assert.equal(model.name, "mystery-model");
  assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});

test("toPiModel sets vision only where the catalog supports image input", () => {
  assert.deepEqual(toPiModel({ id: "kimi-k2.5" }).input, ["text", "image"]);
  assert.deepEqual(toPiModel({ id: "deepseek-v4-pro" }).input, ["text"]);
  assert.deepEqual(toPiModel({ id: "dola-seed-2.0-pro" }).input, ["text", "image"]);
  assert.deepEqual(toPiModel({ id: "gpt-oss-120b" }).input, ["text"]);
});

test("toPiModel prefers curated vision capability over conflicting platform catalog metadata", () => {
  // bytedance-seed-code is curated as vision: true. Curated hint wins over live false.
  assert.deepEqual(toPiModel({ id: "bytedance-seed-code", vision: false }).input, ["text", "image"]);
  // deepseek-v4-pro is curated as vision: false. Curated hint wins over live true.
  assert.deepEqual(toPiModel({ id: "deepseek-v4-pro", vision: true }).input, ["text"]);
  // Uncurated models use live catalog metadata.
  assert.deepEqual(toPiModel({ id: "new-uncurated", vision: true }).input, ["text", "image"]);
  assert.deepEqual(toPiModel({ id: "new-uncurated", vision: false }).input, ["text"]);
});

test("toPiModel marks curated families as reasoning and exposes their thinking map", () => {
  const glm = toPiModel({ id: "glm-5.2" });
  assert.equal(glm.reasoning, true);
  assert.deepEqual(glm.thinkingLevelMap, { off: "none", xhigh: "xhigh" });
  const other = toPiModel({ id: "kimi-k2.5" });
  assert.equal(other.reasoning, true);
  assert.equal(other.thinkingLevelMap, undefined);
});

test("toPiModel lets overrides raise but never lower the caps", () => {
  const raise = new Map([["glm-5.2", { maxTokens: 250000, contextWindow: 2000000 }]]);
  const raised = toPiModel({ id: "glm-5.2" }, raise);
  assert.equal(raised.maxTokens, 250000);
  assert.equal(raised.contextWindow, 2000000);

  const lower = new Map([["glm-5.2", { maxTokens: 100, contextWindow: 100 }]]);
  const kept = toPiModel({ id: "glm-5.2" }, lower);
  assert.equal(kept.maxTokens, 131072);
  assert.equal(kept.contextWindow, 1048576);
});

test("toPiModel matches overrides by normalized display name too", () => {
  const overrides = loadModelOverrides({
    path: "/dev/null",
    fsImpl: { readFileSync: () => JSON.stringify({ "Seed 2.0 Lite": { maxTokens: 99000 } }) },
  });
  assert.equal(toPiModel({ id: "dola-seed-2.0-lite" }, overrides).maxTokens, 99000);
});

test("toPiModel honours a pinned defaultMaxTokens for tests", () => {
  assert.equal(toPiModel({ id: "mystery" }, undefined, 1234).maxTokens, 1234);
  assert.equal(toPiModel({ id: "mystery", maxTokens: 77 }, undefined, 1234).maxTokens, 77);
});

test("toPiModel preserves BytePlus' exact model id", () => {
  assert.equal(toPiModel({ id: "dola-seed-2.0-code" }).id, "dola-seed-2.0-code");
});

test("toPiModels maps a list", () => {
  const models = toPiModels([{ id: "glm-5.1" }, { id: "kimi-k2.5" }]);
  assert.deepEqual(models.map((m) => m.id), ["glm-5.1", "kimi-k2.5"]);
});

// ─── buildCatalog ────────────────────────────────────────────────────────────

test("buildCatalog prefers the plan list and enriches it from the live catalog", () => {
  const catalog = buildCatalog({
    planModels: [{ id: "glm-5.2" }, { id: "new-model" }],
    liveModels: [
      { id: "glm-5.2", name: "GLM 5.2", contextLength: 200000, maxTokens: 131072 },
      { id: "not-on-plan" },
    ],
  });
  assert.deepEqual(catalog.map((m) => m.id), [
    "glm-5.2",
    "new-model",
    ...EXTRA_PLAN_MODELS,
  ]);
  assert.equal(catalog[0].name, "GLM-5.2", "curated name beats the catalog's display name");
  assert.equal(catalog[0].contextLength, 200000);
  assert.equal(catalog[1].contextLength, undefined);
  assert.ok(!catalog.some((m) => m.id === "not-on-plan"), "live-only ids must not enter a successful plan list");
});

test("buildCatalog appends the extra ids and de-duplicates them", () => {
  const catalog = buildCatalog({ planModels: [{ id: "glm-5.2" }] });
  assert.deepEqual(catalog.map((m) => m.id), ["glm-5.2", ...EXTRA_PLAN_MODELS]);
});

test("buildCatalog does not duplicate a model that is in both sources", () => {
  for (const id of EXTRA_PLAN_MODELS) {
    const catalog = buildCatalog({ planModels: [{ id }, { id: "glm-5.2" }] });
    assert.deepEqual(catalog.map((m) => m.id), [id, "glm-5.2", ...EXTRA_PLAN_MODELS.filter((e) => e !== id)]);
  }
});

test("buildCatalog does not append extras to the live-fallback path", () => {
  const catalog = buildCatalog({ planModels: null, liveModels: [{ id: "glm-5.2" }] });
  assert.deepEqual(catalog.map((m) => m.id), ["glm-5.2"]);
});

test("buildCatalog appends verifiedLiveModels and enriches them from the live catalog", () => {
  const catalog = buildCatalog({
    planModels: [{ id: "glm-5.2" }],
    verifiedLiveModels: [{ id: "glm-5.3-flash" }, { id: "glm-5.2" }],
    liveModels: [
      { id: "glm-5.3-flash", name: "GLM 5.3 Flash", contextLength: 128000, maxTokens: 8192, vision: true },
      { id: "glm-5.2", contextLength: 200000 },
      { id: "unverified-live" },
    ],
  });

  assert.deepEqual(catalog.map((m) => m.id), ["glm-5.2", ...EXTRA_PLAN_MODELS, "glm-5.3-flash"]);
  const verifiedEntry = catalog.find((m) => m.id === "glm-5.3-flash");
  assert.equal(verifiedEntry.contextLength, 128000);
  assert.equal(verifiedEntry.maxTokens, 8192);
  assert.equal(verifiedEntry.vision, true);
  assert.ok(!catalog.some((m) => m.id === "unverified-live"));
});

test("buildCatalog supports verifiedLiveModels when planModels is empty", () => {
  const catalog = buildCatalog({
    planModels: [],
    verifiedLiveModels: [{ id: "custom-live-model" }],
    liveModels: [{ id: "custom-live-model", contextLength: 64000 }],
  });

  assert.deepEqual(catalog.map((m) => m.id), [...EXTRA_PLAN_MODELS, "custom-live-model"]);
  const custom = catalog.find((m) => m.id === "custom-live-model");
  assert.equal(custom.contextLength, 64000);
});

test("buildCatalog enriches plan aliases from versioned platform ids", () => {
  const catalog = buildCatalog({
    planModels: [{ id: "glm-5.2" }, { id: "kimi-k2.5" }],
    liveModels: [
      {
        id: "glm-5-2-260617",
        name: "glm-5.2",
        status: "active",
        contextLength: 1048576,
      },
      { id: "kimi-k2-250905", status: "Shutdown" },
    ],
  });
  // `glm-5.2` matches `glm-5-2-260617` after normalization.
  assert.equal(catalog[0].id, "glm-5.2");
  assert.equal(catalog[0].contextLength, 1048576);
  assert.equal(catalog[0].name, "GLM-5.2", "curated name still wins over the live catalog's");
  // A Shutdown platform twin supplies no metadata.
  assert.equal(catalog[1].contextLength, undefined);
  // Live ids still never enter a successful plan list.
  assert.ok(!catalog.some((m) => m.id === "glm-5-2-260617"));
});

test("buildCatalog falls back to the live catalog, filtered to usable chat models", () => {
  const catalog = buildCatalog({
    planModels: [],
    liveModels: [
      { id: "glm-5-2-260617", status: "active" },
      { id: "deepseek-r1-250120", status: "Shutdown" },
      { id: "doubao-embedding-large" },
      { id: "dola-seedance-2-0" },
    ],
  });
  assert.deepEqual(catalog.map((m) => m.id), ["glm-5-2-260617"]);
});

test("buildCatalog falls back to the bundled seed list when everything else fails", () => {
  assert.deepEqual(buildCatalog({}).map((m) => m.id), [...SEED_CATALOG]);
  assert.deepEqual(
    buildCatalog({ planModels: [], liveModels: [{ id: "doubao-embedding-large" }] }).map((m) => m.id),
    [...SEED_CATALOG]
  );
});

test("buildCatalog tolerates null/undefined sources", () => {
  assert.deepEqual(buildCatalog({ planModels: null, liveModels: undefined }).length, SEED_CATALOG.length);
  assert.deepEqual(buildCatalog().length, SEED_CATALOG.length);
});

test("the curated hints cover the plan-verified GA variants", () => {
  for (const id of ["deepseek-v4-flash-ga", "deepseek-v4-pro-ga"]) {
    assert.ok(Object.hasOwn(MODEL_HINTS, id), id);
    const model = toPiModel({ id });
    assert.equal(model.contextWindow, 1048576);
    assert.equal(model.maxTokens, 131072);
    assert.equal(model.reasoning, true);
    assert.equal(model.input.includes("image"), false);
  }
});

// ─── secret hygiene ──────────────────────────────────────────────────────────

test("no error path ever includes the API key", async () => {
  const failures = [
    () => fetchCatalog({ apiKey: SECRET, fetchImpl: async () => jsonResponse(401, {}) }),
    () => fetchCatalog({ apiKey: SECRET, fetchImpl: async () => jsonResponse(500, {}) }),
    () => fetchCatalog({ apiKey: SECRET, fetchImpl: async () => { throw new Error("boom"); } }),
    () => fetchCatalog({ apiKey: SECRET, fetchImpl: async () => jsonResponse(200, { data: [] }) }),
    () =>
      fetchCatalog({
        apiKey: SECRET,
        fetchImpl: async () => ({ ok: true, status: 200, async json() { throw new Error("bad"); } }),
      }),
  ];
  for (const fn of failures) {
    await assert.rejects(fn, (err) => {
      assert.ok(!String(err.message).includes(SECRET), `leaked key in: ${err.message}`);
      return true;
    });
  }

  const logs = await captureErrors(async () => {
    // loadModelOverrides is the only core function that logs.
    loadModelOverrides({ path: "/nope.json", fsImpl: { readFileSync: () => "{ bad" } });
  });
  for (const line of logs) assert.ok(!line.includes(SECRET), line);
});

// ─── diffModelIds ────────────────────────────────────────────────────────────

test("diffModelIds reports additions and removals, order-insensitively", () => {
  assert.deepEqual(diffModelIds(["a", "b", "c"], ["c", "b", "d"]), { added: ["d"], removed: ["a"] });
  assert.deepEqual(diffModelIds(["a", "b"], ["a", "b"]), { added: [], removed: [] });
  assert.deepEqual(diffModelIds([], ["a"]), { added: ["a"], removed: [] });
  assert.deepEqual(diffModelIds(["a"], []), { added: [], removed: ["a"] });
});

test("diffModelIds accepts catalog entries and collapses duplicates", () => {
  assert.deepEqual(diffModelIds([{ id: "a" }, { id: "a" }, { id: "b" }], [{ id: "b" }, { id: "b" }, { id: "c" }]), {
    added: ["c"],
    removed: ["a"],
  });
  assert.deepEqual(diffModelIds([{ id: "a" }, { id: "" }, {}], [{ id: "a" }]), { added: [], removed: [] });
});

test("diffModelIds tolerates missing and malformed input", () => {
  assert.deepEqual(diffModelIds(undefined, undefined), { added: [], removed: [] });
  assert.deepEqual(diffModelIds(null, [{ id: "x" }]), { added: ["x"], removed: [] });
  assert.deepEqual(diffModelIds("not-an-array", undefined), { added: [], removed: [] });
  assert.deepEqual(diffModelIds([1, null, { id: 5 }], []), { added: [], removed: [] });
});

test("diffModelIds preserves first-seen order for both sides", () => {
  assert.deepEqual(diffModelIds(["z", "y"], ["y2", "z2"]), { added: ["y2", "z2"], removed: ["z", "y"] });
});
