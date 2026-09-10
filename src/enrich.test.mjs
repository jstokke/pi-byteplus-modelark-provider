/**
 * Unit tests for enrich.mjs — the Coding Plan docs scrape.
 *
 * The fixtures mirror the live page's structure: the article body is
 * server-rendered inside `window._ROUTER_DATA` as `curDoc.MDContent`
 * (markdown) with `curDoc.Content` (a double-encoded Quill delta) as the
 * alternate representation. One test parses the real markdown captured from
 * that page so a docs-shape regression fails here instead of silently
 * shrinking the model list.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ENRICHMENT_TIMEOUT_MS,
  ENRICHMENT_TTL_MS,
  EnrichmentError,
  PLAN_DOC_URL,
  defaultCachePath,
  extractDocMarkdown,
  extractRouterData,
  fetchPlanModels,
  getPlanDocUrl,
  loadPlanCache,
  parsePlanHtml,
  parsePlanModels,
  savePlanCache,
} from "./enrich.mjs";

/**
 * The model-list section, captured verbatim from the live Coding Plan page —
 * including the escaped backticks the docs pipeline emits
 * (`\`glm-5.2\`` rather than `` `glm-5.2` ``). Pinning the real format is
 * what makes a docs-format regression fail here instead of silently
 * shrinking the discovered model list.
 */
const REAL_SECTION = [
  "This topic describes how to configure ModelArk Coding Plan in Codex CLI.",
  "",
  'Specify the name of the model to be used in the configuration file of the tool.',
  "",
  "The following models are supported:",
  "",
  "* \\`dola-seed-2.0-pro\\`",
  "",
  "* \\`dola-seed-2.0-lite\\`",
  "",
  "* \\`dola-seed-2.0-code\\`",
  "",
  "* \\`bytedance-seed-code\\`",
  "",
  "* \\`glm-5.2\\`",
  "",
  "* \\`glm-5.1\\`",
  "",
  "* \\`kimi-k2.5\\`",
  "",
  "* \\`gpt-oss-120b\\`",
  "",
  "* \\`deepseek-v4-flash\\`",
  "",
  "* \\`deepseek-v4-pro\\`",
  "",
  '<div data-tips="true" data-tips-type="tip" data-tips-is-title="true">Tip</div>',
  "",
  '* <div data-tips="true" data-tips-type="tip">Availability varies by region.</div>',
  "",
  "## Base URL",
  "",
  "Tools compatible with the Anthropic protocol: `https://ark.ap-southeast.bytepluses.com/api/coding`",
  "",
].join("\n");

const REAL_MODELS = [
  "dola-seed-2.0-pro",
  "dola-seed-2.0-lite",
  "dola-seed-2.0-code",
  "bytedance-seed-code",
  "glm-5.2",
  "glm-5.1",
  "kimi-k2.5",
  "gpt-oss-120b",
  "deepseek-v4-flash",
  "deepseek-v4-pro",
];

function ssrPage({ md, quill }) {
  const curDoc = {};
  if (md !== undefined) curDoc.MDContent = md;
  if (quill !== undefined) curDoc.Content = quill;
  const data = {
    loaderData: {
      "(lang)/docs/(libcode)/(doccode$)/page": { curDoc },
      "(lang)/docs/(libcode)/layout": { docListMap: { Title: "ModelArk", ID: 1 } },
    },
  };
  return `<html><body><script>window._ROUTER_DATA = ${JSON.stringify(data)}</script></body></html>`;
}

function textResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return body;
    },
  };
}

function tmpDir() {
  return mkdtempSync(join(tmpdir(), "byteplus-enrich-"));
}

// ─── extractRouterData ───────────────────────────────────────────────────────

test("extractRouterData reads the embedded payload", () => {
  const data = extractRouterData(ssrPage({ md: "hello" }));
  assert.equal(
    data.loaderData["(lang)/docs/(libcode)/(doccode$)/page"].curDoc.MDContent,
    "hello"
  );
});

test("extractRouterData tolerates a trailing semicolon and whitespace", () => {
  const html = `<script>window._ROUTER_DATA = {"a":1} ;\n</script>`;
  assert.deepEqual(extractRouterData(html), { a: 1 });
});

test("extractRouterData returns undefined for unrecognized pages", () => {
  for (const html of ["", "<html></html>", "window._ROUTER_DATA = not json", "<script>window._ROUTER_DATA =</script>"]) {
    assert.equal(extractRouterData(html), undefined, JSON.stringify(html));
  }
  assert.equal(extractRouterData(undefined), undefined);
});

