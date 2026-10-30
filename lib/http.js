// SPDX-License-Identifier: Apache-2.0
// A tiny router and request helpers on top of node:http.
import fs from "node:fs";
import path from "node:path";

export class HttpError extends Error {
  // extra: more fields for the JSON error body.
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export class Router {
  constructor() {
    this.routes = [];
  }
  add(method, pattern, handler) {
    const keys = [];
    const regex = new RegExp("^" + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), "([^/]+)")) + "$");
    this.routes.push({ method, regex, keys, handler });
  }
  get(p, h) { this.add("GET", p, h); }
  post(p, h) { this.add("POST", p, h); }
  put(p, h) { this.add("PUT", p, h); }
  patch(p, h) { this.add("PATCH", p, h); }
  delete(p, h) { this.add("DELETE", p, h); }
  match(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.regex.exec(pathname);
      if (m) return { handler: r.handler, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
    }
    return null;
  }
}

export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, "the upload is too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export async function readJson(req, limit = 1024 * 1024) {
  const body = await readBody(req, limit);
  if (!body.length) return {};
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid JSON");
  }
}

export function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function send(res, status, body, headers = {}) {
  const isBuffer = Buffer.isBuffer(body);
  const data = isBuffer || typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": isBuffer ? "application/octet-stream" : typeof body === "string" ? "text/plain; charset=utf-8" : "application/json",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(data);
}

const TYPES = {
  ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".json": "application/json",
  ".apkg": "application/x-astra-apkg", ".ico": "image/x-icon",
};

export function contentType(file) {
  return TYPES[path.extname(file).toLowerCase()] || "application/octet-stream";
}

// Static files; "/dev" serves "/dev/index.html".
export function serveStatic(root, pathname, res) {
  let file = path.normalize(path.join(root, pathname));
  if (!file.startsWith(root)) return false;
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
  if (!fs.existsSync(file)) return false;
  res.writeHead(200, { "Content-Type": contentType(file), "Cache-Control": "public, max-age=300" });
  fs.createReadStream(file).pipe(res);
  return true;
}

export function sendFile(res, file, type, extra = {}) {
  if (!fs.existsSync(file)) throw new HttpError(404, "not found");
  const stat = fs.statSync(file);
  res.writeHead(200, { "Content-Type": type || contentType(file), "Content-Length": stat.size, ...extra });
  fs.createReadStream(file).pipe(res);
}
