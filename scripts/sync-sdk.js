// SPDX-License-Identifier: Apache-2.0
// Copies the astraOS SDK's design check from the astra repository into
// vendor/astra-sdk, which the server runs on every uploaded .apkg.
//
//   node scripts/sync-sdk.js [path to the astra repository, default ../astra]
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const astra = path.resolve(process.argv[2] || path.join(ROOT, "..", "astra"));
const dest = path.join(ROOT, "vendor", "astra-sdk");
// astra repository path -> vendor/astra-sdk path (the layout `astra` expects
// of an installed SDK: bundled tools in tools/<name>.py).
const FILES = {
  "sdk/bin/astra": "bin/astra",
  "sdk/astra_sdk/__init__.py": "astra_sdk/__init__.py",
  "sdk/astra_sdk/cli.py": "astra_sdk/cli.py",
  "sdk/astra_sdk/lint.py": "astra_sdk/lint.py",
  "tools/apkgtool/apkgtool.py": "tools/apkgtool.py",
};

if (!fs.existsSync(path.join(astra, "sdk", "astra_sdk", "lint.py"))) {
  console.error(`sync-sdk: ${astra} is not the astra repository`);
  process.exit(1);
}
fs.rmSync(dest, { recursive: true, force: true });
for (const [from, to] of Object.entries(FILES)) {
  fs.mkdirSync(path.dirname(path.join(dest, to)), { recursive: true });
  fs.copyFileSync(path.join(astra, from), path.join(dest, to));
}
let commit = "unknown";
try {
  commit = execFileSync("git", ["-C", astra, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
} catch {}
fs.writeFileSync(path.join(dest, "SOURCE"), `Copied from the astra repository (${commit}) by scripts/sync-sdk.js: do not edit here.\n`);
console.log(`sync-sdk: vendor/astra-sdk from ${astra} (${commit.slice(0, 7)})`);