// ─── extractDocMarkdown ──────────────────────────────────────────────────────

test("extractDocMarkdown prefers MDContent", () => {
  const md = extractDocMarkdown({
    a: { MDContent: "The following models are supported:\n\n* `glm-5.2`\n" },
  });
  assert.match(md, /glm-5\.2/);
});

test("extractDocMarkdown falls back to the double-encoded Quill delta", () => {
  const quill = JSON.stringify({
    version: "0.4.18",
    data: {
      0: {
        ops: [
          { insert: "The following models are supported:\n" },
          { insert: "* `glm-5.2`\n" },
          { insert: "* `kimi-k2.5`\n" },
        ],
      },
    },
  });
  const md = extractDocMarkdown({ page: { curDoc: { Content: quill } } });
  assert.match(md, /glm-5\.2/);
  assert.match(md, /kimi-k2\.5/);
  assert.deepEqual(parsePlanModels(md).map((m) => m.id), ["glm-5.2", "kimi-k2.5"]);
});

test("extractDocMarkdown returns an empty string for unknown structure", () => {
  assert.equal(extractDocMarkdown(undefined), "");
  assert.equal(extractDocMarkdown({ loaderData: {} }), "");
  // A "Content" string that is not a Quill payload is ignored rather than thrown on.
  assert.equal(extractDocMarkdown({ feedbackContent: "Content" }), "");
});

// ─── parsePlanModels ─────────────────────────────────────────────────────────

test("parsePlanModels reads the real published list", () => {
  assert.deepEqual(parsePlanModels(REAL_SECTION).map((m) => m.id), REAL_MODELS);
});

test("parsePlanModels stops at the end of the list", () => {
  const md = [
    "The following models are supported:",
    "* `glm-5.2`",
    "* `kimi-k2.5`",
    "",
    "## Base URL",
    "* `https://ark.ap-southeast.bytepluses.com/api/coding`",
  ].join("\n");
  assert.deepEqual(parsePlanModels(md).map((m) => m.id), ["glm-5.2", "kimi-k2.5"]);
});

test("parsePlanModels skips prose bullets and accepts - / + markers", () => {
  const md = [
    "The following models are supported:",
    "- `glm-5.2`",
    "+ `kimi-k2.5`",
    "* a prose bullet that is not a model",
    "* `UPPER CASE`",
    "* `has spaces`",
    "* `glm-5.2`",
  ].join("\n");
  assert.deepEqual(parsePlanModels(md).map((m) => m.id), ["glm-5.2", "kimi-k2.5"]);
});

test("parsePlanModels accepts both escaped and plain inline-code spans", () => {
  const escaped = ["The following models are supported:", "* \\`glm-5.2\\`", "* \\`kimi-k2.5\\`"].join("\n");
  const plain = ["The following models are supported:", "* `glm-5.2`", "* `kimi-k2.5`"].join("\n");
  assert.deepEqual(parsePlanModels(escaped).map((m) => m.id), ["glm-5.2", "kimi-k2.5"]);
  assert.deepEqual(parsePlanModels(plain).map((m) => m.id), ["glm-5.2", "kimi-k2.5"]);
});

test("parsePlanModels throws when the section or the list is gone", () => {
  assert.throws(() => parsePlanModels(""), EnrichmentError);
  assert.throws(() => parsePlanModels("A page with no list at all."), /no longer contains/);
  assert.throws(() => parsePlanModels("The following models are supported:\n\n## Next"), /listed no models/);
});

// ─── end-to-end parsing of a page ────────────────────────────────────────────

test("parsePlanHtml reads a server-rendered Coding Plan page", () => {
  const models = parsePlanHtml(ssrPage({ md: REAL_SECTION }));
  assert.deepEqual(models.map((m) => m.id), REAL_MODELS);
});

// ─── fetchPlanModels ─────────────────────────────────────────────────────────

test("fetchPlanModels requests the docs page and parses it", async () => {
  let seen;
  const models = await fetchPlanModels({
    fetchImpl: async (url, init) => {
      seen = { url, init };
      return textResponse(200, ssrPage({ md: REAL_SECTION }));
    },
  });
  assert.equal(seen.url, PLAN_DOC_URL);
  assert.equal(seen.init.headers.Accept, "text/html");
  assert.deepEqual(models.map((m) => m.id), REAL_MODELS);
});

test("fetchPlanModels reports HTTP failures", async () => {
  await assert.rejects(
    () => fetchPlanModels({ fetchImpl: async () => textResponse(503, "") }),
    /HTTP 503/
  );
});

