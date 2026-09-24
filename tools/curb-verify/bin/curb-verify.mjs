#!/usr/bin/env node
// The `curb-verify` command, as installed from npm. Plain JavaScript on purpose, for two reasons:
//
//  1. The version check must run on any Node, including one that cannot load TypeScript at all. A .ts
//     entry point cannot guard itself: an old Node fails on the file extension before line one runs.
//  2. npm installs this package under node_modules/, and Node refuses to strip types from files
//     there (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING). So this registers a load hook that strips
//     them with Node's own stripper, for this package's files only, and then runs src/cli.ts unchanged.
//     The code that runs is exactly the TypeScript in the repository, less its type annotations.
//     Nothing is compiled or bundled.
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
  process.stderr.write(`curb-verify needs Node 22.18 or newer (found ${process.versions.node}).\n`);
  process.exit(2);
}

const { registerHooks, stripTypeScriptTypes } = await import("node:module");
const { readFileSync } = await import("node:fs");
const { fileURLToPath } = await import("node:url");

// Node flags stripTypeScriptTypes as experimental. The warning would land on every judge's terminal,
// so drop that one warning and nothing else.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...rest) => {
  const text = typeof warning === "string" ? warning : warning?.message ?? "";
  if (/stripTypeScriptTypes/.test(text)) return;
  return emitWarning(warning, ...rest);
};

const packageRoot = new URL("../../../", import.meta.url).href;
registerHooks({
  load(url, context, nextLoad) {
    if (url.startsWith(packageRoot) && url.endsWith(".ts")) {
      const source = stripTypeScriptTypes(readFileSync(fileURLToPath(url), "utf8"));
      return { format: "module", source, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

await import("../src/cli.ts");
