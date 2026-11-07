# OpenWave

An ad-free music streaming platform for independent and royalty-free music
(Creative Commons, public domain, or artists uploading their own work).

Zero npm dependencies. Needs **Node 22.13+** and **FFmpeg** (with `ffprobe`).

## Run it

```bash
npm run demo          # generates 4 CC0 test tones and imports them
npm start             # http://localhost:3000
npm test              # 13 API tests (auth, privacy, streaming, install files, rate limits)
```

Browsing and streaming need no account. Click **Sign in / Create account** to upload
tracks and build playlists.

Import a folder of music you have the rights to (no account needed, run on the server):

```bash
node scripts/seed.js ./my-music CC-BY "Artist Name"
```

## Install on your phone (PWA)

OpenWave is an installable web app: home-screen icon, full-screen, opens offline (the app itself;
music always streams live and is never cached).

**Browsers only offer installation over HTTPS** (plain `http://192.168...` addresses can't be installed).
Pick one:

- **Private, from your own computer: Tailscale (free).** Install Tailscale on your computer and phone,
  then on the computer run `tailscale serve --bg 3000` and start OpenWave with
  `COOKIE_SECURE=1 TRUST_PROXY=1 npm start`. Open the `https://<computer>.<tailnet>.ts.net` address it prints.
  (Untested here, so check Tailscale's current Serve docs if the command differs.)
- **Your own certificate.** Set `TLS_CERT=/path/fullchain.pem TLS_KEY=/path/privkey.pem` and the server speaks
  HTTPS itself (default port 8443, secure cookies on automatically). A self-signed certificate will *not* work for install.
- **A real server** behind Caddy or nginx with a domain (automatic HTTPS), plus `COOKIE_SECURE=1 TRUST_PROXY=1`.

Then:
- **Android / Chrome / Edge**: tap **Install app** in the sidebar, or the browser's install option.
- **iPhone / iPad (Safari)**: tap Share, then **Add to Home Screen**.
- **Desktop Chrome/Edge**: click the install icon in the address bar, or **Install app** in the sidebar.

## Deploy to a hosting service (no computer needed)

The repo includes a `Dockerfile` (Node 22 + FFmpeg), so any host that builds from GitHub can run it
(Render, Railway, Fly.io, Koyeb, and similar). The recipe is the same everywhere:

1. Put this project in a GitHub repository.
2. In the host, create a new **web service from that repository** using the Dockerfile.
3. Add a **persistent disk/volume mounted at `/data`**. Without it, accounts and music are lost on every restart.
4. Port `3000`, health check path `/healthz`. `COOKIE_SECURE=1` and `TRUST_PROXY=1` are already set in the image.
5. Open the `https://…` address the host gives you, create your account, and install the app from your phone.

Note: the Dockerfile has not been run on a real host yet, so expect to adjust a setting or two on the first deploy.

## Accounts

- Email + password (min. 10 characters), hashed with scrypt and a per-user salt.
- Sessions are random 256-bit tokens in an `HttpOnly`, `SameSite=Lax` cookie; only a SHA-256 hash is stored.
- Playlists are **private** to their owner. Anyone can listen to the catalog.
- Uploaders can delete their own tracks (the audio file is removed too). Imported/seeded tracks have no owner.
- Failed logins are rate limited (10 per 15 min per IP), registrations too (10 per hour per IP).
- Cross-site writes are rejected (Origin check), and a strict Content-Security-Policy is sent on every response.

Upgrading from v0.1? The database migrates automatically. Playlists made with the old admin token
have no owner, so they no longer show up; tracks are kept.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DATA_DIR` | `./data` | SQLite database location |
| `MEDIA_DIR` | `./media` | Transcoded audio files |
| `COOKIE_SECURE` | off | Set to `1` when served over HTTPS (adds `Secure` to the cookie) |
| `TRUST_PROXY` | off | Set to `1` behind a reverse proxy so the real client IP is used for rate limiting |
| `TLS_CERT`, `TLS_KEY` | off | PEM file paths; serve HTTPS directly (default port 8443) |

Serve it behind HTTPS (Caddy or nginx) in production, with `COOKIE_SECURE=1` and `TRUST_PROXY=1`.

## How it works

| Piece | What it does |
|---|---|
| `lib/ingest.js` | Validates audio with ffprobe, transcodes to AAC 128 kbps (`.m4a`), saves to `media/`, registers in SQLite |
| `lib/auth.js` | Passwords, sessions, rate limiting |
| `server.js` | JSON API, HTTP Range streaming (seeking works), static files, security headers |
| `lib/db.js` | SQLite schema and migrations (`data/openwave.db`) |
| `public/` | Web player: library, search, playlists, upload, sign-in, Media Session (lock-screen controls), PWA manifest, service worker, icons |
| `test/` | `node:test` suite, runs against a throwaway database |

Every track must carry a license (`CC0`, `CC-BY`, `CC-BY-SA`, `CC-BY-NC`, `public-domain`, `original`).
That is what keeps the catalog legal without label deals.

## API

```
POST   /api/register {email,password}   create account + sign in
POST   /api/login    {email,password}
POST   /api/logout
GET    /api/me                          current user or null

GET    /api/tracks?q=term               list / search (public)
POST   /api/tracks?title=&artist=&album=&license=&source_url=   raw audio body, signed in
DELETE /api/tracks/:id                  own uploads only
GET    /api/tracks/:id/stream           audio (supports Range)

GET    /api/playlists                   your playlists
POST   /api/playlists                   {name}
GET    /api/playlists/:id               playlist with tracks (owner only)
DELETE /api/playlists/:id
POST   /api/playlists/:id/tracks        {track_id}
DELETE /api/playlists/:id/tracks/:tid
```

## Before going public

1. **Takedown process**: a visible contact address and a way to remove a track quickly if someone uploads music they don't own. Anyone can upload under any license label today, so moderation matters.
2. **Email verification and password reset** (needs an email provider).
3. **Object storage + CDN** (S3/R2 + CloudFront/Cloudflare) and **HLS**; keep audio off the app server.
4. **Postgres** and Meilisearch once the catalog passes a few thousand tracks. Rate-limit state is in memory, so move it to Redis if you run several servers.
5. **Cover art**, album and artist pages, likes, listening history.
6. **Funding the "no ads" part**: donations, an optional supporter subscription (Stripe), or artist tips.
7. **Importers** for Jamendo, Free Music Archive and the Internet Archive, storing each track's license and attribution.
8. **Mobile apps** (React Native/Flutter) on the same API.

CC-BY tracks require showing attribution; add artist/source links to the track view before launch.
