#!/usr/bin/env python3
"""Leonida Clipper — YouTube fetch backend (yt-dlp edition).

Speaks the SAME API contract as Cobalt, so the Leonida Clipper page
(https://leonidanights07.github.io/leonida-clipper/) needs no code change
to use it — just point its "server address" at this service:

  GET  /            -> instance info JSON (wake-up / health check)
  POST /            -> {"status":"tunnel","url":"...","filename":"..."}
                       or {"status":"error","error":{"code":"..."}}
  GET  /v/<token>   -> the finished MP4 file, streamed back, then deleted

Why this exists: our Cobalt backend on Render answers
"error.api.fetch.fail" for every YouTube link — Cobalt's own YouTube
pipeline is bot-blocked on Render's datacenter IP. yt-dlp handles
YouTube's defenses far better (it is the tool the whole downloading
ecosystem depends on), and plain yt-dlp was verified working from this
VM on 2026-11-20 for both a normal video (dQw4w9WgXcQ) and a GTA 6
streamer video (LwJEFow3ccE): metadata + a real 10-second download.

This is the same idea as "Tungsten" (github.com/neozmmv/tungsten), a
yt-dlp service that speaks Cobalt's contract — written here from
scratch in stdlib-only Python so there is no extra dependency to audit.

HONEST LIMITS (read before deploying):
- Whether yt-dlp works from RENDER's IP is UNPROVEN until deployed.
  Cobalt fails there because of IP reputation; yt-dlp may work there
  because it uses different YouTube clients and challenge handling, or
  it may hit the same wall. The only way to know is to deploy and
  paste a link. If it fails, the page falls back to upload-the-file.
- Render free tier: 512 MB RAM, 0.1 CPU, sleeps after 15 min idle,
  5 GB bandwidth/month. One download at a time (a lock enforces it).
  A full video is downloaded + remuxed on the server before the
  browser gets any bytes, so a long video can take minutes and may
  hit Render's request timeouts — Shorts-length source videos work
  best; long VODs are the risky case.
- No API key: the page is public, so any key in it would be visible.
  Anyone who finds this URL can use it and burn the 5 GB. If abused,
  add a key server-side and stop calling it from the public page.
- Only YouTube. Nothing else.

Env vars:
  PORT      - listen port (Render sets this; default 9000)
  API_URL   - this service's public URL, no trailing slash
              (default http://localhost:9000) — tunnel URLs are built from it
  CORS_URL  - origin allowed to call this API from a browser
              (default https://leonidanights07.github.io)
"""

import base64
import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

PORT = int(os.environ.get("PORT", "9000"))
API_URL = os.environ.get("API_URL", "http://localhost:9000").rstrip("/")
CORS_URL = os.environ.get("CORS_URL", "https://leonidanights07.github.io")
VERSION = "1.0.0-yt-dlp"

# One download at a time: Render free tier is 0.1 CPU / 512 MB.
DOWNLOAD_LOCK = threading.Lock()

YT_RE = re.compile(
    r"^https?://(www\.|m\.)?(youtube\.com/(watch|shorts/)|youtu\.be/)"
)
# 720p max, H.264 video + AAC audio in an MP4 — what the Clipper expects.
# vcodec^=avc1 matters: without it yt-dlp picks AV1 (itag 398), which the
# in-browser cutter may not decode. Fall back to any 720p if no AVC1 exists.
FORMAT = ("bv*[height<=720][vcodec^=avc1][ext=mp4]+ba[ext=m4a]/"
          "bv*[height<=720][vcodec^=avc1]+ba/"
          "bv*[height<=720]+ba/b[height<=720]")


def b64url_encode(s):
    return base64.urlsafe_b64encode(s.encode()).decode().rstrip("=")


def b64url_decode(s):
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4)).decode()


def safe_filename(title):
    name = re.sub(r"[^\w\- ]+", "", (title or "video").strip())[:60] or "video"
    return name + ".mp4"


def _yt_dlp_bin():
    for cand in (shutil.which("yt-dlp"),
                 os.path.expanduser("~/.local/bin/yt-dlp"),
                 "/usr/local/bin/yt-dlp", "/usr/bin/yt-dlp"):
        if cand and os.path.isfile(cand) and os.access(cand, os.X_OK):
            return cand
    return "yt-dlp"  # let the error surface clearly if truly missing


YT_DLP = _yt_dlp_bin()


