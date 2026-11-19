#!/usr/bin/env python3
"""
Leonida Clipper — free, unlimited, no-watermark clipping tool.

Turns a long streamer video / live-stream VOD into 60-second vertical
(1080x1920) clips for YouTube Shorts.

No monthly cap, no watermark, no paid API, no API key.
Works offline after the source video is downloaded.

How it finds the best moments (no paid AI):
  * Audio energy: ffmpeg extracts the audio, then the tool measures
    loudness (RMS) in 0.5-second windows. Shouting, laughter, hype
    reactions and gunfights are loud; quiet walking / loading screens
    are not. Windows with high mean energy + high peaks score best.
  * Silence breaks: ffmpeg silencedetect finds natural breaks, so a
    clip starts near a break instead of mid-sentence.
  * Transcript (optional): if faster-whisper is installed, it
    transcribes the audio and boosts windows with dense, excited
    speech. If it is NOT installed, the tool just uses audio peaks —
    it never fails for a missing whisper install.

Usage:
  python3 clipper.py INPUT [--count 7] [--length 60] [--output ./output]
  python3 clipper.py https://www.youtube.com/watch?v=XXXX
  python3 clipper.py ~/videos/carry-stream.mp4 --count 5 --length 60

Requirements: ffmpeg + ffprobe + yt-dlp on PATH (already on this machine).
Python: stdlib only. numpy is used if present, otherwise pure-Python.
faster-whisper is OPTIONAL — install it only if you want transcript scoring:
  pip install faster-whisper
"""
import argparse
import json
import math
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import wave
from pathlib import Path

VERSION = "1.0.0"


def run(cmd, check=True, capture=True):
    """Run a command, return CompletedProcess."""
    result = subprocess.run(cmd, capture_output=capture, text=True)
    if check and result.returncode != 0:
        raise RuntimeError(
            f"Command failed ({result.returncode}): {' '.join(cmd)}\n"
            f"{result.stderr[-2000:]}"
        )
    return result


def check_tools():
    for tool in ("ffmpeg", "ffprobe"):
        if not shutil.which(tool):
            sys.exit(f"ERROR: {tool} not found on PATH. Install ffmpeg first.")
    # yt-dlp is only needed for URLs, checked later if needed.


def probe(path):
    """Return (duration_seconds, width, height) via ffprobe."""
    r = run([
        "ffprobe", "-v", "error",
        "-show_entries", "format=duration",
        "-show_entries", "stream=width,height,codec_type",
        "-of", "json", str(path),
    ])
    data = json.loads(r.stdout)
    duration = float(data["format"]["duration"])
    width = height = 0
    for s in data.get("streams", []):
        if s.get("codec_type") == "video":
            width, height = int(s["width"]), int(s["height"])
            break
    return duration, width, height


def download_youtube(url, dest_dir):
    """Download a YouTube URL with yt-dlp. Returns local file path."""
    if not shutil.which("yt-dlp"):
        sys.exit("ERROR: yt-dlp not found on PATH — needed for YouTube URLs.")
    out_tmpl = str(Path(dest_dir) / "source.%(ext)s")
    print(f"[1/5] Downloading {url} ...")
    run([
        "yt-dlp",
        "-f", "bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080]/best",
        "--no-playlist", "-o", out_tmpl, url,
    ])
    files = sorted(Path(dest_dir).glob("source.*"))
    if not files:
        sys.exit("ERROR: yt-dlp finished but no file was downloaded.")
    return files[0]


def extract_audio_wav(video_path, wav_path):
    """Extract mono 16 kHz WAV for analysis."""
    run([
        "ffmpeg", "-y", "-v", "error",
        "-i", str(video_path),
        "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
        str(wav_path),
    ])


def audio_rms_per_window(wav_path, window_s=0.5):
    """RMS loudness per window_s seconds. Returns list[float] (0..1)."""
    with wave.open(str(wav_path), "rb") as w:
        n_channels, sampwidth, framerate, n_frames = (
            w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
        )
        raw = w.readframes(n_frames)
    # pcm_s16le, mono (we extracted mono, but be safe)
    n_samples = len(raw) // 2
    samples = struct.unpack(f"<{n_samples}h", raw[: n_samples * 2])
    if n_channels > 1:
        samples = samples[::n_channels]
    per_window = int(framerate * window_s)
    rms_list = []
    try:
        import numpy as np  # fast path if available
        arr = np.asarray(samples, dtype=np.float64) / 32768.0
        for i in range(0, len(arr), per_window):
            chunk = arr[i:i + per_window]
            if len(chunk) == 0:
                continue
            rms_list.append(float(np.sqrt(np.mean(chunk ** 2))))
    except ImportError:
        for i in range(0, len(samples), per_window):
            chunk = samples[i:i + per_window]
            if not chunk:
                continue
            mean_sq = sum((s / 32768.0) ** 2 for s in chunk) / len(chunk)
            rms_list.append(math.sqrt(mean_sq))
    return rms_list


