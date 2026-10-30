// WhatsAstra's server side: WhatsApp through OpenWA
// (https://github.com/rmyndharis/OpenWA, MIT), which runs next to this
// server, unexposed, and speaks WhatsApp's protocol (whatsapp-web.js engine).
//
// Each AstraID account gets its own OpenWA session; the phone only ever
// talks to these routes, authenticated with its AstraID device token, so
// OpenWA's key never leaves the server. WhatsApp's protocol is not official:
// an account linked this way can be restricted by WhatsApp.
//
//   GET  /api/app/com.astra.whatsastra/state      link state: status, qr (PNG data URL), phone, name
//   POST /api/app/com.astra.whatsastra/logout     unlink and forget the session
//   GET  /api/app/com.astra.whatsastra/chats      chats, most recent first
//   GET  /api/app/com.astra.whatsastra/messages?chatId=&limit=   the last messages of a chat, oldest first
//   GET  /api/app/com.astra.whatsastra/updates?since=            messages received since (epoch ms)
//   POST /api/app/com.astra.whatsastra/send       { chatId, text }
//   POST /api/app/com.astra.whatsastra/read       { chatId }
//   GET  /api/app/com.astra.whatsastra/media?chatId=&messageId=  a message's photo, video or file
import fs from "node:fs";
import { HttpError, readJson, send } from "./http.js";

const BASE = "/api/app/com.astra.whatsastra";

