#!/usr/bin/env node
/**
 * Bump, tag and publish a release.
 *
 *   npm run release -- patch            # 0.1.0 -> 0.1.1
 *   npm run release -- minor            # 0.1.0 -> 0.2.0
 *   npm run release -- major            # 0.1.0 -> 1.0.0
 *   npm run release -- 0.2.0            # exact version
 *
 *   npm run release -- patch --dry-run  # checks everything, changes nothing
 *
 * The order matters. `npm publish` is the only irreversible step here — a
 * published name@version can never be reused, not even after `npm unpublish` —
 * so every check runs before it, and the git tag is only pushed once the
 * registry has accepted the tarball. If publishing fails, the local release
 * commit and tag are rolled back so the repository is not left half-released.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("-")));
const positionals = argv.filter((a) => !a.startsWith("-"));
const dryRun = flags.has("--dry-run");
const assumeYes = flags.has("--yes") || flags.has("-y");
const skipGithubRelease = flags.has("--no-github-release");

if (flags.has("--help") || flags.has("-h")) {
  usage(0);
}
if (positionals.length !== 1) {
  usage(1);
}

function usage(code) {
  console.log(`Usage: npm run release -- <patch|minor|major|X.Y.Z> [options]

Options:
  --dry-run             Run every check and a publish rehearsal, change nothing
  --yes, -y             Skip the confirmation prompt
  --no-github-release   Do not create a GitHub release after publishing

Releasing is: update CHANGELOG.md, then run this. It refuses to start unless
the CHANGELOG already has a section for the version being released.`);
  process.exit(code);
}

const step = (n, text) => console.log(`\n[${n}] ${text}`);
const info = (text) => console.log(`    ${text}`);

function fail(message, hint) {
  console.error(`\n✗ ${message}`);
  if (hint) console.error(`  ${hint}`);
  process.exit(1);
}

/** Run a command, inheriting stdio (interactive: npm login / 2FA prompts). */
function run(cmd, args) {
  execFileSync(cmd, args, { cwd: ROOT, stdio: "inherit" });
}

