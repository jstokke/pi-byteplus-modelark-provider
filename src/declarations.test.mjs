/**
 * Keeps the hand-written `.d.mts` declarations honest about the `.mjs`.
 *
 * `npm run typecheck` cannot do this. `skipLibCheck` is on, so the contents of
 * the declaration files are not verified, and the `.mjs` modules carry no JSDoc
 * so they cannot be checked as JavaScript either. That makes the declarations
 * the only description of these modules, with nothing comparing them to the
 * implementations they describe.
 *
 * This test covers the failure that actually bites: a declared export that no
 * longer exists at runtime, or a runtime export that was never declared. It
 * cannot check argument or return types — see CONTRIBUTING.md.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const modules = ["core", "enrich", "native-provider"];

/** Value exports (things that exist at runtime), as declared in a `.d.mts`. */
function declaredValueExports(source) {
  const names = new Set();
  const patterns = [
    /^export\s+declare\s+(?:async\s+)?(?:function|const|let|var|class|enum)\s+([A-Za-z_$][\w$]*)/gm,
    /^export\s+(?:async\s+)?(?:function|const|let|var|class|enum)\s+([A-Za-z_$][\w$]*)/gm,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) names.add(match[1]);
  }
  return names;
}

/** Type-only exports, which correctly have no runtime counterpart. */
function declaredTypeExports(source) {
  const names = new Set();
  for (const match of source.matchAll(/^export\s+(?:interface|type)\s+([A-Za-z_$][\w$]*)/gm)) {
    names.add(match[1]);
  }
  return names;
}

for (const name of modules) {
  test(`${name}: declared value exports match the runtime exports`, async () => {
    const declaration = readFileSync(join(here, `${name}.d.mts`), "utf8");
    const declared = declaredValueExports(declaration);
    const runtime = new Set(Object.keys(await import(`./${name}.mjs`)));

    const missing = [...declared].filter((key) => !runtime.has(key)).sort();
    const undeclared = [...runtime].filter((key) => !declared.has(key)).sort();

    assert.deepEqual(
      missing,
      [],
      `${name}.d.mts declares exports that ${name}.mjs does not provide. Either implement them or drop the declaration.`,
    );
    assert.deepEqual(
      undeclared,
      [],
      `${name}.mjs exports these but ${name}.d.mts does not declare them, so consumers cannot see them.`,
    );

    // A declaration that is only a type is fine, and must not be expected at
    // runtime. This keeps the intent of the two sets explicit.
    for (const typeName of declaredTypeExports(declaration)) {
      assert.ok(!runtime.has(typeName), `${name}.d.mts declares ${typeName} as a type, but ${name}.mjs also exports a value with that name.`);
    }
  });
}
