# Leonida Clipper — try ANOTHER free host for the yt-dlp backend

## Why this exists

- Cobalt on Render: Live, but answers `error.api.fetch.fail` for every
  YouTube link — YouTube bot-blocks Render's datacenter IP.
- yt-dlp backend (`backend-yt/server.py`) on Render
  (`leonida-clipper-yt.onrender.com`): also Live, but the **same** error
  for both test videos (`dQw4w9WgXcQ` and `LwJEFow3ccE`). The code is
  fine — plain yt-dlp works from a test VM's IP — so the problem is
  **Render's IP**, not the tool.
- This file prepares the SAME backend for three other free hosts.
  The code does not change: same `server.py`, same `Dockerfile`, same
  Cobalt API contract, so the Clipper page needs no code change — only
  its "server address" (default `COBALT_BACKEND_URL` in `app.js`) has
  to point at the new URL once a host is proven to work.

## The honest truth first

**Nobody can promise a different host will work.** Every host below
runs in a datacenter, and YouTube's bot check is about IP reputation.
Render is blocked; Railway / Fly.io / Oracle *might* not be, or might
be blocked the same way. The only test that decides it is: deploy,
then `POST /` with a real YouTube link and see if it returns a tunnel
instead of `error.api.fetch.fail`. Each host below has that test
written out. Do not change the Clipper page's default URL until a
host passes that test — test it first via the page's "server address"
box, which overrides the default without a code change.

## Host comparison (checked 2026-11-20)

| | Railway — TRY FIRST | Fly.io | Oracle Always Free |
|---|---|---|---|
| Cost | $0. $5 trial credit once (30 days), then $1/month credit. No card. | **NOT free for new accounts.** $1 trial, 7 days only, then card required. ~$3.69/mo for 512 MB after that. | $0 forever. Card required at signup (identity check only, not billed). |
| Sleeps? | Yes, sleeps when idle (free plan). First request after sleep takes ~30–60 s to wake. | Trial machines auto-stop after 5 min running. After trial, auto-stop is configurable. | Never sleeps. Always on, 2 OCPU / 12 GB. |
| Resources | 1 replica, 0.5 GB RAM, 1 vCPU. Enough for one 720p download at a time. | 512 MB shared-cpu-1x (256 MB is too tight for ffmpeg + yt-dlp). | 2 OCPU / 12 GB — far more than needed. 10 TB egress/mo. |
| HTTPS | Yes, automatic (`*.up.railway.app`). | Yes, automatic (`*.fly.dev`). | **No.** Plain http only — needs Cloudflare Tunnel (free) or your own domain + Caddy for TLS. The Clipper page (https) cannot call an http backend. |
| Setup effort | Low — dashboard, ~10 min. | Low — CLI, ~10 min. | High — VM, firewall, Docker, then TLS. ~1 hour. |
| IP block risk | Datacenter IP, same gamble as Render. Different provider/range, so it *may* pass. | Datacenter IP, same gamble. | Datacenter IP, same gamble. Oracle IPs are less commonly flagged than Render's, but that is anecdotal, not a guarantee. |
| Biggest catch | $1/month after the trial is tiny — heavy use stops the service until next month. Trial needs GitHub verification or network access is restricted (see below). | It is not free. Only useful as a 7-day IP test. | Card + capacity ("Out of capacity" is common for the free ARM shape) + idle-reclaim risk + no HTTPS out of the box. |

## Recommendation

**Try Railway first.** It is the only option that is free, needs no
card, gives automatic HTTPS, and takes ~10 minutes. If Railway's IP
is blocked too, the next step is Oracle (free forever, most powerful,
but needs the card + TLS work) — Fly.io only makes sense as a 7-day
IP test if someone is willing to pay $3.69/mo afterwards, so do not
treat it as a free host.

## 1. Railway (try first)

Config file: `backend-yt/railway.toml` (already in the repo).

Free tier (docs.railway.com, checked 2026-11-20):
- $0, no credit card. New accounts get a one-time $5 trial credit for
  30 days, then $1 of usage credit every month (no rollover). When the
  credit runs out, services stop until the next cycle — no surprise bill.
