/**
 * Unit tests for arkcli-oauth.mjs.
 *
 * The CLI is fully faked: a scripted `runFn` returns canned stdout per
 * argv, so no test touches a real binary, browser, or network. Secrets
 * (API keys, authorization codes) are asserted absent from every error,
 * notification, and prompt.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AMBIENT_KEY_TTL_MS,
  AMBIENT_NEGATIVE_TTL_MS,
  ARKCLI_AMBIENT_ENV_VAR,
  ARKCLI_BIN_ENV_VAR,
  ARKCLI_DEFAULT_BIN,
  ArkCliError,
  ArkCliNotFoundError,
  OAUTH_CREDENTIAL_TTL_MS,
  OAUTH_LOGIN_LABEL,
  OAUTH_REFRESH_SENTINEL,
  arkCliEnv,
  completeSsoNoBrowser,
  createAmbientKeySource,
  createArkCliOAuth,
  fetchArkCliApiKey,
  findArkCliOnPath,
  isArkCliAmbientEnabled,
  isUsableAmbientProfile,
  parseArkCliJson,
  resolveArkCliBin,
  startSsoNoBrowser,
} from "./arkcli-oauth.mjs";

const SECRET = "ark-test-key-do-not-log-9f2e";
const CODE = "dGVzdC1hdXRoLWNvZGU";
const AUTH_URL = "https://signin.byteplus.com/authorize/oauth/authorize?state=test";
const NOW = 1789000000000;

const phase1Json = JSON.stringify({
  stage: "authorize_pending",
  method: "sso_no_browser",
  authorize_url: AUTH_URL,
  next_command: "arkcli auth login --no-browser --code <authorization-code>",
  expires_in_sec: 600,
});
const phase2Json = JSON.stringify({ logged_in: true });
const keyJson = JSON.stringify({
  api_key: SECRET,
  plan_tier: "lite",
  profile: "coding-plan_ap-southeast-1_personal",
  profile_type: "coding-plan",
  region: "ap-southeast-1",
});

/** Scripted CLI: match argv prefix to canned stdout, record calls. */
function fakeRun(scenes, { calls = [], fallback } = {}) {
  return async (args, options) => {
    calls.push({ args, signal: options?.signal });
    for (const [prefix, output] of scenes) {
      if (prefix.every((part, i) => args[i] === part)) {
        if (typeof output === "function") return output(args);
        return { stdout: output, stderr: "" };
      }
    }
    if (fallback) return fallback(args);
    throw new Error(`unexpected arkcli argv: ${args.join(" ")}`);
  };
}

function fakeInteraction({ code = CODE } = {}) {
  const events = [];
  const prompts = [];
  return {
    events,
    prompts,
    signal: new AbortController().signal,
    notify: (event) => events.push(event),
    prompt: async (prompt) => {
      prompts.push(prompt);
      return code;
    },
  };
}

function noSecrets(value) {
  const text = JSON.stringify(value);
  assert.ok(!text.includes(SECRET), "must not leak the API key");
  assert.ok(!text.includes(CODE), "must not leak the authorization code");
}

// ─── binary resolution ───────────────────────────────────────────────────────

test("resolveArkCliBin honors BYTEPLUS_ARKCLI_BIN, else PATH name", () => {
  assert.equal(resolveArkCliBin({ env: { [ARKCLI_BIN_ENV_VAR]: "  /opt/bin/arkcli " } }), "/opt/bin/arkcli");
  assert.equal(resolveArkCliBin({ env: {} }), ARKCLI_DEFAULT_BIN);
  assert.equal(resolveArkCliBin({ env: { [ARKCLI_BIN_ENV_VAR]: "   " } }), ARKCLI_DEFAULT_BIN);
});

test("arkCliEnv pins the caller identity and disables update checks", () => {
  const env = arkCliEnv({ env: { KEEP: "yes" } });
  assert.equal(env.KEEP, "yes");
  assert.equal(env.ARKCLI_NO_UPDATE_NOTIFIER, "1");
  assert.equal(env.ARKCLI_CALLER_TYPE, "ai_agent");
  assert.equal(env.ARKCLI_CALLER_NAME, "pi");
  assert.equal(env.ARKCLI_SKILL_NAME, "pi-byteplus-modelark-provider");
});

