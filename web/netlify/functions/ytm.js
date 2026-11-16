// The web app's only backend: the same two anonymous InnerTube calls the Rust
// proof of concept makes (WEB_REMIX search, visionOS player), behind one function.
//
// GET /api/ytm?action=search&q=...   -> { hits, error }
// GET /api/ytm?action=resolve&id=... -> { ok, title, duration_ms, itag, url, hls, ... }
//
// Set APP_KEY in the Netlify environment to keep the function for yourself; the
// page then sends it back as x-app-key. Without APP_KEY the endpoint is open.

const VISION_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";

const WEB_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

// The "Songs" chip of a music.youtube.com search (ytm.rs, Filter::Songs).
const SONGS = "EgWKAQIIAWoQEAMQBBAJEAoQBRAREBAQFQ%3D%3D";

const WEB_VERSION_FALLBACK = "1.20241127.01.00";

let session = { at: 0, version: "", visitor: "" };

function between(haystack, start, end) {
  const s = haystack.indexOf(start);
  if (s < 0) return null;
  const from = s + start.length;
  const e = haystack.indexOf(end, from);
  return e < 0 ? null : haystack.slice(from, e);
}

async function getSession() {
  if (session.version && Date.now() - session.at < 3_600_000) return session;
  try {
    const resp = await fetch("https://music.youtube.com/", {
      headers: { "User-Agent": WEB_UA },
      signal: AbortSignal.timeout(12_000),
    });
    const html = await resp.text();
    const visitor = between(html, '"VISITOR_DATA":"', '"') ?? "";
    const version = between(html, '"INNERTUBE_CLIENT_VERSION":"', '"') ?? WEB_VERSION_FALLBACK;
    session = { at: Date.now(), version, visitor };
  } catch {
    // Keep the fallback for this call only; try the page again next time.
    session = { at: 0, version: WEB_VERSION_FALLBACK, visitor: "" };
  }
  return session;
}

function textOf(v) {
  if (!v || !Array.isArray(v.runs)) return "";
  return v.runs.map((r) => r?.text ?? "").join("");
}

export function looksLikeDuration(s) {
  return (
    typeof s === "string" &&
    s.length > 0 &&
    s.length <= 8 &&
    s.includes(":") &&
    [...s].every((c) => (c >= "0" && c <= "9") || c === ":")
  );
}

export function parseSearch(v) {
  const hits = [];
  const sections =
    v?.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer?.content
      ?.sectionListRenderer?.contents;
  if (!Array.isArray(sections)) return hits;
  for (const section of sections) {
    const rows = section?.musicShelfRenderer?.contents;
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      const r = row?.musicResponsiveListItemRenderer;
      if (!r) continue;
      const col = (i) => r?.flexColumns?.[i]?.musicResponsiveListItemFlexColumnRenderer?.text;
      const title = textOf(col(0));
      let id = r?.playlistItemData?.videoId;
      if (!id) {
        for (const run of col(0)?.runs ?? []) {
          id = run?.navigationEndpoint?.watchEndpoint?.videoId;
          if (id) break;
        }
      }
      if (!id || !title) continue;
      const meta = textOf(col(1));
      const parts = meta.split("•").map((p) => p.trim());
      const artist = parts[0] ?? "";
      const duration = parts.find(looksLikeDuration) ?? "";
      hits.push({ id, title, artist, duration });
    }
  }
  return hits;
}

// The first of `itags` that carries a plain URL. The web clients cipher theirs;
// this is exactly why the visionOS client is used.
export function pick(player, itags) {
  const formats = player?.streamingData?.adaptiveFormats;
  if (!Array.isArray(formats)) return null;
  for (const itag of itags) {
    const found = formats.find((f) => f?.itag === itag);
    if (found && typeof found.url === "string") return { itag, url: found.url };
  }
  for (const f of formats) {
    if (typeof f?.url === "string" && typeof f.itag === "number") {
      return { itag: f.itag, url: f.url };
    }
  }
  return null;
}

export function validVideoId(id) {
  return typeof id === "string" && /^[A-Za-z0-9_-]{11}$/.test(id);
}

function param(url, name) {
  try {
    return new URL(url).searchParams.get(name) ?? "";
  } catch {
    return "";
  }
}

