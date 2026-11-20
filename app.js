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
//  4. ffmpeg.wasm (loaded from a CDN) cuts those windows to the size you
//     picked, with a blurred background, H.264 + AAC, no watermark.
//  5. Every clip gets a playable preview and a download button.
//
// A pasted YouTube link is fetched through Piped first, then Invidious
// (both free public services, no key, no server of our own). Neither is
// guaranteed: their servers can be down, slow, or blocked by YouTube for
// some videos, so the page tries each one in turn and says plainly when
// all of them failed — it never fakes a fetch. Uploading the video file
// directly always works instead.

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
 * ffmpeg filter that fills the target frame with a blurred copy of the
 * video and centres the full video on top of it (the Leonida Nights look).
 */
export function buildVideoFilter(width, height) {
  return (
    `[0:v]split[a][b];` +
    `[a]scale=${width}:${height}:force_original_aspect_ratio=increase,` +
    `crop=${width}:${height},gblur=sigma=32[bg];` +
    `[b]scale=${width}:${height}:force_original_aspect_ratio=decrease[fg];` +
    `[bg][fg]overlay=(W-w)/2:(H-h)/2,format=yuv420p[v]`
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

// Piped — free public front-ends for YouTube, no key, no server of our own.
// Tried in this order when the user picks "Auto". These are free services
// run by volunteers: any of them can be down, slow, rate-limited, or blocked
// by YouTube at any time, so the code always falls through to the next one
// and says plainly when all of them failed.
export const PIPED_INSTANCES = [
  "https://api.piped.private.coffee",
  "https://pipedapi.wireway.ch",
  "https://pipedapi.kavin.rocks",
];

// Invidious — free public front-ends for YouTube, no key, no server of
// our own. Tried only after every Piped instance has failed.
// Live-tested 2026-11-20: of the instances in the official list
// (api.invidious.io/instances.json) and the usual public ones, ONLY
// yt.chocolatemoo53.com actually answered /api/v1/videos with video data
// — and it did so even for GTA 6 streamer videos (Clix, CarryMinati)
// that Piped answers with HTTP 500. It is also the only listed instance
// with api=true AND cors=true, which a browser page needs to call it.
// The others failed on the day: nadeko 403, nerdvpn 403 access_denied,
// tiekoetter 403, yewtu 403, pixora returns an HTML picker page (no API),
// privacyredirect / datura / projectsegfau / flokinet unreachable.
// If that one instance ever goes down, add a replacement that has
// api=true and cors=true in the official instances list — do NOT add an
// instance that has not been live-tested to return video data.
export const INVIDIOUS_INSTANCES = [
  "https://yt.chocolatemoo53.com",
];

/** Proxied media URL through an Invidious instance (bypasses the direct
 * googlevideo link's IP/CORS limits). Returns a 302 to a companion host;
 * if that host refuses, the caller falls back to the direct URL. */
export function invidiousProxyUrl(base, videoId, itag) {
  return `${base}/latest_version?id=${videoId}&itag=${itag}&local=true`;
}

function resolutionNumber(res) {
  const m = String(res || "").match(/(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

function isH264Mp4(f) {
  const type = String(f.type || "");
  // H.264 video in an MP4 container. Avoid AV1 (codecs av01) — the
  // in-browser cutter handles H.264 far better — and VP9/WebM.
  return (
    type.startsWith("video/mp4") &&
    (f.container === "mp4" || type.includes("avc1")) &&
    !type.includes("av01")
  );
}

/**
 * Pick the streams to download from an Invidious /api/v1/videos/{id}
 * response. Invidious returns adaptive-only streams (no muxed
 * formatStreams in practice): a video-only track plus a separate audio
 * track, muxed later by ffmpeg — the same as the Piped video-only path.
 * Prefers H.264 MP4 at 720p, then 1080p, then 480p, then 360p, with the
 * best AAC (audio/mp4, itag 140) track.
 * Returns { videoUrl, audioUrl|null, videoItag, audioItag|null, quality,
 * hasAudio } or null. videoUrl/audioUrl are the direct googlevideo URLs;
 * callers should try the proxied latest_version URL first.
 */
export function chooseInvidiousStreams(data) {
  if (!data || typeof data !== "object") return null;
  const videoId = data.videoId || null;

  // 1. A muxed format stream with audio, if the instance ever returns one.
  const muxed = (data.formatStreams || []).filter(
    (f) => f && f.url && String(f.type || "").startsWith("video/"),
  );
  if (muxed.length) {
    const sorted = [...muxed].sort(
      (a, b) => resolutionNumber(b.resolution || b.quality) - resolutionNumber(a.resolution || a.quality),
    );
    const pick = sorted.find((f) => resolutionNumber(f.resolution || f.quality) <= 720) || sorted[sorted.length - 1];
    return {
      videoUrl: pick.url,
      audioUrl: null,
      videoItag: pick.itag != null ? String(pick.itag) : null,
      audioItag: null,
      quality: pick.quality || pick.resolution || "?",
      hasAudio: true,
      videoId,
    };
  }

  // 2. Adaptive: best H.264 MP4 video + best AAC audio.
  const adaptive = (data.adaptiveFormats || []).filter((f) => f && f.url);
  const videos = adaptive.filter((f) => String(f.type || "").startsWith("video/") && isH264Mp4(f));
  const audios = adaptive.filter((f) => String(f.type || "").startsWith("audio/mp4"));
  if (!videos.length) return null;
  const byRes = (a, b) => resolutionNumber(b.resolution) - resolutionNumber(a.resolution);
  const video =
    [...videos].sort(byRes).find((f) => resolutionNumber(f.resolution) <= 720) ||
    [...videos].sort(byRes)[0];
  const audio =
    [...audios].sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0] || null;
  return {
    videoUrl: video.url,
    audioUrl: audio ? audio.url : null,
    videoItag: video.itag != null ? String(video.itag) : null,
    audioItag: audio && audio.itag != null ? String(audio.itag) : null,
    quality: video.resolution || video.quality || "?",
    hasAudio: !!audio,
    videoId,
  };
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

function qualityNumber(q) {
  const m = String(q || "").match(/(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * Pick the streams to download from a Piped /streams/{id} response.
 * Prefers a muxed (video+audio) MP4 at 720p/1080p; if the only good video
 * is video-only, pairs it with the best audio stream to mux later.
 * Returns { videoUrl, audioUrl|null, quality, hasAudio } or null.
 */
export function choosePipedStreams(data) {
  if (!data || typeof data !== "object") return null;
  const videos = (data.videoStreams || []).filter((v) => v && v.url);
  const audios = (data.audioStreams || []).filter((a) => a && a.url);
  const mp4 = (list) => list.filter((v) => (v.mimeType || "").includes("video/mp4") || v.format === "MPEG_4");
  const best = (list) =>
    [...list].sort((a, b) => qualityNumber(b.quality) - qualityNumber(a.quality))
      .find((v) => qualityNumber(v.quality) <= 1080) || list[0];

  // 1. Muxed MP4 with audio — simplest, one download.
  const muxed = mp4(videos).filter((v) => v.videoOnly === false);
  if (muxed.length) {
    const v = best(muxed);
    return { videoUrl: v.url, audioUrl: null, quality: v.quality || "?", hasAudio: true };
  }
  // 2. Best video-only MP4 + best audio stream (muxed later by ffmpeg).
  const videoOnly = mp4(videos).filter((v) => v.videoOnly !== false);
  if (videoOnly.length) {
    const v = best(videoOnly);
    const audio = [...audios]
      .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
    if (audio) {
      return { videoUrl: v.url, audioUrl: audio.url, quality: v.quality || "?", hasAudio: true };
    }
    return { videoUrl: v.url, audioUrl: null, quality: v.quality || "?", hasAudio: false };
  }
  // 3. Any other video stream with a URL (e.g. webm) — last resort.
  if (videos.length) {
    const v = best(videos);
    const audio = [...audios].sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
    return { videoUrl: v.url, audioUrl: audio ? audio.url : null, quality: v.quality || "?", hasAudio: !!audio };
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
  let selectedAudioFile = null; // separate audio track, when Piped gives video-only video
  let selectedDuration = 0;
  let pipedTitle = "";
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
    pipedTitle = "";
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

  async function loadCutter() {
    if (ffmpeg) return ffmpeg;
    setStatus("Loading the video cutter for the first time (about 30 MB) — this can take a minute on a slow connection…");
    setProgress(0.05);
    const ffmpegMod = await import(FFMPEG_ESM);
    ffmpegUtil = await import(FFMPEG_UTIL_ESM);
    ffmpeg = new ffmpegMod.FFmpeg();
    ffmpeg.on("log", ({ message }) => log(message));
    await ffmpeg.load({
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

  // Which fetch services to try, from the combined "Fetch the link with"
  // selector in Step 1. Returns { piped: [...], invidious: [...] }.
  // "auto" tries every Piped instance first, then every Invidious one.
  // A "piped:URL" / "invidious:URL" choice tries only that one server.
  function fetchPlan() {
    const picked = $("fetchServer").value || "auto";
    const custom = ($("customInvidious").value || "").trim().replace(/\/$/, "");
    const invidious = [...INVIDIOUS_INSTANCES];
    if (custom && custom.startsWith("http") && !invidious.includes(custom)) {
      invidious.push(custom);
    }
    if (picked === "auto") return { piped: [...PIPED_INSTANCES], invidious };
    if (picked.startsWith("piped:")) return { piped: [picked.slice("piped:".length)], invidious: [] };
    if (picked.startsWith("invidious:")) return { piped: [], invidious: [picked.slice("invidious:".length), ...invidious.filter((u) => u !== picked.slice("invidious:".length))] };
    return { piped: [...PIPED_INSTANCES], invidious };
  }

  /**
   * Fetch a YouTube video through Piped. Tries each instance in turn.
   * Returns { file, audioFile|null, instance, quality, title }.
   * Throws an Error listing what each instance said, when all of them fail.
   * Never pretends it worked.
   */
  async function fetchViaPiped(videoId, bases) {
    const failures = [];
    for (const base of bases) {
      const host = base.replace("https://", "");
      try {
        setStatus(`Asking ${host} for the video…`);
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 15000);
        let res;
        try {
          res = await fetch(`${base}/streams/${videoId}`, { signal: ctrl.signal });
        } finally {
          clearTimeout(timer);
        }
        if (!res.ok) {
          failures.push(`${host}: answered HTTP ${res.status}`);
          continue;
        }
        const data = await res.json();
        if (data.error || data.message) {
          const msg = String(data.message || data.error).slice(0, 160);
          failures.push(`${host}: ${msg}`);
          continue;
        }
        const choice = choosePipedStreams(data);
        if (!choice) {
          failures.push(`${host}: no downloadable video stream in the answer`);
          continue;
        }
        const title = (data.title || videoId).replace(/[^\w\- ]+/g, "").trim().slice(0, 50) || videoId;
        setStatus(`Found it on ${host} (${choice.quality}) — downloading the video…`);
        log(`Piped (${host}): ${data.title || videoId} · ${choice.quality} · ${choice.audioUrl ? "video + separate audio" : "video with audio"}`);
        const videoBlob = await downloadWithProgress(choice.videoUrl, "video", (got, total) => {
          setStatus(`Downloading the video from ${host} — ${formatSize(got)}${total ? ` of ${formatSize(total)}` : ""}…`);
          if (total) setProgress(0.05 + 0.1 * (got / total));
        });
        let audioBlob = null;
        if (choice.audioUrl) {
          setStatus(`Downloading the audio track from ${host}…`);
          try {
            audioBlob = await downloadWithProgress(choice.audioUrl, "audio", null);
          } catch (e) {
            // Video-only is still cuttable, just silent — say so and carry on.
            log(`Audio track download failed (${e.message}) — cutting the video without sound.`);
            audioBlob = null;
          }
        }
        return {
          file: new File([videoBlob], `${title}.mp4`, { type: "video/mp4" }),
          audioFile: audioBlob ? new File([audioBlob], `${title}-audio.m4a`, { type: "audio/mp4" }) : null,
          instance: host,
          quality: choice.quality,
          title: data.title || title,
        };
      } catch (err) {
        failures.push(`${host}: ${err.name === "AbortError" ? "timed out after 15s" : err.message}`);
      }
    }
    throw new Error(failures.join(" | ") || "all Piped instances failed");
  }

  // Download a media URL, trying the Invidious-proxied URL first (it goes
  // through the instance, bypassing the direct link's IP/CORS limits) and
  // then the direct googlevideo URL. Throws when both fail.
  async function downloadInvidiousMedia(base, videoId, itag, directUrl, label, onBytes) {
    const host = base.replace("https://", "");
    const attempts = [];
    if (itag) attempts.push({ url: invidiousProxyUrl(base, videoId, itag), via: `proxied (${host})` });
    if (directUrl) attempts.push({ url: directUrl, via: `direct (${host})` });
    let lastErr = null;
    for (const a of attempts) {
      try {
        return await downloadWithProgress(a.url, label, onBytes);
      } catch (e) {
        lastErr = e;
        log(`Invidious ${label} via ${a.via} failed (${e.message}) — trying the other way.`);
      }
    }
    throw lastErr || new Error(`could not download ${label}`);
  }

  /**
   * Fetch a YouTube video through Invidious. Tries each instance in turn.
   * Same return shape as fetchViaPiped. Invidious returns adaptive-only
   * streams, so the video is video-only H.264 MP4 and the audio is a
   * separate AAC track, muxed later by ffmpeg.
   */
  async function fetchViaInvidious(videoId, bases) {
    const failures = [];
    for (const base of bases) {
      const host = base.replace("https://", "");
      try {
        setStatus(`Asking Invidious (${host}) for the video…`);
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 15000);
        let res;
        try {
          res = await fetch(`${base}/api/v1/videos/${videoId}`, { signal: ctrl.signal });
        } finally {
          clearTimeout(timer);
        }
        if (!res.ok) {
          failures.push(`${host}: answered HTTP ${res.status}`);
          continue;
        }
        const data = await res.json();
        if (data.error) {
          failures.push(`${host}: ${String(data.error).slice(0, 160)}`);
          continue;
        }
        const choice = chooseInvidiousStreams(data);
        if (!choice) {
          failures.push(`${host}: no downloadable video stream in the answer`);
          continue;
        }
        const title = (data.title || videoId).replace(/[^\w\- ]+/g, "").trim().slice(0, 50) || videoId;
        setStatus(`Found it on Invidious (${host}, ${choice.quality}) — downloading the video…`);
        log(`Invidious (${host}): ${data.title || videoId} · ${choice.quality} · video + separate audio`);
        const videoBlob = await downloadInvidiousMedia(base, videoId, choice.videoItag, choice.videoUrl, "video", (got, total) => {
          setStatus(`Downloading the video from Invidious (${host}) — ${formatSize(got)}${total ? ` of ${formatSize(total)}` : ""}…`);
          if (total) setProgress(0.05 + 0.1 * (got / total));
        });
        let audioBlob = null;
        if (choice.audioUrl) {
          setStatus(`Downloading the audio track from Invidious (${host})…`);
          try {
            audioBlob = await downloadInvidiousMedia(base, videoId, choice.audioItag, choice.audioUrl, "audio", null);
          } catch (e) {
            log(`Audio track download failed (${e.message}) — cutting the video without sound.`);
            audioBlob = null;
          }
        }
        return {
          file: new File([videoBlob], `${title}.mp4`, { type: "video/mp4" }),
          audioFile: audioBlob ? new File([audioBlob], `${title}-audio.m4a`, { type: "audio/mp4" }) : null,
          instance: `Invidious ${host}`,
          quality: choice.quality,
          title: data.title || title,
        };
      } catch (err) {
        failures.push(`${host}: ${err.name === "AbortError" ? "timed out after 15s" : err.message}`);
      }
    }
    throw new Error(failures.join(" | ") || "all Invidious instances failed");
  }

  /**
   * Fetch a pasted YouTube link: Piped first, then Invidious. Throws one
   * error listing what every service said, so the page can show it honestly.
   */
  async function fetchViaLink(videoId) {
    const plan = fetchPlan();
    const failures = [];
    if (plan.piped.length) {
      try {
        const got = await fetchViaPiped(videoId, plan.piped);
        return { ...got, source: "Piped" };
      } catch (err) {
        failures.push(`Piped — ${err.message}`);
      }
    }
    if (plan.invidious.length) {
      setStatus("Piped couldn't fetch it — trying Invidious instead…");
      log("Piped failed, falling back to Invidious.");
      try {
        const got = await fetchViaInvidious(videoId, plan.invidious);
        return { ...got, source: "Invidious" };
      } catch (err) {
        failures.push(`Invidious — ${err.message}`);
      }
    }
    throw new Error(failures.join(" || ") || "all fetch services failed");
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

    // No file uploaded — try to fetch the pasted YouTube link, first
    // through Piped, then through Invidious. If neither can get it, say
    // so plainly and point at uploading the file.
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
          const fetched = await fetchViaLink(videoId);
          selectedFile = fetched.file;
          selectedAudioFile = fetched.audioFile;
          pipedTitle = fetched.title;
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
          $("pipedError").innerHTML =
            `<strong>What happened:</strong> ${escapeHtml(err.message)}<br>` +
            `You can change the fetch server in Step 1 and try again, or upload the video file instead — that always works.`;
          ytExplainer.scrollIntoView({ behavior: "smooth", block: "start" });
          setStatus("That link couldn't be fetched right now — see the steps above. Try again, pick a different fetch server, or upload the video file instead.");
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
    if (link && isYouTubeUrl(link)) {
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
        // If Piped gave video-only video plus a separate audio track,
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
        `<div class="s">Energy ${c.score.toFixed(2)} · ${formatSize(c.size)} · ${dim.label}</div>`;
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

  $("pipedRetryBtn").addEventListener("click", () => {
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
