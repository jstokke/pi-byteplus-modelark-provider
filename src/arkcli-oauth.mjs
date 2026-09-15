/**
 * BytePlus SSO login for Pi, backed by the `arkcli` CLI.
 *
 * Pi's `/login` flow supports two credential shapes per provider: `api_key`
 * (a pasted secret) and `oauth` (a refreshable token triple). BytePlus SSO
 * itself only mints control-plane STS credentials — the Coding Plan data
 * plane still needs an `ark-…` bearer key — so this module implements Pi's
 * `oauth` method as a thin wrapper around the CLI the user already trusts:
 *
 *   1. `arkcli auth login --no-browser` starts SSO and returns an
 *      `authorize_url` (Phase 1). Pi shows the URL via `notify`.
 *   2. The user authorizes in any browser and pastes the displayed base64
 *      code into Pi's `manual_code` prompt (Phase 2).
 *   3. `arkcli profile apikey get --format json` reads back the plan API
 *      key bound to the (now authenticated) profile, which becomes the
 *      OAuth `access` value Pi sends as the request bearer key.
 *
 * `refresh()` simply re-reads the key through the CLI, so a rotated or
 * re-selected key is picked up without another browser round-trip while the
 * SSO session is still valid. `toAuth()` derives request auth from the
 * stored credential without spawning anything.
 *
 * Pure module: the CLI spawn is injectable (`runFn`) so tests never touch a
 * real binary, and no secret (API key, authorization code) is ever embedded
 * in a thrown error, a notification, or a log line.
 */

import { execFile } from "node:child_process";
import { existsSync as defaultExistsSync } from "node:fs";
import { delimiter as pathDelimiter, isAbsolute, join } from "node:path";

/** Env var overriding the CLI binary (full path or PATH entry). */
export const ARKCLI_BIN_ENV_VAR = "BYTEPLUS_ARKCLI_BIN";

/** Fallback binary name when no override is configured. */
export const ARKCLI_DEFAULT_BIN = "arkcli";

/** Display name shown by `/login` for the SSO method. */
export const OAUTH_METHOD_NAME = "BytePlus ModelArk (SSO)";

/** Selector label for the SSO login option. */
export const OAUTH_LOGIN_LABEL = "Sign in with BytePlus SSO (arkcli)";

/** Sentinel stored in the OAuth `refresh` field (the CLI owns rotation). */
export const OAUTH_REFRESH_SENTINEL = "arkcli";

/** How long an imported key is used before `refresh()` re-reads the CLI. */
export const OAUTH_CREDENTIAL_TTL_MS = 24 * 60 * 60 * 1000;

/** Per-spawn bound: the prompts wait in Pi, never inside the child. */
export const ARKCLI_TIMEOUT_MS = 60000;

/** Env prefix applied to every CLI spawn (no implicit update checks). */
export function arkCliEnv({ env = process.env } = {}) {
  return {
    ...env,
    ARKCLI_NO_UPDATE_NOTIFIER: "1",
    ARKCLI_CALLER_TYPE: "ai_agent",
    ARKCLI_CALLER_NAME: "pi",
    ARKCLI_SKILL_NAME: "pi-byteplus-modelark-provider",
  };
}

/** Resolve the CLI binary: explicit override wins, otherwise PATH. */
export function resolveArkCliBin({ env = process.env } = {}) {
  const override = env[ARKCLI_BIN_ENV_VAR];
  if (typeof override === "string" && override.trim() !== "") return override.trim();
  return ARKCLI_DEFAULT_BIN;
}

/** Error type for CLI failures. Never carries stdout/stderr (may hold a key). */
export class ArkCliError extends Error {
  constructor(message) {
    super(message);
    this.name = "ArkCliError";
  }
}

/** Thrown when the CLI binary cannot be spawned. Points at the fallback. */
export class ArkCliNotFoundError extends ArkCliError {
  constructor(message) {
    super(message);
    this.name = "ArkCliNotFoundError";
  }
}

