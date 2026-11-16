const $ = (id) => document.getElementById(id);
const audio = $("audio");
const logEl = $("log");

const SILENT =
  "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=";

let key = localStorage.getItem("ytmKey") || "";
let current = null;

const qp = new URLSearchParams(location.search);
if (qp.get("key")) {
  key = qp.get("key");
  localStorage.setItem("ytmKey", key);
  qp.delete("key");
  const rest = qp.toString();
  history.replaceState(null, "", location.pathname + (rest ? "?" + rest : ""));
}

function log(msg, cls = "") {
  const t = new Date().toLocaleTimeString("en-GB", { hour12: false });
  const line = document.createElement("div");
  line.textContent = `${t}  ${msg}`;
  if (cls) line.className = cls;
  logEl.append(line);
  logEl.scrollTop = logEl.scrollHeight;
}

function status(msg, kind = "") {
  const el = $("status");
  el.textContent = msg;
  el.className = "status " + kind;
}

async function api(params) {
  const url = new URL("/api/ytm", location.origin);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const resp = await fetch(url, {
    headers: key ? { "x-app-key": key } : {},
    cache: "no-store",
  });
  if (resp.status === 401) {
    $("keyBox").hidden = false;
    throw new Error("کلید لازم است");
  }
  let data = {};
  try {
    data = await resp.json();
  } catch {}
  if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
  return data;
}

// iOS only lets the audio element start from a gesture. The resolve takes a
// moment, so the element is unlocked once, on the first touch, with silence.
document.addEventListener(
  "pointerdown",
  () => {
    audio.src = SILENT;
    audio.play().catch(() => {});
  },
  { once: true }
);

$("searchForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = $("q").value.trim();
  if (!q) return;
  $("searchBtn").disabled = true;
  status("در حال جست‌وجو…");
  log(`search "${q}"`);
  try {
    const d = await api({ action: "search", q });
    if (d.error) {
      log(`search failed: ${d.error}`, "warn");
      status(d.error, "bad");
      return;
    }
    renderHits(d.hits || []);
    status(d.hits?.length ? `${d.hits.length} نتیجه` : "نتیجه‌ای نبود", d.hits?.length ? "ok" : "");
    log(`${d.hits?.length || 0} hits`);
  } catch (err) {
    log(`search error: ${err.message}`, "warn");
    status(err.message, "bad");
  } finally {
    $("searchBtn").disabled = false;
  }
});

function renderHits(hits) {
  const ol = $("hits");
  ol.textContent = "";
  for (const hit of hits.slice(0, 20)) {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button";
    const left = document.createElement("span");
    const title = document.createElement("span");
    title.className = "t";
    title.textContent = hit.title;
    const meta = document.createElement("span");
    meta.className = "m";
    meta.textContent = [hit.artist, hit.duration].filter(Boolean).join(" • ") || hit.id;
    left.append(title, meta);
    const play = document.createElement("span");
    play.className = "play";
    play.textContent = "▶";
    b.append(left, play);
    b.addEventListener("click", () => playSong(hit));
    li.append(b);
    ol.append(li);
  }
}

async function playSong(hit) {
  audio.pause();
  resetWatch();
  $("nowTitle").textContent = hit.title;
  $("nowMeta").textContent = [hit.artist, hit.duration, hit.id].filter(Boolean).join(" • ");
  $("directLink").hidden = true;
  current = null;
  status("در حال ساخت لینک پخش…");
  log(`resolve ${hit.id}`);
  try {
    const d = await api({ action: "resolve", id: hit.id });
    if (!d.ok) {
      log(`resolve failed: ${d.error || "?"}${d.note ? " — " + d.note : ""}`, "warn");
      status(d.error || "لینک نشد", "bad");
      return;
    }
    current = d;
    log(`itag ${d.itag} @ ${d.host} ipbits=${d.ipbits} expire=${d.expire}`, "ok");
    if (!d.hls) log("no HLS manifest in the response");
    $("directLink").href = d.url;
    $("directLink").hidden = false;
    const useHls = $("hls").checked && d.hls;
    log(useHls ? "using the HLS manifest" : "using the direct URL");
    start(useHls ? d.hls : d.url);
  } catch (err) {
    log(`resolve error: ${err.message}`, "warn");
    status(err.message, "bad");
  }
}