def silence_breaks(video_path):
    """Return list of silence-end times (seconds) via ffmpeg silencedetect."""
    r = run([
        "ffmpeg", "-i", str(video_path),
        "-af", "silencedetect=noise=-35dB:d=0.5",
        "-f", "null", "-",
    ], check=False)
    breaks = []
    for line in (r.stderr or "").splitlines():
        if "silence_end:" in line:
            try:
                breaks.append(float(line.split("silence_end:")[1].split()[0]))
            except (ValueError, IndexError):
                pass
    return breaks


def transcript_words(video_path, wav_path):
    """Optional: transcribe with faster-whisper. Returns [(start, end, text)] or []."""
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print("      (faster-whisper not installed — using audio peaks only)")
        return []
    try:
        print("      Transcribing with faster-whisper (tiny model, local)...")
        model = WhisperModel("tiny", device="cpu", compute_type="int8")
        segments, _ = model.transcribe(str(wav_path), beam_size=1)
        words = []
        for seg in segments:
            words.append((float(seg.start), float(seg.end), seg.text.strip()))
        return words
    except Exception as e:  # never fail the whole run for transcript problems
        print(f"      (transcript failed, continuing with audio only: {e})")
        return []


def score_windows(rms, window_s, clip_len, duration, breaks, words):
    """Score every candidate clip window. Returns [(score, start_s), ...] sorted desc."""
    # Smooth RMS a little (3-window moving average) so one spike doesn't dominate.
    smooth = []
    for i, v in enumerate(rms):
        lo, hi = max(0, i - 1), min(len(rms), i + 2)
        smooth.append(sum(rms[lo:hi]) / (hi - lo))
    max_rms = max(smooth) if smooth else 1.0
    max_rms = max(max_rms, 1e-6)

    # Word density per second, if we have a transcript.
    word_density = [0.0] * len(rms)
    if words:
        for start, end, text in words:
            n = max(1, len(text.split()))
            a = int(start / window_s)
            b = max(a + 1, int(end / window_s))
            for i in range(a, min(b, len(word_density))):
                word_density[i] += n / max(1.0, (end - start))
    max_wd = max(word_density) if word_density else 0.0

    step_s = 5.0  # candidate starts every 5 seconds
    candidates = []
    t = 0.0
    while t + clip_len <= duration:
        a = int(t / window_s)
        b = int((t + clip_len) / window_s)
        seg = smooth[a:b]
        if not seg:
            t += step_s
            continue
        mean_e = sum(seg) / len(seg) / max_rms          # 0..1 average loudness
        peak_e = max(seg) / max_rms                      # 0..1 loudest moment
        # Variance = excitement / change inside the clip, not flat noise.
        var = sum((x - sum(seg) / len(seg)) ** 2 for x in seg) / len(seg)
        var_e = min(1.0, var * 50)
        # Penalise mostly-silent clips.
        silent_frac = sum(1 for x in seg if x < 0.02 * max_rms) / len(seg)
        speech = 0.0
        if max_wd > 0:
            speech = (sum(word_density[a:b]) / len(seg)) / max_wd
        score = (
            0.45 * mean_e
            + 0.25 * peak_e
            + 0.15 * var_e
            + 0.15 * speech
            - 0.40 * silent_frac
        )
        # Small bonus for starting near a silence break (clean cut-in).
        if breaks and min((abs(t - b_) for b_ in breaks), default=99) < 3.0:
            score += 0.05
        candidates.append((round(score, 4), round(t, 1)))
        t += step_s
    candidates.sort(reverse=True)
    return candidates


def pick_distinct(candidates, count, clip_len):
    """Greedy: highest score first, skip any window overlapping a picked one."""
    picked = []
    for score, start in candidates:
        if len(picked) >= count:
            break
        if any(abs(start - p_start) < clip_len for _, p_start in picked):
            continue
        picked.append((score, start))
    picked.sort(key=lambda x: x[1])  # chronological order for output
    return picked


def vertical_filter(width, height):
    """ffmpeg video filter: vertical 1080x1920, blurred background for 16:9."""
    if width >= height:
        # 16:9 (or wider) source: blurred enlarged background + centred foreground
        return (
            "[0:v]split[a][b];"
            "[a]scale=1080:1920:force_original_aspect_ratio=increase,"
            "crop=1080:1920,gblur=sigma=40[bg];"
            "[b]scale=1080:1080:force_original_aspect_ratio=decrease[fg];"
            "[bg][fg]overlay=(W-w)/2:(H-h)/2,format=yuv420p[v]"
        )
    # Already vertical: just scale to 1080x1920.
    return "[0:v]scale=1080:1920,format=yuv420p[v]"


