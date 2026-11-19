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
   or paste a YouTube link and let Piped fetch it (see "YouTube links" below).
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

Paste a YouTube link and the page tries to fetch the video through **Piped**,
a free public service (no account, no key, no server of ours). It tries these
Piped servers in turn — you can also pick one directly under the link box:

- `api.piped.private.coffee`
- `pipedapi.wireway.ch`
- `pipedapi.kavin.rocks`

It takes the best MP4 stream (720p/1080p if there is one, with audio; if the
video is video-only, it downloads the audio track too and mixes it in while
cutting). Then the clips are cut in your browser exactly like an uploaded file.

**Honest warning:** Piped is run by volunteers and YouTube sometimes blocks
it — for some videos it answers "sign in to confirm you're not a bot", and
some of its servers are down at any given moment. When that happens the page
says so plainly, tells you which server said what, and offers a retry or a
different server. If no server can fetch the link, do this instead:

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
Node without a browser.

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