async function search(q) {
  const { version, visitor } = await getSession();
  const body = {
    context: {
      client: {
        clientName: "WEB_REMIX",
        clientVersion: version,
        platform: "DESKTOP",
        originalUrl: "https://music.youtube.com",
        visitorData: visitor,
        hl: "en",
        gl: "US",
      },
    },
    query: q,
    params: SONGS,
  };
  const resp = await fetch("https://music.youtube.com/youtubei/v1/search?prettyPrint=false", {
    method: "POST",
    headers: {
      "User-Agent": WEB_UA,
      "Content-Type": "application/json",
      Origin: "https://music.youtube.com",
      "X-Origin": "https://music.youtube.com",
      Referer: "https://music.youtube.com/",
      "X-YouTube-Client-Name": "67",
      "X-YouTube-Client-Version": version,
      ...(visitor ? { "X-Goog-Visitor-Id": visitor } : {}),
      Cookie: "SOCS=CAISAiAD",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) return { hits: [], error: `search HTTP ${resp.status}` };
  const v = await resp.json();
  return { hits: parseSearch(v), error: "" };
}

async function resolve(id) {
  const out = {
    ok: false,
    title: "",
    duration_ms: 0,
    itag: 0,
    url: "",
    host: "",
    ipbits: "",
    expire: "",
    hls: "",
    error: "",
    note: "",
  };
  const { visitor } = await getSession();
  const body = {
    context: {
      client: {
        clientName: "VISIONOS",
        clientVersion: "1.02",
        deviceMake: "Apple",
        deviceModel: "RealityDevice17,1",
        userAgent: VISION_UA,
        osName: "visionOS",
        osVersion: "26.5.23O471",
        hl: "en",
        gl: "US",
        visitorData: visitor,
      },
    },
    videoId: id,
    contentCheckOk: true,
    racyCheckOk: true,
  };
  const resp = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
    method: "POST",
    headers: {
      "User-Agent": VISION_UA,
      "Content-Type": "application/json",
      "X-YouTube-Client-Name": "101",
      "X-YouTube-Client-Version": "1.02",
      ...(visitor ? { "X-Goog-Visitor-Id": visitor } : {}),
      Origin: "https://www.youtube.com",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) {
    out.error = `player HTTP ${resp.status}`;
    return out;
  }
  const player = await resp.json();
  const status = player?.playabilityStatus?.status ?? "";
  if (status !== "OK") {
    out.error = `${status || "no status"}: ${player?.playabilityStatus?.reason ?? "no reason"}`;
    return out;
  }
  out.title = player?.videoDetails?.title ?? "";
  out.duration_ms = Number.parseInt(player?.videoDetails?.lengthSeconds ?? "0", 10) * 1000 || 0;
  const found = pick(player, [140, 139, 251]);
  if (found) {
    out.ok = true;
    out.itag = found.itag;
    out.url = found.url;
    try {
      out.host = new URL(found.url).host;
    } catch {}
    out.ipbits = param(found.url, "ipbits");
    out.expire = param(found.url, "expire");
  } else {
    out.error = "no plain URL in the player response";
    out.note = "All formats are ciphered.";
  }
  const hls = player?.streamingData?.hlsManifestUrl;
  if (typeof hls === "string") out.hls = hls;
  return out;
}

function appKey() {
  try {
    if (typeof Netlify !== "undefined" && Netlify?.env?.get) return Netlify.env.get("APP_KEY") ?? "";
  } catch {}
  // The generated Cloudflare Worker sets this from its own env binding.
  if (typeof globalThis.__YTM_APP_KEY === "string" && globalThis.__YTM_APP_KEY) {
    return globalThis.__YTM_APP_KEY;
  }
  if (typeof process !== "undefined" && process?.env) return process.env.APP_KEY ?? "";
  return "";
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export default async (req) => {
  const url = new URL(req.url);
  const expected = appKey();
  if (expected) {
    const given = req.headers.get("x-app-key") ?? url.searchParams.get("key") ?? "";
    if (given !== expected) return json({ error: "unauthorized" }, 401);
  }

  const action = url.searchParams.get("action") ?? "";
  try {
    if (action === "search") {
      const q = (url.searchParams.get("q") ?? "").trim();
      if (!q) return json({ hits: [], error: "empty query" }, 400);
      return json(await search(q.slice(0, 200)));
    }
    if (action === "resolve") {
      const id = url.searchParams.get("id") ?? "";
      if (!validVideoId(id)) return json({ error: "bad video id" }, 400);
      return json(await resolve(id));
    }
    return json({ error: "unknown action" }, 400);
  } catch (e) {
    const msg =
      e?.name === "TimeoutError"
        ? "request timed out"
        : `${e?.message ?? e}${e?.cause?.code ? " (" + e.cause.code + ")" : ""}`;
    return json({ error: msg }, 502);
  }
};
