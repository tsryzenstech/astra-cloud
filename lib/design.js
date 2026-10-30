// SPDX-License-Identifier: Apache-2.0
// The astraOS design check on uploaded packages: the SDK's `astra check`
// (vendor/astra-sdk, copied from the astra repository by scripts/sync-sdk.js)
// run on the unpacked .apkg. Market publishes no version it reports errors on.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

import { ApkgError } from "./apkg.js";

const ASTRA = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "vendor", "astra-sdk", "bin", "astra");
const SOURCES = /\.(qml|js|mjs)$/;

export class DesignCheckError extends Error {}

// Runs the check on a package read by readApkg; resolves to the findings
// ({file, line, severity, code, message}). system: the rules of the apps
// built into the system image (only the seeded default apps).
export async function checkDesign(pkg, { python = "python3", timeoutMs = 30000, maxBytes = 1 << 30, system = false } = {}) {
  // The check skips build/, dist/ and hidden folders: code there would not be checked.
  const hidden = pkg.names.find((n) => SOURCES.test(n) && n.split("/").slice(0, -1).some((d) => d.startsWith(".") || d === "build" || d === "dist"));
  if (hidden) throw new ApkgError(`${hidden}: QML and JavaScript go outside build/, dist/ and hidden folders, which the design check skips`);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "astra-check-"));
  try {
    pkg.extract(dir, maxBytes);
    // The manifest in the header is the one phones read.
    fs.writeFileSync(path.join(dir, "app.json"), JSON.stringify(pkg.manifest));
    const args = ["-I", ASTRA, "check", dir, "--json", ...(system ? ["--system"] : [])];
    const stdout = await new Promise((resolve, reject) => {
      execFile(python, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, cwd: os.tmpdir(), windowsHide: true },
               (err, out, stderr) => {
                 // Exit status 1 only means errors were found: the JSON says which.
                 if (err && (err.killed || typeof err.code !== "number" || err.code > 1))
                   reject(new DesignCheckError(err.killed ? `timed out after ${timeoutMs} ms` : `${err.message} ${stderr}`.trim()));
                 else resolve(out);
               });
    });
    let findings;
    try {
      findings = JSON.parse(stdout);
    } catch {
      throw new DesignCheckError(`unexpected output: ${stdout.slice(0, 200)}`);
    }
    if (!Array.isArray(findings)) throw new DesignCheckError("unexpected output");
    return findings.map((f) => ({ file: String(f.file), line: Number(f.line) || 1, severity: f.severity === "error" ? "error" : "warning",
                                  code: String(f.code), message: String(f.message) }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