export function registerWhatsApp(r, { db, needDevice, env }) {
  const OPENWA = (env.OPENWA_URL || "http://openwa:2785").replace(/\/$/, "");
  const keyFile = env.OPENWA_KEY_FILE || "/openwa/.api-key";
  const q = (sql) => db.prepare(sql);
  db.exec(`CREATE TABLE IF NOT EXISTS wa_sessions (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL,
    created INTEGER NOT NULL
  )`);

  // OpenWA writes its admin key on the first boot (data/.api-key).
  function apiKey() {
    if (env.OPENWA_API_KEY) return env.OPENWA_API_KEY;
    try {
      return fs.readFileSync(keyFile, "utf8").trim();
    } catch {
      throw new HttpError(503, "WhatsApp is not set up on this server");
    }
  }

  async function openwa(method, path, body, { raw = false } = {}) {
    let res;
    try {
      res = await fetch(OPENWA + "/api" + path, {
        method,
        headers: { "X-API-Key": apiKey(), ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30000),
      });
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(503, "WhatsApp is not reachable right now");
    }
    if (raw) return res;
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) {
      const message = data && data.message ? [].concat(data.message).join(", ") : `WhatsApp error ${res.status}`;
      const err = new HttpError(res.status === 409 ? 409 : res.status >= 500 ? 502 : res.status, message);
      err.upstream = res.status;
      throw err;
    }
    return data;
  }

  // The user's session, created on first use.
  async function sessionOf(userId) {
    const row = q("SELECT session_id FROM wa_sessions WHERE user_id = ?").get(userId);
    if (row) return row.session_id;
    const s = await openwa("POST", "/sessions", { name: `astra-${userId}` });
    q("INSERT INTO wa_sessions (user_id, session_id, created) VALUES (?, ?, ?)").run(userId, s.id, Date.now());
    return s.id;
  }

  async function started(userId) {
    const id = await sessionOf(userId);
    let s;
    try {
      s = await openwa("GET", `/sessions/${id}`);
    } catch (e) {
      if (e.upstream !== 404) throw e;
      // OpenWA lost it (its data was reset): start over.
      q("DELETE FROM wa_sessions WHERE user_id = ?").run(userId);
      return started(userId);
    }
    if (!s.engineLoaded && !["initializing", "authenticating"].includes(s.status)) {
      try { await openwa("POST", `/sessions/${id}/start`); } catch (e) { if (e.upstream !== 400) throw e; }
      s = await openwa("GET", `/sessions/${id}`);
    }
    return { id, session: s };
  }

  const chatId = (v) => {
    const id = String(v || "");
    if (!/^[^\s@/]+@[^\s@/]+$/.test(id) || id.length > 255) throw new HttpError(400, "invalid chat");
    return id;
  };

  r.get(`${BASE}/state`, async (req, res) => {
    const s = needDevice(req);
    const { id, session } = await started(s.user.id);
    const out = { status: session.status, phone: session.phone || null, name: session.pushName || null, error: session.lastError || null };
    if (session.status === "qr_ready" || session.status === "initializing") {
      try {
        out.qr = (await openwa("GET", `/sessions/${id}/qr`)).qrCode;
        out.status = "qr_ready";
      } catch { /* not ready yet: the app asks again */ }
    }
    send(res, 200, out);
  });

  r.post(`${BASE}/logout`, async (req, res) => {
    const s = needDevice(req);
    const row = q("SELECT session_id FROM wa_sessions WHERE user_id = ?").get(s.user.id);
    if (row) {
      try { await openwa("POST", `/sessions/${row.session_id}/logout`); } catch { /* already gone */ }
      try { await openwa("DELETE", `/sessions/${row.session_id}`); } catch { /* already gone */ }
      q("DELETE FROM wa_sessions WHERE user_id = ?").run(s.user.id);
    }
    send(res, 200, { ok: true });
  });

  r.get(`${BASE}/chats`, async (req, res) => {
    const s = needDevice(req);
    const id = await sessionOf(s.user.id);
    const chats = await openwa("GET", `/sessions/${id}/chats?limit=200`);
    send(res, 200, (chats || []).filter((c) => c.kind === "individual" || c.kind === "group"));
  });

  r.get(`${BASE}/messages`, async (req, res) => {
    const s = needDevice(req);
    const url = new URL(req.url, "http://x");
    const id = await sessionOf(s.user.id);
    const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit")) || 60));
    const list = await openwa("GET", `/sessions/${id}/messages/${encodeURIComponent(chatId(url.searchParams.get("chatId")))}/history?limit=${limit}`);
    send(res, 200, (list || []).map(slim));
  });

  // New messages since a moment, from OpenWA's store (incoming and outgoing).
  r.get(`${BASE}/updates`, async (req, res) => {
    const s = needDevice(req);
    const url = new URL(req.url, "http://x");
    const id = await sessionOf(s.user.id);
    const since = Math.max(0, Number(url.searchParams.get("since")) || Date.now() - 60000);
    const page = await openwa("GET", `/sessions/${id}/messages?since=${since}&orderBy=timestamp&inlineMedia=false&limit=100`);
    const list = (page && page.messages) || [];
    send(res, 200, list.map((m) => ({
      id: m.waMessageId || m.id, chatId: m.chatId, body: m.body || "", type: m.type,
      fromMe: m.direction === "outgoing", timestamp: m.timestamp, author: m.author, name: m.chatName,
    })).reverse());
  });

  r.post(`${BASE}/send`, async (req, res) => {
    const s = needDevice(req);
    const b = await readJson(req);
    const text = String(b.text || "").trim();
    if (!text || text.length > 4096) throw new HttpError(400, "write a message of up to 4096 characters");
    const id = await sessionOf(s.user.id);
    const sent = await openwa("POST", `/sessions/${id}/messages/send-text`, { chatId: chatId(b.chatId), text });
    send(res, 200, { id: sent && (sent.messageId || sent.id), timestamp: Math.floor(Date.now() / 1000) });
  });

  r.post(`${BASE}/read`, async (req, res) => {
    const s = needDevice(req);
    const b = await readJson(req);
    const id = await sessionOf(s.user.id);
    try { await openwa("POST", `/sessions/${id}/chats/read`, { chatId: chatId(b.chatId) }); } catch { /* best effort */ }
    send(res, 200, { ok: true });
  });

  r.get(`${BASE}/media`, async (req, res) => {
    const s = needDevice(req);
    const url = new URL(req.url, "http://x");
    const id = await sessionOf(s.user.id);
    const msg = String(url.searchParams.get("messageId") || "");
    if (!msg || msg.length > 255) throw new HttpError(400, "invalid message");
    const up = await openwa("GET", `/sessions/${id}/messages/${encodeURIComponent(chatId(url.searchParams.get("chatId")))}/${encodeURIComponent(msg)}/media`, null, { raw: true });
    if (!up.ok) throw new HttpError(up.status === 404 ? 404 : 502, "this media is not available");
    const buf = Buffer.from(await up.arrayBuffer());
    res.writeHead(200, { "Content-Type": up.headers.get("content-type") || "application/octet-stream", "Content-Length": buf.length,
                         "Cache-Control": "private, max-age=86400" });
    res.end(buf);
  });

  function slim(m) {
    return { id: m.id, chatId: m.chatId, body: m.body || "", type: m.type, fromMe: !!m.fromMe,
             timestamp: m.timestamp, author: m.author || null, hasMedia: !!(m.media || ["image", "video", "document", "audio", "voice", "sticker"].includes(m.type)) };
  }
}
