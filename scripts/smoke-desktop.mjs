// SPDX-License-Identifier: Apache-2.0
// Smoke test of what astraOS Desktop needs from this server (run it from the repository root):
//
//   node scripts/smoke-desktop.mjs [path to the astra repository]      (default ../astra; needs python3)
//
// It starts the server on a scratch directory and checks: one app with a mobile and a desktop build is one
// catalog entry, whose build is the asking device's; an app with a desktop build only is for desktops; a
// phone and a desktop of one AstraID link (one phone with one desktop), and what one sends the other gets.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const astra = path.resolve(process.argv[2] || "../astra");
const tool = path.join(astra, "tools", "apkgtool", "apkgtool.py");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "astra-cloud-smoke-"));
const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;

// ---- packages ------------------------------------------------------------------
function makeApkg(name, manifest, qml = "import QtQuick\nItem {}\n") {
  const dir = path.join(tmp, name);
  fs.mkdirSync(path.join(dir, "qml"), { recursive: true });
  fs.writeFileSync(path.join(dir, "app.json"), JSON.stringify({ name: "Hello", version: "1.0", versionCode: 1, main: "qml/Main.qml", icon: "icon.svg", ...manifest }));
  fs.writeFileSync(path.join(dir, "qml", "Main.qml"), qml);
  fs.writeFileSync(path.join(dir, "icon.svg"), "<svg xmlns='http://www.w3.org/2000/svg' width='1' height='1'/>");
  const out = path.join(tmp, `${name}.apkg`);
  const r = spawnSync("python3", [tool, "pack", dir, "-o", out], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return fs.readFileSync(out);
}
const mobile = makeApkg("both-mobile", { package: "org.example.both", versionCode: 3, version: "3.0" });
const desktop = makeApkg("both-desktop", { package: "org.example.both", versionCode: 3, version: "3.0", target: "desktop", desktop: { width: 900, height: 600 } });
const desktopOnly = makeApkg("only-desktop", { package: "org.example.deskonly", name: "Desk Only", target: "desktop" });

// ---- server --------------------------------------------------------------------------
const server = spawn("node", ["server.js"], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: path.join(tmp, "data"), PUBLIC_URL: BASE, MASTER_KEY: "ab".repeat(32),
         ADMIN_EMAIL: "admin@example.com", ADMIN_PASSWORD: "admin-password-1", ASTRA_PYTHON: "python3" },
  stdio: ["ignore", "pipe", "inherit"],
});
let ready = false;
server.stdout.on("data", (d) => { if (String(d).includes("astra cloud on")) ready = true; });
for (let i = 0; i < 100 && !ready; i++) await new Promise((r) => setTimeout(r, 100));
assert.ok(ready, "the server did not start");

async function call(method, url, { token, cookie, body, raw, headers = {} } = {}) {
  const res = await fetch(BASE + url, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(cookie ? { Cookie: cookie } : {}),
               ...(body && !raw ? { "Content-Type": "application/json" } : {}), ...headers },
    body: raw ? raw : body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json, headers: res.headers };
}

