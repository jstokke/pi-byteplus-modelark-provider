#!/usr/bin/env node
/**
 * Maintenance smoke check for the Coding Plan docs scrape.
 *
 * `npm test` runs entirely against fixtures, so it cannot notice that
 * BytePlus changed the shape of its docs page — the failure mode there is a
 * silent fallback, not a red test. Run this after a BytePlus docs change, or
 * periodically, to confirm the live page still parses and to see whether the
 * curated hints in src/core.mjs have drifted from what the plan actually
 * serves.
 *
 *   node scripts/check-plan-docs.mjs           # report, exit 0 unless unparsable
 *   node scripts/check-plan-docs.mjs --strict  # exit 1 on any drift
 *
 * No API key is used or required.
 */

import { EXTRA_PLAN_MODELS, MODEL_HINTS, SEED_CATALOG, OPENAI_BASE_URL, toPiModels } from "../src/core.mjs";
import { fetchPlanModels, getPlanDocUrl } from "../src/enrich.mjs";

const strict = process.argv.includes("--strict");

function fail(message) {
  console.error(`FAIL  ${message}`);
  process.exitCode = 1;
}

console.log(`Reading ${getPlanDocUrl()}`);

let models;
try {
  models = await fetchPlanModels();
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
  console.log("\nThe extension still works: it falls back to the live /models catalog, then to the bundled seed list.");
  process.exit(process.exitCode ?? 0);
}

const ids = models.map((model) => model.id);
console.log(`Parsed ${ids.length} plan models:\n  ${ids.join("\n  ")}`);

// Exercise the full conversion so a bad hint cannot pass unnoticed.
const converted = toPiModels(models.map((model) => ({ ...model })), undefined, undefined, {
  provider: "byteplus",
  api: "openai-completions",
  baseUrl: OPENAI_BASE_URL,
});
console.log(`\nConverted ${converted.length} models for Pi (sample: ${converted[0]?.id ?? "none"}).`);

const curated = Object.keys(MODEL_HINTS);
const served = new Set([...ids, ...EXTRA_PLAN_MODELS]);

const withoutHints = ids.filter((id) => !curated.includes(id));
const noLongerServed = curated.filter((id) => !served.has(id));
const seedDrift = SEED_CATALOG.filter((id) => !curated.includes(id));

console.log("");
if (withoutHints.length > 0) {
  console.log(`Models on the plan with no curated hint (they get conservative defaults):\n  ${withoutHints.join("\n  ")}`);
} else {
  console.log("Every plan model has a curated hint.");
}

if (noLongerServed.length > 0) {
  console.log(`\nCurated hints no longer served by the plan (safe to remove):\n  ${noLongerServed.join("\n  ")}`);
}

if (seedDrift.length > 0) {
  console.log(`\nSeed catalog entries missing from MODEL_HINTS (bug):\n  ${seedDrift.join("\n  ")}`);
}

const drift = withoutHints.length + noLongerServed.length + seedDrift.length;
if (drift > 0) {
  if (strict) fail(`${drift} drift item(s) between the live plan and MODEL_HINTS.`);
  else console.log("\nDrift found. Re-run with --strict to make this fail, or update MODEL_HINTS in src/core.mjs.");
} else {
  console.log("\nNo drift.");
}