function isMissingBinary(err) {
  return err?.code === "ENOENT";
}

function missingBinaryMessage(bin) {
  return (
    `BytePlus ModelArk: SSO sign-in needs the \`arkcli\` CLI (looked for "${bin}"), ` +
    "which is not installed or not on PATH. " +
    'Or sign in with the "BytePlus ModelArk API key" option and paste an ark key instead.'
  );
}

/**
 * Default CLI runner. Resolves `{ stdout, stderr }`; rejects with the raw
 * execFile error (mapped to ArkCliError by `runArkCli`, never propagated).
 */
export function defaultRunArkCli(args, { signal, env = process.env, timeoutMs = ARKCLI_TIMEOUT_MS } = {}) {
  const bin = resolveArkCliBin({ env });
  return new Promise((resolve, reject) => {
    execFile(bin, args, { signal, timeout: timeoutMs, env: arkCliEnv({ env }), maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        if (isMissingBinary(err)) reject(new ArkCliNotFoundError(missingBinaryMessage(bin)));
        else reject(err);
        return;
      }
      resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

/**
 * Parse CLI structured output. Human guidance may trail the JSON payload on
 * stdout, so a whole-output parse is attempted first and then the leading
 * balanced `{…}` object. Throws ArkCliError with no output attached.
 */
export function parseArkCliJson(output, what) {
  const text = String(output ?? "").trim();
  if (text === "") throw new ArkCliError(`BytePlus ModelArk: SSO sign-in failed (${what} returned no output). Try again.`);
  try {
    return JSON.parse(text);
  } catch {
    // Fall through to the balanced-object scan below.
  }
  const start = text.indexOf("{");
  if (start === -1) throw new ArkCliError(`BytePlus ModelArk: SSO sign-in failed (could not read ${what}). Try again.`);
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          throw new ArkCliError(`BytePlus ModelArk: SSO sign-in failed (could not read ${what}). Try again.`);
        }
      }
    }
  }
  throw new ArkCliError(`BytePlus ModelArk: SSO sign-in failed (could not read ${what}). Try again.`);
}

async function runArkCli(args, { runFn = defaultRunArkCli, signal } = {}) {
  try {
    return await runFn(args, { signal });
  } catch (err) {
    if (err instanceof ArkCliError) throw err;
    if (isMissingBinary(err)) throw new ArkCliNotFoundError(missingBinaryMessage(resolveArkCliBin()));
    // stderr may echo arguments; the authorization code travels as a flag
    // value, so never attach raw process output to the error.
    throw new ArkCliError("BytePlus ModelArk: SSO sign-in failed (the arkcli command did not complete). Try again.");
  }
}

/**
 * Phase 1: create the pending SSO session. Returns `{ authorizeUrl,
 * expiresInSec }`. Throws when the CLI is missing or the session cannot
 * be created.
 */
export async function startSsoNoBrowser({ runFn = defaultRunArkCli, signal } = {}) {
  const { stdout } = await runArkCli(["auth", "login", "--no-browser", "--format", "json"], { runFn, signal });
  const payload = parseArkCliJson(stdout, "SSO authorization");
  const authorizeUrl = typeof payload?.authorize_url === "string" ? payload.authorize_url : undefined;
  if (!authorizeUrl) throw new ArkCliError("BytePlus ModelArk: SSO sign-in failed (no authorization URL). Try again.");
  const expiresInSec = typeof payload?.expires_in_sec === "number" ? payload.expires_in_sec : undefined;
  return { authorizeUrl, expiresInSec };
}

/**
 * Phase 2: exchange the pasted authorization code. The code itself is never
 * included in any error.
 */
