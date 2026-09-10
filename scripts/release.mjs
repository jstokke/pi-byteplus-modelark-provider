#!/usr/bin/env node
/**
 * Bump, tag and publish a release.
 *
 *   npm run release -- patch            # 0.1.0 -> 0.1.1
 *   npm run release -- minor
 *   npm run release -- 0.2.0            # exact version
 *   npm run release -- patch --dry-run  # checks everything, changes nothing
 *
 * Publishing mode is chosen automatically:
 *
 *   - If `.github/workflows/publish.yml` exists, the release is published by
 *     that workflow (npm trusted publishing / OIDC, with provenance). This
 *     script pushes the commit and tag, creates the GitHub release, waits for
 *     the run, and verifies the version landed.
 *   - Otherwise, or with `--local-publish`, `npm publish` runs here.
 *
 * The two must not both happen: creating the GitHub release is what triggers the
 * workflow, so publishing locally *and* creating a release would attempt to push
 * the same version twice.
 *
 * `npm publish` is the only irreversible step — a published name@version can
 * never be reused, not even after `npm unpublish` — so every check runs before
 * it. In local mode, if publishing fails, the local release commit and tag are
 * rolled back so the repository is not left half-released.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
const PUBLISH_WORKFLOW = "publish.yml";
const WORKFLOW_PATH = join(ROOT, ".github", "workflows", PUBLISH_WORKFLOW);

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("-")));
const positionals = argv.filter((a) => !a.startsWith("-"));
const dryRun = flags.has("--dry-run");
const assumeYes = flags.has("--yes") || flags.has("-y");
const skipGithubRelease = flags.has("--no-github-release");
const forceCi = flags.has("--ci-publish");
const forceLocal = flags.has("--local-publish");

if (flags.has("--help") || flags.has("-h")) {
  usage(0);
}
if (positionals.length !== 1) {
  usage(1);
}
if (forceCi && forceLocal) {
  console.error("✗ --ci-publish and --local-publish are mutually exclusive.");
  process.exit(1);
}

function usage(code) {
  console.log(`Usage: npm run release -- <patch|minor|major|X.Y.Z> [options]

Options:
  --dry-run             Run every check and a publish rehearsal, change nothing
  --yes, -y             Skip the confirmation prompt
  --local-publish       Publish from this machine with \`npm publish\`
  --ci-publish          Publish via the ${PUBLISH_WORKFLOW} GitHub workflow
  --no-github-release   Do not create a GitHub release

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

const hasPublishWorkflow = existsSync(WORKFLOW_PATH);
const ciPublish = forceCi || (hasPublishWorkflow && !forceLocal);

console.log(`${name}: ${pkg.version} -> ${version}${dryRun ? "  (dry run: nothing will change)" : ""}`);
console.log(`publishing: ${ciPublish ? `GitHub Actions (${PUBLISH_WORKFLOW})` : "locally with npm publish"}`);

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

// Works without credentials, and exercises the same tarball computation.
run(NPM, ["publish", "--dry-run"]);

if (dryRun) {
  console.log(`\n✓ Dry run complete. Nothing was changed and nothing was published.`);
  console.log(`  Re-run without --dry-run to release ${tag}.`);
  process.exit(0);
}

// -------------------------------------------------------------- confirmation

step(6, ciPublish ? "Preparing the CI publish" : "Authenticating");

if (ciPublish) {
  if (!hasPublishWorkflow) {
    fail(
      `--ci-publish was requested but .github/workflows/${PUBLISH_WORKFLOW} does not exist.`,
      "Add the workflow, or use --local-publish.",
    );
  }
  // OIDC can only publish to a package that already exists, because the trusted
  // publisher is configured per package. A brand new name has to go up first by
  // hand.
  const anyVersion = capture(NPM, ["view", name, "version"]);
  if (!anyVersion) {
    fail(
      `${name} does not exist on npm yet, so OIDC cannot publish it.`,
      "Publish the first version with --local-publish, then configure the trusted publisher\n  on npmjs.com and let CI publish from then on.",
    );
  }
  info(`${name} exists on npm (latest: ${anyVersion}); OIDC can publish to it`);
  info(`the workflow must be bound to ${PUBLISH_WORKFLOW} on npmjs.com -> package -> Settings`);
} else {
  const who = capture(NPM, ["whoami"]);
  if (who) {
    info(`npm user: ${who}`);
  } else {
    info("not logged in to npm, or the session expired");
  }
  info("npm sessions last two hours and 2FA is required to publish,");
  info("so expect a login or a one-time-password prompt.");

  if (hasPublishWorkflow) {
    info(`note: ${PUBLISH_WORKFLOW} exists, so CI would normally publish this.`);
    info("      --local-publish is forcing a local publish, and creating a GitHub");
    info("      release is skipped so the workflow cannot publish the same version twice.");
  }
}

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

// `npm version <same-version>` exits 1 with "Version not changed", so the bump
// has to be skipped when the target equals the current version. This is the
// normal case for a first release, where package.json is already at the version
// being published.
if (version === pkg.version) {
  info(`package.json is already ${version}; skipping the version bump`);
} else {
  run(NPM, ["version", version, "--no-git-tag-version"]);
}

run("git", ["add", "package.json", "package-lock.json", "CHANGELOG.md"]);

// With an unchanged version and an already-committed CHANGELOG section there is
// nothing to record, so tag the current commit instead of failing on an empty
// commit.
let createdCommit = false;
const staged = capture("git", ["diff", "--cached", "--name-only"]);
if (staged) {
  run("git", ["commit", "-m", `chore(release): ${tag}`]);
  createdCommit = true;
} else {
  info("no file changes to record; tagging the current commit");
}

run("git", ["tag", "-a", tag, "-m", tag]);
const releaseCommit = capture("git", ["rev-parse", "HEAD"]);
info(`tagged ${tag} at ${releaseCommit.slice(0, 7)}${createdCommit ? " (with a release commit)" : ""}`);

/** Find the workflow run for this commit, then wait for it to finish. */
function watchPublishRun(sha) {
  let runId;
  for (let attempt = 0; attempt < 12 && !runId; attempt++) {
    runId = capture("gh", [
      "run", "list",
      `--workflow=${PUBLISH_WORKFLOW}`,
      "--limit", "20",
      "--json", "databaseId,headSha",
      "--jq", `.[] | select(.headSha == "${sha}") | .databaseId`,
    ]);
    if (!runId) {
      // Runs take a moment to register.
      try {
        execFileSync("sleep", ["5"]);
      } catch {
        /* ignore */
      }
    }
  }
  if (!runId) return false;
  info(`workflow run ${runId}`);
  try {
    run("gh", ["run", "watch", runId, "--exit-status", "--interval", "10"]);
    return true;
  } catch {
    return false;
  }
}

