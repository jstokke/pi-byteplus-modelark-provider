/**
 * Enrichment layer: reads the Coding Plan's published model list out of
 * BytePlus' documentation, with a TTL cache so the page is fetched at most
 * once per TTL window per session.
 *
 * Why scrape at all: the Coding Plan serves an explicit, small set of model
 * aliases (`dola-seed-2.0-pro`, `glm-5.2`, `kimi-k2.5`, …) that is not the
 * same as ModelArk's platform catalog, and BytePlus does not document a
 * model-listing endpoint for the plan. The docs page is the authoritative
 * source, and scraping it is what makes new plan models appear without
 * publishing a new extension version.
 *
 * The docs site is server-rendered: the article body is embedded in
 * `window._ROUTER_DATA` as markdown (`curDoc.MDContent`) and as a
 * double-encoded Quill delta (`curDoc.Content`). Both are handled.
 *
 * This whole module is best-effort and key-free — no API key is ever sent to
 * the docs site. Any parse failure leaves the caller to fall back to the
 * live catalog or the bundled seed list.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The Codex integration page. It is the Coding Plan page that enumerates the
 * supported model aliases in machine-parseable form, alongside the two
 * protocol base URLs. Verified against the live page; see src/README.md.
 */
export const PLAN_DOC_URL = "https://docs.byteplus.com/en/docs/ModelArk/2556056";
export const ENRICHMENT_TTL_MS = 24 * 60 * 60 * 1000;
export const ENRICHMENT_TIMEOUT_MS = 8000;

/** Sentence that introduces the supported-model list. */
const MODEL_LIST_MARKER = "The following models are supported";

/**
 * A model alias is a single inline-code token: `glm-5.2`. Anything else in
 * the list position (a prose bullet, a `<div>` tip) is not a model.
 */
const MODEL_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const BULLET_RE = /^\s*[*+-]\s+(.*)$/;

/**
 * Unwrap an inline-code span.
 *
 * BytePlus' docs pipeline escapes the backticks in code spans, so the live
 * markdown contains `\`glm-5.2\`` rather than `` `glm-5.2` ``. Both forms are
 * accepted; anything else (prose, a `<div>` tip) returns undefined.
 */
