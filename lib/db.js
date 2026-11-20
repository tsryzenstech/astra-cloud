// SPDX-License-Identifier: Apache-2.0
// SQLite storage (Node's built-in node:sqlite).
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

// An app has one Market page and up to two builds of each version: "mobile" (every app so far: runs on
// phones and, in a phone shaped window, on astraOS Desktop) and "desktop" (astraOS Desktop only).
// app.json's "target" says which a package is. Versions were keyed by (package, version_code): the same
// versionCode of both builds needs the target in the key.
function migrateVersionTargets(db) {
  const cols = db.prepare("PRAGMA table_info(versions)").all().map((c) => c.name);
  if (cols.includes("target")) return;
  db.exec(`
    BEGIN;
    CREATE TABLE versions_v2 (
      package TEXT NOT NULL REFERENCES apps(package) ON DELETE CASCADE,
      target TEXT NOT NULL DEFAULT 'mobile',      -- mobile | desktop (app.json "target")
      version_code INTEGER NOT NULL,
      version TEXT NOT NULL,
      size INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      manifest TEXT NOT NULL,
      created INTEGER NOT NULL,
      PRIMARY KEY (package, target, version_code)
    );
    INSERT INTO versions_v2 (package, target, version_code, version, size, sha256, notes, manifest, created)
      SELECT package, 'mobile', version_code, version, size, sha256, notes, manifest, created FROM versions;
    DROP TABLE versions;
    ALTER TABLE versions_v2 RENAME TO versions;
    COMMIT;
  `);
}

// AstraID has phones and desktops: a device says which it is. A phone and a desktop of one account can be
// linked (Phone Linker, PetalDrop): one phone with one desktop and the other way round.
function migrateDeviceKinds(db) {
  const cols = db.prepare("PRAGMA table_info(devices)").all().map((c) => c.name);
  if (!cols.includes("kind"))
    db.exec("ALTER TABLE devices ADD COLUMN kind TEXT NOT NULL DEFAULT 'phone'");   // phone | desktop
  db.exec(`
    CREATE TABLE IF NOT EXISTS device_links (
      phone_id INTEGER NOT NULL UNIQUE REFERENCES devices(id) ON DELETE CASCADE,
      desktop_id INTEGER NOT NULL UNIQUE REFERENCES devices(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created INTEGER NOT NULL,
      PRIMARY KEY (phone_id, desktop_id)
    );

    -- What Phone Linker carries between the two: notifications, contacts, photos. Kept until the other side
    -- has fetched it (or a day), encrypted with the user's data key.
    CREATE TABLE IF NOT EXISTS link_events (
      id INTEGER PRIMARY KEY,
      to_device INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      from_device INTEGER NOT NULL,
      kind TEXT NOT NULL,                         -- notification | contacts | photo | dismiss
      blob TEXT NOT NULL,
      created INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS link_events_to ON link_events (to_device, id);
  `);
}

export function openDatabase(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, "astra-cloud.db"));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT NOT NULL,
      pass_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',          -- user | developer | admin
      data_key TEXT NOT NULL,                     -- the user's data key, wrapped with the master key
      created INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      device_id INTEGER REFERENCES devices(id) ON DELETE CASCADE,
      created INTEGER NOT NULL,
      last_used INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS devices (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      model TEXT NOT NULL DEFAULT '',
      os TEXT NOT NULL DEFAULT '',
      find_my INTEGER NOT NULL DEFAULT 1,
      report TEXT,                                -- last report (JSON: battery, location, network...)
      last_seen INTEGER,
      created INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS commands (
      id INTEGER PRIMARY KEY,
      device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      type TEXT NOT NULL,                         -- ring | notify | lock | locate
      payload TEXT NOT NULL DEFAULT '{}',
      state TEXT NOT NULL DEFAULT 'pending',      -- pending | delivered | done
      result TEXT,
      created INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS contacts_backup (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      blob TEXT NOT NULL,                         -- AES-256-GCM with the user's data key
      count INTEGER NOT NULL,
      updated INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS dev_requests (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      company TEXT NOT NULL DEFAULT '',
      website TEXT NOT NULL DEFAULT '',
      message TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL DEFAULT 'pending',      -- pending | approved | rejected
      created INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS apps (
      package TEXT PRIMARY KEY,
      owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT 'Apps',
      website TEXT NOT NULL DEFAULT '',
      published INTEGER NOT NULL DEFAULT 0,
      featured INTEGER NOT NULL DEFAULT 0,
      has_icon INTEGER NOT NULL DEFAULT 0,
      screenshots INTEGER NOT NULL DEFAULT 0,
      downloads INTEGER NOT NULL DEFAULT 0,
      created INTEGER NOT NULL,
      updated INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS versions (
      package TEXT NOT NULL REFERENCES apps(package) ON DELETE CASCADE,
      version_code INTEGER NOT NULL,
      version TEXT NOT NULL,
      size INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      manifest TEXT NOT NULL,
      created INTEGER NOT NULL,
      PRIMARY KEY (package, version_code)
    );

    -- Market's Today page: editorial cards written by the admins.
    CREATE TABLE IF NOT EXISTS stories (
      id INTEGER PRIMARY KEY,
      kind TEXT NOT NULL DEFAULT 'feature',       -- feature | app_of_day | game_of_day | list | tip
      eyebrow TEXT NOT NULL DEFAULT '',           -- small caps line above the title
      title TEXT NOT NULL,
      subtitle TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      packages TEXT NOT NULL DEFAULT '[]',        -- JSON list of featured apps
      color TEXT NOT NULL DEFAULT '#7B2FF7',
      has_image INTEGER NOT NULL DEFAULT 0,
      day TEXT NOT NULL DEFAULT '',               -- YYYY-MM-DD: shown that day only (app/game of the day)
      position INTEGER NOT NULL DEFAULT 0,
      published INTEGER NOT NULL DEFAULT 1,
      created INTEGER NOT NULL
    );
  `);
  migrateVersionTargets(db);
  migrateDeviceKinds(db);
  return db;
}
