// SPDX-License-Identifier: Apache-2.0
//
// astra cloud: the astraOS app store (Market) and AstraID.
//
//   Store      catalog for Market, app pages, downloads; a developer panel to
//              publish apps; a landing page where people ask to become
//              developers; SDK documentation.
//   AstraID    accounts, Find My Device (locate, ring, lock, notifications
//              sent to a phone) and an encrypted backup of contacts. Nothing
//              else is backed up: no files, photos, videos or audio.
//
// Configuration (environment): see .env.example.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { openDatabase } from "./lib/db.js";
import { Router, HttpError, readBody, readJson, cookies, send, serveStatic, sendFile } from "./lib/http.js";
import * as sec from "./lib/security.js";
import { readApkg, ApkgError } from "./lib/apkg.js";
import { checkDesign, DesignCheckError } from "./lib/design.js";
import { registerWhatsApp } from "./lib/whatsapp.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;
const PORT = Number(env.PORT || 8080);
const DATA = path.resolve(env.DATA_DIR || path.join(ROOT, "data"));
const PUBLIC_URL = (env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const MAX_APKG = Number(env.MAX_APKG_MB || 300) * 1024 * 1024;
const DESIGN_CHECK = { python: env.ASTRA_PYTHON || "python3", timeoutMs: Number(env.DESIGN_CHECK_TIMEOUT_S || 30) * 1000,
                       maxBytes: 4 * MAX_APKG };
const MASTER = sec.masterKey(env);
const SECURE_COOKIE = PUBLIC_URL.startsWith("https://");

const db = openDatabase(DATA);
const FILES = { apps: path.join(DATA, "apps"), icons: path.join(DATA, "icons"), screens: path.join(DATA, "screens"),
                stories: path.join(DATA, "stories") };
for (const d of Object.values(FILES)) fs.mkdirSync(d, { recursive: true });
const now = () => Date.now();
const q = (sql) => db.prepare(sql);

// ---- first admin --------------------------------------------------------------
if (env.ADMIN_EMAIL && env.ADMIN_PASSWORD && !q("SELECT 1 FROM users WHERE email = ?").get(env.ADMIN_EMAIL)) {
  q("INSERT INTO users (email, name, pass_hash, role, data_key, created) VALUES (?, ?, ?, 'admin', ?, ?)")
    .run(env.ADMIN_EMAIL, "Administrator", sec.hashPassword(env.ADMIN_PASSWORD), sec.newDataKey(MASTER), now());
  console.log(`created admin ${env.ADMIN_EMAIL}`);
}

// ---- auth -------------------------------------------------------------------------
function sessionFor(req) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : cookies(req).sid;
  if (!token) return null;
  const s = q("SELECT * FROM sessions WHERE token_hash = ?").get(sec.tokenHash(token));
  if (!s) return null;
  const user = q("SELECT id, email, name, role, data_key FROM users WHERE id = ?").get(s.user_id);
  if (!user) return null;
  q("UPDATE sessions SET last_used = ? WHERE token_hash = ?").run(now(), s.token_hash);
  return { user, deviceId: s.device_id, tokenHash: s.token_hash };
}
function need(req, role) {
  const s = sessionFor(req);
  if (!s) throw new HttpError(401, "sign in first");
  const rank = { user: 0, developer: 1, admin: 2 };
  if (role && rank[s.user.role] < rank[role]) throw new HttpError(403, "not allowed");
  return s;
}
function needDevice(req) {
  const s = need(req);
  if (!s.deviceId) throw new HttpError(403, "a device token is required");
  return s;
}
function startSession(userId, deviceId = null) {
  const token = sec.newToken();
  q("INSERT INTO sessions (token_hash, user_id, device_id, created, last_used) VALUES (?, ?, ?, ?, ?)")
    .run(sec.tokenHash(token), userId, deviceId, now(), now());
  return token;
}
function sessionCookie(token) {
  return `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}${SECURE_COOKIE ? "; Secure" : ""}`;
}

// Login throttling: 10 attempts per address every 10 minutes.
const attempts = new Map();
function throttle(req) {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket.remoteAddress;
  const list = (attempts.get(ip) || []).filter((t) => now() - t < 10 * 60 * 1000);
  if (list.length >= 10) throw new HttpError(429, "too many attempts, try again later");
  list.push(now());
  attempts.set(ip, list);
}

const validEmail = (e) => typeof e === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) && e.length < 200;
const clean = (s, n = 200) => String(s ?? "").trim().slice(0, n);

const r = new Router();

