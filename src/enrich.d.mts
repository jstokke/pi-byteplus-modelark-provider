/**
 * Type declarations for enrich.mjs.
 *
 * See core.d.mts for the rationale; the same pattern applies.
 */

/** One model alias published on the Coding Plan docs page. */
export interface PlanModel {
  id: string;
  name?: string;
}

export interface PlanCache {
  models: PlanModel[];
  fetchedAt: number;
  stale: boolean;
}

export const PLAN_DOC_URL: string;
export const ENRICHMENT_TTL_MS: number;
export const ENRICHMENT_TIMEOUT_MS: number;

export class EnrichmentError extends Error {}

export function getPlanDocUrl(options?: { env?: Record<string, string | undefined> }): string;

export function defaultCachePath(options?: { env?: Record<string, string | undefined> }): string;

/** Parse the `window._ROUTER_DATA = {…}` payload out of a server-rendered docs page. */
export function extractRouterData(html: string): unknown;

/** Extract the article body (markdown, falling back to a Quill delta) from router data. */
export function extractDocMarkdown(routerData: unknown): string;

/** Parse the "The following models are supported:" bullet list. Throws EnrichmentError. */
export function parsePlanModels(markdown: string): PlanModel[];

/** Parse a docs page end to end. Throws EnrichmentError. */
export function parsePlanHtml(html: string): PlanModel[];

export function fetchPlanModels(options?: {
  url?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<PlanModel[]>;

export function loadPlanCache(options?: {
  cachePath?: string;
  now?: number;
  ttlMs?: number;
}): PlanCache | null;

export function savePlanCache(
  models: PlanModel[],
  options?: { cachePath?: string; now?: number; source?: string }
): void;
