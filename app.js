// Leonida Clipper — web UI (control panel for clipper.py)
// This page does NOT cut video in the browser. It builds the exact
// command to run locally, and previews a clips.json produced by clipper.py.

const $ = (id) => document.getElementById(id);

function buildCommand() {
  const src = ($("src").value || "").trim() || "PASTE_URL_OR_FILE_HERE";
  const count = $("count").value;
  const length = $("length").value;
  const out = ($("out").value || "./output").trim();
  // Quote the source in case it contains & or spaces (YouTube URLs do).
  return `python3 clipper.py "${src}" --count ${count} --length ${length} --output ${out}`;
}

$("gen").addEventListener("click", () => {
  $("cmd").textContent = buildCommand();
});

["src", "count", "length", "out"].forEach((id) => {
  $(id).addEventListener("input", () => { $("cmd").textContent = buildCommand(); });
  $(id).addEventListener("change", () => { $("cmd").textContent = buildCommand(); });
});

$("copy").addEventListener("click", async () => {
  const text = $("cmd").textContent;
  try {
    await navigator.clipboard.writeText(text);
    $("copy").textContent = "Copied ✓";
  } catch (e) {
    // Fallback for browsers without clipboard permission.
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
    $("copy").textContent = "Copied ✓";
  }
  setTimeout(() => { $("copy").textContent = "Copy command"; }, 2000);
});

let loadedClips = [];

$("jsonfile").addEventListener("change", async (ev) => {
  const file = ev.target.files && ev.target.files[0];
  if (!file) return;
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch (e) {
    $("moments").innerHTML = "<p>Could not read that file — it is not a valid clips.json.</p>";
    return;
  }
  loadedClips = Array.isArray(data.clips) ? data.clips : [];
  renderMoments(data);
});

function renderMoments(data) {
  const box = $("moments");
  if (!loadedClips.length) {
    box.innerHTML = "<p>No clips in this clips.json.</p>";
    return;
  }
  box.innerHTML = "";
  loadedClips.forEach((clip, i) => {
    const div = document.createElement("div");
    div.className = "moment";
    const score = typeof clip.score === "number" ? clip.score.toFixed(2) : "—";
    div.innerHTML =
      `<input type="checkbox" checked data-i="${i}" aria-label="Keep clip ${i + 1}">` +
      `<div><div class="t">${i + 1}. ${escapeHtml(clip.file || "clip")}</div>` +
      `<div class="s">${escapeHtml(clip.start_time || "")}–${escapeHtml(clip.end_time || "")} · ` +
      `${escapeHtml(clip.resolution || "")} · ${escapeHtml(String(clip.size_mb ?? ""))} MB<br>` +
      `${escapeHtml(clip.suggested_title || "")}</div></div>` +
      `<div class="score">★ ${score}</div>`;
    box.appendChild(div);
  });
  $("export").style.display = "";
}

$("export").addEventListener("click", async () => {
  const checked = [...document.querySelectorAll(".moment input:checked")]
    .map((el) => loadedClips[Number(el.dataset.i)])
    .filter(Boolean);
  const text = checked
    .map((c) => `${c.file}  |  ${c.start_time}–${c.end_time}  |  score ${c.score}  |  ${c.suggested_title || ""}`)
    .join("\n");
  const out = $("exportOut");
  out.style.display = "";
  out.textContent = text || "No clips selected.";
  try { await navigator.clipboard.writeText(text); } catch (e) { /* text is shown above */ }
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
