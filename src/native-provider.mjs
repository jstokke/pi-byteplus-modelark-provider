/**
 * Native Pi provider wiring for BytePlus ModelArk (Coding Plan).
 *
 * Produces a Provider object suitable for `pi.registerProvider()` that
 * participates in Pi's `/login` and `/logout` flows: masked secret input,
 * `auth.json` persistence, and a credential source label in the selector.
 * Pi handles all of that once we expose the standard `auth.apiKey` block, so
 * the user never has to export an environment variable.
 *
 * Pure module: every dependency is injectable so tests can mock HTTP, the
 * docs page, the cache, and auth.json. No top-level side effects.
 *
 * Model discovery is intentionally layered (see core.buildCatalog):
 *   1. the Coding Plan's published model list (docs scrape, TTL cached)
 *   2. the live `/models` catalog — metadata, and a fallback source of ids
 *   3. the bundled seed catalog
 * New plan models therefore appear without an extension update, and a
 * network or docs-layout problem degrades instead of breaking.
 */

import { stream as compatStream, streamSimple as compatStreamSimple } from "@earendil-works/pi-ai/compat";

import {
  EXTRA_PLAN_MODELS,
  MODEL_HINTS,
  OPENAI_BASE_URL,
  PROVIDER_ID,
  buildCatalog,
  fetchCatalog as defaultFetchCatalog,
  isUsableLiveModel,
  loadModelOverrides as defaultLoadModelOverrides,
  normalizeModelId,
  probeModelSupport as defaultProbeModelSupport,
  readStoredApiKey,
  toPiModels,
  validateApiKey as defaultValidateApiKey,
} from "./core.mjs";
import {
  fetchPlanModels as defaultFetchPlanModels,
  getPlanDocUrl,
  loadPlanCache as defaultLoadPlanCache,
  savePlanCache as defaultSavePlanCache,
} from "./enrich.mjs";

/** Env vars that disable the docs scrape (see README). */
export function isEnrichmentDisabled({ env = process.env } = {}) {
  return env.BYTEPLUS_NO_ENRICHMENT === "1";
}

/**
 * Resolve the API key for this provider, in the documented order:
 *   1. the credential Pi passes in for this provider (from `/login`)
 *   2. a stored `byteplus` credential in auth.json (covers a manual edit, and
 *      a login performed before this refresh)
 *   3. BYTEPLUS_API_KEY / ARK_API_KEY in the environment
 * Returns undefined when nothing has a key. Never throws, and never logs it.
 */
