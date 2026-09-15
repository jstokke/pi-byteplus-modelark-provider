/**
 * Type declarations for arkcli-oauth.mjs.
 *
 * The runtime module is plain ES module JavaScript so it can be loaded by
 * Pi's jiti runtime AND tested directly with `node --test` without any
 * compile step. These declarations give the .ts entrypoint accurate types
 * for everything it imports.
 */

import type { ModelAuth, OAuthCredential } from "@earendil-works/pi-ai";

import type { ApiKeyVerdict } from "./core.d.mts";

export const ARKCLI_BIN_ENV_VAR: string;
export const ARKCLI_DEFAULT_BIN: string;
export const OAUTH_METHOD_NAME: string;
export const OAUTH_LOGIN_LABEL: string;
export const OAUTH_REFRESH_SENTINEL: string;
export const OAUTH_CREDENTIAL_TTL_MS: number;
export const ARKCLI_TIMEOUT_MS: number;
export const ARKCLI_AMBIENT_ENV_VAR: string;
export const AMBIENT_PROFILE_TYPES: readonly string[];
export const AMBIENT_KEY_TTL_MS: number;
export const AMBIENT_NEGATIVE_TTL_MS: number;

export interface ArkCliRunResult {
  stdout: string;
  stderr: string;
}

export type ArkCliRunFn = (
  args: string[],
  options?: { signal?: AbortSignal; env?: Record<string, string | undefined>; timeoutMs?: number }
) => Promise<ArkCliRunResult>;

export function arkCliEnv(options?: { env?: Record<string, string | undefined> }): Record<string, string | undefined>;

export function resolveArkCliBin(options?: { env?: Record<string, string | undefined> }): string;

export class ArkCliError extends Error {}
export class ArkCliNotFoundError extends ArkCliError {}

export function defaultRunArkCli(
  args: string[],
  options?: { signal?: AbortSignal; env?: Record<string, string | undefined>; timeoutMs?: number }
): Promise<ArkCliRunResult>;

export function parseArkCliJson(output: unknown, what: string): Record<string, unknown>;

export interface SsoPending {
  authorizeUrl: string;
  expiresInSec?: number;
}

export function startSsoNoBrowser(options?: { runFn?: ArkCliRunFn; signal?: AbortSignal }): Promise<SsoPending>;

export function completeSsoNoBrowser(options: {
  code: string;
  runFn?: ArkCliRunFn;
  signal?: AbortSignal;
}): Promise<Record<string, unknown>>;

export interface ArkCliApiKey {
  apiKey: string;
  profile?: string;
  profileType?: string;
  region?: string;
}

export function fetchArkCliApiKey(options?: {
  runFn?: ArkCliRunFn;
  signal?: AbortSignal;
  profile?: string;
}): Promise<ArkCliApiKey>;

export function isArkCliAmbientEnabled(options?: { env?: Record<string, string | undefined> }): boolean;

export function isUsableAmbientProfile(fetched: ArkCliApiKey | undefined | null): boolean;

export function createAmbientKeySource(options?: {
  runFn?: ArkCliRunFn;
  env?: Record<string, string | undefined>;
  nowFn?: () => number;
  ttlMs?: number;
  negativeTtlMs?: number;
}): (options?: { signal?: AbortSignal }) => Promise<string | undefined>;

export function findArkCliOnPath(options?: {
  env?: Record<string, string | undefined>;
  existsFn?: (path: string) => boolean;
  pathDirs?: string[];
  delimiter?: string;
}): string | undefined;

export interface CreateArkCliOAuthOptions {
  name?: string;
  validateApiKeyFn?: (
    apiKey: string,
    options?: { url?: string; timeoutMs?: number; fetchImpl?: typeof fetch; signal?: AbortSignal }
  ) => Promise<ApiKeyVerdict>;
  runFn?: ArkCliRunFn;
  nowFn?: () => number;
  extraHeaders?: Record<string, string>;
  modelsUrl?: string;
}

export interface ArkCliOAuthMethod {
  name: string;
  isSubscription: boolean;
  loginLabel: string;
  login(interaction: {
    signal: AbortSignal;
    prompt(prompt: { type: string; message: string; placeholder?: string }): Promise<string>;
    notify(event: { type: string; url?: string; instructions?: string; message?: string }): void;
  }): Promise<OAuthCredential>;
  refresh(credential: OAuthCredential, signal: AbortSignal): Promise<OAuthCredential>;
  toAuth(credential: OAuthCredential): Promise<ModelAuth>;
}

export function createArkCliOAuth(options?: CreateArkCliOAuthOptions): ArkCliOAuthMethod;
