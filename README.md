# Leonida Clipper 🎮

Free, unlimited, no-watermark clipping tool for the **Leonida Nights** channel.

Turn a long streamer video / live-stream VOD into 60-second vertical
(1080×1920) clips for YouTube Shorts. No monthly cap, no watermark,
no paid API, no API key, no account.

**Repo:** `https://github.com/leonidanights07/leonida-clipper` (new repo —
clone it and run it manually; nothing here pushes or uploads by itself)

## Install

```bash
git clone https://github.com/leonidanights07/leonida-clipper.git
cd leonida-clipper
```

You need on your machine:

- `ffmpeg` + `ffprobe`
- `yt-dlp` — only for YouTube URLs
- Python 3.10+ — standard library only, nothing to `pip install` for the
  basic tool

Check them:

```bash
ffmpeg -version
yt-dlp --version
python3 --version
```

Optional, only if you want transcript scoring:

```bash
pip install faster-whisper
```

Without it the tool still works — it just uses audio peaks only.

## Run it

```bash
# From a YouTube URL
python3 clipper.py "https://www.youtube.com/watch?v=XXXX" --count 7

# From a local file (what we tested with)
python3 clipper.py ~/workspace/gta6-clips/source/carry-first-time-best.mp4 --count 2

# Options
python3 clipper.py INPUT --count 5 --length 60 --output ./my-clips
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--count` | 7 | How many clips to make |
| `--length` | 60 | Clip length in seconds |
| `--output` | `output` | Folder for the finished clips |
| `--keep-source` | off | Keep the downloaded YouTube source (deleted by default) |

## What you get

In the output folder, per run:

- `01-<source>-<start>.mp4` … — the clips, 1080×1920, H.264 + AAC,
  blurred-background vertical format (same as the Leonida Nights clips),
  **no watermark**
- `clips.json` — file, start/end time, score, duration, resolution,
  suggested title for every clip
- `titles.txt` — same list in plain text, easy to copy into the Sheet

## How it finds the best moments (no paid AI)

1. **Audio energy** — ffmpeg extracts the audio, the tool measures
   loudness every 0.5 s. Shouting, laughter, hype reactions and
   gunfights are loud; quiet walking / loading screens are not.
2. **Silence breaks** — `silencedetect` finds natural pauses, so clips
   start near a clean break instead of mid-sentence.
3. **Transcript (optional)** — if `faster-whisper` is installed it
   transcribes locally and boosts windows with dense, excited speech.
   If it is missing, the tool skips this step and never fails.
4. **Scoring + de-duplication** — every 60 s window is scored, then the
   top N are picked greedily with no overlap, so you never get the
   same moment twice.

## Test results (2026-11-20)

Tested on the CarryMinati source already on hand
(`carry-first-time-best.mp4`, 299.65 s, 1280×720):

```bash
python3 clipper.py ~/workspace/gta6-clips/source/carry-first-time-best.mp4 \
  --count 2 --output ~/workspace/leonida-clipper/test-output
```

- Clip 1: `01-carry-first-time-best-0005.mp4` — 00:05–01:05, score 0.4784,
  60.03 s, 1080×1920, H.264 + AAC, 18.9 MB
- Clip 2: `02-carry-first-time-best-0300.mp4` — 03:00–04:00, score 0.5102,
  60.03 s, 1080×1920, H.264 + AAC, 39.7 MB
- Both verified with `ffprobe` (see `test-output/clips.json`).
- Ran in 3 min 29 s on this machine (most of that is the blurred-background
  encode — about 90 s per clip on 1.5 CPUs).
- faster-whisper was NOT installed, so scoring used audio peaks only —
  and the tool did not fail.
- No watermark, no API call, no monthly limit used.

Note: the test clips live in `test-output/`, which is in `.gitignore` —
they are **not** part of the repo and must not be pushed to GitHub.

## Honest limits

**Does well:** loud reactions, laughter, shouting, hype moments,
shootouts / chases — anything with an audio spike. Gaming reactions
are exactly what it is best at.

**Misses:** silent visual moments (a funny crash with no one talking),
visual gags, and jokes that only make sense from the transcript.
It also cannot tell *which* moment is funniest — it ranks by energy,
so always watch the 30 s thumbnail / preview before uploading.

**Permission still matters:** the tool cuts faster, it does not grant
permission. Only use it on creators who have given permission to clip
their videos (e.g. CarryMinati, per Uzair's check) or on campaigns
that grant permission on joining. Never use it on a creator whose
permission you have not verified.

## Web UI

Open `index.html` in a browser (double-click it, no server needed).
It is a control panel for this CLI: paste a URL, pick count / length,
copy the exact command, and load a `clips.json` to preview and pick
which moments to keep. It does **not** cut video in the browser —
there is no fake in-browser ffmpeg. Cutting happens locally with
`clipper.py` (see the UI's "How it works" section).

## Push to GitHub (for Uzair — manual, from his account)

The folder is ready to push as a new repo `leonida-clipper` under
`leonidanights07`. This tool does not push anything itself.

```bash
cd leonida-clipper
git init
git add clipper.py index.html app.js README.md requirements.txt LICENSE .gitignore
git commit -m "Leonida Clipper v1.0 — free, unlimited, no-watermark clipping tool"
git branch -M main
git remote add origin https://github.com/leonidanights07/leonida-clipper.git
git push -u origin main
```

Only those 7 files are committed. `output/`, `test-output/`, `*.mp4`,
`__pycache__/` and `.env` are all in `.gitignore` and will not be pushed.
No credentials or API keys are in the repo (checked).