// ─── JSON parsing ────────────────────────────────────────────────────────────

test("parseArkCliJson reads clean JSON and JSON with trailing guidance", () => {
  assert.deepEqual(parseArkCliJson(phase1Json, "x").authorize_url, AUTH_URL);
  const withTrailing = `${phase1Json}\nOpen the following URL in a browser:\n\n${AUTH_URL}\n`;
  assert.deepEqual(parseArkCliJson(withTrailing, "x").authorize_url, AUTH_URL);
});

test("parseArkCliJson rejects empty and non-JSON output without echoing it", () => {
  for (const output of ["", "   ", "not json at all", `{\"a\": } trailing ${SECRET}`]) {
    assert.throws(() => parseArkCliJson(output, "SSO thing"), (err) => {
      assert.ok(err instanceof ArkCliError);
      noSecrets(err.message);
      return true;
    });
  }
});

// ─── Phase 1 / Phase 2 ───────────────────────────────────────────────────────

test("startSsoNoBrowser returns the authorize URL", async () => {
  const calls = [];
  const pending = await startSsoNoBrowser({ runFn: fakeRun([[["auth", "login"], phase1Json]], { calls }) });
  assert.equal(pending.authorizeUrl, AUTH_URL);
  assert.equal(pending.expiresInSec, 600);
  assert.deepEqual(calls[0].args.slice(0, 3), ["auth", "login", "--no-browser"]);
});

test("startSsoNoBrowser maps a missing binary to ArkCliNotFoundError", async () => {
  const missing = Object.assign(new Error("spawn arkcli ENOENT"), { code: "ENOENT" });
  await assert.rejects(() => startSsoNoBrowser({ runFn: async () => { throw missing; } }), (err) => {
    assert.ok(err instanceof ArkCliNotFoundError);
    assert.match(err.message, /API key/);
    return true;
  });
});

test("completeSsoNoBrowser sends the trimmed code and rejects blanks locally", async () => {
  const calls = [];
  await completeSsoNoBrowser({
    code: `  ${CODE}  `,
    runFn: fakeRun([[["auth", "login"], phase2Json]], { calls }),
  });
  const codeFlag = calls[0].args.indexOf("--code");
  assert.equal(calls[0].args[codeFlag + 1], CODE);
  await assert.rejects(() => completeSsoNoBrowser({ code: "   ", runFn: fakeRun([]) }), /cancelled/);
});

test("completeSsoNoBrowser reports a failed exchange without the code", async () => {
  const runFn = fakeRun([[["auth", "login"], JSON.stringify({ logged_in: false })]]);
  await assert.rejects(() => completeSsoNoBrowser({ code: CODE, runFn }), (err) => {
    noSecrets(err.message);
    assert.match(err.message, /not completed/);
    return true;
  });
});

// ─── API key import ──────────────────────────────────────────────────────────

test("fetchArkCliApiKey returns the key plus profile metadata", async () => {
  const fetched = await fetchArkCliApiKey({ runFn: fakeRun([[["profile", "apikey"], keyJson]]) });
  assert.equal(fetched.apiKey, SECRET);
  assert.equal(fetched.profile, "coding-plan_ap-southeast-1_personal");
  assert.equal(fetched.profileType, "coding-plan");
});

test("fetchArkCliApiKey targets a pinned profile when given", async () => {
  const calls = [];
  await fetchArkCliApiKey({ runFn: fakeRun([[["profile", "apikey"], keyJson]], { calls }), profile: "mine" });
  const at = calls[0].args.indexOf("--profile");
  assert.equal(calls[0].args[at + 1], "mine");
});

