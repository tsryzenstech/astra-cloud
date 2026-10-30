# astra cloud

The astraOS app store (Market) and AstraID, in one Node.js server with no dependencies (Node 22 built-ins: `http`, `sqlite`, `crypto`),
plus Python 3 for the design check of uploaded apps.

- **Market**: the catalog phones read (`/api/store/index.json`), app pages (`/store/<package>`), downloads. There's also a developer panel (`/dev/`), a landing page with a developer request form (`/`), SDK docs (`/docs/`) and an admin page (`/admin/`).
- **AstraID**: accounts and Find My Device: location, play a sound, lock, and notifications sent to the phone. Contacts are backed up encrypted with AES-256-GCM, using a per-account key wrapped by `MASTER_KEY`. **Nothing else is backed up**: no files, photos, videos or audio.

## Hosting on 34.155.86.153

1. On the server (Debian/Ubuntu), install Docker:
   ```bash
   curl -fsSL https://get.docker.com | sudo sh
   ```
2. Get the code and configure it:
   ```bash
   git clone https://github.com/tsryzenstech/astra-cloud.git && cd astra-cloud
   cp .env.example .env
   openssl rand -hex 32   # paste into MASTER_KEY, and keep a copy offline
   nano .env              # also set ADMIN_EMAIL and ADMIN_PASSWORD
   ```
3. Start it:
   ```bash
   sudo docker compose up -d --build
   ```
4. Open ports 80 and 443. On Google Cloud that's VPC network › Firewall: allow tcp:80,443, or tick "Allow HTTP/HTTPS traffic" on the VM.
5. Open `http://34.155.86.153/dev/` (with `http://`: on the bare IP there is no HTTPS, so `https://` is refused) and sign in with the admin account.

**If the page says 502 Bad Gateway**, Caddy is running but the server isn't: `sudo docker compose logs cloud` says why
(usually an empty or wrong `MASTER_KEY` in `.env`).

**HTTPS (recommended).** Passwords and tokens travel over the network, so point a domain at the IP. Then set `DOMAIN=cloud.example.com` and `PUBLIC_URL=https://cloud.example.com` in `.env`, and run `docker compose up -d` again. Caddy gets the certificate automatically.

**Updates:** run `git pull && sudo docker compose up -d --build`.

**Backups:** copy the `data/` folder (database and apkg files) and keep `MASTER_KEY` somewhere safe.

## WhatsAstra: WhatsApp through OpenWA

WhatsAstra is a native astraOS app; the WhatsApp protocol runs here, in
[OpenWA](https://github.com/rmyndharis/OpenWA) (MIT), the `openwa` service of
`docker-compose.yml`. It is not published on any port: the phone talks to
this server (`/api/app/com.astra.whatsastra/*`, see `lib/whatsapp.js`) with
its AstraID, and every AstraID account gets its own WhatsApp session.

1. `sudo docker compose up -d` starts OpenWA too. On its first start it writes
   its API key: `sudo cat openwa/.api-key`, then put it in `.env` as
   `OPENWA_API_KEY=...` and run `sudo docker compose up -d` again.
2. In WhatsAstra on the phone, scan the QR code with WhatsApp on your main phone
   (Settings > Linked devices > Link a device).

**WhatsApp does not offer this officially.** OpenWA speaks WhatsApp's protocol
through reverse-engineered clients: WhatsApp can restrict or ban an account
linked this way. Use a number you can afford to lose. Messages pass through this
server in clear (between WhatsApp's encryption and the phone's TLS connection):
host it yourself.

## Market's Today page and default apps

- **Today**: admins write the cards on `/admin/` (features, lists, tips, App and Game of the Day for a date). Without a
  chosen App or Game of the Day, Market picks one from the catalog each day. Market reads `/api/store/today`.
- **Default apps**: every `seed/<package>.apkg` (with an optional `seed/<package>.json` page) is published by the first
  admin when the server starts, and updated when a newer versionCode is dropped in. **WhatsAstra** ships this way.

## The design check on uploads

Market publishes only apps built from astraOS's own components. Every uploaded `.apkg` (the `/dev/` panel and
`PUT /api/dev/apps/<package>/versions`) is unpacked to a temporary folder and checked with the SDK's
`astra check --json`, the same check developers run (error codes E010–E101, warnings W050/W060, see
`docs/DESIGN.md` in the astra repository):

- **errors**: the version is refused with `422` and the findings, `{"error": "...", "findings": [{"file", "line",
  "severity", "code", "message"}]}`; the panel lists them under the upload button;
- **warnings only**: the version is published and the warnings come back in the response (`"warnings": [...]`) and in
  the panel;
- QML or JavaScript under `build/`, `dist/` or a hidden folder, which the check skips, is refused with `400`;
- if the check cannot run (no Python, timeout) the upload is refused with `503`: nothing is published unchecked.

Every upload is checked as a third-party app, whatever its package name. Only the default apps in `seed/` are checked
with `--system` (the rules of the apps built into the system image).

The check is a copy of the SDK in `vendor/astra-sdk` (`vendor/astra-sdk/SOURCE` names the astra commit). When the
design rules change in the astra repository, update it with:

```bash
node scripts/sync-sdk.js ../astra
```

The Docker image installs `python3`; elsewhere set `ASTRA_PYTHON` if Python 3 is not `python3`, and
`DESIGN_CHECK_TIMEOUT_S` (default 30) to change the time limit.

## Running locally

```bash
MASTER_KEY=$(openssl rand -hex 32) ADMIN_EMAIL=me@example.com ADMIN_PASSWORD=changeme123 node server.js
```

Python 3 must be installed for uploads (see the design check above).

## Publishing from CI

```bash
curl -X PUT --data-binary @app.apkg -H "Authorization: Bearer $ASTRA_TOKEN" \
     "$SERVER/api/dev/apps/com.example.app/versions?notes=Fixes"
```

A version with design errors is refused with HTTP 422 and the findings in the JSON body: run `astra check` in CI
before uploading to catch them earlier.
