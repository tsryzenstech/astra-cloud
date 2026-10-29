# astra cloud

The astraOS app store (Market) and AstraID, in one Node.js server with no dependencies (Node 22 built-ins: `http`, `sqlite`, `crypto`).

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

## Market's Today page and default apps

- **Today**: admins write the cards on `/admin/` (features, lists, tips, App and Game of the Day for a date). Without a
  chosen App or Game of the Day, Market picks one from the catalog each day. Market reads `/api/store/today`.
- **Default apps**: every `seed/<package>.apkg` (with an optional `seed/<package>.json` page) is published by the first
  admin when the server starts, and updated when a newer versionCode is dropped in. **WhatsAstra** ships this way.

## Running locally

```bash
MASTER_KEY=$(openssl rand -hex 32) ADMIN_EMAIL=me@example.com ADMIN_PASSWORD=changeme123 node server.js
```

## Publishing from CI

```bash
curl -X PUT --data-binary @app.apkg -H "Authorization: Bearer $ASTRA_TOKEN" \
     "$SERVER/api/dev/apps/com.example.app/versions?notes=Fixes"
```
