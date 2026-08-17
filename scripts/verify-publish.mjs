import { readFile } from "node:fs/promises";

const manifest = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8")
);

const expected = Object.freeze({
  name: "dsh-open-file",
  version: "0.1.0",
  license: "MIT",
  repository: "git+https://github.com/Hyp6666/dsh-open-file.git"
});

if (
  manifest.name !== expected.name ||
  manifest.version !== expected.version ||
  manifest.license !== expected.license ||
  manifest.repository?.url !== expected.repository ||
  manifest.publishConfig?.access !== "public"
) {
  throw new Error(
    `npm publish is blocked because the manifest does not match the reviewed identity for ${expected.name}.`
  );
}

process.stdout.write(
  `Verified npm publish identity: ${expected.name}@${expected.version}\n`
);