r.post("/api/auth/register", async (req, res) => {
  throttle(req);
  const b = await readJson(req);
  if (!validEmail(b.email)) throw new HttpError(400, "enter a valid email address");
  if (String(b.password || "").length < 8) throw new HttpError(400, "the password needs at least 8 characters");
  if (q("SELECT 1 FROM users WHERE email = ?").get(b.email)) throw new HttpError(409, "an AstraID with this email already exists");
  const info = q("INSERT INTO users (email, name, pass_hash, role, data_key, created) VALUES (?, ?, ?, 'user', ?, ?)")
    .run(b.email, clean(b.name, 80) || b.email.split("@")[0], sec.hashPassword(b.password), sec.newDataKey(MASTER), now());
  return login(res, Number(info.lastInsertRowid), b.device);
});

r.post("/api/auth/login", async (req, res) => {
  throttle(req);
  const b = await readJson(req);
  const u = q("SELECT * FROM users WHERE email = ?").get(String(b.email || ""));
  if (!u || !sec.verifyPassword(String(b.password || ""), u.pass_hash)) throw new HttpError(401, "wrong email or password");
  return login(res, u.id, b.device);
});

function login(res, userId, device) {
  const u = q("SELECT id, email, name, role FROM users WHERE id = ?").get(userId);
  if (device && typeof device === "object") {
    // A phone signing in: it becomes one of the account's devices.
    const d = q("INSERT INTO devices (user_id, name, model, os, created) VALUES (?, ?, ?, ?, ?)")
      .run(userId, clean(device.name, 60) || "astraOS phone", clean(device.model, 60), clean(device.os, 60), now());
    const token = startSession(userId, Number(d.lastInsertRowid));
    return send(res, 200, { token, deviceId: Number(d.lastInsertRowid), user: u });
  }
  return send(res, 200, { user: u }, { "Set-Cookie": sessionCookie(startSession(userId)) });
}

r.post("/api/auth/logout", async (req, res) => {
  const s = sessionFor(req);
  if (s) {
    q("DELETE FROM sessions WHERE token_hash = ?").run(s.tokenHash);
    if (s.deviceId) q("DELETE FROM devices WHERE id = ?").run(s.deviceId);
  }
  send(res, 200, { ok: true }, { "Set-Cookie": "sid=; Path=/; Max-Age=0" });
});

r.get("/api/auth/me", async (req, res) => {
  const s = need(req);
  const { id, email, name, role } = s.user;
  send(res, 200, { id, email, name, role });
});

r.post("/api/auth/password", async (req, res) => {
  const s = need(req);
  const b = await readJson(req);
  const u = q("SELECT pass_hash FROM users WHERE id = ?").get(s.user.id);
  if (!sec.verifyPassword(String(b.current || ""), u.pass_hash)) throw new HttpError(401, "the current password is wrong");
  if (String(b.password || "").length < 8) throw new HttpError(400, "the password needs at least 8 characters");
  q("UPDATE users SET pass_hash = ? WHERE id = ?").run(sec.hashPassword(b.password), s.user.id);
  send(res, 200, { ok: true });
});

r.delete("/api/auth/account", async (req, res) => {
  const s = need(req);
  q("DELETE FROM users WHERE id = ?").run(s.user.id); // devices, sessions, backups and apps cascade
  send(res, 200, { ok: true }, { "Set-Cookie": "sid=; Path=/; Max-Age=0" });
});

// ---- developer requests --------------------------------------------------------------
r.post("/api/dev-requests", async (req, res) => {
  throttle(req);
  const b = await readJson(req);
  if (!clean(b.name) || !validEmail(b.email)) throw new HttpError(400, "name and a valid email are required");
  q("INSERT INTO dev_requests (name, email, company, website, message, created) VALUES (?, ?, ?, ?, ?, ?)")
    .run(clean(b.name, 80), b.email, clean(b.company, 80), clean(b.website, 200), clean(b.message, 2000), now());
  send(res, 200, { ok: true });
});

r.get("/api/admin/dev-requests", async (req, res) => {
  need(req, "admin");
  send(res, 200, q("SELECT * FROM dev_requests ORDER BY state = 'pending' DESC, created DESC").all());
});

r.post("/api/admin/dev-requests/:id/:action", async (req, res, p) => {
  need(req, "admin");
  const d = q("SELECT * FROM dev_requests WHERE id = ?").get(Number(p.id));
  if (!d) throw new HttpError(404, "not found");
  if (p.action === "reject") {
    q("UPDATE dev_requests SET state = 'rejected' WHERE id = ?").run(d.id);
    return send(res, 200, { ok: true });
  }
  if (p.action !== "approve") throw new HttpError(400, "unknown action");
  let password = null;
  const u = q("SELECT * FROM users WHERE email = ?").get(d.email);
  if (u) {
    if (u.role === "user") q("UPDATE users SET role = 'developer' WHERE id = ?").run(u.id);
  } else {
    password = sec.randomPassword();
    q("INSERT INTO users (email, name, pass_hash, role, data_key, created) VALUES (?, ?, ?, 'developer', ?, ?)")
      .run(d.email, d.name, sec.hashPassword(password), sec.newDataKey(MASTER), now());
  }
  q("UPDATE dev_requests SET state = 'approved' WHERE id = ?").run(d.id);
  // No mail server: the admin gives the temporary password to the developer.
  send(res, 200, { ok: true, email: d.email, password });
});