export async function completeSsoNoBrowser({ code, runFn = defaultRunArkCli, signal } = {}) {
  if (typeof code !== "string" || code.trim() === "") {
    throw new ArkCliError("BytePlus ModelArk: SSO sign-in cancelled (no authorization code entered).");
  }
  const { stdout } = await runArkCli(["auth", "login", "--no-browser", "--code", code.trim(), "--format", "json"], {
    runFn,
    signal,
  });
  const payload = parseArkCliJson(stdout, "SSO completion");
  if (payload?.logged_in === false) {
    throw new ArkCliError("BytePlus ModelArk: SSO sign-in was not completed. Check the authorization code and try again.");
  }
  return payload;
}

/**
 * Read the plan API key bound to the authenticated profile. Never throws
 * the key itself; failures explain the recovery (`arkcli auth apikey`).
 */
export async function fetchArkCliApiKey({ runFn = defaultRunArkCli, signal, profile } = {}) {
  const args =
    typeof profile === "string" && profile !== ""
      ? ["profile", "apikey", "get", "--profile", profile, "--format", "json"]
      : ["profile", "apikey", "get", "--format", "json"];
  let stdout;
  try {
    ({ stdout } = await runArkCli(args, { runFn, signal }));
  } catch (err) {
    if (err instanceof ArkCliNotFoundError) throw err;
    throw new ArkCliError(
      "BytePlus ModelArk: SSO succeeded but no default ARK API key is selected. " +
        "Run `arkcli auth apikey` once in a terminal to pick a Coding Plan key, then retry sign-in, " +
        "or use the API-key option and paste the key directly."
    );
  }
  let payload;
  try {
    payload = parseArkCliJson(stdout, "API key");
  } catch {
    throw new ArkCliError(
      "BytePlus ModelArk: SSO succeeded but the API key could not be read. " +
        "Run `arkcli auth apikey` once in a terminal to pick a Coding Plan key, then retry sign-in."
    );
  }
  const apiKey = typeof payload?.api_key === "string" ? payload.api_key.trim() : "";
  if (apiKey === "") {
    throw new ArkCliError(
      "BytePlus ModelArk: SSO succeeded but no default ARK API key is selected. " +
        "Run `arkcli auth apikey` once in a terminal to pick a Coding Plan key, then retry sign-in, " +
        "or use the API-key option and paste the key directly."
    );
  }
  return {
    apiKey,
    profile: typeof payload?.profile === "string" ? payload.profile : undefined,
    profileType: typeof payload?.profile_type === "string" ? payload.profile_type : undefined,
    region: typeof payload?.region === "string" ? payload.region : undefined,
  };
}

/**
 * Build Pi's `oauth` auth method for the provider.
 *
 * @param {object} options
 * @param {string} [options.name] Display name used by `/login`.
 * @param {Function} [options.validateApiKeyFn] Key check (only an explicit
 *   401/403 rejects; anything else keeps the imported key).
 * @param {Function} [options.runFn] CLI runner override (tests).
 * @param {Function} [options.nowFn] Clock override (tests).
 * @param {Record<string,string>} [options.extraHeaders] Headers for request auth.
 * @param {string} [options.modelsUrl] URL used to validate the imported key.
 */