test("fetchPlanModels reports network failures and timeouts", async () => {
  await assert.rejects(
    () => fetchPlanModels({ fetchImpl: async () => { throw new Error("ENOTFOUND"); } }),
    /ENOTFOUND/
  );
  await assert.rejects(
    () =>
      fetchPlanModels({
        timeoutMs: 10,
        fetchImpl: (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          }),
      }),
    /timed out after/
  );
});

test("fetchPlanModels honours an external abort signal", async () => {
  const controller = new AbortController();
  const promise = fetchPlanModels({
    signal: controller.signal,
    fetchImpl: (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
  });
  controller.abort();
  await assert.rejects(() => promise, /aborted/);
});

test("fetchPlanModels never sends an API key", async () => {
  let headers;
  await fetchPlanModels({
    fetchImpl: async (_url, init) => {
      headers = init.headers;
      return textResponse(200, ssrPage({ md: REAL_SECTION }));
    },
  });
  assert.deepEqual(Object.keys(headers), ["Accept"]);
});

// ─── configuration ───────────────────────────────────────────────────────────

test("getPlanDocUrl defaults to the published page and honours the override", () => {
  assert.equal(getPlanDocUrl({ env: {} }), PLAN_DOC_URL);
  assert.equal(getPlanDocUrl({ env: { BYTEPLUS_PLAN_DOC_URL: "https://mirror.test/plan" } }), "https://mirror.test/plan");
  assert.equal(getPlanDocUrl({ env: { BYTEPLUS_PLAN_DOC_URL: "   " } }), PLAN_DOC_URL);
});

test("defaultCachePath lives beside auth.json", () => {
  assert.equal(
    defaultCachePath({ env: { PI_CODING_AGENT_DIR: "/custom/agent" } }),
    join("/custom/agent", "byteplus-coding-plan-cache.json")
  );
  assert.ok(defaultCachePath({ env: {} }).endsWith(join(".pi", "agent", "byteplus-coding-plan-cache.json")));
});

// ─── cache ───────────────────────────────────────────────────────────────────

test("loadPlanCache returns null for missing or malformed files", () => {
  const dir = tmpDir();
  try {
    assert.equal(loadPlanCache({ cachePath: join(dir, "missing.json") }), null);

    const cases = {
      "bad.json": "{ nope",
      "arr.json": JSON.stringify([1]),
      "nofetch.json": JSON.stringify({ models: [{ id: "glm-5.2" }] }),
      "emptymodels.json": JSON.stringify({ fetchedAt: 1, models: [] }),
      "junkmodels.json": JSON.stringify({ fetchedAt: 1, models: [{ nope: true }, null] }),
    };
    for (const [name, body] of Object.entries(cases)) {
      const p = join(dir, name);
      writeFileSync(p, body);
      assert.equal(loadPlanCache({ cachePath: p }), null, name);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("savePlanCache round-trips and reports staleness against the TTL", () => {
  const dir = tmpDir();
  const cachePath = join(dir, "cache.json");
  try {
    savePlanCache([{ id: "glm-5.2" }, { id: "kimi-k2.5" }], { cachePath, now: 1_000, source: "test" });

    const fresh = loadPlanCache({ cachePath, now: 1_000 + ENRICHMENT_TTL_MS - 1 });
    assert.equal(fresh.stale, false);
    assert.deepEqual(fresh.models.map((m) => m.id), ["glm-5.2", "kimi-k2.5"]);

    const stale = loadPlanCache({ cachePath, now: 1_000 + ENRICHMENT_TTL_MS + 1 });
    assert.equal(stale.stale, true);

    const raw = JSON.parse(readFileSync(cachePath, "utf8"));
    assert.equal(raw.source, "test");
    assert.equal(raw.fetchedAt, 1_000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("savePlanCache never throws when the path is unwritable", () => {
  // Parent is a regular file, so mkdir/write fail with ENOTDIR immediately.
  const dir = tmpDir();
  const blocker = join(dir, "blocker");
  writeFileSync(blocker, "not a directory");
  try {
    assert.doesNotThrow(() => savePlanCache([{ id: "glm-5.2" }], { cachePath: join(blocker, "nested", "cache.json") }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cache and parse timings are bounded", () => {
  assert.ok(ENRICHMENT_TIMEOUT_MS <= 10000);
  assert.equal(ENRICHMENT_TTL_MS, 24 * 60 * 60 * 1000);
});
