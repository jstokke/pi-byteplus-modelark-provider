#!/usr/bin/env node
/**
 * Asserts what `npm publish` would actually upload.
 *
 * The package ships its source rather than a build artifact, so an over-broad
 * `files` entry or a stray local file is the easiest way to publish something
 * unintended. Running this in CI turns a tarball change into a failed build
 * instead of a surprise on npm.
 */
import { execFileSync } from "node:child_process";

const REQUIRED = [
  "package.json",
  "README.md",
  "CHANGELOG.md",
  "LICENSE",
  "src/index.ts",
  "src/core.mjs",
  "src/enrich.mjs",
  "src/native-provider.mjs",
  "src/core.d.mts",
  "src/enrich.d.mts",
  "src/native-provider.d.mts",
  "src/README.md",
];

const FORBIDDEN = [
  /\.test\.mjs$/,
  /^node_modules\//,
  /^\.ai_logs\//,
  /^\.github\//,
  /^scripts\//,
  /^CONTRIBUTING\.md$/,
];

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const raw = execFileSync(npm, ["pack", "--dry-run", "--json"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"],
});
const [{ files }] = JSON.parse(raw);
const paths = files.map((entry) => entry.path).sort();

const missing = REQUIRED.filter((path) => !paths.includes(path));
const unexpected = paths.filter((path) =>
  FORBIDDEN.some((pattern) => pattern.test(path)),
);

if (missing.length > 0 || unexpected.length > 0) {
  console.error("npm pack contents are wrong:\n");
  for (const path of missing) console.error(`  missing:            ${path}`);
  for (const path of unexpected) console.error(`  should not ship:    ${path}`);
  console.error(`\nActual tarball contents (${paths.length} files):`);
  for (const path of paths) console.error(`  ${path}`);
  process.exit(1);
}

console.log(`npm pack contents OK (${paths.length} files).`);