export function resolveKey({ credential, readStoredApiKeyFn = readStoredApiKey, env = process.env }) {
  const fromProvider = typeof credential?.key === "string" && credential.key !== "" ? credential.key : undefined;
  if (fromProvider) return fromProvider;

  const stored = readStoredApiKeyFn(PROVIDER_ID);
  if (typeof stored === "string" && stored !== "") return stored;

  for (const name of ["BYTEPLUS_API_KEY", "ARK_API_KEY"]) {
    const value = env[name];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return undefined;
}

/**
 * Label the credential source for `/login`'s status display. Callers only
 * invoke this after resolveKey() returned a key, so the final fallback exists
 * only to keep the return type a plain string.
 */
export function resolveSource({ credential, readStoredApiKeyFn = readStoredApiKey, env = process.env }) {
  if (typeof credential?.key === "string" && credential.key !== "") return "stored credential";
  const stored = readStoredApiKeyFn(PROVIDER_ID);
  if (typeof stored === "string" && stored !== "") return "stored credential";
  for (const name of ["BYTEPLUS_API_KEY", "ARK_API_KEY"]) {
    const value = env[name];
    if (typeof value === "string" && value.trim() !== "") return name;
  }
  return "stored credential";
}

/**
 * Build the native provider.
 *
 * @param {object} options
 * @param {string} options.name  Display name used by `/login` and the picker.
 * @param {string} [options.baseUrl]  Coding Plan OpenAI-protocol base URL.
 * @param {Record<string, string>} [options.extraHeaders]  Headers added to every request.
 */
export function createBytePlusProvider(options = {}) {
  const {
    id = PROVIDER_ID,
    name = "BytePlus ModelArk",
    baseUrl = OPENAI_BASE_URL,
    api = "openai-completions",
    fetchCatalogFn = defaultFetchCatalog,
    fetchPlanModelsFn = defaultFetchPlanModels,
    loadPlanCacheFn = defaultLoadPlanCache,
    savePlanCacheFn = defaultSavePlanCache,
    loadModelOverridesFn = defaultLoadModelOverrides,
    validateApiKeyFn = defaultValidateApiKey,
    probeModelSupportFn = defaultProbeModelSupport,
    readStoredApiKeyFn = readStoredApiKey,
    extraHeaders,
    env = process.env,
  } = options;

  // A base URL override may arrive with a trailing slash; never emit "//models".
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");
  const modelsUrl = `${normalizedBaseUrl}/models`;

  // Per-model overrides are read once at provider creation; Pi passes the
  // same Map across every refreshModels call in the session.
  const modelOverrides = loadModelOverridesFn();

  // Empty until the first refreshModels() restores a persisted snapshot or
  // publishes a live one.
  let models = [];

  /** Provider-scoped metadata stamped onto every model we publish. */
  const modelMeta = { provider: id, api, baseUrl: normalizedBaseUrl };

  /**
   * Normalize a persisted model entry for this provider. Entries written by
   * another provider are dropped rather than cross-wired; entries written
   * before provider/api/baseUrl were stamped are backfilled.
   */
  function normalizeStoredModel(entry) {
    if (!entry || typeof entry !== "object" || typeof entry.id !== "string" || entry.id.trim() === "") {
      return undefined;
    }
    if (entry.provider !== undefined && entry.provider !== id) return undefined;
    return {
      ...entry,
      provider: id,
      api: entry.api ?? api,
      baseUrl: entry.baseUrl ?? normalizedBaseUrl,
    };
  }

  /** The `auth.apiKey` block Pi's `/login` flow drives. */
  function buildAuthMethod() {
    return {
      name: `${name} API key`,
      async login(interaction) {
        const entered = (
          await interaction.prompt({
            type: "secret",
            message: `${name} API key`,
            placeholder: "ark-…",
          })
        ).trim();
        if (!entered) {
          throw new Error(`${name}: empty API key — login cancelled.`);
        }
        // Verify when we can. BytePlus does not document a model-listing
        // endpoint, so only an explicit 401/403 rejects the key; anything
        // else means the check was inconclusive and we keep the key rather
        // than blocking a valid user on a missing endpoint.
        const verdict = await validateApiKeyFn(entered, { url: modelsUrl, signal: interaction.signal });
        if (!verdict?.ok) {
          throw new Error(
            `${name}: that API key was rejected (HTTP 401/403). Create or check a key at https://console.byteplus.com/ark and try again.`
          );
        }
        return { type: "api_key", key: entered };
      },
      async check({ ctx, credential }) {
        void ctx;
        const key = resolveKey({ credential, readStoredApiKeyFn, env });
        return key ? { type: "api_key", source: resolveSource({ credential, readStoredApiKeyFn, env }) } : undefined;
      },
      async resolve({ ctx, credential }) {
        void ctx;
        const key = resolveKey({ credential, readStoredApiKeyFn, env });
        if (!key) return undefined;
        return {
          auth: { apiKey: key, ...(extraHeaders ? { headers: extraHeaders } : {}) },
          source: resolveSource({ credential, readStoredApiKeyFn, env }),
        };
      },
    };
  }

  return {
    id,
    name,
    baseUrl: normalizedBaseUrl,
    api,
    ...(extraHeaders ? { headers: extraHeaders } : {}),
    auth: { apiKey: buildAuthMethod() },
    getModels: () => models,
    // Native providers without a models.json overlay are used raw by Pi's
    // model runtime, so stream dispatch must live here. The compat streamers
    // pick the wire implementation from model.api (which every published
    // model carries) and receive the resolved apiKey/headers through
    // `options`.
    stream: (model, context, streamOptions) => compatStream(model, context, streamOptions),
    streamSimple: (model, context, streamOptions) => compatStreamSimple(model, context, streamOptions),
    async refreshModels(context) {
      // Offline restore first: Pi runs a cache-only refresh at startup,
      // before login and before any network access. Republishing the
      // persisted catalog keeps `/model` populated even when the network
      // phase is skipped or fails.
      const storedModels = Array.isArray(context.stored?.models) ? context.stored.models : [];
      if (storedModels.length > 0) {
        const restored = storedModels.map(normalizeStoredModel).filter((entry) => entry !== undefined);
        if (restored.length > 0) {
          const ok = await context.publish({ update: () => { models = restored; } });
          if (!ok) return;
        }
      }

      if (!context.allowNetwork) return;
      if (context.signal.aborted) return;

      // Mirror check()/resolve() key resolution so headless env-var setups
      // also get a live catalog on `/model` refresh.
      const apiKey = resolveKey({ credential: context.credential, readStoredApiKeyFn, env });
      if (!apiKey) return;

      const planDocUrl = getPlanDocUrl({ env });
      const cached = loadPlanCacheFn();
      const enrichmentDisabled = isEnrichmentDisabled({ env });
      const needPlanFetch = !enrichmentDisabled && (!cached || cached.stale);

      const planPromise = needPlanFetch
        ? fetchPlanModelsFn({ url: planDocUrl, signal: context.signal })
        : Promise.resolve(cached ? cached.models : undefined);

      // Both sources are best-effort and independent, so a slow or broken
      // one never blocks the other.
      const [planResult, liveResult] = await Promise.allSettled([
        planPromise,
        fetchCatalogFn({ apiKey, url: modelsUrl, signal: context.signal }),
      ]);

      if (context.signal.aborted) return;

      let planModels = cached?.models;
      let newlyScraped = false;
      const scraped = planResult.status === "fulfilled" ? planResult.value : undefined;
      if (scraped && scraped.length > 0) {
        planModels = scraped;
        if (needPlanFetch) newlyScraped = true;
      } else if (planResult.status === "rejected" && needPlanFetch) {
        const reason = planResult.reason instanceof Error ? planResult.reason.message : String(planResult.reason);
        const fallback =
          planModels && planModels.length > 0 ? "using the cached plan list" : "falling back to the live catalog";
        console.error(`${reason} (${fallback})`);
      }

      let liveModels;
      if (liveResult.status === "fulfilled") {
        liveModels = liveResult.value;
      } else if (!planModels || planModels.length === 0) {
        // Only worth reporting when it is the failure that actually costs us
        // models — `/models` is undocumented, so it failing alongside a good
        // plan list is expected and must not spam the console.
        const reason = liveResult.reason instanceof Error ? liveResult.reason.message : String(liveResult.reason);
        console.error(`${reason} (using the bundled model list)`);
      }

      // Dynamic discovery: whenever an API key is set and liveModels responds,
      // probe any chat-capable platform models that the plan docs don't list.
      // Verified models are cached alongside the plan list so subsequent
      // refreshes within the TTL window stay fast and zero-probe.
      const verifiedCache = new Set(cached?.verifiedModels ?? []);
      const unsupportedCache = new Set(cached?.unsupportedModels ?? []);
      const verifiedLiveModels = [];
      let cacheUpdated = false;

      if (Array.isArray(liveModels) && liveModels.length > 0) {
        const usableLive = liveModels.filter(isUsableLiveModel);
        const knownIds = new Set();
        for (const entry of planModels ?? []) {
          knownIds.add(entry.id.toLowerCase());
          knownIds.add(normalizeModelId(entry.id));
        }
        for (const id of EXTRA_PLAN_MODELS) {
          knownIds.add(id.toLowerCase());
          knownIds.add(normalizeModelId(id));
        }

        const candidates = [];
        for (const entry of usableLive) {
          const entryId = entry.id.toLowerCase();
          const normId = normalizeModelId(entry.id);
          const alias = typeof entry.name === "string" && entry.name !== "" ? entry.name.toLowerCase() : undefined;
          const normAlias = alias ? normalizeModelId(alias) : undefined;

          if (
            knownIds.has(entryId) ||
            knownIds.has(normId) ||
            (alias && knownIds.has(alias)) ||
            (normAlias && knownIds.has(normAlias))
          ) {
            continue;
          }

          const candidateId = alias && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(alias) ? entry.name : entry.id;

          if (verifiedCache.has(candidateId)) {
            verifiedLiveModels.push({ ...entry, id: candidateId });
            continue;
          }
          if (unsupportedCache.has(candidateId)) {
            continue;
          }

          candidates.push({ candidateId, entry });
        }

        const probeDisabled = env.BYTEPLUS_NO_PROBE === "1";
        if (candidates.length > 0 && !probeDisabled && !context.signal.aborted) {
          const probeResults = await Promise.allSettled(
            candidates.map(async ({ candidateId, entry }) => {
              const supported = await probeModelSupportFn({
                apiKey,
                modelId: candidateId,
                baseUrl: normalizedBaseUrl,
                signal: context.signal,
              });
              return { candidateId, entry, supported };
            })
          );

          for (const result of probeResults) {
            if (result.status === "fulfilled") {
              const { candidateId, entry, supported } = result.value;
              if (supported) {
                verifiedCache.add(candidateId);
                verifiedLiveModels.push({ ...entry, id: candidateId });
                cacheUpdated = true;
              } else {
                unsupportedCache.add(candidateId);
                cacheUpdated = true;
              }
            }
          }
        }
      }

      if ((newlyScraped || cacheUpdated) && planModels && planModels.length > 0) {
        savePlanCacheFn(planModels, {
          source: planDocUrl,
          verifiedModels: [...verifiedCache],
          unsupportedModels: [...unsupportedCache],
        });
      }

      const catalog = buildCatalog({ planModels, liveModels, verifiedLiveModels });
      const filtered = toPiModels(catalog, modelOverrides, undefined, modelMeta);

      // publish() can return false when the update was cancelled; only
      // persist after it succeeds so we never write a stale snapshot.
      const published = await context.publish({ update: () => { models = filtered; } });
      if (!published) return;

      await context.publish({ persist: { models: filtered, checkedAt: Date.now() } });

      models = filtered;
    },
  };
}

/** Number of curated models, used by the startup hint and tests. */
export function knownModelCount() {
  return Object.keys(MODEL_HINTS).length;
}
