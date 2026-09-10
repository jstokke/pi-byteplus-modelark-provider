/**
 * Type declarations for core.mjs.
 *
 * The runtime module is plain ES module JavaScript so it can be loaded by
 * Pi's jiti runtime AND tested directly with `node --test` without any
 * compile step. These declarations give the .ts entrypoint accurate types
 * for everything it imports.
 */

export interface ModelOverrideEntry {
  /** Positive integer maxTokens, or undefined when not set. */
  maxTokens?: number;
  /** Positive integer contextWindow, or undefined when not set. */
  contextWindow?: number;
}

/** A model entry from any catalog source (docs scrape, /models, seed list). */
export interface CatalogEntry {
  id: string;
  name?: string;
  /** Published context length, from the live `/models` call. */
  contextLength?: number;
  /** Published output cap, from the live `/models` call. */
  maxTokens?: number;
  /** Set when the source knows about image input. */
  vision?: boolean;
  /** Set when the source knows about reasoning support. */
  reasoning?: boolean;
}

/** `compat` block Pi applies to OpenAI-completions requests. */
export interface OpenAiCompletionsCompat {
  supportsDeveloperRole: boolean;
  maxTokensField: "max_tokens" | "max_completion_tokens";
  supportsReasoningEffort: boolean;
  thinkingFormat: "openai";
}

/** Pi-side model definition produced by toPiModel(). */
export interface PiModelDefinition {
  id: string;
  name: string;
  /** Provider-scoped metadata (stamped via `meta`); required by Pi's model runtime. */
  provider?: string;
  api?: "openai-completions";
  baseUrl?: string;
  reasoning: boolean;
  thinkingLevelMap?: { off?: string | null; minimal?: string | null; low?: string | null; medium?: string | null; high?: string | null; xhigh?: string | null; max?: string | null };
  input: ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  compat: OpenAiCompletionsCompat;
}

/** Provider-scoped metadata Pi requires on every model. */
export interface PiModelMeta {
  provider: string;
  api: "openai-completions";
  baseUrl: string;
}

export interface ApiKeyVerdict {
  ok: boolean;
  /** True when BytePlus itself answered the check (either way). */
  verified: boolean;
  reason?: string;
}

export const API_ROOT: string;
export const CODING_ROOT: string;
export const OPENAI_BASE_URL: string;
export const PROVIDER_ID: string;
export const DEFAULT_CONTEXT_WINDOW: number;
export const DEFAULT_MAX_TOKENS: number;
export const DEFAULT_MAX_TOKENS_REASONING: number;
export const DISCOVERY_TIMEOUT_MS: number;
export const OPENAI_COMPAT: OpenAiCompletionsCompat;
export const API_KEY_ENV_VARS: readonly string[];
export const SEED_CATALOG: readonly string[];
export const EXTRA_PLAN_MODELS: readonly string[];
export const MODEL_HINTS: Record<string, ModelHint>;

export interface ModelHint {
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  vision: boolean;
  thinkingLevelMap?: { off?: string | null; xhigh?: string | null };
}

export class DiscoveryError extends Error {}

export function defaultAuthPath(options?: { env?: Record<string, string | undefined> }): string;

export function readStoredApiKey(providerId: string, authPath?: string): string | undefined;

export function resolveApiKey(options?: {
  env?: Record<string, string | undefined>;
  authPath?: string;
}): string | undefined;

export function getDefaultMaxTokens(options?: {
  env?: Record<string, string | undefined>;
  reasoning?: boolean;
}): number;

export function defaultOverridesPath(options?: { env?: Record<string, string | undefined> }): string;

export function loadModelOverrides(options?: {
  path?: string;
  fsImpl?: { readFileSync: (path: string, encoding: string) => string };
}): Map<string, ModelOverrideEntry>;

export function normalizeName(name: unknown): string;

export function fetchCatalog(options: {
  apiKey: string | undefined;
  url?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<CatalogEntry[]>;

export function parseCatalog(payload: unknown): CatalogEntry[];

export function isChatModel(id: string): boolean;

export function getModelHint(id: string): ModelHint | undefined;

/** Best-effort reasoning capability + thinking-level map, or undefined when unknown. */
export function inferThinking(model: { id: string } | undefined):
  | { reasoning: boolean; thinkingLevelMap?: PiModelDefinition["thinkingLevelMap"] }
  | undefined;

export function toPiModel(
  entry: CatalogEntry,
  overrides?: Map<string, ModelOverrideEntry>,
  defaultMaxTokens?: number,
  meta?: PiModelMeta
): PiModelDefinition;

export function toPiModels(
  entries: CatalogEntry[],
  overrides?: Map<string, ModelOverrideEntry>,
  defaultMaxTokens?: number,
  meta?: PiModelMeta
): PiModelDefinition[];

/** Merge the available discovery sources into one ordered catalog. */
export function buildCatalog(sources?: {
  planModels?: CatalogEntry[] | null;
  liveModels?: CatalogEntry[] | null;
}): CatalogEntry[];

/** Validate a key; only an explicit 401/403 rejects it. Never logs the key. */
export function validateApiKey(
  apiKey: string,
  options?: { fetchImpl?: typeof fetch; timeoutMs?: number; url?: string; signal?: AbortSignal }
): Promise<ApiKeyVerdict>;
