# Deploying the Leonida Clipper Cobalt backend on Render (free)

The Clipper website is a static page on GitHub Pages — it has no server.
Pasted YouTube links used to be fetched through Piped, then Invidious.
Both are free public services, and both can *find* a video, but the
browser usually cannot *download* the actual video file from them
(CORS / proxy blocks — the "Failed to fetch" you saw). This backend
fixes that: it runs on Render, fetches the video server-side, and
tunnels the file back to the browser through our own URL.

## What you need

- A Render account (https://render.com) — free, **no credit card**.
- The `leonida-clipper` GitHub repo (already public).
- About 10 minutes. The first deploy takes a few minutes because
  Render has to pull the Cobalt image.

## Steps

1. **Sign in to Render** at https://render.com (sign up free if needed).
2. **Dashboard → New + → Web Service** (or "New Blueprint Instance").
   - If you pick **Web Service**: connect the GitHub repo
     `leonidanights07/leonida-clipper`, then set:
     - Name: `leonida-clipper-cobalt`
     - Region: `Singapore` (closest to Pakistan; use `Oregon` if
       Singapore is not offered on the free plan)
     - Runtime: `Docker`
     - Dockerfile Path: `./backend/Dockerfile`
     - Docker Context: `./backend`
     - Plan: `Free`
     - Health Check Path: `/`
     - Environment variables — copy them from `render.yaml` at the repo
       root (API_URL, CORS_WILDCARD, CORS_URL, DURATION_LIMIT,
       TUNNEL_LIFESPAN, RATELIMIT_WINDOW, RATELIMIT_MAX).
   - If you pick **New Blueprint Instance**: choose the same repo and
     Render reads `render.yaml` and fills all of the above in for you.
     This is the easier way — use it if you see it.
3. **Check the service name is exactly `leonida-clipper-cobalt`.**
   Its public URL will be `https://leonida-clipper-cobalt.onrender.com`.
   If you rename it, you MUST also change `API_URL` in the Render
   dashboard (Environment tab) to the new URL **with a trailing slash**,
   or Cobalt's tunnel links will point at the wrong place and break.
   You must also paste the new URL into the "Your Cobalt backend URL"
   box on the Clipper page (it is saved in your browser).
4. **Deploy.** Wait for "Live" in the dashboard.
5. **Check it works:** open `https://leonida-clipper-cobalt.onrender.com/`
   in a browser. You should see a small JSON page with cobalt version
   info (`"cobalt": {"version": ...}`). That means it is up.
6. **Try it in the Clipper:** open
   https://leonidanights07.github.io/leonida-clipper/, paste a YouTube
   link, press Generate Clips. The first try after the backend has been
   idle takes about 30–60 seconds — the free service sleeps after
   15 minutes and has to wake up. The page says this on screen and
   waits up to 2 minutes. Later tries are fast.

## If it does not work

- **Deploy fails / health check fails:** open the service in Render →
  Logs. The most common cause is the container not binding Render's
  `$PORT`. The Dockerfile maps `$PORT` to Cobalt's `API_PORT` for
  exactly this reason — if you deployed with a different Dockerfile
  or image setting, use `./backend/Dockerfile`.
- **The page says "our server didn't answer":** the service may still
  be deploying, or it may have spun down and be waking up. Open the
  backend URL directly (step 5) — if it loads, try the Clipper again.
- **Cobalt answers with an error (e.g. a bot-check code):** YouTube
  blocked the Render server. The Clipper page says so and points at
  uploading the video file instead — there is no fallback service.
  Try again later, or upload the file.
- **"CORS" errors in the browser console:** `CORS_URL` in Render must
  be exactly `https://leonidanights07.github.io` (no trailing slash).
  If you test from `http://localhost`, set `CORS_WILDCARD` to `1`
  temporarily in Render — and set it back to `0` afterwards.
- **It stops working after a while / bandwidth used up:** the free
  plan has 5 GB of bandwidth a month. A 720p video is roughly
  10–20 MB a minute. Check Render → Metrics. It resets next month.
  If the URL is being abused by strangers, see "Abuse" in the main
  README — there is no API key on purpose, and adding one to a public
  web page does not hide it.

## Updating Cobalt

The Dockerfile uses `ghcr.io/imputnet/cobalt:latest`, so every
redeploy on Render pulls the newest Cobalt. To update, click
"Manual Deploy → Deploy latest commit" in Render (or push any change
to the repo if auto-deploy is on). No code change is needed.
