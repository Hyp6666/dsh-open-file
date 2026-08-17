import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const output = await build({
  entryPoints: [resolve(root, "src/client/index.tsx")],
  bundle: true,
  write: false,
  format: "cjs",
  platform: "browser",
  target: "es2022",
  jsx: "automatic",
  loader: { ".png": "dataurl" },
  external: ["react", "react/*", "@deepseek-ai/*"],
  logLevel: "warning"
});
const bundled = output.outputFiles[0];
if (bundled === undefined) throw new Error("The browser bundle was not produced.");
const body = bundled.text;
const wrapped = `window.__ModuleLoader__.load({\n` +
  `  id: "dsh-open-file",\n` +
  `  factory: (require) => {\n` +
  `    var module = { exports: {} };\n` +
  `    var exports = module.exports;\n` +
  `${body}\n` +
  `    return module.exports;\n` +
  `  }\n` +
  `});\n`;
await writeFile(resolve(root, "lib/client.js"), wrapped, "utf8");