- Rates: $20/vCPU/month, $10/GB RAM/month, $0.05/GB egress. Our
  service sleeps when idle, so light use fits the $1 easily:
  ~20 fetches/month, ~5 min awake each, ~1 GB egress ≈ $0.11/month.
- Free plan caps: 1 replica, 0.5 GB RAM, 1 vCPU, 1 GB ephemeral
  storage. Enough — `server.py` only does one download at a time.
- **Trial catch:** Railway verifies the account through GitHub for the
  full trial. An unverified account gets a "Limited Trial" that
  RESTRICTS NETWORK ACCESS — yt-dlp would not be able to reach
  YouTube at all. Verify with the leonidanights07 GitHub account.

Deploy steps (dashboard, ~10 min, no card):
1. Sign up at https://railway.app with GitHub (leonidanights07),
   complete GitHub verification for the full trial.
2. New Project → Deploy from GitHub repo → pick
   `leonidanights07/leonida-clipper`.
3. Service Settings → Root Directory = `backend-yt`. Railway reads
   `backend-yt/railway.toml` and builds `backend-yt/Dockerfile`.
   Generate a public domain (Settings → Networking → Generate Domain).
4. Variables tab: set
   `API_URL=https://<your-service>.up.railway.app` (no trailing slash;
   copy the domain Railway assigned),
   `CORS_URL=https://leonidanights07.github.io`.
   `PORT` is injected by Railway automatically. Redeploy after setting
   API_URL — until it matches the real public URL, tunnel links will
   point at the wrong place.
5. Wait for the deploy to go Live.

Test it (the test that decides it — do this BEFORE changing app.js):
```bash
curl -s https://<your-service>.up.railway.app/
# expect: {"cobalt":{"version":"1.0.0-yt-dlp",...,"services":["youtube"]}}

curl -s -X POST https://<your-service>.up.railway.app/ \
  -H "Content-Type: application/json" \
  -d '{"url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ"}'
# PASS: {"status":"tunnel","url":"https://<your-service>.up.railway.app/v/...","filename":"...mp4"}
# FAIL: {"status":"error","error":{"code":"error.api.fetch.fail",...}} — Railway's IP is blocked too.
```
Then repeat the POST with the streamer video
`https://www.youtube.com/watch?v=LwJEFow3ccE`. If both pass, paste
the Railway URL in the Clipper page's "server address" box and press
Generate Clips — if that works end to end, change `COBALT_BACKEND_URL`
in `app.js` to the Railway URL and push v2.6.

## 2. Fly.io (7-day IP test only — NOT free)

Config file: `backend-yt/fly.toml` (already in the repo).

Free tier: **there is none for new accounts** (checked 2026-11-20,
docs.fly.io). Old free allowances (3× 256 MB VMs) are legacy-only for
accounts from before 7 Oct 2024. New accounts get a $1 trial credit
for 7 days, trial machines auto-stop after 5 minutes of running, and
when the trial ends the app STOPS until a credit card is added. After
that it is pay-as-you-go from the first second: shared-cpu-1x with
512 MB RAM = $3.69/month in the cheapest regions (256 MB = $2.19/mo,
but 256 MB is too tight for ffmpeg + yt-dlp remuxing 720p). No monthly
free allowance, no spending cap by default.

Deploy steps (CLI, ~10 min):
```bash
cd backend-yt
fly auth signup          # no card needed for the trial
fly launch --no-deploy   # app name leonida-clipper-yt, region sin
fly deploy               # uses backend-yt/fly.toml + Dockerfile
fly status               # wait for it to be running
```
`fly.toml` already sets `API_URL=https://leonida-clipper-yt.fly.dev`
and `PORT=8080`. If the app is renamed, change `API_URL` to match.

Test it the same way as Railway (curl GET `/`, then POST the two
test videos). Trial machines stop after 5 minutes of running, so a
long VOD download may be cut off mid-download — short videos are the
safe test. If it passes, it only proves the IP works for 7 days; after
that it costs $3.69/month unless the service is destroyed.

## 3. Oracle Always Free VM ($0 forever, most setup)

Setup script: `backend-yt/oracle-setup.sh` (already in the repo).