export function createArkCliOAuth(options = {}) {
  const {
    name = OAUTH_METHOD_NAME,
    validateApiKeyFn = async () => ({ ok: true, verified: false }),
    runFn = defaultRunArkCli,
    nowFn = () => Date.now(),
    extraHeaders,
    modelsUrl,
  } = options;

  function toCredential(apiKey, extra = {}) {
    return {
      type: "oauth",
      refresh: OAUTH_REFRESH_SENTINEL,
      access: apiKey,
      expires: nowFn() + OAUTH_CREDENTIAL_TTL_MS,
      ...extra,
    };
  }

  async function importKey({ signal, profile } = {}) {
    const fetched = await fetchArkCliApiKey({ runFn, signal, profile });
    // Verify when we can. Only an explicit 401/403 rejects the key; an
    // inconclusive check keeps it rather than blocking SSO on an
    // undocumented endpoint (same policy as the API-key login).
    const verdict = await validateApiKeyFn(fetched.apiKey, { url: modelsUrl, signal });
    if (verdict && verdict.ok === false) {
      throw new ArkCliError(
        "BytePlus ModelArk: the API key selected in arkcli was rejected (HTTP 401/403). " +
          "Run `arkcli auth apikey` to pick a Coding Plan key and try again."
      );
    }
    return toCredential(fetched.apiKey, {
      ...(fetched.profile ? { profile: fetched.profile } : {}),
      ...(fetched.profileType ? { profileType: fetched.profileType } : {}),
    });
  }

  return {
    name,
    isSubscription: true,
    loginLabel: OAUTH_LOGIN_LABEL,
    async login(interaction) {
      const signal = interaction.signal;
      let pending;
      try {
        pending = await startSsoNoBrowser({ runFn, signal });
      } catch (err) {
        if (err instanceof ArkCliNotFoundError) throw err;
        throw new ArkCliError("BytePlus ModelArk: SSO sign-in failed (could not start browser authorization). Try again.");
      }
      interaction.notify({
        type: "auth_url",
        url: pending.authorizeUrl,
        instructions:
          "Open the URL in any browser, finish BytePlus SSO, then paste the displayed authorization code here." +
          (typeof pending.expiresInSec === "number" ? ` The code expires in about ${Math.round(pending.expiresInSec / 60)} minutes.` : ""),
      });
      let code;
      try {
        code = await interaction.prompt({
          type: "manual_code",
          message: "BytePlus SSO authorization code",
          placeholder: "Paste the code shown in the browser",
        });
      } catch {
        throw new ArkCliError("BytePlus ModelArk: SSO sign-in cancelled.");
      }
      if (typeof code !== "string" || code.trim() === "") {
        throw new ArkCliError("BytePlus ModelArk: SSO sign-in cancelled (no authorization code entered).");
      }
      try {
        await completeSsoNoBrowser({ code: code.trim(), runFn, signal });
      } catch (err) {
        if (err instanceof ArkCliError) throw err;
        throw new ArkCliError("BytePlus ModelArk: SSO sign-in was not completed. Check the authorization code and try again.");
      }
      interaction.notify({ type: "progress", message: "BytePlus SSO complete, importing the Coding Plan API key." });
      return importKey({ signal });
    },
    async refresh(credential, signal) {
      const current = credential && typeof credential.access === "string" ? credential.access : undefined;
      if (!current) throw new ArkCliError("BytePlus ModelArk: SSO credential is missing. Run `/login byteplus` again.");
      const profile = credential && typeof credential.profile === "string" ? credential.profile : undefined;
      let fetched;
      try {
        fetched = await fetchArkCliApiKey({ runFn, signal, profile });
      } catch (err) {
        if (err instanceof ArkCliNotFoundError) throw err;
        throw new ArkCliError("BytePlus ModelArk: SSO session expired or the API key changed. Run `/login byteplus` again.");
      }
      const verdict = await validateApiKeyFn(fetched.apiKey, { url: modelsUrl, signal });
      if (verdict && verdict.ok === false) {
        throw new ArkCliError("BytePlus ModelArk: the stored SSO key was rejected (HTTP 401/403). Run `/login byteplus` again.");
      }
      return toCredential(fetched.apiKey, {
        ...(fetched.profile ?? profile ? { profile: fetched.profile ?? profile } : {}),
        ...(fetched.profileType ? { profileType: fetched.profileType } : {}),
      });
    },
    async toAuth(credential) {
      const access = credential && typeof credential.access === "string" ? credential.access : undefined;
      if (!access) throw new ArkCliError("BytePlus ModelArk: SSO credential is missing. Run `/login byteplus` again.");
      return { apiKey: access, ...(extraHeaders ? { headers: extraHeaders } : {}) };
    },
  };
}

/** Env var disabling automatic reuse of the arkcli-stored key. */
export const ARKCLI_AMBIENT_ENV_VAR = "BYTEPLUS_NO_ARKCLI";