r.get("/api/admin/users", async (req, res) => {
  need(req, "admin");
  send(res, 200, q("SELECT id, email, name, role, created FROM users ORDER BY created DESC").all());
});

r.post("/api/admin/apps/:pkg/feature", async (req, res, p) => {
  need(req, "admin");
  const b = await readJson(req);
  q("UPDATE apps SET featured = ? WHERE package = ?").run(b.featured ? 1 : 0, p.pkg);
  send(res, 200, { ok: true });
});

// ---- store (public) ---------------------------------------------------------------------
function latest(pkg) {
  return q("SELECT * FROM versions WHERE package = ? ORDER BY version_code DESC LIMIT 1").get(pkg);
}
function catalogEntry(a) {
  const v = latest(a.package);
  if (!v) return null;
  return {
    package: a.package, name: a.name, summary: a.summary, description: a.summary || a.description, category: a.category,
    featured: !!a.featured, version: v.version, versionCode: v.version_code, size: v.size, sha256: v.sha256,
    url: `${PUBLIC_URL}/files/apps/${a.package}/${v.version_code}.apkg`,
    icon: a.has_icon ? `${PUBLIC_URL}/files/icons/${a.package}` : "",
    page: `${PUBLIC_URL}/store/${a.package}`,
  };
}

// The catalog Market reads (a JSON list, newest updates first).
r.get("/api/store/index.json", async (req, res) => {
  const apps = q("SELECT * FROM apps WHERE published = 1 ORDER BY featured DESC, updated DESC").all();
  send(res, 200, apps.map(catalogEntry).filter(Boolean), { "Cache-Control": "public, max-age=60" });
});

r.get("/api/store/apps/:pkg", async (req, res, p) => {
  const a = q("SELECT * FROM apps WHERE package = ? AND published = 1").get(p.pkg);
  if (!a) throw new HttpError(404, "no such app");
  const owner = q("SELECT name FROM users WHERE id = ?").get(a.owner_id);
  send(res, 200, {
    ...catalogEntry(a), description: a.description, website: a.website, developer: owner?.name || "", downloads: a.downloads,
    screenshots: Array.from({ length: a.screenshots }, (_, i) => `${PUBLIC_URL}/files/screens/${a.package}/${i}`),
    versions: q("SELECT version, version_code AS versionCode, size, notes, created FROM versions WHERE package = ? ORDER BY version_code DESC").all(a.package),
  });
});

r.get("/files/apps/:pkg/:file", async (req, res, p) => {
  const code = Number(String(p.file).replace(/\.apkg$/, ""));
  const v = q("SELECT * FROM versions WHERE package = ? AND version_code = ?").get(p.pkg, code);
  if (!v) throw new HttpError(404, "not found");
  q("UPDATE apps SET downloads = downloads + 1 WHERE package = ?").run(p.pkg);
  sendFile(res, path.join(FILES.apps, p.pkg, `${code}.apkg`), "application/x-astra-apkg",
           { "Content-Disposition": `attachment; filename="${p.pkg}-${v.version}.apkg"` });
});
r.get("/files/icons/:pkg", async (req, res, p) => sendFile(res, path.join(FILES.icons, p.pkg), iconType(path.join(FILES.icons, p.pkg))));
r.get("/files/screens/:pkg/:n", async (req, res, p) => sendFile(res, path.join(FILES.screens, p.pkg, String(Number(p.n))), "image/png"));

function iconType(file) {
  if (!fs.existsSync(file)) return "application/octet-stream";
  const head = fs.readFileSync(file).subarray(0, 8);
  if (head.subarray(0, 4).toString("hex") === "89504e47") return "image/png";
  if (head[0] === 0xff && head[1] === 0xd8) return "image/jpeg";
  return "image/svg+xml";
}

// ---- Market: Today page ------------------------------------------------------------------
function storyView(s) {
  const apps = JSON.parse(s.packages || "[]")
    .map((pkg) => q("SELECT * FROM apps WHERE package = ? AND published = 1").get(pkg))
    .filter(Boolean).map(catalogEntry).filter(Boolean);
  return {
    id: s.id, kind: s.kind, eyebrow: s.eyebrow, title: s.title, subtitle: s.subtitle, body: s.body, color: s.color,
    image: s.has_image ? `${PUBLIC_URL}/files/stories/${s.id}?${s.created}` : "", day: s.day, apps,
  };
}
const today = () => new Date().toISOString().slice(0, 10);