test("fetchArkCliApiKey explains the apikey-selection recovery without the key", async () => {
  const failing = async () => {
    const err = new Error("exit 1");
    err.code = 1;
    throw err;
  };
  await assert.rejects(() => fetchArkCliApiKey({ runFn: failing }), (err) => {
    assert.ok(err instanceof ArkCliError);
    assert.match(err.message, /arkcli auth apikey/);
    noSecrets(err.message);
    return true;
  });
  await assert.rejects(
    () => fetchArkCliApiKey({ runFn: fakeRun([[["profile", "apikey"], JSON.stringify({})]]) }),
    /no default ARK API key/
  );
});

// ─── OAuth method ────────────────────────────────────────────────────────────

function makeOAuth({ runFn, validate = async () => ({ ok: true, verified: true }) } = {}) {
  return createArkCliOAuth({
    validateApiKeyFn: validate,
    runFn: runFn ?? fakeRun([
      [["auth", "login", "--no-browser", "--code"], phase2Json],
      [["auth", "login"], phase1Json],
      [["profile", "apikey"], keyJson],
    ]),
    nowFn: () => NOW,
    modelsUrl: "https://ark.example/api/coding/v3/models",
  });
}

test("the OAuth method advertises the subscription login", () => {
  const oauth = makeOAuth();
  assert.equal(oauth.isSubscription, true);
  assert.equal(oauth.loginLabel, OAUTH_LOGIN_LABEL);
  assert.equal(typeof oauth.login, "function");
  assert.equal(typeof oauth.refresh, "function");
  assert.equal(typeof oauth.toAuth, "function");
});

test("login runs SSO, prompts for the code, and imports the key", async () => {
  const calls = [];
  const runFn = fakeRun(
    [
      [["auth", "login", "--no-browser", "--code"], phase2Json],
      [["auth", "login"], phase1Json],
      [["profile", "apikey"], keyJson],
    ],
    { calls }
  );
  const seen = {};
  const oauth = createArkCliOAuth({
    validateApiKeyFn: async (key, options) => {
      seen.key = key;
      seen.url = options?.url;
      return { ok: true, verified: true };
    },
    runFn,
    nowFn: () => NOW,
    modelsUrl: "https://ark.example/models",
  });
  const interaction = fakeInteraction();
  const credential = await oauth.login(interaction);

  assert.equal(credential.type, "oauth");
  assert.equal(credential.access, SECRET);
  assert.equal(credential.refresh, OAUTH_REFRESH_SENTINEL);
  assert.equal(credential.expires, NOW + OAUTH_CREDENTIAL_TTL_MS);
  assert.equal(credential.profile, "coding-plan_ap-southeast-1_personal");
  assert.equal(seen.key, SECRET);
  assert.equal(seen.url, "https://ark.example/models");

  const authUrl = interaction.events.find((event) => event.type === "auth_url");
  assert.equal(authUrl.url, AUTH_URL);
  assert.equal(interaction.prompts.length, 1);
  assert.equal(interaction.prompts[0].type, "manual_code");
  noSecrets(interaction.events);
  noSecrets(interaction.prompts);
  assert.equal(calls.length, 3);
});

test("login surfaces a missing CLI with the paste-key fallback", async () => {
  const missing = Object.assign(new Error("spawn arkcli ENOENT"), { code: "ENOENT" });
  const oauth = makeOAuth({ runFn: async () => { throw missing; } });
  await assert.rejects(() => oauth.login(fakeInteraction()), (err) => {
    assert.ok(err instanceof ArkCliNotFoundError);
    assert.match(err.message, /API key/);
    return true;
  });
});

test("login treats a cancelled prompt as cancelled, without spawning Phase 2", async () => {
  const calls = [];
  const runFn = fakeRun([[["auth", "login"], phase1Json]], { calls });
  const oauth = makeOAuth({ runFn });
  const interaction = fakeInteraction();
  interaction.prompt = async () => {
    throw new Error("user aborted");
  };
  await assert.rejects(() => oauth.login(interaction), /cancelled/);
  assert.equal(calls.length, 1);
});

test("login rejects an arkcli-selected key BytePlus refuses", async () => {
  const oauth = makeOAuth({ validate: async () => ({ ok: false, verified: true }) });
  await assert.rejects(() => oauth.login(fakeInteraction()), (err) => {
    assert.match(err.message, /401\/403/);
    noSecrets(err.message);
    return true;
  });
});

