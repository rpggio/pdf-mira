import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { tsImport } from "tsx/esm/api";

const files = process.argv.slice(2);
if (!files.length) {
  console.error("Usage: node scripts/audit-map.mjs <map-file> [map-file ...]");
  process.exit(2);
}

const { parseGraphFile } = await tsImport("../src/lib/parse.ts", import.meta.url);
const { auditMap } = await tsImport("../server/map-topology.ts", import.meta.url);
const audits = [];
for (const file of files) {
  let path = resolve(file);
  try {
    path = await realpath(path);
    const bytes = await readFile(path);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const json = JSON.parse(bytes);
    audits.push({ path, sha256, ...auditMap(parseGraphFile(path, json)) });
  } catch (error) {
    audits.push({ path, error: error.message });
    process.exitCode = 1;
  }
}
console.log(JSON.stringify(audits, null, 2));
