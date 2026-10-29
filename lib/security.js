// SPDX-License-Identifier: Apache-2.0
// Passwords, tokens and encryption at rest.
//
// Every user has a random 256-bit data key, stored wrapped (AES-256-GCM)
// with the server's MASTER_KEY. Contacts backups are encrypted with the
// user's data key. A stolen database alone reveals nothing; the master key
// lives only in the environment of the server process.
import crypto from "node:crypto";

const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32, SCRYPT);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(password, stored) {
  const [kind, salt, hash] = String(stored).split("$");
  if (kind !== "scrypt") return false;
  const expected = Buffer.from(hash, "base64");
  const actual = crypto.scryptSync(password, Buffer.from(salt, "base64"), expected.length, SCRYPT);
  return crypto.timingSafeEqual(actual, expected);
}

export function newToken() {
  return crypto.randomBytes(32).toString("base64url");
}

export function tokenHash(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

export function masterKey(env) {
  const raw = env.MASTER_KEY || "";
  const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (key.length !== 32)
    throw new Error("MASTER_KEY must be 32 bytes (64 hex characters): run `openssl rand -hex 32`");
  return key;
}

export function seal(key, plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
}

export function open(key, sealed) {
  const buf = Buffer.from(sealed, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]);
}

export function newDataKey(master) {
  return seal(master, crypto.randomBytes(32));
}

export function dataKey(master, wrapped) {
  return open(master, wrapped);
}

export function randomPassword() {
  return crypto.randomBytes(9).toString("base64url");
}