test("refresh re-reads the CLI key and extends expiry", async () => {
  const rotated = "ark-rotated-key-do-not-log-77ab";
  const runFn = fakeRun([[["profile", "apikey"], JSON.stringify({ api_key: rotated, profile: "p", profile_type: "coding-plan" })]]);
  const oauth = createArkCliOAuth({ validateApiKeyFn: async () => ({ ok: true, verified: true }), runFn, nowFn: () => NOW });
  const next = await oauth.refresh({ type: "oauth", refresh: OAUTH_REFRESH_SENTINEL, access: SECRET, expires: 1 }, undefined);
  assert.equal(next.access, rotated);
  assert.equal(next.expires, NOW + OAUTH_CREDENTIAL_TTL_MS);
  assert.ok(!JSON.stringify(next).includes(SECRET));
});

test("refresh fails closed when the CLI is gone or the key is rejected", async () => {
  const missing = Object.assign(new Error("spawn arkcli ENOENT"), { code: "ENOENT" });
  const gone = createArkCliOAuth({ runFn: async () => { throw missing; }, nowFn: () => NOW });
  await assert.rejects(
    () => gone.refresh({ type: "oauth", refresh: "arkcli", access: SECRET, expires: 1 }, undefined),
    (err) => {
      noSecrets(err.message);
      return true;
    }
  );
  const rejected = createArkCliOAuth({
    runFn: fakeRun([[["profile", "apikey"], keyJson]]),
    validateApiKeyFn: async () => ({ ok: false, verified: true }),
    nowFn: () => NOW,
  });
  await assert.rejects(
    () => rejected.refresh({ type: "oauth", refresh: "arkcli", access: SECRET, expires: 1 }, undefined),
    /401\/403/
  );
  const empty = makeOAuth();
  await assert.rejects(() => empty.refresh({ type: "oauth", refresh: "arkcli", expires: 1 }, undefined), /missing/);
});

test("toAuth derives request auth without spawning, and fails closed", async () => {
  let spawned = 0;
  const oauth = createArkCliOAuth({
    runFn: async () => {
      spawned++;
      throw new Error("must not spawn");
    },
    extraHeaders: { "x-test": "1" },
    nowFn: () => NOW,
  });
  assert.deepEqual(await oauth.toAuth({ type: "oauth", refresh: "arkcli", access: SECRET, expires: 1 }), {
    apiKey: SECRET,
    headers: { "x-test": "1" },
  });
  assert.equal(spawned, 0);
  await assert.rejects(() => oauth.toAuth({ type: "oauth", refresh: "arkcli", expires: 1 }), /missing/);
});

// ─── ambient reuse ───────────────────────────────────────────────────────────

test("isArkCliAmbientEnabled only opts out on exactly \"1\"", () => {
  assert.equal(isArkCliAmbientEnabled({ env: {} }), true);
  assert.equal(isArkCliAmbientEnabled({ env: { [ARKCLI_AMBIENT_ENV_VAR]: "1" } }), false);
  for (const value of ["0", "true", "", "yes", " 1 "]) {
    assert.equal(isArkCliAmbientEnabled({ env: { [ARKCLI_AMBIENT_ENV_VAR]: value } }), true, JSON.stringify(value));
  }
});

test("isUsableAmbientProfile accepts Coding Plan keys only", () => {
  assert.equal(isUsableAmbientProfile({ apiKey: SECRET, profileType: "coding-plan" }), true);
  assert.equal(isUsableAmbientProfile({ apiKey: SECRET, profileType: undefined }), true);
  for (const fetched of [
    undefined,
    null,
    {},
    { apiKey: "" },
    { apiKey: SECRET, profileType: "platform" },
    { apiKey: SECRET, profileType: "pay-as-you-go" },
  ]) {
    assert.equal(isUsableAmbientProfile(fetched), false, JSON.stringify(fetched?.profileType ?? fetched));
  }
});