def cut_clip(video_path, start, length, out_path, width, height):
    run([
        "ffmpeg", "-y", "-v", "error",
        "-ss", str(start), "-i", str(video_path),
        "-t", str(length),
        "-filter_complex", vertical_filter(width, height),
        "-map", "[v]", "-map", "0:a?",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
        "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart",
        str(out_path),
    ])


def fmt_time(s):
    m, sec = divmod(int(round(s)), 60)
    return f"{m:02d}:{sec:02d}"


def main():
    ap = argparse.ArgumentParser(
        description="Leonida Clipper — free, unlimited, no-watermark 60s vertical clips."
    )
    ap.add_argument("input", help="YouTube URL or local video file")
    ap.add_argument("--count", type=int, default=7, help="Number of clips (default 7)")
    ap.add_argument("--length", type=int, default=60, help="Clip length in seconds (default 60)")
    ap.add_argument("--output", default="output", help="Output folder (default ./output)")
    ap.add_argument("--keep-source", action="store_true",
                    help="Keep the downloaded source file (default: delete it)")
    args = ap.parse_args()
    check_tools()

    out_dir = Path(args.output)
    out_dir.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix="leonida-clipper-"))

    try:
        # --- 1. Resolve source ---
        if args.input.startswith(("http://", "https://", "www.")):
            source = download_youtube(args.input, tmp)
        else:
            source = Path(args.input)
            if not source.exists():
                sys.exit(f"ERROR: file not found: {source}")
        duration, width, height = probe(source)
        print(f"[1/5] Source: {source}  ({duration:.1f}s, {width}x{height})")
        if duration < args.length:
            sys.exit(f"ERROR: source is only {duration:.1f}s, shorter than one {args.length}s clip.")

        # --- 2. Audio analysis ---
        print("[2/5] Analysing audio (loudness peaks, silence breaks)...")
        wav = tmp / "audio.wav"
        extract_audio_wav(source, wav)
        rms = audio_rms_per_window(wav)
        breaks = silence_breaks(source)
        print(f"      {len(rms)} x 0.5s windows, {len(breaks)} silence breaks")

        # --- 3. Optional transcript ---
        print("[3/5] Transcript (optional, skipped if faster-whisper is missing)...")
        words = transcript_words(source, wav)

        # --- 4. Score + pick moments ---
        print("[4/5] Scoring moments...")
        candidates = score_windows(rms, 0.5, args.length, duration, breaks, words)
        picked = pick_distinct(candidates, args.count, args.length)
        if not picked:
            sys.exit("ERROR: no moments found — source may be silent.")
        print(f"      Picked {len(picked)} distinct moments:")
        for score, start in picked:
            print(f"        {fmt_time(start)}–{fmt_time(start + args.length)}  score {score}")

        # --- 5. Cut clips ---
        print("[5/5] Cutting vertical clips (1080x1920, no watermark)...")
        results = []
        base = source.stem.replace(" ", "-").lower()
        for i, (score, start) in enumerate(picked, 1):
            name = f"{i:02d}-{base}-{fmt_time(start).replace(':', '')}.mp4"
            out_path = out_dir / name
            cut_clip(source, start, args.length, out_path, width, height)
            d, w, h = probe(out_path)
            size_mb = out_path.stat().st_size / 1e6
            print(f"      {name}  {d:.2f}s {w}x{h}  {size_mb:.1f} MB")
            results.append({
                "file": name,
                "start_seconds": start,
                "start_time": fmt_time(start),
                "end_seconds": round(start + args.length, 1),
                "end_time": fmt_time(start + args.length),
                "score": score,
                "duration_seconds": round(d, 2),
                "resolution": f"{w}x{h}",
                "size_mb": round(size_mb, 1),
                "suggested_title": (
                    f"Best Moments in {args.length} Seconds! "
                    f"({fmt_time(start)} — {source.stem})"
                ),
            })

        # --- Manifests ---
        (out_dir / "clips.json").write_text(json.dumps({
            "tool": "leonida-clipper", "version": VERSION,
            "source": str(source), "source_duration_seconds": round(duration, 1),
            "clip_length_seconds": args.length,
            "clips": results,
        }, indent=2))
        lines = ["Leonida Clipper — suggested titles\n"]
        for r in results:
            lines.append(
                f"{r['file']}  |  {r['start_time']}–{r['end_time']}  |  "
                f"score {r['score']}  |  {r['suggested_title']}"
            )
        (out_dir / "titles.txt").write_text("\n".join(lines) + "\n")
        print(f"\nDone. {len(results)} clips in {out_dir}/")
        print(f"  Manifest: {out_dir}/clips.json")
        print(f"  Titles:   {out_dir}/titles.txt")
        return 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