if (ciPublish) {
  step(8, "Pushing the commit and tag");
  // The tag must exist remotely before the release is created.
  run("git", ["push", "--follow-tags"]);
  info("pushed");

  step(9, `Triggering ${PUBLISH_WORKFLOW}`);
  try {
    run("gh", ["release", "create", tag, "--title", tag, "--verify-tag", "--generate-notes"]);
    info("GitHub release created");
  } catch {
    fail(
      "Could not create the GitHub release.",
      `The commit and tag are pushed, but nothing was published.\n  Create the release yourself to trigger the workflow:\n    gh release create ${tag} --title ${tag} --verify-tag --generate-notes`,
    );
  }

  step(10, "Waiting for the publish workflow");
  const ok = watchPublishRun(releaseCommit);
  if (!ok) {
    console.error("\n! The publish workflow did not succeed.");
    console.error(`  Nothing definitive was published by this script. Check:`);
    console.error(`    gh run list --workflow=${PUBLISH_WORKFLOW} --limit 5`);
    console.error(`  If it failed on authentication, confirm the trusted publisher on npmjs.com`);
    console.error(`  names the repository and the workflow filename "${PUBLISH_WORKFLOW}" exactly.`);
    console.error(`  Re-running the job is safe while ${version} is unpublished.`);
    process.exit(1);
  }
  info("workflow succeeded");
} else {
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
    console.error("\n✗ npm publish failed. Undoing the local tag" + (createdCommit ? " and release commit" : "") + ".");
    const head = capture("git", ["rev-parse", "HEAD"]);
    if (head !== releaseCommit) {
      console.error(`  HEAD moved unexpectedly; leaving ${tag} and the commit in place.`);
    } else {
      capture("git", ["tag", "-d", tag]);
      if (createdCommit) {
        run("git", ["reset", "--hard", "HEAD~1"]);
        console.error("  Undid the release commit and tag. Nothing was pushed, so origin is untouched.");
      } else {
        console.error("  Undid the tag. No release commit had been created, so nothing else changed.");
      }
    }
    console.error("  Fix the cause (usually authentication), then re-run.");
    process.exit(1);
  }

  step(9, "Pushing the commit and tag");
  run("git", ["push", "--follow-tags"]);
  info("pushed");

  // Creating a release fires the publish workflow, which would try to publish a
  // version that is already on the registry. Skip it and say so.
  if (hasPublishWorkflow) {
    step(10, "Skipping the GitHub release");
    info(`a local publish happened, and creating a release would trigger ${PUBLISH_WORKFLOW}`);
    info("to publish the same version again. Create the release yourself if you want one,");
    info(`or let CI handle the next release: npm run release -- <patch>`);
  } else if (!skipGithubRelease && capture("gh", ["--version"])) {
    step(10, "Creating the GitHub release");
    try {
      run("gh", ["release", "create", tag, "--title", tag, "--verify-tag", "--generate-notes"]);
      info("GitHub release created");
    } catch {
      console.error("  Could not create the GitHub release. Publish succeeded; create it by hand if you want one.");
    }
  } else if (skipGithubRelease) {
    info("skipping the GitHub release (--no-github-release)");
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
