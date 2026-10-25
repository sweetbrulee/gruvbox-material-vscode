// Usage: npm run check:colors -- <path-to-vscode-checkout>
//
// Lists workbench color ids registered by VS Code but not set by our theme,
// and ids we set that VS Code no longer registers. Only src/vs and the built-in
// extensions' package.json are read, so a sparse checkout is enough:
//   git clone --depth 1 --filter=blob:none --sparse https://github.com/microsoft/vscode.git
//   git -C vscode sparse-checkout set src/vs extensions
//
// Ids are extracted with regexes, not a TS parser. Calls whose id is not a
// string literal are listed under "dynamic registerColor calls" so they can be
// checked by hand; the terminal ANSI colors are the one known case and are
// handled explicitly below.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { getWorkbench } = require("../dist/workbench/index.js");

const vscodeRoot = process.argv[2];
if (!vscodeRoot) {
  console.error("usage: missing-colors.mjs <path-to-vscode-checkout>");
  process.exit(2);
}
const srcRoot = join(vscodeRoot, "src", "vs");

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === "test") continue;
      yield* walk(path);
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
      yield path;
    }
  }
}

const registered = new Map(); // id -> { file, deprecated }
const dynamicCalls = [];
const literalCall = /\bregisterColor\(\s*(['"`])([^'"`]+)\1/g;
// `(?<!\.)` skips the registry's own `colorRegistry.registerColor(id, ...)`.
const anyCall = /(?<!\.)\bregisterColor\(\s*(?!['"`])(\w+)/g;

for (const file of walk(srcRoot)) {
  const text = readFileSync(file, "utf8");
  if (!text.includes("registerColor(")) continue;
  const rel = relative(srcRoot, file);

  for (const m of text.matchAll(literalCall)) {
    // The statement ends at the first `);` — nested localize(...) calls close
    // with `)` followed by `,` or `)`, never `;`.
    const end = text.indexOf(");", m.index);
    const call = text.slice(m.index, end === -1 ? undefined : end);
    registered.set(m[2], { file: rel, deprecated: /deprecat/i.test(call) });
  }
  for (const m of text.matchAll(anyCall)) {
    // Skip the declarations in colorUtils.ts (`registerColor(id: string, ...)`).
    if (/^\s*:/.test(text.slice(m.index + m[0].length))) continue;
    if (rel.endsWith("terminalColorRegistry.ts")) continue;
    const line = text.slice(0, m.index).split("\n").length;
    dynamicCalls.push(`${rel}:${line}`);
  }
  if (rel.endsWith("terminalColorRegistry.ts")) {
    for (const m of text.matchAll(/['"](terminal\.ansi\w+)['"]\s*:/g)) {
      registered.set(m[1], { file: rel, deprecated: false });
    }
  }
}

// Built-in extensions (e.g. git's gitDecoration.*) register colors through
// contributes.colors instead of registerColor().
const extensionsRoot = join(vscodeRoot, "extensions");
for (const name of readdirSync(extensionsRoot)) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(extensionsRoot, name, "package.json"), "utf8"));
  } catch {
    continue;
  }
  for (const { id } of manifest.contributes?.colors ?? []) {
    registered.set(id, { file: `extensions/${name}/package.json`, deprecated: false });
  }
}

const baseConfiguration = {
  darkContrast: "medium",
  lightContrast: "medium",
  darkPalette: "material",
  lightPalette: "material",
  darkCursor: "white",
  lightCursor: "black",
  darkSelection: "grey",
  lightSelection: "grey",
  colorfulSyntax: false,
  italicKeywords: false,
  italicComments: true,
  diagnosticTextBackgroundOpacity: "0%",
  highContrast: false,
};

const styles = ["material", "flat", "high-contrast"];
const definedByStyle = new Map();
for (const style of styles) {
  const configuration = {
    ...baseConfiguration,
    darkWorkbench: style,
    lightWorkbench: style,
  };
  const keys = new Set([
    ...Object.keys(getWorkbench(configuration, "dark")),
    ...Object.keys(getWorkbench(configuration, "light")),
  ]);
  definedByStyle.set(style, keys);
}

const active = [...registered].filter(([, v]) => !v.deprecated);
const missing = new Map(); // id -> styles missing it
for (const [id] of active) {
  const lacking = styles.filter((s) => !definedByStyle.get(s).has(id));
  if (lacking.length) missing.set(id, lacking);
}

const allDefined = new Set(styles.flatMap((s) => [...definedByStyle.get(s)]));
const unknown = [...allDefined].filter((id) => !registered.has(id)).sort();
const deprecatedUsed = [...allDefined]
  .filter((id) => registered.get(id)?.deprecated)
  .sort();

// Group missing ids by source file so related colors land together.
const byFile = new Map();
for (const [id, lacking] of missing) {
  const { file } = registered.get(id);
  if (!byFile.has(file)) byFile.set(file, []);
  byFile.get(file).push([id, lacking]);
}

console.log(
  `VS Code registers ${active.length} active color ids; ${missing.size} are not set by every workbench style.\n`
);
for (const file of [...byFile.keys()].sort()) {
  console.log(file);
  for (const [id, lacking] of byFile.get(file).sort()) {
    const note = lacking.length === styles.length ? "" : `  (missing in: ${lacking.join(", ")})`;
    console.log(`  ${id}${note}`);
  }
}
if (deprecatedUsed.length) {
  console.log(`\nSet by us but deprecated in VS Code (${deprecatedUsed.length}):`);
  for (const id of deprecatedUsed) console.log(`  ${id}`);
}
if (unknown.length) {
  console.log(`\nSet by us but not registered by VS Code (${unknown.length}):`);
  for (const id of unknown) console.log(`  ${id}`);
}
if (dynamicCalls.length) {
  console.log(`\nDynamic registerColor calls, check by hand (${dynamicCalls.length}):`);
  for (const loc of dynamicCalls) console.log(`  ${loc}`);
}