/** Run a command and capture stdout; returns undefined if it exits non-zero. */
function capture(cmd, args) {
  try {
    return execFileSync(cmd, args, {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

function bump(version, kind) {
  const [major, minor, patch] = version.split(".").map(Number);
  if ([major, minor, patch].some((n) => !Number.isInteger(n))) {
    fail(`package.json has an unparseable version: ${version}`);
  }
  if (kind === "major") return `${major + 1}.0.0`;
  if (kind === "minor") return `${major}.${minor + 1}.0`;
  if (kind === "patch") return `${major}.${minor}.${patch + 1}`;
  if (/^\d+\.\d+\.\d+$/.test(kind)) return kind;
  fail(`Unknown release type: ${kind}`, "Use patch, minor, major or an exact X.Y.Z version.");
}

// ---------------------------------------------------------------- preflight

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const name = pkg.name;
const kind = positionals[0];
const version = bump(pkg.version, kind);
const tag = `v${version}`;

console.log(`${name}: ${pkg.version} -> ${version}${dryRun ? "  (dry run: nothing will change)" : ""}`);

step(1, "Checking the git state");

const branch = capture("git", ["branch", "--show-current"]);
if (branch !== "main") {
  fail(`On branch "${branch || "(detached)"}", not main.`, "Release from main.");
}
info(`branch: ${branch}`);

// CHANGELOG.md is expected to carry the new version's section, so it is the one
// file allowed to be modified. Everything else must be committed.
const dirty = (capture("git", ["status", "--porcelain"]) || "")
  .split("\n")
  .filter(Boolean)
  .filter((line) => !/^\s*\S+\s+CHANGELOG\.md$/.test(line));
if (dirty.length > 0) {
  fail("Working tree has uncommitted changes.", `Commit or stash these first:\n    ${dirty.join("\n    ")}`);
}
info("working tree clean (CHANGELOG.md excepted)");

const hasOrigin = (capture("git", ["remote"]) || "").split("\n").includes("origin");
if (hasOrigin) {
  run("git", ["fetch", "--quiet", "origin"]);
  const head = capture("git", ["rev-parse", "HEAD"]);
  const remote = capture("git", ["rev-parse", "origin/main"]);
  if (head !== remote) {
    fail("main is not in sync with origin/main.", "Push or pull first so the tag matches what is public.");
  }
  info("in sync with origin/main");
} else {
  info("no origin remote: skipping the sync check");
}

const localTag = capture("git", ["rev-parse", "-q", "--verify", `refs/tags/${tag}`]);
if (localTag) fail(`Tag ${tag} already exists locally.`);
const remoteTag = hasOrigin ? capture("git", ["ls-remote", "--tags", "origin", tag]) : "";
if (remoteTag) fail(`Tag ${tag} already exists on origin.`);
info(`tag ${tag} is free`);

step(2, "Checking the version is unpublished");

// A published version can never be reused, so this check is the last real
// safety net before the irreversible step.
const published = capture(NPM, ["view", `${name}@${version}`, "version"]);
if (published) {
  fail(`${name}@${version} is already on npm.`, "A published version can never be reused. Bump the version.");
}
info(`${name}@${version} is not on npm`);

step(3, "Checking the CHANGELOG");

const changelog = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");
if (!new RegExp(`^## \\[${version.replace(/\./g, "\\.")}\\]`, "m").test(changelog)) {
  fail(
    `CHANGELOG.md has no "## [${version}]" section.`,
    `Move the [Unreleased] notes under a "## [${version}]" heading first.`,
  );
}
info(`CHANGELOG.md has a [${version}] section`);

step(4, "Running the gates");

for (const script of ["test", "typecheck", "check:pack"]) {
  info(`npm run ${script}`);
  run(NPM, ["run", "--silent", script]);
}

step(5, "Rehearsing the publish");

run(NPM, ["publish", "--dry-run"]);

if (dryRun) {
  console.log(`\n✓ Dry run complete. Nothing was changed and nothing was published.`);
  console.log(`  Re-run without --dry-run to release ${tag}.`);
  process.exit(0);
}

// -------------------------------------------------------------- confirmation

const who = capture(NPM, ["whoami"]);
step(6, "Authenticating");
if (who) {
  info(`npm user: ${who}`);
} else {
  info("not logged in to npm, or the session expired");
}
info("npm sessions last two hours and 2FA is required to publish,");
info("so expect a login or a one-time-password prompt.");

if (!assumeYes) {
  console.log(`\nAbout to publish ${name}@${version} to npm, commit, tag ${tag} and push.`);
  console.log("A published version can never be reused or overwritten.");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`Type the version (${version}) to confirm: `)).trim();
  rl.close();
  if (answer !== version) fail("Confirmation did not match. Aborted.");
}

// -------------------------------------------------------- release and publish

step(7, "Committing and tagging");

run(NPM, ["version", version, "--no-git-tag-version"]);
run("git", ["add", "package.json", "package-lock.json", "CHANGELOG.md"]);
run("git", ["commit", "-m", `chore(release): ${tag}`]);
run("git", ["tag", "-a", tag, "-m", tag]);
const releaseCommit = capture("git", ["rev-parse", "HEAD"]);
info(`committed ${releaseCommit.slice(0, 7)} and tagged ${tag}`);

step(8, "Publishing to npm");

let publishedOk = true;
try {
  run(NPM, ["publish"]);
} catch {
  publishedOk = false;
}

if (!publishedOk) {
  // Keep the repository consistent: if the registry refused the tarball, do not
  // leave a release commit and tag behind that claim a release happened.
  console.error("\n✗ npm publish failed. Rolling back the local release commit and tag.");
  const head = capture("git", ["rev-parse", "HEAD"]);
  if (head === releaseCommit) {
    capture("git", ["tag", "-d", tag]);
    run("git", ["reset", "--hard", "HEAD~1"]);
    console.error("  Undid the commit and tag. Nothing was pushed, so origin is untouched.");
  } else {
    console.error(`  HEAD moved unexpectedly; leaving ${tag} and the commit in place.`);
  }
  console.error("  Fix the cause (usually authentication), then re-run.");
  process.exit(1);
}

step(9, "Pushing the commit and tag");
run("git", ["push", "--follow-tags"]);
info("pushed");

if (!skipGithubRelease && capture("gh", ["--version"])) {
  step(10, "Creating the GitHub release");
  try {
    run("gh", ["release", "create", tag, "--title", tag, "--verify-tag", "--generate-notes"]);
    info("GitHub release created");
  } catch {
    console.error("  Could not create the GitHub release. Publish succeeded; create it by hand if you want one.");
  }
}

step(11, "Verifying");
const live = capture(NPM, ["view", `${name}@${version}`, "version"]);
if (live === version) {
  console.log(`\n✓ ${name}@${version} is live on npm.`);
  console.log(`  pi install npm:${name}@${version}`);
} else {
  console.error(`\n! Published, but "npm view" did not confirm it yet. It may still be propagating.`);
  console.error(`  Check: npm view ${name}@${version}`);
}
