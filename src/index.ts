/**
 * BytePlus ModelArk (Coding Plan) — dynamic custom provider for Pi.
 *
 * Registers one native provider backed by a ModelArk Coding Plan API key:
 *
 *   byteplus  →  OpenAI Chat Completions wire (openai-completions)
 *
 * The Coding Plan base URL (`…/api/coding/v3`) is required. BytePlus bills
 * the pay-as-you-go data plane (`…/api/v3`) separately, so requests sent to
 * the wrong base URL do not consume the subscription.
 *
 * Auth is handled by Pi's `/login` flow. The extension exposes an
 * `auth.apiKey` block, so Pi prompts with a masked secret input, checks the
 * key, persists it to `auth.json`, and shows the credential source in the
 * selector. `BYTEPLUS_API_KEY` (and `ARK_API_KEY`) remain supported as
 * headless fallbacks — they are a fallback, not the setup path.
 *
 * The model list is discovered, not hardcoded: the Coding Plan's published
 * model list is read from BytePlus' docs (TTL cached), the live `/models`
 * catalog supplies metadata and a fallback, and a bundled seed list covers
 * the rest. See native-provider.mjs and README.md.
 *
 * Per-model maxTokens / contextWindow overrides live in
 * ~/.pi/agent/byteplus-model-overrides.json.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { OPENAI_BASE_URL, PROVIDER_ID, resolveApiKey } from "./core.mjs";
import { createBytePlusProvider } from "./native-provider.mjs";

export default function (pi: ExtensionAPI) {
  const configuredBaseUrl = (process.env.BYTEPLUS_BASE_URL || "").trim();
  const baseUrl = configuredBaseUrl || OPENAI_BASE_URL;

  pi.registerProvider(
    createBytePlusProvider({
      id: PROVIDER_ID,
      name: "BytePlus ModelArk",
      baseUrl,
      api: "openai-completions",
    })
  );

  // The one footgun worth shouting about: the pay-as-you-go data plane looks
  // almost identical but is billed on top of the subscription.
  if (configuredBaseUrl !== "" && !configuredBaseUrl.includes("/api/coding")) {
    console.error(
      `BytePlus ModelArk: BYTEPLUS_BASE_URL is set to ${configuredBaseUrl}, which is not a Coding Plan URL. Requests to the data plane (/api/v3) do not consume your Coding Plan quota and are billed separately.`
    );
  }

  // Best-effort startup hint. `/login` is the primary setup path, so log once
  // here rather than leaving first-time users with an empty `/model` picker.
  // The check is cheap (two env lookups plus one auth.json read) and only
  // fires when no source has a key at all.
  if (resolveApiKey() === undefined) {
    console.error(
      "BytePlus ModelArk: no API key found. Run `/login byteplus` in Pi (the key is saved to ~/.pi/agent/auth.json), or set BYTEPLUS_API_KEY before launching."
    );
  }
}
