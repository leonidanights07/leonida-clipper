// Leonida Clipper — cuts video clips right in the browser. No server,
// no upload, no install, no command line. The video file you choose never
// leaves your device.
//
// How it works:
//  1. You upload a video file.
//  2. The Web Audio API reads the audio and measures loudness (RMS) every
//     0.5 seconds, the same way the original tool did.
//  3. Every possible clip window is scored by its average loudness and the
//     best N non-overlapping windows are picked.
//  4. ffmpeg.wasm (core loaded from a CDN, worker script vendored in
//     vendor/ffmpeg/ so the browser can construct it — see the
//     FFMPEG_WORKER_URL comment) cuts those windows to the size you
//     picked, with a true 9:16 centre crop for vertical clips (no blurred
//     background, no black bars — the frame is filled edge to edge),
//     H.264 + AAC, no watermark.
//  5. Every clip gets a playable preview and a download button.
//
// A pasted YouTube link is fetched through OUR OWN Cobalt backend only
// (a free Cobalt instance on Render — see render.yaml and backend/DEPLOY.md).
// The server fetches the video and tunnels the file back to the browser.
// Piped and Invidious used to be tried too, but they do not work for the
// videos this tool clips — Piped answers HTTP 500 for streamer videos,
// and Invidious finds the video but the browser cannot download the
// actual media file from it — so they were removed entirely (2026-11-20).
// If our server is asleep, down, or blocked by YouTube, the page says so
// plainly and points at uploading the video file, which always works.

// ---------------------------------------------------------------------------
// Pure helpers — exported so they can be unit-tested without a browser.
// ---------------------------------------------------------------------------