// The Today page Market shows first: cards of the day, App and Game of the
// Day (picked from the catalog when no admin chose one), charts, new apps.
r.get("/api/store/today", async (req, res) => {
  const day = today();
  const published = q("SELECT * FROM apps WHERE published = 1").all().filter((a) => latest(a.package));
  const stories = q("SELECT * FROM stories WHERE published = 1 AND (day = '' OR day = ?) ORDER BY position, created DESC")
    .all(day).map(storyView);
  // A different app every day, the same one for everybody.
  const seed = [...day].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  const pick = (list) => (list.length ? catalogEntry(list[seed % list.length]) : null);
  const games = published.filter((a) => a.category === "Games");
  const others = published.filter((a) => a.category !== "Games");
  const ofDay = (kind, list, eyebrow) => {
    const chosen = stories.find((s) => s.kind === kind);
    if (chosen) return chosen;
    const app = pick(list);
    return app ? { id: 0, kind, eyebrow, title: app.name, subtitle: app.summary, body: "", color: "#FF7A00", image: "", apps: [app] } : null;
  };
  send(res, 200, {
    date: day,
    appOfTheDay: ofDay("app_of_day", others.filter((a) => a.featured).length ? others.filter((a) => a.featured) : others, "APP OF THE DAY"),
    gameOfTheDay: ofDay("game_of_day", games, "GAME OF THE DAY"),
    stories: stories.filter((s) => s.kind !== "app_of_day" && s.kind !== "game_of_day"),
    top: published.slice().sort((a, b) => b.downloads - a.downloads).slice(0, 10).map(catalogEntry),
    fresh: published.slice().sort((a, b) => b.created - a.created).slice(0, 10).map(catalogEntry),
    categories: [...new Set(published.map((a) => a.category))].sort(),
  }, { "Cache-Control": "public, max-age=120" });
});
r.get("/files/stories/:id", async (req, res, p) => sendFile(res, path.join(FILES.stories, String(Number(p.id))), iconType(path.join(FILES.stories, String(Number(p.id))))));

