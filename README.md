# TallySync

Gmail (IMAP) → free Google AI extraction → review & approve → **Sync to Tally** (checks Tally first, never posts twice) and **Sync from Tally** (pulls entries typed in Tally, no duplicates).

```
 Browser ──► Vercel (frontend/, static page)
                │  HTTPS, Bearer token
                ▼
   Cloudflare Tunnel ──► tally-api.unimisk.com     ──► backend (Node, port 8100) ──► Postgres (local Supabase)
                     └─► tally-backend.unimisk.com ──► Supabase Studio (Kong)
 Windows PC with Tally ──► the same API URL (agent polls out, no inbound ports)
```

## Folders
| Folder | What |
|---|---|
| `frontend/` | The web page (single `index.html`). `build.js` writes `dist/` for Vercel from two env vars |
| `backend/` | Node 22 / Express API, IMAP listener, AI extraction, Tally XML, tests |
| `agent/` | Windows Tally agent source (built into a single `.exe`) |
| `deploy/tunnel/` | Cloudflare Tunnel connector (docker compose) |
| `downloads/` | Put the built `TallySync-Agent.exe` here on the server (not stored in git) |

## 1. Backend (Ubuntu server)
```bash
cp .env.example .env     # fill in DATABASE_URL, FERNET_KEY, SECRET_KEY, GEMINI_API_KEY, ADMIN_*, SUPABASE_NETWORK
docker compose up -d --build
```
- `FERNET_KEY`: `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`
- `SECRET_KEY`: any long random string (the server refuses to start in production with the default).
- Port 8100 is bound to `BIND_ADDR` (default `127.0.0.1`); only the tunnel needs to reach it.

## 2. Cloudflare Tunnel
Create a tunnel in Cloudflare Zero Trust (Networks → Tunnels → Create → Cloudflared), copy its token, then:
```bash
cd deploy/tunnel && cp .env.example .env     # set TUNNEL_TOKEN and SUPABASE_NETWORK
docker compose up -d
```
Public hostnames (in the tunnel's settings):

| Hostname | Service |
|---|---|
| `tally-api.unimisk.com` | `http://tallysync:8100` |
| `tally-backend.unimisk.com` | `http://supabase-kong-<id>:8000` (Supabase Studio) |

> Studio is protected only by Supabase's basic-auth. Put **Cloudflare Access** (Zero Trust → Access → Applications) in front of `tally-backend.unimisk.com` so only your own emails can open it.

## 3. Frontend on Vercel
1. Import this GitHub repo in Vercel. **Root Directory: `frontend`**. Framework: Other (settings come from `vercel.json`).
2. Environment variables:

| Name | Value |
|---|---|
| `API_URL` | `https://tally-api.unimisk.com` |
| `STUDIO_URL` | `https://tally-backend.unimisk.com` |

3. Deploy. The API allows pages from `*.vercel.app` and `*.unimisk.com` (`ALLOWED_ORIGINS`); add your own domain there if you use one.

## What lives in Supabase
- **Database:** all tables in schema `public` of the `postgres` database (row-level security on, no public API access).
- **Auth:** every user is a Supabase Auth user (`auth.users`); `public.users` links it to the company (`auth_id`). Passwords are checked by Supabase Auth.
- **Storage:** original PDFs / images are in the private bucket `documents` (`<company id>/<document id>_<name>`).
- **Edge Function:** `supabase/functions/tallysync-status` (copy it to the Supabase functions volume). Call it with the service key to get document counts and the last sync.

## Security notes
- Login returns a signed, expiring token (14 days) kept in the browser; file previews and downloads use 30-minute links valid for one path only.
- Wrong-password limit: 8 per account+address, 40 per address, per 15 minutes.
- Mailbox passwords are encrypted with `FERNET_KEY`. Never commit `.env`.

## Tally agent (Windows PC with Tally Prime)
Dashboard → Setup → Connect Tally → "Download the Tally program". Open it once: it installs into `%LOCALAPPDATA%\TallySync`, starts with Windows (per-user, no admin) and runs hidden. Its settings (API address + token) are appended to the downloaded file by `GET /api/agent-download`.
- In Tally once: F1 Help → Settings → Connectivity → Client/Server → Server, port 9000, open the company.
- Update: download again and open. Remove: `%LOCALAPPDATA%\TallySync\TallySync-Agent.exe --uninstall`. Log: `agent.log` in that folder.
- Build the exe (Node single-executable): `node --experimental-sea-config` + `npx postject` (sentinel `NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`), then copy to `downloads/`.

## How syncing works
- **Gmail → dashboard:** the IMAP listener downloads attachments; the AI decides if it is a PO / SO / bill.
- **Sync to Tally:** approved documents are queued; the agent reads Tally first. Same invoice number already in Tally → marked synced, not posted. Same party + amount + date with another number → held as "possible duplicate" for you to decide.
- **Sync from Tally:** vouchers typed in Tally become records (source "Tally"); already-matched ones are not duplicated; edits and deletions are followed.

## Tests
```bash
cd backend && node test/unit.js                                   # offline
docker exec -i tallysync node - < backend/test/integration.js     # live DB, temporary org
```