export function formatTime(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function isYouTubeUrl(text) {
  if (!text) return false;
  const u = text.trim().toLowerCase();
  return (
    u.includes("youtube.com/watch") ||
    u.includes("youtube.com/shorts") ||
    u.includes("youtube.com/live") ||
    u.includes("youtu.be/") ||
    u.includes("music.youtube.com")
  );
}

/**
 * Pick the best non-overlapping clip windows from per-0.5s loudness values.
 * rms: array of RMS loudness values, one per hopSeconds.
 * Returns [{start, end, score}] sorted by start time.
 */
export function computeBestWindows(rms, hopSeconds, clipLength, count) {
  if (!rms || rms.length === 0 || clipLength <= 0 || count <= 0) return [];
  const windowBins = Math.max(1, Math.round(clipLength / hopSeconds));
  const totalBins = rms.length;
  if (totalBins < windowBins) {
    // Video is shorter than one clip: take the whole thing once.
    const score = rms.reduce((a, b) => a + b, 0) / totalBins;
    return [{ start: 0, end: totalBins * hopSeconds, score }];
  }
  // Score every window, stepping 5s (or a quarter of the clip length).
  const stepBins = Math.max(1, Math.round(Math.min(5, clipLength / 4) / hopSeconds));
  const scored = [];
  for (let startBin = 0; startBin + windowBins <= totalBins; startBin += stepBins) {
    let sum = 0;
    let peak = 0;
    for (let i = startBin; i < startBin + windowBins; i++) {
      sum += rms[i];
      if (rms[i] > peak) peak = rms[i];
    }
    const mean = sum / windowBins;
    scored.push({ start: startBin * hopSeconds, end: (startBin + windowBins) * hopSeconds, score: mean + 0.25 * peak });
  }
  // Greedy: best score first, reject anything overlapping a picked window.
  scored.sort((a, b) => b.score - a.score);
  const picked = [];
  for (const w of scored) {
    if (picked.length >= count) break;
    const overlaps = picked.some((p) => w.start < p.end && w.end > p.start);
    if (!overlaps) picked.push(w);
  }
  picked.sort((a, b) => a.start - b.start);
  return picked;
}

/** Evenly spaced fallback windows (used when a video has no usable audio). */
export function evenWindows(duration, clipLength, count) {
  const windows = [];
  if (duration <= 0 || clipLength <= 0 || count <= 0) return windows;
  if (duration <= clipLength) return [{ start: 0, end: duration, score: 0 }];
  const step = (duration - clipLength) / count;
  for (let i = 0; i < count; i++) {
    const start = Math.round(i * step * 10) / 10;
    windows.push({ start, end: start + clipLength, score: 0 });
  }
  return windows;
}

/**
 * ffmpeg filter for a TRUE centre crop to the target frame — no blurred
 * background, no black bars. The crop takes the middle window of the
 * source at the target aspect ratio, then scales it to the target size,
 * so the clip fills the whole frame edge to edge.
 *
 * For the default vertical size (1080x1920) from a 16:9 source this is
 * the centre 9:16 window: crop=ih*9/16 wide x ih tall, scaled to
 * 1080x1920 — exactly what Uzair asked for (2026-11-20).
 *
 * The crop size is the smaller of the source size and the size the
 * target aspect ratio allows, truncated to an even number (yuv420p /
 * libx264 need even dimensions). If the source already matches the
 * target aspect (e.g. an already-vertical video cut to 1080x1920),
 * the crop is the whole frame — nothing is cut off, it just scales.
 * Crop x/y default to the centre, so the window is always centred.
 */
export function buildVideoFilter(width, height) {
  return (
    `crop='trunc(min(iw,ih*${width}/${height})/2)*2':` +
    `'trunc(min(ih,iw*${height}/${width})/2)*2',` +
    `scale=${width}:${height},setsar=1,format=yuv420p[v]`
  );
}

export const DIMENSIONS = {
  "1080x1920": { w: 1080, h: 1920, label: "Vertical 1080×1920" },
  "1080x1080": { w: 1080, h: 1080, label: "Square 1080×1080" },
  "1920x1080": { w: 1920, h: 1080, label: "Landscape 1920×1080" },
};

// CDN locations (verified live). Single-threaded @ffmpeg/core — it works on
// GitHub Pages, which does not send the special headers the multi-threaded
// core needs.
const FFMPEG_ESM = "https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.15/dist/esm/index.js";
const FFMPEG_UTIL_ESM = "https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.2/dist/esm/index.js";
const FFMPEG_CORE_BASE = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm";

// The ffmpeg worker script, served from OUR OWN origin. This is the fix
// for the "Failed to construct 'Worker'" error (2026-11-20): the FFmpeg
// class creates its worker with new Worker(new URL("./worker.js",
// import.meta.url)) — a script on the CDN's origin — and browsers refuse
// to construct a Worker from a cross-origin script, so cutting failed on
// GitHub Pages before it even started. Passing classWorkerURL (an absolute
// URL to vendor/ffmpeg/worker.js on this site) makes the worker same-origin,
// which browsers allow. The worker's own relative imports (./const.js,
// ./errors.js) resolve in that same folder — see vendor/ffmpeg/README.md.
// A blob URL would NOT work here: a blob URL has no directory, so the
// worker's `import "./const.js"` would fail. The core files
// (ffmpeg-core.js / .wasm) are still fetched from the CDN via toBlobURL()
// below — fetching them in the main thread works cross-origin, only the
// worker script itself has the same-origin restriction.
// Resolved against this module's own URL so it works wherever the site is
// hosted (GitHub Pages serves it under /leonida-clipper/, not the root).
export const FFMPEG_WORKER_URL = new URL("vendor/ffmpeg/worker.js", import.meta.url).toString();

// Our own video-fetch backend on Render (free tier). This is the URL the
// service gets when it is deployed from render.yaml with the service name
// `leonida-clipper-yt`. It does NOT exist until someone deploys it —
// see backend-yt/DEPLOY-YT.md. Until then every call to it fails fast
// (DNS / connection refused) and the page reports that the backend is not
// deployed yet, and points at uploading the file instead.
// NOTE (2026-11-20): this used to point at our Cobalt backend
// (leonida-clipper-cobalt), but Cobalt answers "error.api.fetch.fail"
// for every YouTube link — its YouTube pipeline is bot-blocked on
// Render's datacenter IP. This service speaks the SAME Cobalt API
// contract but fetches with yt-dlp (backend-yt/server.py), which
// handles YouTube's defenses far better. The Cobalt URL still works
// as a fallback: paste it in the "server address" box on the page.
// The page also has a "Your Cobalt backend URL" box: if the deployed URL
// is different (e.g. the service was renamed), paste it there and it is
// saved in the browser. Never put an API key here — the page is public,
// so anything in it is visible to everyone.
export const COBALT_BACKEND_URL = "https://leonida-clipper-yt-production.up.railway.app/";

/** Pick the Cobalt backend URL: the "Your server address" box wins, then a
 * URL saved in the browser, then the default above. Pure — unit-testable.
 * (This is the function fetchPlan() calls. An earlier version called a
 * cobaltBaseUrl() that was never defined, so pasting any link failed
 * instantly with "cobaltBaseUrl is not defined" and the server was never
 * contacted — fixed 2026-11-20.) */
export function resolveCobaltBaseUrl(custom, saved) {
  const c = (custom || "").trim();
  if (c) return c.replace(/\/+$/, "");
  const s = (saved || "").trim();
  if (s.startsWith("http")) return s.replace(/\/+$/, "");
  return COBALT_BACKEND_URL;
}

// How long to wait for the Render free service to wake up. It sleeps
// after 15 minutes idle; waking takes about 30–60 seconds. The page
// retries the wake-up call, so a first fetch of the day can take up to
// ~2 minutes before it gives up and says the backend could not
// be reached.
export const COBALT_WAKE_TIMEOUT_MS = 120000;
export const COBALT_API_TIMEOUT_MS = 120000;

/** The POST / body sent to a Cobalt instance for a YouTube URL.
 * alwaysProxy:true is the whole point of our own backend: it forces
 * Cobalt to tunnel the file through our server instead of answering
 * with a redirect to a direct googlevideo link, which the browser
 * cannot fetch (no CORS headers). 720p + h264/mp4 is what the
 * in-browser cutter handles best. Pure — unit-testable. */
export function cobaltRequestBody(url) {
  return {
    url,
    videoQuality: "720",
    downloadMode: "auto",
    youtubeVideoCodec: "h264",
    youtubeVideoContainer: "mp4",
    alwaysProxy: true,
    filenameStyle: "basic",
  };
}

/** Turn a Cobalt POST / response into something the downloader can use.
 * Returns { kind, urls, filename, error }:
 *  - tunnel / redirect: kind "file", urls [the one file URL].
 *  - local-processing: kind "split" when tunnel[] has 2 entries (video +
 *    audio to mux locally), kind "file" when it has 1.
 *  - picker / error / anything else: kind "error" with a readable message.
 * Relative URLs are resolved against the backend base. Pure — testable. */
export function parseCobaltResponse(data, base) {
  if (!data || typeof data !== "object") {
    return { kind: "error", urls: [], filename: null, error: "empty answer from the server" };
  }
  const resolve = (u) => {
    if (!u) return null;
    try {
      return new URL(u, base).toString();
    } catch (e) {
      return u;
    }
  };
  if (data.status === "tunnel" || data.status === "redirect") {
    if (!data.url) return { kind: "error", urls: [], filename: null, error: "server answered but gave no file link" };
    return { kind: "file", urls: [resolve(data.url)], filename: data.filename || null, error: null };
  }
  if (data.status === "local-processing") {
    const tunnels = (data.tunnel || []).map(resolve).filter(Boolean);
    if (!tunnels.length) {
      return { kind: "error", urls: [], filename: null, error: "server answered but gave no file link" };
    }
    const filename = (data.output && data.output.filename) || null;
    return { kind: tunnels.length > 1 ? "split" : "file", urls: tunnels, filename, error: null };
  }
  if (data.status === "picker") {
    return { kind: "error", urls: [], filename: null, error: "that link has several videos in it — open one video, not a list" };
  }
  if (data.status === "error" && data.error) {
    const code = data.error.code || "unknown error";
    return { kind: "error", urls: [], filename: null, error: `server said: ${code}` };
  }
  return { kind: "error", urls: [], filename: null, error: `unexpected answer from the server (status: ${data.status || "?"})` };
}

/** Pull the 11-character video ID out of any YouTube URL shape. */
export function extractVideoId(text) {
  if (!text) return null;
  const u = text.trim();
  const patterns = [
    /[?&]v=([A-Za-z0-9_-]{11})/,
    /youtu\.be\/([A-Za-z0-9_-]{11})/,
    /youtube\.com\/shorts\/([A-Za-z0-9_-]{11})/,
    /youtube\.com\/live\/([A-Za-z0-9_-]{11})/,
    /youtube\.com\/embed\/([A-Za-z0-9_-]{11})/,
    /youtube\.com\/v\/([A-Za-z0-9_-]{11})/,
  ];
  for (const p of patterns) {
    const m = u.match(p);
    if (m) return m[1];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Browser UI — only runs when there is a document (so the helpers above
// can be imported and tested in Node without a browser).
// ---------------------------------------------------------------------------

if (typeof document !== "undefined") {
  const $ = (id) => document.getElementById(id);

  const dropZone = $("dropZone");
  const fileInput = $("fileInput");
  const fileInfo = $("fileInfo");
  const ytUrl = $("ytUrl");
  const ytNotice = $("ytNotice");
  const ytExplainer = $("ytExplainer");
  const generateBtn = $("generateBtn");
  const statusEl = $("status");
  const logEl = $("log");
  const progressWrap = $("progressWrap");
  const progressBar = $("progressBar");
  const resultsCard = $("resultsCard");
  const resultsEl = $("results");
  const resultsSummary = $("resultsSummary");
  const downloadAllBtn = $("downloadAllBtn");

  let selectedFile = null;
  let selectedAudioFile = null; // separate audio track, when the server gives video-only video
  let selectedDuration = 0;
  let fetchedTitle = "";
  let fetchedVideoId = null; // YouTube ID of the video loaded via link fetch (null for an uploaded file)
  let clips = []; // {start, end, score, filename, url, size}
  let ffmpeg = null;
  let ffmpegUtil = null;
  let running = false;

  function setStatus(html) {
    statusEl.innerHTML = html;
  }
  function log(msg) {
    logEl.classList.add("show");
    logEl.textContent += `${msg}\n`;
    logEl.scrollTop = logEl.scrollHeight;
  }
  function setProgress(frac) {
    progressWrap.classList.add("show");
    progressBar.style.width = `${Math.max(0, Math.min(100, frac * 100)).toFixed(1)}%`;
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function clearClips() {
    for (const c of clips) {
      if (c.url) URL.revokeObjectURL(c.url);
    }
    clips = [];
    resultsEl.innerHTML = "";
    resultsCard.style.display = "none";
  }

  function pickFile(file) {
    if (!file) return;
    if (!file.type.startsWith("video/") && !/\.(mp4|webm|mov|mkv|avi|m4v)$/i.test(file.name)) {
      setStatus("That doesn't look like a video file. Please choose a video (MP4, WebM, MOV…).");
      return;
    }
    selectedFile = file;
    selectedAudioFile = null;
    fetchedTitle = "";
    fetchedVideoId = null;
    selectedDuration = 0;
    ytExplainer.classList.remove("show");
    clearClips();
    fileInfo.textContent = `✓ ${file.name} · ${formatSize(file.size)} — reading length…`;
    setStatus(`<b>${escapeHtml(file.name)}</b> loaded. Pick your clips below and press Generate Clips.`);
    // Read the length from the file itself.
    const probe = document.createElement("video");
    probe.preload = "metadata";
    probe.muted = true;
    probe.src = URL.createObjectURL(file);
    probe.onloadedmetadata = () => {
      selectedDuration = probe.duration || 0;
      URL.revokeObjectURL(probe.src);
      fileInfo.textContent = `✓ ${file.name} · ${formatSize(file.size)} · ${formatTime(selectedDuration)} long`;
      if (selectedFile && selectedFile.size > 1024 * 1024 * 1024) {
        setStatus("That file is over 1 GB — it may be slow or run out of browser memory. A shorter video works best.");
      }
    };
    probe.onerror = () => {
      URL.revokeObjectURL(probe.src);
      setStatus("I couldn't read that video file. Try a different file (MP4 works best).");
    };
  }

  dropZone.addEventListener("click", () => fileInput.click());
  dropZone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); }
  });
  fileInput.addEventListener("change", () => pickFile(fileInput.files && fileInput.files[0]));
  ["dragenter", "dragover"].forEach((ev) =>
    dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((ev) =>
    dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.remove("drag"); }));
  dropZone.addEventListener("drop", (e) => {
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) pickFile(f);
  });

  ytUrl.addEventListener("input", () => {
    ytNotice.classList.toggle("show", isYouTubeUrl(ytUrl.value));
  });

  // Restore a saved custom Cobalt backend URL (if the deployed URL is
  // different from the default — e.g. the Render service was renamed).
  try {
    const savedCobalt = localStorage.getItem("leonida-cobalt-url");
    if (savedCobalt && savedCobalt.startsWith("http") && savedCobalt.replace(/\/$/, "") !== COBALT_BACKEND_URL) {
      $("customCobalt").value = savedCobalt;
    }
  } catch (e) { /* private mode */ }

  // The Cobalt backend URL actually used for a link fetch: the "Your server
  // address" box if filled in (saved in the browser as it is typed), else a
  // previously saved URL, else the default COBALT_BACKEND_URL.
  function cobaltBaseUrl() {
    let saved = null;
    try { saved = localStorage.getItem("leonida-cobalt-url"); } catch (e) { /* private mode */ }
    const custom = $("customCobalt") ? $("customCobalt").value : "";
    return resolveCobaltBaseUrl(custom, saved);
  }
  if ($("customCobalt")) {
    $("customCobalt").addEventListener("input", () => {
      try {
        const v = $("customCobalt").value.trim();
        if (v.startsWith("http")) localStorage.setItem("leonida-cobalt-url", v);
        else localStorage.removeItem("leonida-cobalt-url");
      } catch (e) { /* private mode */ }
    });
  }

  async function loadCutter() {
    if (ffmpeg) return ffmpeg;
    setStatus("Loading the video cutter for the first time (about 30 MB) — this can take a minute on a slow connection…");
    setProgress(0.05);
    const ffmpegMod = await import(FFMPEG_ESM);
    ffmpegUtil = await import(FFMPEG_UTIL_ESM);
    ffmpeg = new ffmpegMod.FFmpeg();
    ffmpeg.on("log", ({ message }) => log(message));
    await ffmpeg.load({
      // classWorkerURL is the same-origin vendored worker (see the
      // FFMPEG_WORKER_URL comment above). Without it, load() builds the
      // worker from the CDN URL and the browser refuses to construct it.
      classWorkerURL: FFMPEG_WORKER_URL,
      coreURL: await ffmpegUtil.toBlobURL(`${FFMPEG_CORE_BASE}/ffmpeg-core.js`, "text/javascript"),
      wasmURL: await ffmpegUtil.toBlobURL(`${FFMPEG_CORE_BASE}/ffmpeg-core.wasm`, "application/wasm"),
    });
    return ffmpeg;
  }

  // Download a URL in the browser with progress, as a Blob.
  async function downloadWithProgress(url, label, onBytes) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download failed (HTTP ${res.status})`);
    const total = parseInt(res.headers.get("content-length") || "0", 10) || 0;
    if (!res.body) return new Blob([await res.arrayBuffer()]);
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      if (onBytes) onBytes(got, total);
    }
    return new Blob(chunks, { type: res.headers.get("content-type") || undefined });
  }

  // The link-fetch path: our own Cobalt backend only. There used to be
  // a "Fetch the link with" selector for Piped / Invidious, but both were
  // removed (2026-11-20) because they do not work for the videos this
  // tool clips. The Cobalt URL comes from the "Your Cobalt backend URL"
  // box if filled in (saved in the browser), otherwise the default
  // COBALT_BACKEND_URL.
  function fetchPlan() {
    return { cobalt: cobaltBaseUrl() };
  }

  /**
   * Fetch a YouTube video through our own Cobalt backend on Render.
   *  1. Wake the free service: GET / — it sleeps after 15 min idle and
   *     takes ~30–60 s to wake. Retried once on 502/503/timeout.
   *  2. POST / with the Cobalt body (alwaysProxy so we get a tunnel, not
   *     a direct link the browser cannot fetch).
   *  3. Download the tunnel URL immediately — tunnel links live 5 min
   *     (TUNNEL_LIFESPAN=300 on our instance).
   * Returns { file, audioFile|null, instance, quality, title }.
   * Throws an Error describing what happened, when it fails — the caller
   * Throws an Error describing what happened. Never pretends it worked.
   */
  async function fetchViaCobalt(videoUrl, base) {
    const host = base.replace("https://", "");
    // 1. Wake-up: GET / returns instance info JSON when it is up.
    setStatus(`Waking up our server (${host}) — the free service sleeps after 15 minutes, so the first try can take about a minute…`);
    let awake = false;
    let wakeErr = null;
    for (let attempt = 0; attempt < 2 && !awake; attempt++) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), COBALT_WAKE_TIMEOUT_MS);
        let res;
        try {
          res = await fetch(`${base}/`, { signal: ctrl.signal });
        } finally {
          clearTimeout(timer);
        }
        if (res.ok) {
          awake = true;
        } else if (res.status === 502 || res.status === 503) {
          wakeErr = new Error(`server is waking up (HTTP ${res.status})`);
          await new Promise((r) => setTimeout(r, 5000));
        } else {
          throw new Error(`server answered HTTP ${res.status}`);
        }
      } catch (err) {
        wakeErr = err;
        if (attempt === 0) {
          log(`Cobalt wake-up try ${attempt + 1} failed (${err.name === "AbortError" ? "timed out" : err.message}) — trying once more.`);
          await new Promise((r) => setTimeout(r, 5000));
        }
      }
    }
    if (!awake) {
      throw new Error(wakeErr ? `our server didn't answer (${wakeErr.name === "AbortError" ? "timed out after 2 minutes — it may not be deployed yet, see backend/DEPLOY.md" : wakeErr.message})` : "our server didn't answer");
    }
    // 2. Ask Cobalt for the video.
    setStatus(`Our server is awake — asking it for the video…`);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), COBALT_API_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(`${base}/`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(cobaltRequestBody(videoUrl)),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const errBody = await res.json();
        if (errBody && errBody.error && errBody.error.code) detail = errBody.error.code;
      } catch (e) { /* keep the HTTP status */ }
      throw new Error(`our server answered ${detail}`);
    }
    const data = await res.json();
    const parsed = parseCobaltResponse(data, base);
    if (parsed.kind === "error") throw new Error(parsed.error);
    const title = (parsed.filename || "video").replace(/\.[^.]+$/, "").replace(/[^\w\- ]+/g, "").trim().slice(0, 50) || "video";
    // 3. Download the tunnel file(s) right now — the links expire in minutes.
    setStatus(`Our server found it — downloading the video through our server…`);
    log(`Cobalt (${host}): ${parsed.kind === "split" ? "video + separate audio" : "video with audio"} · 720p · tunnel`);
    const videoBlob = await downloadWithProgress(parsed.urls[0], "video", (got, total) => {
      setStatus(`Downloading the video from our server — ${formatSize(got)}${total ? ` of ${formatSize(total)}` : ""}…`);
      if (total) setProgress(0.05 + 0.1 * (got / total));
    });
    let audioBlob = null;
    if (parsed.kind === "split" && parsed.urls[1]) {
      setStatus(`Downloading the audio track from our server…`);
      try {
        audioBlob = await downloadWithProgress(parsed.urls[1], "audio", null);
      } catch (e) {
        log(`Audio track download failed (${e.message}) — cutting the video without sound.`);
        audioBlob = null;
      }
    }
    return {
      file: new File([videoBlob], `${title}.mp4`, { type: "video/mp4" }),
      audioFile: audioBlob ? new File([audioBlob], `${title}-audio.m4a`, { type: "audio/mp4" }) : null,
      instance: `our server (${host})`,
      quality: "720p",
      title,
    };
  }

  /**
   * Fetch a pasted YouTube link through our own Cobalt backend only.
   * Throws the backend's error, so the page can show it honestly and
   * point at uploading the file instead. There is no fallback service.
   */
  async function fetchViaLink(videoId, videoUrl) {
    const plan = fetchPlan();
    const got = await fetchViaCobalt(videoUrl, plan.cobalt);
    return { ...got, source: "our server" };
  }

  async function analyseAudio(file) {
    // Decode the audio in the browser and measure loudness every 0.5s.
    const buf = await file.arrayBuffer();
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    try {
      const audio = await ctx.decodeAudioData(buf);
      const channel = audio.getChannelData(0);
      const sr = audio.sampleRate;
      const hop = Math.floor(sr * 0.5);
      const rms = [];
      for (let i = 0; i + hop <= channel.length; i += hop) {
        let sum = 0;
        for (let j = i; j < i + hop; j++) sum += channel[j] * channel[j];
        rms.push(Math.sqrt(sum / hop));
      }
      return { rms, hopSeconds: 0.5, duration: audio.duration, hasAudio: rms.some((v) => v > 0.0001) };
    } finally {
      try { await ctx.close(); } catch (e) { /* already closed */ }
    }
  }

  async function generate() {
    if (running) return;
    const link = ytUrl.value.trim();

    running = true;
    generateBtn.disabled = true;
    generateBtn.textContent = "Working…";
    const stopRunning = () => {
      running = false;
      generateBtn.disabled = false;
      generateBtn.textContent = "Generate Clips";
    };

    // A NEW link pasted while a fetched video is already loaded: the old
    // video must NOT be re-cut if the new fetch fails (bug found
    // 2026-11-20: the tool silently re-analysed and re-cut the previous
    // video — same clip, same size — with no sign the new link was
    // ignored, so a user could download the wrong video's clip). Clear
    // the stale video and its results FIRST, then fetch the new link;
    // on failure the catch below returns with nothing loaded, so
    // nothing gets cut. (A manually uploaded file is untouched: pasting
    // a link alongside an upload still uses the uploaded file, as before.)
    const pastedVideoId = isYouTubeUrl(link) ? extractVideoId(link) : null;
    const isNewLink = !!(pastedVideoId && fetchedVideoId && pastedVideoId !== fetchedVideoId);
    if (isNewLink) {
      selectedFile = null;
      selectedAudioFile = null;
      fetchedVideoId = null;
      fetchedTitle = "";
      selectedDuration = 0;
      clearClips();
      fileInfo.textContent = "";
    }

    // No file uploaded — try to fetch the pasted YouTube link, first
    // through our own Cobalt backend only. If it cannot get it, say
    // none of them can get it, say so plainly and point at uploading
    // the file.
    if (!selectedFile) {
      if (isYouTubeUrl(link)) {
        const videoId = extractVideoId(link);
        if (!videoId) {
          setStatus("I couldn't read a video ID from that link. Check the link and try again — or upload the video file instead.");
          stopRunning();
          return;
        }
        setProgress(0.02);
        try {
          const fetched = await fetchViaLink(videoId, link);
          selectedFile = fetched.file;
          selectedAudioFile = fetched.audioFile;
          fetchedTitle = fetched.title;
          fetchedVideoId = videoId;
          selectedDuration = 0;
          clearClips();
          fileInfo.textContent = `✓ ${fetched.title} · ${formatSize(fetched.file.size)} · fetched via ${fetched.source} (${fetched.instance}, ${fetched.quality})`;
          log(`Fetched "${fetched.title}" via ${fetched.source} (${fetched.instance}, ${fetched.quality}).`);
          // Read the length from the fetched file.
          await new Promise((resolve) => {
            const probe = document.createElement("video");
            probe.preload = "metadata";
            probe.muted = true;
            probe.src = URL.createObjectURL(selectedFile);
            probe.onloadedmetadata = () => {
              selectedDuration = probe.duration || 0;
              URL.revokeObjectURL(probe.src);
              fileInfo.textContent = `✓ ${fetched.title} · ${formatSize(fetched.file.size)} · ${formatTime(selectedDuration)} long · via ${fetched.source} (${fetched.instance}, ${fetched.quality})`;
              resolve();
            };
            probe.onerror = () => { URL.revokeObjectURL(probe.src); resolve(); };
          });
        } catch (err) {
          ytExplainer.classList.add("show");
          $("fetchError").innerHTML =
            `<strong>What happened:</strong> ${escapeHtml(err.message)}<br>` +
            `You can change the server address in Step 1 and try again, or upload the video file instead — that always works.`;
          ytExplainer.scrollIntoView({ behavior: "smooth", block: "start" });
          setStatus("That link couldn't be fetched right now — see the steps above. Try again, check the server address in Step 1, or upload the video file instead.");
          log(`Link fetch failed: ${err.message}`);
          stopRunning();
          return;
        }
      } else if (link) {
        setStatus("That link doesn't look like a YouTube video. Upload the video file instead — drop it on the box in Step 1.");
        stopRunning();
        return;
      } else {
        setStatus("Upload a video file first — drop it on the box in Step 1, or tap the box to choose one. Or paste a YouTube link and I'll try to fetch it.");
        stopRunning();
        return;
      }
    }
    if (link && isYouTubeUrl(link) && pastedVideoId !== fetchedVideoId) {
      log("A YouTube link was pasted too — using the uploaded file, which is already here.");
    }

    const count = parseInt($("clipCount").value, 10) || 3;
    let clipLength = parseInt($("clipLength").value, 10) || 60;
    const dimKey = $("dimension").value;
    const dim = DIMENSIONS[dimKey] || DIMENSIONS["1080x1920"];

    ytExplainer.classList.remove("show");
    clearClips();
    logEl.textContent = "";
    setProgress(0);

    try {
      // 1. Find the best moments from the audio.
      setStatus("Listening to the video to find the loudest moments…");
      setProgress(0.1);
      let windows;
      let hasAudio = true;
      let duration = selectedDuration;
      try {
        // If the server gave video-only video plus a separate audio track,
        // analyse the audio track (the video file itself has no sound).
        const analysis = await analyseAudio(selectedAudioFile || selectedFile);
        duration = analysis.duration || duration;
        hasAudio = analysis.hasAudio;
        if (selectedAudioFile && !hasAudio) hasAudio = true; // audio track exists, even if quiet
        duration = analysis.duration || duration;
        hasAudio = analysis.hasAudio;
        if (hasAudio) {
          windows = computeBestWindows(analysis.rms, analysis.hopSeconds, clipLength, count);
        } else {
          log("No usable audio found — spacing the clips evenly instead.");
          windows = evenWindows(duration, clipLength, count);
        }
      } catch (err) {
        log(`Audio analysis failed (${err.message}) — spacing the clips evenly instead.`);
        windows = evenWindows(duration || 300, clipLength, count);
        hasAudio = false;
      }
      if (!windows.length) {
        setStatus("I couldn't find any moments in that video. Try a longer video.");
        return;
      }
      // If the video is shorter than the chosen clip length, use its full length.
      if (duration > 0 && duration < clipLength) clipLength = Math.max(5, Math.floor(duration));

      setStatus(`Found ${windows.length} moment${windows.length === 1 ? "" : "s"} — now cutting them to ${dim.label}…`);
      log(windows.map((w, i) => `Clip ${i + 1}: ${formatTime(w.start)}–${formatTime(w.end)} (energy ${w.score.toFixed(3)})`).join("\n"));

      // 2. Cut each window with ffmpeg.wasm, in the browser.
      const ff = await loadCutter();
      let currentClip = 0;
      let currentLen = 60;
      ff.on("progress", ({ time }) => {
        setProgress((currentClip + Math.min(1, (time || 0) / 1000000 / currentLen)) / windows.length);
      });
      const ext = (selectedFile.name.split(".").pop() || "mp4").toLowerCase();
      const inputName = `input.${ext}`;
      await ff.writeFile(inputName, await ffmpegUtil.fetchFile(selectedFile));
      const hasSeparateAudio = !!selectedAudioFile;
      if (hasSeparateAudio) {
        await ff.writeFile("audio.m4a", await ffmpegUtil.fetchFile(selectedAudioFile));
      }
      const filter = buildVideoFilter(dim.w, dim.h);
      const baseName = selectedFile.name.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9-_]+/g, "-").slice(0, 40) || "clip";

      for (let i = 0; i < windows.length; i++) {
        const w = windows[i];
        const len = Math.min(clipLength, Math.max(1, w.end - w.start));
        const outName = `clip-${String(i + 1).padStart(2, "0")}.mp4`;
        setStatus(`Cutting clip ${i + 1} of ${windows.length} — ${formatTime(w.start)} to ${formatTime(w.end)}…`);
        currentClip = i;
        currentLen = len;
        const args = [
          "-ss", String(w.start),
          "-i", inputName,
        ];
        if (hasSeparateAudio) args.push("-ss", String(w.start), "-i", "audio.m4a");
        args.push(
          "-t", String(len),
          "-filter_complex", filter,
          "-map", "[v]",
        );
        if (hasAudio) args.push("-map", hasSeparateAudio ? "1:a" : "0:a");
        args.push(
          "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
        );
        if (hasAudio) args.push("-c:a", "aac", "-b:a", "128k");
        else args.push("-an");
        args.push("-movflags", "+faststart", "-y", outName);
        await ff.exec(args);
        const data = await ff.readFile(outName);
        const blob = new Blob([data], { type: "video/mp4" });
        clips.push({
          start: w.start,
          end: w.start + len,
          score: w.score,
          filename: `${baseName}-${dim.w}x${dim.h}-${String(i + 1).padStart(2, "0")}.mp4`,
          url: URL.createObjectURL(blob),
          size: blob.size,
        });
        await ff.deleteFile(outName);
        setProgress((i + 1) / windows.length);
      }
      try { await ff.deleteFile(inputName); } catch (e) { /* ignore */ }
      if (hasSeparateAudio) { try { await ff.deleteFile("audio.m4a"); } catch (e) { /* ignore */ } }

      // 3. Show a playable preview of every clip, with a download button each.
      renderResults(dim);
      setStatus(`<b>Done — ${clips.length} clip${clips.length === 1 ? "" : "s"} ready.</b> Watch them below and download the ones you like.`);
      setProgress(1);
    } catch (err) {
      console.error(err);
      setStatus(`Something went wrong while cutting: ${escapeHtml(err.message || String(err))}. Try a shorter video, or reload the page and try again.`);
      log(`Error: ${err.message || err}`);
    } finally {
      running = false;
      generateBtn.disabled = false;
      generateBtn.textContent = "Generate Clips";
    }
  }

  function renderResults(dim) {
    resultsEl.innerHTML = "";
    resultsSummary.textContent =
      `${clips.length} clip${clips.length === 1 ? "" : "s"} · ${dim.label} · H.264 + AAC · no watermark`;
    clips.forEach((c, i) => {
      const card = document.createElement("div");
      card.className = "clip";
      const video = document.createElement("video");
      video.controls = true;
      video.preload = "metadata";
      video.playsInline = true;
      video.src = c.url;
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.innerHTML =
        `<div class="t">Clip ${i + 1} · ${formatTime(c.start)}–${formatTime(c.end)}</div>` +
        `<div class="s"><span class="energy">★ Energy ${c.score.toFixed(2)}</span> · ${formatSize(c.size)} · ${dim.label}</div>`;
      const dl = document.createElement("a");
      dl.className = "dl";
      dl.href = c.url;
      dl.download = c.filename;
      dl.textContent = "Download Clip";
      card.appendChild(video);
      card.appendChild(meta);
      card.appendChild(dl);
      resultsEl.appendChild(card);
    });
    resultsCard.style.display = "";
    resultsCard.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  generateBtn.addEventListener("click", generate);

  $("retryBtn").addEventListener("click", () => {
    ytExplainer.classList.remove("show");
    generate();
  });

  downloadAllBtn.addEventListener("click", async () => {
    if (!clips.length) return;
    downloadAllBtn.disabled = true;
    downloadAllBtn.textContent = "Downloading…";
    for (const c of clips) {
      const a = document.createElement("a");
      a.href = c.url;
      a.download = c.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Give the browser a moment between downloads so none are blocked.
      await new Promise((r) => setTimeout(r, 700));
    }
    downloadAllBtn.disabled = false;
    downloadAllBtn.textContent = "Download All Clips";
    setStatus("All clips sent to your downloads. If your browser blocked some of them, allow multiple downloads for this page and try again — or use each clip's own Download button.");
  });
}