// Admins write the stories.
function storyFields(b, base = {}) {
  const kinds = ["feature", "app_of_day", "game_of_day", "list", "tip"];
  return {
    kind: kinds.includes(b.kind) ? b.kind : base.kind || "feature",
    eyebrow: clean(b.eyebrow ?? base.eyebrow, 60), title: clean(b.title ?? base.title, 120) || "Untitled",
    subtitle: clean(b.subtitle ?? base.subtitle, 200), body: clean(b.body ?? base.body, 8000),
    packages: JSON.stringify((Array.isArray(b.packages) ? b.packages : JSON.parse(base.packages || "[]")).map((x) => clean(x, 120)).slice(0, 12)),
    color: /^#[0-9a-fA-F]{6}$/.test(b.color || "") ? b.color : base.color || "#7B2FF7",
    day: /^\d{4}-\d{2}-\d{2}$/.test(b.day || "") ? b.day : b.day === "" ? "" : base.day || "",
    position: Number.isFinite(Number(b.position)) ? Number(b.position) : base.position || 0,
    published: b.published === undefined ? (base.published ?? 1) : b.published ? 1 : 0,
  };
}
r.get("/api/admin/stories", async (req, res) => {
  need(req, "admin");
  send(res, 200, q("SELECT * FROM stories ORDER BY day DESC, position, created DESC").all().map((s) => ({ ...storyView(s), published: !!s.published, packages: JSON.parse(s.packages), position: s.position })));
});
r.post("/api/admin/stories", async (req, res) => {
  need(req, "admin");
  const f = storyFields(await readJson(req));
  const info = q("INSERT INTO stories (kind, eyebrow, title, subtitle, body, packages, color, day, position, published, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(f.kind, f.eyebrow, f.title, f.subtitle, f.body, f.packages, f.color, f.day, f.position, f.published, now());
  send(res, 200, { ok: true, id: Number(info.lastInsertRowid) });
});
r.patch("/api/admin/stories/:id", async (req, res, p) => {
  need(req, "admin");
  const s = q("SELECT * FROM stories WHERE id = ?").get(Number(p.id));
  if (!s) throw new HttpError(404, "no such story");
  const f = storyFields(await readJson(req), s);
  q("UPDATE stories SET kind = ?, eyebrow = ?, title = ?, subtitle = ?, body = ?, packages = ?, color = ?, day = ?, position = ?, published = ? WHERE id = ?")
    .run(f.kind, f.eyebrow, f.title, f.subtitle, f.body, f.packages, f.color, f.day, f.position, f.published, s.id);
  send(res, 200, { ok: true });
});
r.delete("/api/admin/stories/:id", async (req, res, p) => {
  need(req, "admin");
  q("DELETE FROM stories WHERE id = ?").run(Number(p.id));
  fs.rmSync(path.join(FILES.stories, String(Number(p.id))), { force: true });
  send(res, 200, { ok: true });
});
r.put("/api/admin/stories/:id/image", async (req, res, p) => {
  need(req, "admin");
  const id = Number(p.id);
  if (!q("SELECT 1 FROM stories WHERE id = ?").get(id)) throw new HttpError(404, "no such story");
  fs.writeFileSync(path.join(FILES.stories, String(id)), await readBody(req, 8 * 1024 * 1024));
  q("UPDATE stories SET has_image = 1, created = ? WHERE id = ?").run(now(), id);
  send(res, 200, { ok: true });
});

// ---- developer panel -----------------------------------------------------------------------
function ownApp(s, pkg) {
  const a = q("SELECT * FROM apps WHERE package = ?").get(pkg);
  if (!a || (a.owner_id !== s.user.id && s.user.role !== "admin")) throw new HttpError(404, "no such app");
  return a;
}

r.get("/api/dev/apps", async (req, res) => {
  const s = need(req, "developer");
  const apps = s.user.role === "admin" ? q("SELECT * FROM apps ORDER BY updated DESC").all()
                                       : q("SELECT * FROM apps WHERE owner_id = ? ORDER BY updated DESC").all(s.user.id);
  send(res, 200, apps.map((a) => ({ ...a, latest: latest(a.package) || null,
                                    versions: q("SELECT version, version_code, size, notes, created FROM versions WHERE package = ? ORDER BY version_code DESC").all(a.package) })));
});

r.post("/api/dev/apps", async (req, res) => {
  const s = need(req, "developer");
  const b = await readJson(req);
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(b.package || "")) throw new HttpError(400, "package names look like com.example.app");
  if (b.package.startsWith("com.astra.") && s.user.role !== "admin") throw new HttpError(403, "com.astra.* is reserved for astraOS");
  if (q("SELECT 1 FROM apps WHERE package = ?").get(b.package)) throw new HttpError(409, "this package name is taken");
  q(`INSERT INTO apps (package, owner_id, name, summary, description, category, website, created, updated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(b.package, s.user.id, clean(b.name, 60) || b.package, clean(b.summary, 140), clean(b.description, 8000),
         clean(b.category, 40) || "Apps", clean(b.website, 200), now(), now());
  send(res, 200, { ok: true });
});

r.patch("/api/dev/apps/:pkg", async (req, res, p) => {
  const s = need(req, "developer");
  const a = ownApp(s, p.pkg);
  const b = await readJson(req);
  q(`UPDATE apps SET name = ?, summary = ?, description = ?, category = ?, website = ?, published = ?, updated = ? WHERE package = ?`)
    .run(clean(b.name ?? a.name, 60), clean(b.summary ?? a.summary, 140), clean(b.description ?? a.description, 8000),
         clean(b.category ?? a.category, 40), clean(b.website ?? a.website, 200),
         b.published === undefined ? a.published : (b.published ? 1 : 0), now(), a.package);
  send(res, 200, { ok: true });
});

r.delete("/api/dev/apps/:pkg", async (req, res, p) => {
  const s = need(req, "developer");
  const a = ownApp(s, p.pkg);
  q("DELETE FROM apps WHERE package = ?").run(a.package);
  for (const dir of [path.join(FILES.apps, a.package), path.join(FILES.screens, a.package)]) fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(path.join(FILES.icons, a.package), { force: true });
  send(res, 200, { ok: true });
});

// Stores a new version of an app from its .apkg once it passes the design
// check (vendor/astra-sdk: `astra check`); returns the manifest and the
// check's warnings. system: only for the seeded default apps.
async function publishVersion(a, body, notes, { system = false } = {}) {
  let pkg;
  try {
    pkg = readApkg(body);
  } catch (e) {
    throw new HttpError(400, e instanceof ApkgError ? e.message : "the package could not be read");
  }
  const m = pkg.manifest;
  if (m.package !== a.package) throw new HttpError(400, `the package is ${m.package}, not ${a.package}`);
  const code = Number(m.versionCode || 0);
  const prev = latest(a.package);
  if (!Number.isInteger(code) || code < 1) throw new HttpError(400, "versionCode must be a positive integer");
  if (prev && code <= prev.version_code) throw new HttpError(409, `versionCode must be greater than ${prev.version_code}`);
  let findings;
  try {
    findings = await checkDesign(pkg, { ...DESIGN_CHECK, system });
  } catch (e) {
    if (e instanceof ApkgError) throw new HttpError(400, e.message);
    console.error(`design check of ${a.package} ${code}: ${e.message}`);
    throw new HttpError(503, e instanceof DesignCheckError ? "the design check could not run: try again later" : "the design check failed");
  }
  const errors = findings.filter((f) => f.severity === "error");
  if (errors.length)
    throw new HttpError(422, `the design check found ${errors.length} error(s): fix them (astra check) and upload again`, { findings });
  const warnings = findings.filter((f) => f.severity !== "error");
  // The check takes a moment: the app may have been removed, or this versionCode published, meanwhile.
  if (!q("SELECT 1 FROM apps WHERE package = ?").get(a.package)) throw new HttpError(404, "no such app");
  const newest = latest(a.package);
  if (newest && code <= newest.version_code) throw new HttpError(409, `versionCode must be greater than ${newest.version_code}`);
  fs.mkdirSync(path.join(FILES.apps, a.package), { recursive: true });
  fs.writeFileSync(path.join(FILES.apps, a.package, `${code}.apkg`), body);
  q("INSERT INTO versions (package, version_code, version, size, sha256, notes, manifest, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(a.package, code, clean(m.version, 30) || String(code), body.length, pkg.sha256, notes, JSON.stringify(m), now());
  // First upload: take the icon from the package.
  if (!a.has_icon && m.icon) {
    const icon = pkg.file(m.icon);
    if (icon) {
      fs.writeFileSync(path.join(FILES.icons, a.package), icon);
      q("UPDATE apps SET has_icon = 1 WHERE package = ?").run(a.package);
    }
  }
  q("UPDATE apps SET updated = ? WHERE package = ?").run(now(), a.package);
  return { version: m.version, versionCode: code, sha256: pkg.sha256, permissions: m.permissions || [], warnings };
}

// Upload a new version: the raw .apkg as the request body.
r.put("/api/dev/apps/:pkg/versions", async (req, res, p) => {
  const s = need(req, "developer");
  const a = ownApp(s, p.pkg);
  const body = await readBody(req, MAX_APKG);
  const notes = clean(new URL(req.url, "http://x").searchParams.get("notes") || "", 4000);
  send(res, 200, { ok: true, ...(await publishVersion(a, body, notes)) });
});

r.delete("/api/dev/apps/:pkg/versions/:code", async (req, res, p) => {
  const s = need(req, "developer");
  const a = ownApp(s, p.pkg);
  q("DELETE FROM versions WHERE package = ? AND version_code = ?").run(a.package, Number(p.code));
  fs.rmSync(path.join(FILES.apps, a.package, `${Number(p.code)}.apkg`), { force: true });
  send(res, 200, { ok: true });
});

r.put("/api/dev/apps/:pkg/icon", async (req, res, p) => {
  const s = need(req, "developer");
  const a = ownApp(s, p.pkg);
  fs.writeFileSync(path.join(FILES.icons, a.package), await readBody(req, 2 * 1024 * 1024));
  q("UPDATE apps SET has_icon = 1, updated = ? WHERE package = ?").run(now(), a.package);
  send(res, 200, { ok: true });
});

r.put("/api/dev/apps/:pkg/screenshots", async (req, res, p) => {
  const s = need(req, "developer");
  const a = ownApp(s, p.pkg);
  if (a.screenshots >= 8) throw new HttpError(400, "up to 8 screenshots");
  fs.mkdirSync(path.join(FILES.screens, a.package), { recursive: true });
  fs.writeFileSync(path.join(FILES.screens, a.package, String(a.screenshots)), await readBody(req, 8 * 1024 * 1024));
  q("UPDATE apps SET screenshots = screenshots + 1, updated = ? WHERE package = ?").run(now(), a.package);
  send(res, 200, { ok: true });
});

r.delete("/api/dev/apps/:pkg/screenshots", async (req, res, p) => {
  const s = need(req, "developer");
  const a = ownApp(s, p.pkg);
  fs.rmSync(path.join(FILES.screens, a.package), { recursive: true, force: true });
  q("UPDATE apps SET screenshots = 0 WHERE package = ?").run(a.package);
  send(res, 200, { ok: true });
});

// ---- AstraID: devices and Find My Device ----------------------------------------------------
function deviceView(d) {
  return { id: d.id, name: d.name, model: d.model, os: d.os, findMy: !!d.find_my, lastSeen: d.last_seen,
           report: d.report ? JSON.parse(d.report) : null, created: d.created };
}

r.get("/api/id/devices", async (req, res) => {
  const s = need(req);
  send(res, 200, q("SELECT * FROM devices WHERE user_id = ? ORDER BY last_seen DESC").all(s.user.id).map(deviceView));
});

r.delete("/api/id/devices/:id", async (req, res, p) => {
  const s = need(req);
  q("DELETE FROM devices WHERE id = ? AND user_id = ?").run(Number(p.id), s.user.id);
  send(res, 200, { ok: true });
});

const COMMANDS = ["ring", "notify", "lock", "locate"];
const waiting = new Map(); // device id -> [resolve]

r.post("/api/id/devices/:id/commands", async (req, res, p) => {
  const s = need(req);
  const d = q("SELECT * FROM devices WHERE id = ? AND user_id = ?").get(Number(p.id), s.user.id);
  if (!d) throw new HttpError(404, "no such device");
  if (!d.find_my) throw new HttpError(409, "Find My Device is off on this phone");
  const b = await readJson(req);
  if (!COMMANDS.includes(b.type)) throw new HttpError(400, "unknown command");
  const payload = { title: clean(b.title, 80), body: clean(b.body, 500) };
  const info = q("INSERT INTO commands (device_id, type, payload, created) VALUES (?, ?, ?, ?)")
    .run(d.id, b.type, JSON.stringify(payload), now());
  for (const wake of waiting.get(d.id) || []) wake();
  waiting.delete(d.id);
  send(res, 200, { ok: true, id: Number(info.lastInsertRowid) });
});

r.get("/api/id/devices/:id/commands", async (req, res, p) => {
  const s = need(req);
  if (!q("SELECT 1 FROM devices WHERE id = ? AND user_id = ?").get(Number(p.id), s.user.id)) throw new HttpError(404, "no such device");
  send(res, 200, q("SELECT id, type, payload, state, result, created FROM commands WHERE device_id = ? ORDER BY created DESC LIMIT 20").all(Number(p.id)));
});

// The phone: report its state, fetch commands (long poll), acknowledge them.
r.post("/api/device/report", async (req, res) => {
  const s = needDevice(req);
  const b = await readJson(req);
  const report = {
    battery: Number.isFinite(b.battery) ? b.battery : null, charging: !!b.charging,
    network: clean(b.network, 80), os: clean(b.os, 60),
    location: b.location && Number.isFinite(b.location.lat) && Number.isFinite(b.location.lon)
      ? { lat: b.location.lat, lon: b.location.lon, accuracy: Number(b.location.accuracy) || null, source: clean(b.location.source, 20), time: now() }
      : null,
  };
  const prev = q("SELECT report FROM devices WHERE id = ?").get(s.deviceId);
  if (!report.location && prev?.report) report.location = JSON.parse(prev.report).location || null; // keep the last known place
  q("UPDATE devices SET report = ?, last_seen = ?, os = ?, find_my = ? WHERE id = ?")
    .run(JSON.stringify(report), now(), report.os, b.findMy === false ? 0 : 1, s.deviceId);
  send(res, 200, { ok: true });
});

r.get("/api/device/commands", async (req, res) => {
  const s = needDevice(req);
  const wait = Math.min(55, Number(new URL(req.url, "http://x").searchParams.get("wait") || 0));
  const take = () => {
    const list = q("SELECT id, type, payload FROM commands WHERE device_id = ? AND state = 'pending' ORDER BY id").all(s.deviceId);
    for (const c of list) q("UPDATE commands SET state = 'delivered' WHERE id = ?").run(c.id);
    return list.map((c) => ({ id: c.id, type: c.type, ...JSON.parse(c.payload) }));
  };
  q("UPDATE devices SET last_seen = ? WHERE id = ?").run(now(), s.deviceId);
  let list = take();
  if (!list.length && wait > 0) {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, wait * 1000);
      const wake = () => { clearTimeout(timer); resolve(); };
      waiting.set(s.deviceId, [...(waiting.get(s.deviceId) || []), wake]);
      req.on("close", wake);
    });
    list = take();
  }
  send(res, 200, list);
});

r.post("/api/device/commands/:id/ack", async (req, res, p) => {
  const s = needDevice(req);
  const b = await readJson(req);
  q("UPDATE commands SET state = 'done', result = ? WHERE id = ? AND device_id = ?").run(clean(b.result, 200), Number(p.id), s.deviceId);
  send(res, 200, { ok: true });
});

// ---- AstraID: contacts backup (encrypted with the user's data key) ---------------------------
function userKey(s) {
  return sec.dataKey(MASTER, s.user.data_key);
}

r.put("/api/device/contacts", async (req, res) => {
  const s = needDevice(req);
  const body = await readJson(req, 8 * 1024 * 1024);
  if (!Array.isArray(body.contacts)) throw new HttpError(400, "contacts must be a list");
  const allowed = ["name", "phone", "email", "company", "note", "favorite"];
  const contacts = body.contacts.slice(0, 20000).map((c) => Object.fromEntries(allowed.filter((k) => k in c).map((k) => [k, k === "favorite" ? !!c[k] : clean(c[k], 300)])));
  q("INSERT INTO contacts_backup (user_id, blob, count, updated) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET blob = excluded.blob, count = excluded.count, updated = excluded.updated")
    .run(s.user.id, sec.seal(userKey(s), JSON.stringify(contacts)), contacts.length, now());
  send(res, 200, { ok: true, count: contacts.length });
});

function readContacts(s) {
  const row = q("SELECT * FROM contacts_backup WHERE user_id = ?").get(s.user.id);
  return row ? { contacts: JSON.parse(sec.open(userKey(s), row.blob).toString("utf8")), updated: row.updated } : { contacts: [], updated: null };
}
r.get("/api/device/contacts", async (req, res) => send(res, 200, readContacts(needDevice(req))));
r.get("/api/id/contacts", async (req, res) => send(res, 200, readContacts(need(req))));
r.delete("/api/id/contacts", async (req, res) => {
  const s = need(req);
  q("DELETE FROM contacts_backup WHERE user_id = ?").run(s.user.id);
  send(res, 200, { ok: true });
});

// ---- WhatsAstra: WhatsApp through OpenWA (lib/whatsapp.js) ----------------------------------
registerWhatsApp(r, { db, needDevice, env });

// ---- server -----------------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  try {
    const m = r.match(req.method, url.pathname);
    if (m) return await m.handler(req, res, m.params);
    if (req.method === "GET") {
      // /store/<package> is the public app page (one HTML file reading the API)
      if (url.pathname.startsWith("/store/") && serveStatic(path.join(ROOT, "public"), "/store.html", res)) return;
      if (serveStatic(path.join(ROOT, "public"), url.pathname, res)) return;
    }
    throw new HttpError(404, "not found");
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error(e);
    if (!res.headersSent) send(res, status, status === 500 ? { error: "internal error" } : { error: e.message, ...e.extra });
  }
});
// ---- default apps ----------------------------------------------------------------------------
// Every seed/<package>.apkg (with an optional seed/<package>.json page:
// name, summary, description, category, website, featured, story) is
// published by the first admin, and updated when a newer versionCode
// shows up. WhatsAstra ships this way.
async function seedApps() {
  const dir = path.join(ROOT, "seed");
  if (!fs.existsSync(dir)) return;
  const admin = q("SELECT * FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();
  if (!admin) {
    console.log("seed: no admin yet (set ADMIN_EMAIL and ADMIN_PASSWORD), default apps not published");
    return;
  }
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".apkg"))) {
    try {
      const body = fs.readFileSync(path.join(dir, file));
      const m = readApkg(body).manifest;
      const metaFile = path.join(dir, file.replace(/\.apkg$/, ".json"));
      const meta = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, "utf8")) : {};
      let a = q("SELECT * FROM apps WHERE package = ?").get(m.package);
      if (!a) {
        q(`INSERT INTO apps (package, owner_id, name, summary, description, category, website, published, featured, created, updated)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`)
          .run(m.package, admin.id, clean(meta.name || m.name, 60), clean(meta.summary, 140), clean(meta.description || m.description, 8000),
               clean(meta.category, 40) || "Apps", clean(meta.website, 200), meta.featured ? 1 : 0, now(), now());
        a = q("SELECT * FROM apps WHERE package = ?").get(m.package);
        if (meta.story)
          q("INSERT INTO stories (kind, eyebrow, title, subtitle, body, packages, color, created) VALUES ('feature', ?, ?, ?, ?, ?, ?, ?)")
            .run(clean(meta.story.eyebrow, 60), clean(meta.story.title, 120), clean(meta.story.subtitle, 200), clean(meta.story.body, 8000),
                 JSON.stringify([m.package]), meta.story.color || "#25D366", now());
      }
      const prev = latest(m.package);
      if (!prev || Number(m.versionCode) > prev.version_code) {
        const { warnings } = await publishVersion(a, body, clean(meta.notes || "", 4000), { system: true });
        console.log(`seed: published ${m.package} ${m.version}${warnings.length ? ` (${warnings.length} design warning(s))` : ""}`);
      }
    } catch (e) {
      const findings = (e.extra?.findings || []).map((f) => `
  ${f.file}:${f.line}: ${f.severity} ${f.code}: ${f.message}`);
      console.error(`seed: ${file}: ${e.message}${findings.join("")}`);
    }
  }
}
await seedApps();

server.requestTimeout = 0; // long polls and large uploads
server.listen(PORT, () => console.log(`astra cloud on :${PORT} (${PUBLIC_URL})`));
