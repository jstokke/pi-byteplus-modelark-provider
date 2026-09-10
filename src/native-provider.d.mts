/**
 * Type declarations for native-provider.mjs.
 *
 * The runtime module is plain ES module JavaScript so it can be loaded by
 * Pi's jiti runtime AND tested directly with `node --test` without any
 * compile step.
 *
 * `createBytePlusProvider` is declared as returning pi-ai's runtime
 * `Provider`, so `pi.registerProvider(...)` type-checks against the real
 * interface rather than a locally re-declared structural copy.
 */

import type { Credential, Provider } from "@earendil-works/pi-ai";

import type { ApiKeyVerdict, CatalogEntry, ModelOverrideEntry, PiModelDefinition } from "./core.d.mts";
import type { PlanCache, PlanModel } from "./enrich.d.mts";

/** Pi's api-key credential shape. */
export interface ApiKeyCredentialLike {
  type: "api_key";
  key?: string;
}

export interface CreateProviderOptions {
  id?: string;
  name?: string;
  baseUrl?: string;
  api?: "openai-completions";
  /** Override for tests. Defaults to core.mjs's fetchCatalog. */
  fetchCatalogFn?: (options: {
    apiKey: string | undefined;
    url?: string;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
  }) => Promise<CatalogEntry[]>;
  /** Override for tests. Defaults to enrich.mjs's fetchPlanModels. */
  fetchPlanModelsFn?: (options?: {
    url?: string;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
  }) => Promise<PlanModel[]>;
  loadPlanCacheFn?: () => PlanCache | null;
  savePlanCacheFn?: (models: PlanModel[], options?: { cachePath?: string; now?: number; source?: string }) => void;
  loadModelOverridesFn?: () => Map<string, ModelOverrideEntry>;
  /** Override for tests. Defaults to core.mjs's validateApiKey. */
  validateApiKeyFn?: (
    apiKey: string,
    options?: { url?: string; timeoutMs?: number; fetchImpl?: typeof fetch; signal?: AbortSignal }
  ) => Promise<ApiKeyVerdict>;
  readStoredApiKeyFn?: (providerId: string, authPath?: string) => string | undefined;
  extraHeaders?: Record<string, string>;
  env?: Record<string, string | undefined>;
}

export interface ResolveKeyInput {
  credential?: ApiKeyCredentialLike | Credential;
  readStoredApiKeyFn?: (providerId: string, authPath?: string) => string | undefined;
  env?: Record<string, string | undefined>;
}

export function isEnrichmentDisabled(options?: { env?: Record<string, string | undefined> }): boolean;

export function resolveKey(input?: ResolveKeyInput): string | undefined;

export function resolveSource(input?: ResolveKeyInput): string;

export function createBytePlusProvider(options?: CreateProviderOptions): Provider;

/** Number of curated models in the bundled hints table. */
export function knownModelCount(): number;

export type { PiModelDefinition };