function start(src) {
  resetWatch();
  audio.src = src;
  audio.load();
  log("src set; calling play()");
  audio
    .play()
    .then(() => log("play() accepted", "ok"))
    .catch((e) => {
      log(`play() rejected: ${e.name}: ${e.message}`, "warn");
      status("برای پخش، دکمهٔ ▶ را بزن.", "bad");
    });
}

$("hls").addEventListener("change", () => {
  if (!current) return;
  const useHls = $("hls").checked && current.hls;
  if (useHls || current.url) {
    log(useHls ? "switching to HLS" : "switching to the direct URL");
    start(useHls ? current.hls : current.url);
  }
});

const NAMES = { 1: "ABORTED", 2: "NETWORK", 3: "DECODE", 4: "SRC_NOT_SUPPORTED" };
const isSilent = () => audio.currentSrc.startsWith("data:");

for (const ev of [
  "loadstart", "loadedmetadata", "durationchange", "canplay", "canplaythrough",
  "playing", "pause", "waiting", "stalled", "suspend", "abort", "emptied",
  "seeking", "seeked", "ended", "ratechange", "volumechange",
]) {
  audio.addEventListener(ev, () => {
    if (isSilent()) return;
    log(`<${ev}> t=${audio.currentTime.toFixed(1)} rs=${audio.readyState} ns=${audio.networkState}`);
    if (ev === "playing") status("در حال پخش", "ok");
    if (ev === "waiting" || ev === "stalled") status("بافر می‌کند…", "");
    if (ev === "ended") status("تمام شد", "");
  });
}

audio.addEventListener("error", () => {
  if (isSilent()) return;
  const e = audio.error;
  const code = e?.code ?? "?";
  log(`<error> code=${code} ${NAMES[code] || ""} ${e?.message || ""}`, "warn");
  status(`پخش شکست خورد (کد ${code}).`, "bad");
});

let lastAt = Date.now();
let stallWarned = false;

function resetWatch() {
  lastAt = Date.now();
  stallWarned = false;
}

audio.addEventListener("timeupdate", () => {
  lastAt = Date.now();
  if (stallWarned) stallWarned = false;
});

audio.addEventListener("play", resetWatch);
audio.addEventListener("seeking", resetWatch);

setInterval(() => {
  if (audio.paused || !audio.currentSrc || isSilent()) {
    lastAt = Date.now();
    return;
  }
  const stuck = Date.now() - lastAt;
  if (stuck > 12_000 && !stallWarned) {
    stallWarned = true;
    log(`no progress for ${Math.round(stuck / 1000)}s — likely the 1 MiB cut or a blocked IP`, "warn");
    status("استریم جلو نمی‌رود؛ HLS یا «باز کردن لینک در تب» را امتحان کن.", "bad");
  }
}, 3000);

$("settingsBtn").addEventListener("click", () => {
  $("key").value = key;
  $("keyBox").hidden = !$("keyBox").hidden;
});

$("saveKey").addEventListener("click", () => {
  key = $("key").value.trim();
  if (key) localStorage.setItem("ytmKey", key);
  else localStorage.removeItem("ytmKey");
  $("keyBox").hidden = true;
  log(key ? "key saved" : "key cleared", "ok");
  status("کلید ذخیره شد.");
});

$("clearLog").addEventListener("click", () => {
  logEl.textContent = "";
});

$("copyLog").addEventListener("click", async () => {
  const text = logEl.innerText;
  try {
    await navigator.clipboard.writeText(text);
    status("لاگ کپی شد.", "ok");
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.append(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
    status("لاگ کپی شد.", "ok");
  }
});

log("ready");
