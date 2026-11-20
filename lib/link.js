// SPDX-License-Identifier: Apache-2.0
// astraOS phones and desktops of one AstraID: which is which, which two are linked, and what flows between
// two linked ones (Phone Linker), plus what PetalDrop needs from the account to trust a device nearby.
//
//   GET    /api/device/peers            the account's other devices: id, name, kind, lastSeen, linked
//   GET    /api/device/link             this device's link: { linked, peer } (and who it could link with)
//   POST   /api/device/link             { peer } link this device with one of the other kind (409 if either is taken)
//   DELETE /api/device/link             unlink
//   POST   /api/link/send               { kind: notification|dismiss|contacts|photo, payload } to the linked device
//   GET    /api/link/events?after=&wait= what the linked device sent (long poll); `after` acknowledges up to an id
//   POST   /api/device/lan              { addresses: [ip], port } where PetalDrop of this device listens
//   GET    /api/device/petal            { key, peers: [{ id, name, kind, addresses, port }] }: the account's PetalDrop key
//                                       (devices sign their beacons and offers with it: that is how a device knows
//                                       another one is the same person's) and where its devices are
//
// One phone is linked with one desktop and the other way round (the tables say it: both columns are UNIQUE).
// What is sent waits here, encrypted with the user's data key like the contacts backup, until the other side
// has fetched it, or a day. Notifications, contacts and photos do pass through this server: that is how they
// reach a phone that is not on the desktop's network.
import crypto from "node:crypto";
import { HttpError, readJson, send } from "./http.js";
import * as sec from "./security.js";

const KINDS = ["notification", "dismiss", "contacts", "photo"];
const MAX_EVENT = 16 * 1024 * 1024;
const TTL = 24 * 60 * 60 * 1000;