test("createAmbientKeySource caches successes within the TTL", async () => {
  let spawns = 0;
  let now = NOW;
  const getAmbientKey = createAmbientKeySource({
    runFn: async () => {
      spawns++;
      return { stdout: keyJson, stderr: "" };
    },
    env: {},
    nowFn: () => now,
  });
  assert.equal(await getAmbientKey({}), SECRET);
  assert.equal(await getAmbientKey({}), SECRET);
  assert.equal(spawns, 1);
  now += AMBIENT_KEY_TTL_MS + 1;
  assert.equal(await getAmbientKey({}), SECRET);
  assert.equal(spawns, 2, "expiry re-reads the CLI");
});

test("createAmbientKeySource suppresses failures briefly, then retries", async () => {
  let spawns = 0;
  let now = NOW;
  let failing = true;
  const getAmbientKey = createAmbientKeySource({
    runFn: async () => {
      spawns++;
      if (failing) throw Object.assign(new Error("exit 1"), { code: 1 });
      return { stdout: keyJson, stderr: "" };
    },
    env: {},
    nowFn: () => now,
  });
  assert.equal(await getAmbientKey({}), undefined);
  assert.equal(await getAmbientKey({}), undefined);
  assert.equal(spawns, 1, "negative cache suppresses the second spawn");
  now += AMBIENT_NEGATIVE_TTL_MS + 1;
  failing = false;
  assert.equal(await getAmbientKey({}), SECRET);
  assert.equal(spawns, 2, "retry after the negative window");
});

test("createAmbientKeySource ignores non-plan profiles and honors the opt-out", async () => {
  let spawns = 0;
  const platformJson = JSON.stringify({ api_key: SECRET, profile_type: "platform" });
  const platform = createAmbientKeySource({
    runFn: async () => {
      spawns++;
      return { stdout: platformJson, stderr: "" };
    },
    env: {},
    nowFn: () => NOW,
  });
  assert.equal(await platform({}), undefined);
  assert.equal(spawns, 1);
  const disabled = createAmbientKeySource({
    runFn: async () => {
      throw new Error("must not spawn");
    },
    env: { [ARKCLI_AMBIENT_ENV_VAR]: "1" },
    nowFn: () => NOW,
  });
  assert.equal(await disabled({}), undefined);
});

test("createAmbientKeySource never throws and never leaks the key", async () => {
  const getAmbientKey = createAmbientKeySource({
    runFn: async () => {
      throw Object.assign(new Error(`boom ${SECRET}`), { code: 1 });
    },
    env: {},
    nowFn: () => NOW,
  });
  assert.equal(await getAmbientKey({}), undefined);
});

// ─── binary lookup ───────────────────────────────────────────────────────────

test("findArkCliOnPath honors explicit overrides by existence", () => {
  assert.equal(
    findArkCliOnPath({ env: { [ARKCLI_BIN_ENV_VAR]: "/opt/bin/arkcli" }, existsFn: () => true }),
    "/opt/bin/arkcli"
  );
  assert.equal(
    findArkCliOnPath({ env: { [ARKCLI_BIN_ENV_VAR]: "/opt/bin/arkcli" }, existsFn: () => false }),
    undefined
  );
  assert.equal(findArkCliOnPath({ env: { [ARKCLI_BIN_ENV_VAR]: "  " }, pathDirs: [], existsFn: () => true }), undefined);
});

test("findArkCliOnPath scans PATH and tolerates failing checks", () => {
  const seen = [];
  const existsFn = (path) => {
    seen.push(path);
    if (path === "/bad/arkcli") throw new Error("EACCES");
    return path === "/good/arkcli";
  };
  assert.equal(
    findArkCliOnPath({ pathDirs: ["/bad", "", "/good"], existsFn, delimiter: ":" }),
    "/good/arkcli"
  );
  assert.ok(seen.includes("/good/arkcli"));
  assert.equal(findArkCliOnPath({ env: {}, pathDirs: ["/empty"], existsFn: () => false }), undefined);
  assert.equal(findArkCliOnPath({ env: {}, existsFn: () => false }), undefined);
});
