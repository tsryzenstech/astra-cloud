// SPDX-License-Identifier: Apache-2.0
// Reader for astraOS .apkg packages (format: astra/docs/APKG.md).
import crypto from "node:crypto";
import zlib from "node:zlib";

const MAGIC = Buffer.from("ASTRAPKG");
const END = Buffer.from("APKGEND\0");

export class ApkgError extends Error {}

export function readApkg(buf) {
  if (buf.length < 64 + 40 || !buf.subarray(0, 8).equals(MAGIC))
    throw new ApkgError("not an .apkg file");
  if (!buf.subarray(buf.length - 8).equals(END))
    throw new ApkgError("the package is truncated");
  const digest = crypto.createHash("sha256").update(buf.subarray(0, buf.length - 40)).digest();
  if (!digest.equals(buf.subarray(buf.length - 40, buf.length - 8)))
    throw new ApkgError("the package checksum does not match");

  const version = buf.readUInt16LE(8);
  if (version !== 1)
    throw new ApkgError(`unsupported package format ${version}`);
  const manifestOffset = buf.readUInt32LE(16);
  const manifestSize = buf.readUInt32LE(20);
  const indexOffset = buf.readUInt32LE(24);
  const count = buf.readUInt32LE(32);
  const dataOffset = Number(buf.readBigUInt64LE(40));

  let manifest;
  try {
    manifest = JSON.parse(buf.subarray(manifestOffset, manifestOffset + manifestSize).toString("utf8"));
  } catch {
    throw new ApkgError("the manifest is not valid JSON");
  }
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(manifest.package || ""))
    throw new ApkgError("the manifest has no valid package name");

  const files = new Map();
  let p = indexOffset;
  for (let i = 0; i < count; i++) {
    const pathLength = buf.readUInt16LE(p);
    const compression = buf.readUInt8(p + 2);
    const offset = Number(buf.readBigUInt64LE(p + 8));
    const stored = Number(buf.readBigUInt64LE(p + 16));
    const name = buf.subarray(p + 64, p + 64 + pathLength).toString("utf8");
    files.set(name, { compression, offset: dataOffset + offset, stored });
    p += 64 + pathLength;
  }

  return {
    manifest,
    sha256: crypto.createHash("sha256").update(buf).digest("hex"),
    file(name) {
      const f = files.get(name);
      if (!f) return null;
      const data = buf.subarray(f.offset, f.offset + f.stored);
      return f.compression === 1 ? zlib.inflateSync(data) : Buffer.from(data);
    },
  };
}
