import { createRequire } from "node:module";
import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const destination = new URL("../lib/tessdata/", import.meta.url);
await mkdir(destination, { recursive: true });

for (const packageName of ["eng", "chi_sim"]) {
  const dataPackage = require(`@tesseract.js-data/${packageName}`);
  if (
    typeof dataPackage !== "object" ||
    dataPackage === null ||
    typeof dataPackage.langPath !== "string"
  ) {
    throw new Error(`Invalid local OCR data package: ${packageName}`);
  }
  await copyFile(
    join(dataPackage.langPath, `${packageName}.traineddata.gz`),
    new URL(`${packageName}.traineddata.gz`, destination)
  );
}