Free tier (docs.oracle.com, checked 2026-11-20):
- $0 for the life of the account, in your home region (not a trial).
  Ampere A1 Flex: 1,500 OCPU-hours + 9,000 GB-hours/month = 2 OCPU /
  12 GB RAM running continuously (cut from 4 OCPU / 24 GB in June
  2026). Plus 200 GB block storage, 10 TB egress/month. Far more than
  this backend needs.
- **Card required at signup** for identity verification (not billed;
  a temporary hold may appear and is reversed). No prepaid/virtual/
  single-use cards. One free account per person.
- **Capacity:** the free ARM shape is often "Out of capacity" — you
  may have to retry for days, try another availability domain, or
  upgrade to Pay As You Go (Always Free resources stay $0, and a
  ~US$100 temporary hold applies) for priority capacity.
- **Idle reclaim:** Oracle reclaims Always Free VMs it considers idle
  (low CPU + low network over 7 days). Keep it in use, or upgrade to
  Pay As You Go to stop the reclaim policy.
- Home region is chosen at signup and **cannot be changed** — Always
  Free resources only exist there.

Deploy steps (~1 hour):
1. Sign up at https://www.oracle.com/cloud/free/ (card for ID check).
2. Compute → Create Instance → shape VM.Standard.A1.Flex, 2 OCPU /
   12 GB RAM, image Canonical Ubuntu 24.04 (aarch64), in your home
   region. Add your SSH key.
3. VCN → Security Lists → add an Ingress Rule: source 0.0.0.0/0,
   TCP, destination port 9000 (or the VM will not answer at all).
4. SSH in, copy the repo (or at least `backend-yt/`), then:
   ```bash
   chmod +x backend-yt/oracle-setup.sh
   sudo bash backend-yt/oracle-setup.sh
   ```
   It installs Docker, builds the image, runs the container on
   :9000 with a systemd unit, and runs the Rick Astley POST test
   on the spot.
5. **Test it first over plain http with curl** (from your own
   computer) — GET `/` then POST the two test videos to
   `http://<vm-public-ip>:9000/`. This decides the IP question
   before any TLS work.
6. **Only if the test passes**, set up TLS (the Clipper page is
   https and browsers block http backends as mixed content):
   - Easiest free option: Cloudflare Tunnel — install `cloudflared`,
     `cloudflared tunnel --url http://localhost:9000`, which gives
     an `https://` URL (ephemeral `*.trycloudflare.com`, or a stable
     subdomain with a free Cloudflare account).
   - Or: your own domain (~$10/year) + Caddy, which gets a free
     Let's Encrypt certificate automatically.
   Then set `API_URL` to the final https URL (edit the container env
   / re-run the Docker command with the new `API_URL`) and test
   through the Clipper page's "server address" box.

## If ALL three hosts are blocked too

In order:
1. **Cobalt + disposable Google account (official Cobalt fix):**
   Cobalt supports a YouTube OAuth token (`pnpm token:youtube`).
   Cobalt's docs say a bad-reputation IP needs disposable Google
   accounts — "no other known workaround" — and warn NEVER to use a
   personal Google account (it can be permanently suspended). Create
   a throwaway Google account, generate the token from it, and put
   it in the existing Cobalt service on Render. No new code needed.
2. **User's own computer as the fetcher:** a home IP is residential,
   yt-dlp works from it — but there is no no-terminal way to do it;
   it needs a small helper app/script running on Uzair's computer.
3. **Keep upload-only:** downloading the video first (yt-dlp on any
   home computer) and uploading the file always works — tested end
   to end on the live site.

## Files added (not pushed, not deployed)

- `backend-yt/railway.toml` — Railway config (service root = `backend-yt`)
- `backend-yt/fly.toml` — Fly.io config (deploy from `backend-yt/`)
- `backend-yt/oracle-setup.sh` — Oracle VM install + first test
- `DEPLOY-ALT-HOSTS.md` — this file
- No change to `app.js` / `server.py` / `Dockerfile`: the backend
  already speaks the Cobalt contract, and the page's "server address"
  box lets any new URL be tested without a code change. Only change
  `COBALT_BACKEND_URL` in `app.js` AFTER a host passes the POST test.