export function registerLink(r, { db, need, needDevice, now, clean, MASTER }) {
  const q = (sql) => db.prepare(sql);
  db.exec(`
    CREATE TABLE IF NOT EXISTS device_lan (
      device_id INTEGER PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
      addresses TEXT NOT NULL DEFAULT '[]',
      port INTEGER NOT NULL DEFAULT 0,
      updated INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS petal_keys (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      key TEXT NOT NULL                          -- AES-GCM with the master key
    );
  `);
  const waiting = new Map(); // device id -> [wake]

  const linkOf = (deviceId) => q("SELECT * FROM device_links WHERE phone_id = ? OR desktop_id = ?").get(deviceId, deviceId);
  const peerOf = (deviceId) => {
    const l = linkOf(deviceId);
    return l ? (l.phone_id === deviceId ? l.desktop_id : l.phone_id) : null;
  };
  const view = (d, linkedTo) => ({ id: d.id, name: d.name, model: d.model, kind: d.kind, lastSeen: d.last_seen, linked: linkedTo !== undefined ? linkedTo : !!linkOf(d.id) });

  r.get("/api/device/peers", async (req, res) => {
    const s = needDevice(req);
    const list = q("SELECT * FROM devices WHERE user_id = ? AND id != ? ORDER BY last_seen DESC").all(s.user.id, s.deviceId);
    send(res, 200, list.map((d) => view(d)));
  });

  r.get("/api/device/link", async (req, res) => {
    const s = needDevice(req);
    const me = q("SELECT * FROM devices WHERE id = ?").get(s.deviceId);
    const peerId = peerOf(s.deviceId);
    const peer = peerId ? q("SELECT * FROM devices WHERE id = ?").get(peerId) : null;
    // The devices of the other kind that are free: what this one could link with.
    const candidates = peer ? [] : q("SELECT * FROM devices WHERE user_id = ? AND kind != ? ORDER BY last_seen DESC").all(s.user.id, me.kind)
      .filter((d) => !linkOf(d.id)).map((d) => view(d, false));
    send(res, 200, { kind: me.kind, linked: !!peer, peer: peer ? view(peer, true) : null, candidates });
  });

  r.post("/api/device/link", async (req, res) => {
    const s = needDevice(req);
    const b = await readJson(req);
    const me = q("SELECT * FROM devices WHERE id = ?").get(s.deviceId);
    const other = q("SELECT * FROM devices WHERE id = ? AND user_id = ?").get(Number(b.peer), s.user.id);
    if (!other) throw new HttpError(404, "no such device on this AstraID");
    if (other.kind === me.kind) throw new HttpError(400, `a ${me.kind} links with a ${me.kind === "phone" ? "desktop" : "phone"}`);
    if (linkOf(me.id)) throw new HttpError(409, "this device is already linked: unlink it first");
    if (linkOf(other.id)) throw new HttpError(409, `that ${other.kind} is already linked to another device: unlink it first`);
    const phone = me.kind === "phone" ? me : other;
    const desktop = me.kind === "phone" ? other : me;
    q("INSERT INTO device_links (phone_id, desktop_id, user_id, created) VALUES (?, ?, ?, ?)").run(phone.id, desktop.id, s.user.id, now());
    wake(other.id);
    send(res, 200, { ok: true, peer: view(other, true) });
  });

  r.delete("/api/device/link", async (req, res) => {
    const s = needDevice(req);
    const peerId = peerOf(s.deviceId);
    q("DELETE FROM device_links WHERE phone_id = ? OR desktop_id = ?").run(s.deviceId, s.deviceId);
    if (peerId) {
      q("DELETE FROM link_events WHERE (to_device = ? AND from_device = ?) OR (to_device = ? AND from_device = ?)").run(s.deviceId, peerId, peerId, s.deviceId);
      wake(peerId);
    }
    send(res, 200, { ok: true });
  });

  function wake(deviceId) {
    for (const f of waiting.get(deviceId) || []) f();
    waiting.delete(deviceId);
  }

  r.post("/api/link/send", async (req, res) => {
    const s = needDevice(req);
    const peer = peerOf(s.deviceId);
    if (!peer) throw new HttpError(409, "this device is not linked");
    const b = await readJson(req, MAX_EVENT);
    if (!KINDS.includes(b.kind)) throw new HttpError(400, `kind is one of ${KINDS.join(", ")}`);
    const blob = JSON.stringify(b.payload ?? {});
    if (blob.length > MAX_EVENT) throw new HttpError(413, "too large");
    q("DELETE FROM link_events WHERE created < ?").run(now() - TTL);
    // A photo or the contacts replace the older copy still waiting; a stream of notifications is kept whole.
    if (b.kind === "contacts") q("DELETE FROM link_events WHERE to_device = ? AND kind = 'contacts'").run(peer);
    const key = sec.dataKey(MASTER, s.user.data_key);
    const info = q("INSERT INTO link_events (to_device, from_device, kind, blob, created) VALUES (?, ?, ?, ?, ?)")
      .run(peer, s.deviceId, b.kind, sec.seal(key, blob), now());
    wake(peer);
    send(res, 200, { ok: true, id: Number(info.lastInsertRowid) });
  });

  r.get("/api/link/events", async (req, res) => {
    const s = needDevice(req);
    const params = new URL(req.url, "http://x").searchParams;
    const after = Number(params.get("after") || 0);
    const wait = Math.min(55, Number(params.get("wait") || 0));
    // What was fetched before is acknowledged by `after`.
    if (after > 0) q("DELETE FROM link_events WHERE to_device = ? AND id <= ?").run(s.deviceId, after);
    q("UPDATE devices SET last_seen = ? WHERE id = ?").run(now(), s.deviceId);
    const key = sec.dataKey(MASTER, s.user.data_key);
    const take = () => q("SELECT id, kind, blob, created FROM link_events WHERE to_device = ? AND id > ? ORDER BY id LIMIT 50").all(s.deviceId, after)
      .map((e) => ({ id: e.id, kind: e.kind, created: e.created, payload: JSON.parse(sec.open(key, e.blob).toString("utf8")) }));
    let list = take();
    if (!list.length && wait > 0) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, wait * 1000);
        const wakeUp = () => { clearTimeout(timer); resolve(); };
        waiting.set(s.deviceId, [...(waiting.get(s.deviceId) || []), wakeUp]);
        req.on("close", wakeUp);
      });
      list = take();
    }
    send(res, 200, list);
  });

  // ---- PetalDrop ------------------------------------------------------------------------------
  r.post("/api/device/lan", async (req, res) => {
    const s = needDevice(req);
    const b = await readJson(req);
    const addresses = (Array.isArray(b.addresses) ? b.addresses : []).map((a) => clean(a, 64)).filter((a) => /^[0-9a-f:.]+$/i.test(a)).slice(0, 8);
    const port = Number(b.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HttpError(400, "port?");
    q("INSERT INTO device_lan (device_id, addresses, port, updated) VALUES (?, ?, ?, ?) ON CONFLICT(device_id) DO UPDATE SET addresses = excluded.addresses, port = excluded.port, updated = excluded.updated")
      .run(s.deviceId, JSON.stringify(addresses), port, now());
    send(res, 200, { ok: true });
  });

  r.get("/api/device/petal", async (req, res) => {
    const s = needDevice(req);
    let row = q("SELECT key FROM petal_keys WHERE user_id = ?").get(s.user.id);
    if (!row) {
      q("INSERT INTO petal_keys (user_id, key) VALUES (?, ?)").run(s.user.id, sec.seal(MASTER, crypto.randomBytes(32)));
      row = q("SELECT key FROM petal_keys WHERE user_id = ?").get(s.user.id);
    }
    const peers = q(`SELECT d.*, l.addresses, l.port FROM devices d LEFT JOIN device_lan l ON l.device_id = d.id
                     WHERE d.user_id = ? AND d.id != ? ORDER BY d.last_seen DESC`).all(s.user.id, s.deviceId)
      .map((d) => ({ id: d.id, name: d.name, kind: d.kind, lastSeen: d.last_seen, addresses: JSON.parse(d.addresses || "[]"), port: d.port || 0 }));
    send(res, 200, { key: sec.open(MASTER, row.key).toString("hex"), peers });
  });
}