def yt_dlp(args, timeout=300):
    return subprocess.run(
        [YT_DLP] + args,
        capture_output=True, text=True, timeout=timeout,
    )


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):  # keep logs quiet
        pass

    def _cors(self):
        origin = self.headers.get("Origin", "")
        allow = CORS_URL if origin == CORS_URL else ""
        # Allow curl / server-to-server checks (no Origin header) too.
        self.send_header("Access-Control-Allow-Origin", allow or "*")
        self.send_header("Access-Control-Allow-Headers",
                         "Accept, Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        if self.path in ("/", ""):
            self._json(200, {"cobalt": {
                "version": VERSION,
                "url": API_URL + "/",
                "services": ["youtube"],
            }})
            return
        m = re.match(r"^/v/([A-Za-z0-9_\-]+)$", urlparse(self.path).path)
        if not m:
            self._json(404, {"status": "error",
                             "error": {"code": "error.api.not_found"}})
            return
        try:
            video_url = b64url_decode(m.group(1))
        except Exception:
            self._json(400, {"status": "error",
                             "error": {"code": "error.api.bad_link"}})
            return
        if not YT_RE.match(video_url):
            self._json(400, {"status": "error",
                             "error": {"code": "error.api.not_youtube"}})
            return
        self._serve_video(video_url)

    def _serve_video(self, video_url):
        if not DOWNLOAD_LOCK.acquire(blocking=False):
            self._json(429, {"status": "error", "error": {
                "code": "error.api.busy",
                "context": {"service": "youtube"}}})
            return
        tmpdir = tempfile.mkdtemp(prefix="leonida-yt-")
        try:
            out = os.path.join(tmpdir, "%(title)s.%(ext)s")
            r = yt_dlp([
                "--no-playlist", "--no-warnings",
                "-f", FORMAT, "--merge-output-format", "mp4",
                "--remux-video", "mp4",
                "--socket-timeout", "30", "--retries", "2",
                "-o", out, video_url,
            ], timeout=600)
            files = [f for f in os.listdir(tmpdir)
                     if f.lower().endswith(".mp4")]
            if r.returncode != 0 or not files:
                err = (r.stderr or "").strip().splitlines()
                msg = err[-1][:200] if err else "download failed"
                self._json(502, {"status": "error", "error": {
                    "code": "error.api.fetch.fail",
                    "context": {"service": "youtube", "detail": msg}}})
                return
            path = os.path.join(tmpdir, files[0])
            size = os.path.getsize(path)
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "video/mp4")
            self.send_header("Content-Length", str(size))
            self.send_header("Content-Disposition",
                             'attachment; filename="video.mp4"')
            self.end_headers()
            with open(path, "rb") as fh:
                shutil.copyfileobj(fh, self.wfile, length=1024 * 256)
        except subprocess.TimeoutExpired:
            try:
                self._json(504, {"status": "error", "error": {
                    "code": "error.api.fetch.fail",
                    "context": {"service": "youtube",
                                "detail": "download timed out"}}})
            except Exception:
                pass
        except (BrokenPipeError, ConnectionResetError):
            pass  # browser gave up; nothing more to do
        finally:
            DOWNLOAD_LOCK.release()
            shutil.rmtree(tmpdir, ignore_errors=True)

    def do_POST(self):
        if self.path not in ("/", ""):
            self._json(404, {"status": "error",
                             "error": {"code": "error.api.not_found"}})
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
            data = json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            self._json(400, {"status": "error",
                             "error": {"code": "error.api.bad_request"}})
            return
        url = (data.get("url") or "").strip()
        if not url:
            self._json(400, {"status": "error",
                             "error": {"code": "error.api.bad_link"}})
            return
        if not YT_RE.match(url):
            self._json(200, {"status": "error",
                             "error": {"code": "error.api.not_youtube"}})
            return
        # Ask yt-dlp for the title only — no download yet (same idea as
        # Tungsten: the real download happens on GET of the tunnel link).
        try:
            r = yt_dlp(["--no-playlist", "--no-warnings",
                        "--get-title", "--get-filename",
                        "-f", FORMAT, "-o", "%(title)s.%(ext)s", url],
                       timeout=120)
        except subprocess.TimeoutExpired:
            self._json(502, {"status": "error", "error": {
                "code": "error.api.fetch.fail",
                "context": {"service": "youtube"}}})
            return
        if r.returncode != 0:
            err = (r.stderr or "").strip().splitlines()
            msg = err[-1][:200] if err else "fetch failed"
            self._json(200, {"status": "error", "error": {
                "code": "error.api.fetch.fail",
                "context": {"service": "youtube", "detail": msg}}})
            return
        title = (r.stdout or "").strip().splitlines()
        filename = safe_filename(title[0] if title else "video")
        token = b64url_encode(url)
        self._json(200, {
            "status": "tunnel",
            "url": f"{API_URL}/v/{token}",
            "filename": filename,
        })


if __name__ == "__main__":
    print(f"leonida-yt {VERSION} listening on :{PORT} (API_URL={API_URL})",
          flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