let failed = 0;
async function step(name, fn) {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`); }
}

try {
  const admin = await call("POST", "/api/auth/login", { body: { email: "admin@example.com", password: "admin-password-1" } });
  const cookie = String(admin.headers.get("set-cookie")).split(";")[0];

  await step("publish a mobile and a desktop build of one app, and an app for desktops only", async () => {
    assert.equal((await call("POST", "/api/dev/apps", { cookie, body: { package: "org.example.both", name: "Both" } })).status, 200);
    assert.equal((await call("POST", "/api/dev/apps", { cookie, body: { package: "org.example.deskonly", name: "Desk Only" } })).status, 200);
    for (const [pkg, buf, target] of [["org.example.both", mobile, "mobile"], ["org.example.both", desktop, "desktop"], ["org.example.deskonly", desktopOnly, "desktop"]]) {
      const r = await call("PUT", `/api/dev/apps/${pkg}/versions`, { cookie, raw: buf });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.equal(r.json.target, target);
    }
    for (const pkg of ["org.example.both", "org.example.deskonly"])
      assert.equal((await call("PATCH", `/api/dev/apps/${pkg}`, { cookie, body: { published: true } })).status, 200);
  });

  await step("a versionCode can repeat across targets, not within one", async () => {
    const again = await call("PUT", "/api/dev/apps/org.example.both/versions", { cookie, raw: desktop });
    assert.equal(again.status, 409);
  });

  await step("the catalog: one entry per app, the build of the asking device", async () => {
    const phone = (await call("GET", "/api/store/index.json")).json;
    assert.deepEqual(phone.map((e) => e.package).filter((p) => p.startsWith("org.example.")), ["org.example.both"], "a phone is not offered desktop-only apps");
    const both = phone.find((e) => e.package === "org.example.both");
    assert.equal(both.target, "mobile");
    assert.deepEqual(both.targets, ["mobile", "desktop"]);
    const desk = (await call("GET", "/api/store/index.json?target=desktop")).json;
    assert.deepEqual(desk.map((e) => e.package).filter((p) => p.startsWith("org.example.")).sort(), ["org.example.both", "org.example.deskonly"]);
    assert.equal(desk.find((e) => e.package === "org.example.both").target, "desktop");
    const byAgent = (await call("GET", "/api/store/index.json", { headers: { "User-Agent": "astraOS/27.1.3 (com.astra.market; desktop; +https://github.com/x)" } })).json;
    assert.equal(byAgent.find((e) => e.package === "org.example.both").target, "desktop");
    const phoneAgent = (await call("GET", "/api/store/index.json", { headers: { "User-Agent": "astraOS/27.1.3 (com.astra.market; +https://github.com/x)" } })).json;
    assert.equal(phoneAgent.find((e) => e.package === "org.example.both").target, "mobile");
  });

  await step("one page, the right build behind the button, both downloads", async () => {
    const page = (await call("GET", "/api/store/apps/org.example.both?target=desktop")).json;
    assert.equal(page.target, "desktop");
    assert.equal(page.compatible, true);
    assert.deepEqual(page.variants.map((v) => v.target), ["mobile", "desktop"]);
    const phonePage = (await call("GET", "/api/store/apps/org.example.both")).json;
    assert.equal(phonePage.target, "mobile");
    const only = (await call("GET", "/api/store/apps/org.example.deskonly")).json;
    assert.equal(only.compatible, false, "a phone can not install a desktop-only app");
    const dl = await fetch(page.url);
    assert.equal(dl.status, 200);
    assert.ok(Buffer.from(await dl.arrayBuffer()).equals(desktop));
    const dm = await fetch(phonePage.url);
    assert.ok(Buffer.from(await dm.arrayBuffer()).equals(mobile));
  });

  // ---- devices ------------------------------------------------------------------------------
  const email = "linker@example.com";
  const reg = (kind, n) => call("POST", n === 0 ? "/api/auth/register" : "/api/auth/login",
    { body: { email, password: "long-enough-pw", name: "Linker", device: { name: `${kind} ${n}`, model: "test", os: "astraOS", kind } } });
  const phone = (await reg("phone", 0)).json;
  const desk = (await reg("desktop", 1)).json;
  const phone2 = (await reg("phone", 2)).json;
  const desk2 = (await reg("desktop", 3)).json;

  await step("AstraID knows phones and desktops", async () => {
    const list = (await call("GET", "/api/id/devices", { token: phone.token })).json;
    assert.deepEqual(list.map((d) => d.kind).sort(), ["desktop", "desktop", "phone", "phone"]);
  });

  await step("a phone links with a desktop, and only one", async () => {
    assert.equal((await call("POST", "/api/device/link", { token: phone.token, body: { peer: phone2.deviceId } })).status, 400, "phone with phone");
    assert.equal((await call("POST", "/api/device/link", { token: phone.token, body: { peer: desk.deviceId } })).status, 200);
    assert.equal((await call("POST", "/api/device/link", { token: phone2.token, body: { peer: desk.deviceId } })).status, 409, "the desktop is taken");
    assert.equal((await call("POST", "/api/device/link", { token: phone.token, body: { peer: desk2.deviceId } })).status, 409, "the phone is taken");
    const mine = (await call("GET", "/api/device/link", { token: desk.token })).json;
    assert.equal(mine.linked, true);
    assert.equal(mine.peer.id, phone.deviceId);
  });

  await step("what the phone sends reaches the desktop (and a long poll wakes up)", async () => {
    const waiting = call("GET", "/api/link/events?wait=20", { token: desk.token });
    await new Promise((r) => setTimeout(r, 300));
    const sent = await call("POST", "/api/link/send", { token: phone.token, body: { kind: "notification", payload: { app: "Messages", title: "Hi", body: "Hello" } } });
    assert.equal(sent.status, 200);
    const events = (await waiting).json;
    assert.equal(events.length, 1);
    assert.equal(events[0].payload.title, "Hi");
    // Acknowledged by `after`: it is not delivered again.
    const next = (await call("GET", `/api/link/events?after=${events[0].id}`, { token: desk.token })).json;
    assert.equal(next.length, 0);
    assert.equal((await call("POST", "/api/link/send", { token: phone2.token, body: { kind: "notification", payload: {} } })).status, 409, "an unlinked phone sends nowhere");
    assert.equal((await call("POST", "/api/link/send", { token: phone.token, body: { kind: "nonsense", payload: {} } })).status, 400);
  });

  await step("unlinking frees both", async () => {
    assert.equal((await call("DELETE", "/api/device/link", { token: desk.token })).status, 200);
    assert.equal((await call("GET", "/api/device/link", { token: phone.token })).json.linked, false);
    assert.equal((await call("POST", "/api/device/link", { token: phone.token, body: { peer: desk2.deviceId } })).status, 200);
  });

  await step("PetalDrop: the account's key and where its devices listen", async () => {
    assert.equal((await call("POST", "/api/device/lan", { token: desk2.token, body: { addresses: ["192.168.1.20", "bad address"], port: 47742 } })).status, 200);
    const a = (await call("GET", "/api/device/petal", { token: phone.token })).json;
    const b = (await call("GET", "/api/device/petal", { token: desk.token })).json;
    assert.match(a.key, /^[0-9a-f]{64}$/);
    assert.equal(a.key, b.key, "the devices of one account share the key");
    const d2 = a.peers.find((p) => p.id === desk2.deviceId);
    assert.deepEqual(d2.addresses, ["192.168.1.20"]);
    assert.equal(d2.port, 47742);
    const other = (await call("POST", "/api/auth/register", { body: { email: "other@example.com", password: "long-enough-pw", device: { name: "x", kind: "phone" } } })).json;
    assert.notEqual((await call("GET", "/api/device/petal", { token: other.token })).json.key, a.key, "another account has another key");
  });
} finally {
  server.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(failed ? `${failed} failed` : "all ok");
process.exit(failed ? 1 : 0);
