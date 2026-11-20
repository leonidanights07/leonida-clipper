# Deploy the yt-dlp YouTube backend on Render (free tier)

## What this is

`backend-yt/server.py` is a small Python server (stdlib only) that
speaks the **same API contract as Cobalt**, so the Leonida Clipper
page needs no code change to use it — it just points at a different
server URL (already changed in `app.js`: `COBALT_BACKEND_URL` is now
`https://leonida-clipper-yt.onrender.com`).

- `GET /` → instance info JSON (wake-up / health check)
- `POST /` with `{"url": "<youtube link>"}` →
  `{"status":"tunnel","url":"...","filename":"..."}` (no download yet)
- `GET /v/<token>` → downloads the video with yt-dlp (720p H.264 +
  AAC MP4), streams it back, deletes it. One download at a time.

## Why not Cobalt?

Our Cobalt backend on Render (`leonida-clipper-cobalt`, Cobalt
11.7.1, Live) answers `error.api.fetch.fail` for **every** YouTube
link — normal video and GTA 6 streamer video alike. Cobalt's own
YouTube pipeline is bot-blocked on Render's datacenter IP. yt-dlp
handles YouTube's defenses far better, and plain yt-dlp was verified
working on 2026-11-20 for both test videos (metadata + a real
10-second download, then a full 652-second Clix video → 720p
H.264+AAC MP4 in ~50 s) from a test VM.

This is the same idea as "Tungsten"
(github.com/neozmmv/tungsten) — a yt-dlp service speaking Cobalt's
contract — written here from scratch so there is nothing extra to
audit or trust.

## Deploy steps (in the Render dashboard, ~10 minutes)

The Render account already exists (leonidanights07@gmail.com, free
plan, "Leonida's workspace") and the repo is already connected to
Render. Two ways:

**Way 1 — Blueprint (recommended, uses render.yaml):**
1. Render dashboard → New → Blueprint (New Blueprint Instance).
2. Pick repo `leonidanights07/leonida-clipper`.
3. Render reads `render.yaml`, which now defines TWO services:
   `leonida-clipper-cobalt` (already deployed — do not delete it)
   and `leonida-clipper-yt` (new). Syncing the Blueprint creates
   the new one. If Render asks, confirm the new service only.
4. Wait for the first deploy to go Live (a few minutes — it builds
   the Docker image with ffmpeg + yt-dlp).

**Way 2 — New Web Service (if Blueprint complains):**
1. Render dashboard → New → Web Service → pick the repo.
2. Name: `leonida-clipper-yt`, region Singapore, plan Free,
   runtime Docker, Dockerfile path `./backend-yt/Dockerfile`,
   Docker context `./backend-yt`.
3. Env vars: `API_URL=https://leonida-clipper-yt.onrender.com`
   (no trailing slash), `CORS_URL=https://leonidanights07.github.io`.
4. Deploy.

## Verify it (the test that decides everything)

```bash
curl -s https://leonida-clipper-yt.onrender.com/
# expect: {"cobalt":{"version":"1.0.0-yt-dlp","services":["youtube"],...}}

curl -s -X POST https://leonida-clipper-yt.onrender.com/ \
  -H "Accept: application/json" -H "Content-Type: application/json" \
  -d '{"url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ"}'
# expect: {"status":"tunnel","url":"https://leonida-clipper-yt.onrender.com/v/...","filename":"...mp4"}
```

Then paste the same link on
https://leonidanights07.github.io/leonida-clipper/ and press
Generate Clips. **This is the unproven step:** yt-dlp worked from
the test VM's IP, but Render's IP may be blocked the same way
Cobalt's was. If the page still says `error.api.fetch.fail`, the
Render IP is the problem — see "If it still fails" below. If it
works, link paste is fixed.

## If it still fails (Render IP blocked too)

In order of what to try next:
1. **Cobalt + disposable Google account (official Cobalt fix):**
   Cobalt supports `COOKIE_PATH` with a YouTube OAuth token
   (`pnpm token:youtube` in the Cobalt repo). Cobalt's own docs say
   if the IP has a bad reputation, use disposable Google accounts —
   "there's no other known workaround". **NEVER use a personal Google
   account for this** — Cobalt's docs warn the account can be
   permanently suspended. Create a throwaway Google account, generate
   the token from it, and put the cookies file in the Cobalt service.
   This fixes the *existing* Cobalt service, no new code needed.
2. **Move the yt-dlp service to a different free host** (Railway
   ~$1 credit/month, Fly.io free tier, Oracle Always Free VM):
   a different datacenter IP may not be blocked. Same code, same
   Dockerfile — only the URL changes.
3. **User's own computer as the fetcher:** the user's home IP is
   residential, not a datacenter, so YouTube does not block it —
   yt-dlp works from a home connection. But there is no no-terminal
   way to do this: it would need a small helper app/script running
   on the user's own computer, which is a bigger build and is not
   included here.
4. **Keep upload-only:** downloading the video first (yt-dlp on any
   home computer) and uploading the file always works — that path
   was tested end to end on the live site and works.

## Free-tier limits (same as Cobalt)

- $0, no card. Sleeps after 15 min idle — first request after sleep
  takes ~30–60 s to wake; the Clipper page waits up to 2 minutes.
- 512 MB RAM / 0.1 CPU, 5 GB bandwidth/month. A 720p video is
  roughly 10–20 MB a minute.
- A full video is downloaded + remuxed on the server before the
  browser gets any bytes, so long videos take minutes and may hit
  Render request timeouts. Short source videos work best.
- No API key on purpose (the page is public). If strangers abuse
  the URL and burn the 5 GB, add a key server-side.