function unwrapInlineCode(text) {
  const cleaned = String(text).replace(/\\`/g, "`").trim();
  const match = /^`([^`]+)`$/.exec(cleaned);
  return match ? match[1].trim() : undefined;
}

/** Hard cap so a pathological page cannot produce an unbounded catalog. */
const MAX_MODELS = 200;

export class EnrichmentError extends Error {
  constructor(message) {
    super(message);
    this.name = "EnrichmentError";
  }
}

/**
 * Resolve the docs URL to scrape. Order: `BYTEPLUS_PLAN_DOC_URL` env var
 * (trimmed, non-empty), else the compile-time default. The override exists
 * so users can pin a working URL (or a mirror) if BytePlus restructures the
 * docs, without waiting for a release.
 */
export function getPlanDocUrl({ env = process.env } = {}) {
  const raw = env.BYTEPLUS_PLAN_DOC_URL;
  if (typeof raw === "string" && raw.trim() !== "") return raw.trim();
  return PLAN_DOC_URL;
}

export function defaultCachePath({ env = process.env } = {}) {
  const base = env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  return join(base, "byteplus-coding-plan-cache.json");
}

/**
 * Pull `window._ROUTER_DATA = {…}` out of a Next.js-style server-rendered
 * page. Returns undefined when the marker is missing or the payload is not
 * valid JSON — both are "the page layout changed" signals, not crashes.
 */
export function extractRouterData(html) {
  if (typeof html !== "string") return undefined;
  const start = html.indexOf("window._ROUTER_DATA");
  if (start < 0) return undefined;
  const eq = html.indexOf("=", start);
  if (eq < 0) return undefined;
  const end = html.indexOf("</script>", eq);
  if (end < 0) return undefined;
  try {
    return JSON.parse(html.slice(eq + 1, end).trim().replace(/;\s*$/, ""));
  } catch {
    return undefined;
  }
}

/** Collect every string stored under `key` anywhere in a nested payload. */
function collectStrings(node, key, out) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) collectStrings(item, key, out);
    return;
  }
  for (const [k, v] of Object.entries(node)) {
    if (k === key && typeof v === "string") out.push(v);
    else collectStrings(v, key, out);
  }
}

/** Flatten a Quill delta (`{ ops: [{ insert }] }`, possibly nested) to text. */
function quillToText(value) {
  const inserts = [];
  (function walk(node) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node.ops)) {
      for (const op of node.ops) {
        if (typeof op?.insert === "string") inserts.push(op.insert);
      }
    }
    for (const child of Object.values(node)) walk(child);
  })(value);
  return inserts.join("");
}

/**
 * Extract the article markdown from a docs page.
 *
 * Prefers `curDoc.MDContent` (plain markdown). Falls back to the
 * double-encoded Quill delta in `curDoc.Content` so a docs-build change that
 * drops one representation does not break discovery. Unknown structure →
 * empty string, which the parser treats as an error.
 */
export function extractDocMarkdown(routerData) {
  if (!routerData) return "";

  const markdown = [];
  collectStrings(routerData, "MDContent", markdown);
  if (markdown.length > 0) return markdown.join("\n");

  const raw = [];
  collectStrings(routerData, "Content", raw);
  const decoded = [];
  for (const candidate of raw) {
    try {
      const text = quillToText(JSON.parse(candidate));
      if (text !== "") decoded.push(text);
    } catch {
      // Not a Quill payload; ignore.
    }
  }
  return decoded.join("\n");
}

/**
 * Parse the "The following models are supported:" bullet list out of the
 * article markdown.
 *
 * Returns an array of `{ id }` (plus `{ name }` when the docs spell one out),
 * de-duplicated in document order. Throws EnrichmentError when the marker or
 * the list is missing — the caller then falls back.
 */
export function parsePlanModels(markdown) {
  if (typeof markdown !== "string" || markdown === "") {
    throw new EnrichmentError("BytePlus ModelArk: Coding Plan docs page had no article content");
  }
  const marker = markdown.indexOf(MODEL_LIST_MARKER);
  if (marker < 0) {
    throw new EnrichmentError(
      "BytePlus ModelArk: Coding Plan docs page no longer contains a 'supported models' section (layout may have changed)"
    );
  }

  const rest = markdown.slice(marker + MODEL_LIST_MARKER.length);
  const rawLines = rest.split("\n");
  // The marker's own line is consumed here: it ends with a trailing colon,
  // which must not be mistaken for the end of the list. If BytePlus ever
  // moves the list onto the marker line, the parser below finds no models
  // and the caller falls back instead of returning a partial catalog.
  const lines = rawLines.slice(1);

  const ids = [];
  const seen = new Set();
  for (const line of lines) {
    if (line.trim() === "") continue;
    const bullet = BULLET_RE.exec(line);
    if (!bullet) break; // List ended (next heading, tip block, prose).
    const id = unwrapInlineCode(bullet[1]);
    if (id === undefined) continue; // Prose bullet inside the section, e.g. a tip.
    if (!MODEL_ID_RE.test(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push({ id });
    if (ids.length >= MAX_MODELS) break;
  }

  if (ids.length === 0) {
    throw new EnrichmentError("BytePlus ModelArk: Coding Plan docs page listed no models");
  }
  return ids;
}

/** Parse a docs page body end to end. Throws EnrichmentError on failure. */
export function parsePlanHtml(html) {
  return parsePlanModels(extractDocMarkdown(extractRouterData(html)));
}

/**
 * Fetch and parse the Coding Plan docs page.
 * Throws EnrichmentError on failure; never sends secrets.
 */
export async function fetchPlanModels({
  url,
  timeoutMs = ENRICHMENT_TIMEOUT_MS,
  fetchImpl = fetch,
  signal,
} = {}) {
  const resolvedUrl = url ?? getPlanDocUrl();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
  const onAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  let response;
  try {
    response = await fetchImpl(resolvedUrl, {
      headers: { Accept: "text/html" },
      signal: controller.signal,
    });
  } catch (err) {
    const timedOut = controller.signal.aborted && !(signal?.aborted ?? false);
    const reason = timedOut ? `request timed out after ${timeoutMs}ms` : err instanceof Error ? err.message : String(err);
    throw new EnrichmentError(`BytePlus ModelArk: Coding Plan model list fetch failed: ${reason}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }

  if (!response.ok) {
    throw new EnrichmentError(`BytePlus ModelArk: Coding Plan model list fetch failed: HTTP ${response.status}`);
  }

  const html = await response.text();
  return parsePlanHtml(html);
}

/**
 * Load the TTL cache.
 * Returns `{ models, fetchedAt, stale }` or null. Never throws.
 */
export function loadPlanCache({ cachePath = defaultCachePath(), now = Date.now(), ttlMs = ENRICHMENT_TTL_MS } = {}) {
  try {
    const data = JSON.parse(readFileSync(cachePath, "utf8"));
    if (!data || typeof data !== "object" || !Array.isArray(data.models) || typeof data.fetchedAt !== "number") {
      return null;
    }
    const models = data.models.filter(
      (entry) => entry && typeof entry === "object" && typeof entry.id === "string" && entry.id !== ""
    );
    if (models.length === 0) return null;
    return { models, fetchedAt: data.fetchedAt, stale: now - data.fetchedAt > ttlMs };
  } catch {
    return null;
  }
}

/** Persist the scraped model list; failures are silently non-fatal. */
export function savePlanCache(models, { cachePath = defaultCachePath(), now = Date.now(), source } = {}) {
  try {
    mkdirSync(join(cachePath, ".."), { recursive: true });
    writeFileSync(
      cachePath,
      JSON.stringify({ fetchedAt: now, source: source ?? getPlanDocUrl(), models }, null, 2)
    );
  } catch {
    // Cache write failure must never break provider registration.
  }
}