/** Profile types whose keys may be reused without an explicit login. */
export const AMBIENT_PROFILE_TYPES = Object.freeze(["coding-plan"]);

/** How long a successfully read ambient key is reused before re-reading. */
export const AMBIENT_KEY_TTL_MS = 5 * 60 * 1000;

/** How long a failed ambient read suppresses further CLI spawns. */
export const AMBIENT_NEGATIVE_TTL_MS = 60 * 1000;

/**
 * Whether the apiKey method may silently reuse the arkcli-stored key.
 * Explicit `/login` (either method) always works; this only gates the
 * ambient fallback. `BYTEPLUS_NO_ARKCLI=1` opts out.
 */
export function isArkCliAmbientEnabled({ env = process.env } = {}) {
  return env[ARKCLI_AMBIENT_ENV_VAR] !== "1";
}

/**
 * Only Coding Plan profile keys may be reused unsolicited. A platform
 * (pay-as-you-go) key would authenticate but never consume the plan, so
 * it must not masquerade as a configured provider. An absent profile type
 * (older CLI output) is accepted — the key is still validated on use.
 */
export function isUsableAmbientProfile(fetched) {
  if (!fetched || typeof fetched.apiKey !== "string" || fetched.apiKey === "") return false;
  if (fetched.profileType === undefined) return true;
  return AMBIENT_PROFILE_TYPES.includes(fetched.profileType);
}

/**
 * Cached ambient key source for the apiKey method. Returns an async
 * `getAmbientKey({ signal })` that resolves the arkcli-stored plan key, or
 * undefined when ambient reuse is disabled, the CLI is missing, no key is
 * selected, or the selected profile is not a Coding Plan profile.
 *
 * Successes are cached for `ttlMs`, failures for `negativeTtlMs`, so the
 * per-request check()/resolve() path spawns at most one CLI process per
 * window. Never throws and never leaks the key.
 */
export function createAmbientKeySource({
  runFn = defaultRunArkCli,
  env = process.env,
  nowFn = () => Date.now(),
  ttlMs = AMBIENT_KEY_TTL_MS,
  negativeTtlMs = AMBIENT_NEGATIVE_TTL_MS,
} = {}) {
  let cachedKey;
  let cachedUntil = 0;
  let negativeUntil = 0;
  return async function getAmbientKey({ signal } = {}) {
    if (!isArkCliAmbientEnabled({ env })) return undefined;
    const now = nowFn();
    if (cachedKey !== undefined && now < cachedUntil) return cachedKey;
    if (now < negativeUntil) return undefined;
    let fetched;
    try {
      fetched = await fetchArkCliApiKey({ runFn, signal });
    } catch {
      negativeUntil = now + negativeTtlMs;
      return undefined;
    }
    if (!isUsableAmbientProfile(fetched)) {
      negativeUntil = now + negativeTtlMs;
      return undefined;
    }
    cachedKey = fetched.apiKey;
    cachedUntil = now + ttlMs;
    return cachedKey;
  };
}

/**
 * Locate the arkcli binary without spawning anything. Honors
 * `BYTEPLUS_ARKCLI_BIN` (exact path wins when it exists), otherwise scans
 * PATH. Returns the path or undefined. Used for the startup hint, where a
 * spawn would be too eager; authentication itself always goes through the
 * CLI so a stale PATH entry can never produce a wrong key.
 */
export function findArkCliOnPath({ env = process.env, existsFn = defaultExistsSync, pathDirs, delimiter = pathDelimiter } = {}) {
  const bin = resolveArkCliBin({ env });
  if (bin.includes("/") || isAbsolute(bin)) {
    return existsFn(bin) ? bin : undefined;
  }
  const dirs = pathDirs ?? String(env.PATH ?? "").split(delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = join(dir, bin);
    try {
      if (existsFn(candidate)) return candidate;
    } catch {
      // A failing existence check is not fatal; keep scanning.
    }
  }
  return undefined;
}
