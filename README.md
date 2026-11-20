# Leonida Clipper 🎮

Free, unlimited, no-watermark clipping tool for the **Leonida Nights** channel.

Turn a long streamer video / live-stream VOD into short clips for YouTube
Shorts. No monthly cap, no watermark, no paid API, no API key, no account —
and **no terminal, no Python, nothing to install**. Just open the website,
upload your video, and press Generate Clips.

**Website:** https://leonidanights07.github.io/leonida-clipper/
**Repo:** https://github.com/leonidanights07/leonida-clipper

## How to use it (the website — this is the normal way)

1. Open https://leonidanights07.github.io/leonida-clipper/
2. Upload the full video file — drop it on the box, or tap the box to choose it —
   or paste a YouTube link and let the page fetch it (Piped first, then
   Invidious — see "YouTube links" below).
3. Choose how many clips you want (1–10), how long each clip is (15 / 30 / 45 / 60 / 90 seconds),
   and the size: Vertical 1080×1920 (for Shorts), Square 1080×1080, or Landscape 1920×1080.
4. Press **Generate Clips**. The tool listens to the audio, finds the loudest, most energetic
   moments, and cuts them — all in your browser. Your video never leaves your device.
5. Watch every clip in the preview, then download the ones you like — one by one,
   or all at once with **Download All Clips**.

That's it. There is nothing to install and no command to run.

## What you get

Per run, in your downloads:

- One `.mp4` per clip — H.264 + AAC, blurred-background format (same look as the
  Leonida Nights clips), **no watermark**, at the size you picked.

## How it finds the best moments (no paid AI)

1. **Audio energy** — the browser reads the audio and measures loudness every 0.5 s.
   Shouting, laughter, hype reactions and gunfights are loud; quiet walking /
   loading screens are not.
2. **Scoring + de-duplication** — every clip-length window is scored by its average
   loudness (plus a small bonus for its loudest half-second), then the top N are
   picked with no overlap, so you never get the same moment twice.
3. **Cutting** — ffmpeg.wasm (loaded from a CDN the first time you press Generate)
   cuts each window to the size you picked.

## YouTube links — how they work, and their limits

Paste a YouTube link and the page tries to fetch the video through **Piped**
first, then **Invidious** — both free public services (no account, no key,
no server of ours). You can also pick one server directly under the link box,
or add your own Invidious instance in the optional field.

**Piped** (tried first, in this order):

- `api.piped.private.coffee`
- `pipedapi.wireway.ch`
- `pipedapi.kavin.rocks`

It takes the best MP4 stream (720p/1080p if there is one, with audio; if the
video is video-only, it downloads the audio track too and mixes it in while
cutting). Then the clips are cut in your browser exactly like an uploaded file.

**Invidious** (tried only after every Piped server has failed):

- `yt.chocolatemoo53.com` — live-tested 2026-11-20: the only public instance
  that answered `/api/v1/videos` with real video data that day, and it did so
  even for GTA 6 streamer videos (Clix, CarryMinati) that Piped answers with
  HTTP 500. It is also the only instance in the official list
  (api.invidious.io/instances.json) with both `api=true` and `cors=true`,
  which a browser page needs. The others failed that day: nadeko 403,
  nerdvpn 403 access_denied, tiekoetter 403, yewtu 403, pixora returns an
  HTML picker page (no API), privacyredirect / datura / projectsegfau /
  flokinet unreachable — so they are not in the list. If
  yt.chocolatemoo53.com ever goes down, add a replacement that has
  `api=true` and `cors=true` in the official list, and only after
  live-testing that it returns video data.

Invidious returns adaptive-only streams (no muxed file): the page picks the
best H.264 MP4 video (720p first, then 1080p / 480p / 360p — AV1 is skipped,
the in-browser cutter handles H.264 far better) plus the best AAC audio
track, downloads both (trying the instance's proxied `latest_version` URL
first, then the direct link), and ffmpeg mixes them while cutting.

**Honest warning:** both services are run by volunteers and YouTube
sometimes blocks them — for some videos they answer "sign in to confirm
you're not a bot", and some of their servers are down at any given moment.
Live-tested 2026-11-20: Piped returned HTTP 500 for the GTA 6 streamer
videos and its other two servers were down; Invidious via
yt.chocolatemoo53.com returned the same videos' data and a 200 KB range
download of the 720p stream verified as valid MP4. Note the direct
googlevideo links carry no `Access-Control-Allow-Origin` header, so a
browser fetch of them may still be refused — that is why the page tries
the instance's proxied URL first. The full in-browser fetch could not be
verified in this VM (its headless browser cannot reach the internet), so
treat the link path as "works in tests, may still fail in a real browser".
When a fetch fails the page says so plainly, tells you which service said
what, and offers a retry or a different server. If no server can fetch the
link, do this instead:

1. Download the video to your device first — for example with yt-dlp, or a video
   downloader of your choice.
2. Come back here and upload that video file.
3. Pick your clips and press Generate Clips.

Uploading the file always works — it is the reliable path.

## Honest limits

**Does well:** loud reactions, laughter, shouting, hype moments, shootouts /
chases — anything with an audio spike. Gaming reactions are exactly what it
is best at.

**Misses:** silent visual moments (a funny crash with no one talking), visual
gags, and jokes that only make sense from the transcript. It also cannot tell
*which* moment is funniest — it ranks by energy, so always watch a clip in the
preview before uploading it.

**First run is slower:** the video cutter (about 30 MB) loads from the internet
the first time you press Generate Clips, so allow a minute on a slow connection.
After that, cutting happens on your device. Very long or very large videos
(over about 1 GB) can be slow or run out of browser memory — shorter videos
work best.

**Permission still matters:** the tool cuts faster, it does not grant
permission. Only use it on creators who have given permission to clip
their videos (e.g. CarryMinati, per Uzair's check) or on campaigns
that grant permission on joining. Never use it on a creator whose
permission you have not verified.

## For developers

The website is a single static site — `index.html` + `app.js`, no build step,
no server — so it works on GitHub Pages as-is. It uses:

- **ffmpeg.wasm 0.12.15** (`@ffmpeg/ffmpeg`, `@ffmpeg/util`, single-threaded
  `@ffmpeg/core` 0.12.10) from the jsDelivr CDN, loaded on demand when you
  press Generate Clips.
- **Web Audio API** (`decodeAudioData`) for the loudness analysis.
- No account, no API key, no upload: everything runs in the visitor's browser.

The loudness scoring is in `app.js` as pure functions (`computeBestWindows`,
`evenWindows`, `buildVideoFilter`) — they can be imported and unit-tested in
Node without a browser. So can the stream pickers (`choosePipedStreams`,
`chooseInvidiousStreams`, `invidiousProxyUrl`).

## Advanced: the old command-line tool (optional, not needed for the website)

`clipper.py` is still in this repo for advanced users who want to cut clips
from a YouTube URL directly on their own computer. It is **not** needed to use
the website, and the website never mentions it. It needs ffmpeg, ffprobe,
yt-dlp and Python 3.10+ on the machine:

```bash
python3 clipper.py "https://www.youtube.com/watch?v=XXXX" --count 7
python3 clipper.py ~/videos/my-stream.mp4 --count 5 --length 60 --output ./my-clips
```

It was tested 2026-11-20 on a CarryMinati source (299.65 s): 2 clips,
00:05–01:05 and 03:00–04:00, both 60.03 s, 1080×1920, H.264 + AAC, no watermark.
