//! The iOS proof of concept: search YouTube Music and resolve a song's audio URL
//! exactly the way ytm-rs does (anonymous WEB_REMIX search, anonymous visionOS
//! player), then let the phone probe the URL it got.
//!
//! Deliberately small: no queue, no account, no signature solver, no yt-dlp.
//! Everything here is the part that decides whether an independent iOS app can
//! work at all without any personal backend.

use std::ffi::{c_char, CStr, CString};
use std::io::Read;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};

/// The visionOS player's UA (innertube.rs::UA in the desktop app).
pub const VISION_UA: &str =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";

/// music.youtube.com's UA (webmusic.rs::UA in the desktop app).
pub const WEB_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

/// The "Songs" chip of a music.youtube.com search (ytm.rs, Filter::Songs).
const SONGS: &str = "EgWKAQIIAWoQEAMQBBAJEAoQBRAREBAQFQ%3D%3D";

/// Used when the page doesn't say; the desktop app scrapes the real one too.
const WEB_VERSION_FALLBACK: &str = "1.20241127.01.00";

#[derive(Serialize, Default, Debug)]
pub struct Resolved {
    pub ok: bool,
    pub title: String,
    pub duration_ms: u64,
    pub itag: u64,
    pub url: String,
    pub host: String,
    pub ipbits: String,
    pub expire: String,
    pub hls: String,
    pub error: String,
    pub note: String,
}

#[derive(Serialize, Default, Debug, PartialEq)]
pub struct Hit {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub duration: String,
}

#[derive(Serialize, Default, Debug)]
pub struct SearchOut {
    pub hits: Vec<Hit>,
    pub error: String,
}

fn agent() -> reqwest::blocking::Client {
    reqwest::blocking::Client::builder()
        .user_agent(VISION_UA)
        .timeout(Duration::from_secs(25))
        .build()
        .unwrap_or_default()
}

fn between<'a>(haystack: &'a str, start: &str, end: &str) -> Option<&'a str> {
    let s = haystack.find(start)? + start.len();
    let e = s + haystack[s..].find(end)?;
    Some(&haystack[s..e])
}

static SESSION: Mutex<Option<(String, String, Instant)>> = Mutex::new(None);

/// music.youtube.com's client version and visitor ID, cached for an hour: every
/// resolve would otherwise fetch a megabyte of page first (the desktop app caches
/// the visitor data for 24 hours).
fn session(client: &reqwest::blocking::Client) -> (String, String) {
    if let Some((version, visitor, at)) = SESSION.lock().ok().and_then(|slot| slot.clone()) {
        if at.elapsed() < Duration::from_secs(3600) {
            return (version, visitor);
        }
    }
    let html = client
        .get("https://music.youtube.com/")
        .send()
        .ok()
        .and_then(|r| r.text().ok())
        .unwrap_or_default();
    let visitor = between(&html, "\"VISITOR_DATA\":\"", "\"").unwrap_or("").to_string();
    let version = between(&html, "\"INNERTUBE_CLIENT_VERSION\":\"", "\"")
        .unwrap_or(WEB_VERSION_FALLBACK)
        .to_string();
    if let Ok(mut slot) = SESSION.lock() {
        *slot = Some((version.clone(), visitor.clone(), Instant::now()));
    }
    (version, visitor)
}

fn param(url: &str, name: &str) -> String {
    url.split('?')
        .nth(1)
        .and_then(|q| {
            q.split('&')
                .find_map(|kv| kv.strip_prefix(&format!("{name}=")))
        })
        .unwrap_or("")
        .to_string()
}

/// The first of `itags` that carries a plain URL. The web clients cipher theirs;
/// this is exactly why the desktop app uses visionOS.
fn pick(player: &Value, itags: &[u64]) -> Option<(u64, String)> {
    let formats = player["streamingData"]["adaptiveFormats"].as_array()?;
    for itag in itags {
        if let Some(found) = formats.iter().find(|f| f["itag"] == *itag) {
            if let Some(url) = found["url"].as_str() {
                return Some((*itag, url.to_string()));
            }
        }
    }
    formats
        .iter()
        .find_map(|f| Some((f["itag"].as_u64()?, f["url"].as_str()?.to_string())))
}

fn text_of(v: &Value) -> String {
    v["runs"]
        .as_array()
        .map(|runs| runs.iter().filter_map(|r| r["text"].as_str()).collect::<String>())
        .unwrap_or_default()
}

fn looks_like_duration(s: &str) -> bool {
    !s.is_empty() && s.len() <= 8 && s.contains(':') && s.chars().all(|c| c.is_ascii_digit() || c == ':')
}

/// Search rows (musicResponsiveListItemRenderer), as ytm.rs's `list_item` reads
/// them: title in the first column, "Artist • Album • 3:22" in the second.
fn parse_search(v: &Value) -> Vec<Hit> {
    let mut out = Vec::new();
    let sections = v["contents"]["tabbedSearchResultsRenderer"]["tabs"][0]["tabRenderer"]["content"]
        ["sectionListRenderer"]["contents"]
        .as_array();
    for section in sections.into_iter().flatten() {
        for row in section["musicShelfRenderer"]["contents"].as_array().into_iter().flatten() {
            let r = &row["musicResponsiveListItemRenderer"];
            if r.is_null() {
                continue;
            }
            let cols = r["flexColumns"].as_array();
            let col = |i: usize| {
                cols.and_then(|c| c.get(i))
                    .map(|c| &c["musicResponsiveListItemFlexColumnRenderer"]["text"])
            };
            let title = col(0).map(text_of).unwrap_or_default();
            let id = r["playlistItemData"]["videoId"].as_str().map(str::to_owned).or_else(|| {
                col(0)
                    .and_then(|t| t["runs"].as_array())
                    .and_then(|runs| {
                        runs.iter()
                            .find_map(|x| x["navigationEndpoint"]["watchEndpoint"]["videoId"].as_str())
                    })
                    .map(str::to_owned)
            });
            let (Some(id), true) = (id, !title.is_empty()) else { continue };
            let meta = col(1).map(text_of).unwrap_or_default();
            let artist = meta.split('•').next().unwrap_or("").trim().to_string();
            let duration = meta.split('•').map(str::trim).find(|p| looks_like_duration(p)).unwrap_or("").to_string();
            out.push(Hit { id, title, artist, duration });
        }
    }
    out
}

pub fn search(client: &reqwest::blocking::Client, query: &str) -> SearchOut {
    let (version, visitor) = session(client);
    let body = json!({
        "context": {"client": {
            "clientName": "WEB_REMIX",
            "clientVersion": version,
            "platform": "DESKTOP",
            "originalUrl": "https://music.youtube.com",
            "visitorData": visitor,
            "hl": "en",
            "gl": "US",
        }},
        "query": query,
        "params": SONGS,
    });
    let resp = client
        .post("https://music.youtube.com/youtubei/v1/search?prettyPrint=false")
        .header("User-Agent", WEB_UA)
        .header("Origin", "https://music.youtube.com")
        .header("X-Origin", "https://music.youtube.com")
        .header("Referer", "https://music.youtube.com/")
        .header("X-YouTube-Client-Name", "67")
        .header("X-YouTube-Client-Version", &version)
        .header("X-Goog-Visitor-Id", &visitor)
        .header("Cookie", "SOCS=CAISAiAD")
        .json(&body)
        .send();
    let resp = match resp {
        Ok(r) => r,
        Err(e) => {
            return SearchOut {
                hits: Vec::new(),
                error: format!("request failed: {e}"),
            }
        }
    };
    if !resp.status().is_success() {
        return SearchOut {
            hits: Vec::new(),
            error: format!("HTTP {}", resp.status().as_u16()),
        };
    }
    match resp.json::<Value>() {
        Ok(v) => SearchOut {
            hits: parse_search(&v),
            error: String::new(),
        },
        Err(e) => SearchOut {
            hits: Vec::new(),
            error: format!("bad response: {e}"),
        },
    }
}

pub fn resolve(client: &reqwest::blocking::Client, video_id: &str) -> Resolved {
    let mut out = Resolved::default();
    let (_, vis) = session(client);

    let body = json!({
        "context": {"client": {
            "clientName": "VISIONOS",
            "clientVersion": "1.02",
            "deviceMake": "Apple",
            "deviceModel": "RealityDevice17,1",
            "userAgent": VISION_UA,
            "osName": "visionOS",
            "osVersion": "26.5.23O471",
            "hl": "en",
            "gl": "US",
            "visitorData": vis,
        }},
        "videoId": video_id,
        "contentCheckOk": true,
        "racyCheckOk": true,
    });

    let resp = client
        .post("https://www.youtube.com/youtubei/v1/player?prettyPrint=false")
        .header("X-YouTube-Client-Name", "101")
        .header("X-YouTube-Client-Version", "1.02")
        .header("X-Goog-Visitor-Id", &vis)
        .header("Origin", "https://www.youtube.com")
        .json(&body)
        .send();

    let resp = match resp {
        Ok(r) => r,
        Err(e) => {
            out.error = format!("request failed: {e}");
            return out;
        }
    };

    let player: Value = match resp.json() {
        Ok(v) => v,
        Err(e) => {
            out.error = format!("bad response: {e}");
            return out;
        }
    };

    let status = player["playabilityStatus"]["status"].as_str().unwrap_or("");
    if status != "OK" {
        out.error = format!(
            "{}: {}",
            status,
            player["playabilityStatus"]["reason"].as_str().unwrap_or("no reason")
        );
        return out;
    }

    out.title = player["videoDetails"]["title"].as_str().unwrap_or("").to_string();
    out.duration_ms = player["videoDetails"]["lengthSeconds"]
        .as_str()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0)
        * 1000;

    match pick(&player, &[140, 139, 251]) {
        Some((itag, url)) => {
            out.ok = true;
            out.itag = itag;
            out.host = url.split('/').nth(2).unwrap_or("").to_string();
            out.ipbits = param(&url, "ipbits");
            out.expire = param(&url, "expire");
            out.url = url;
        }
        None => {
            out.error = "no plain URL in the player response".into();
            out.note = "All formats are ciphered; the desktop app solves this with jsc.rs.".into();
        }
    }

    if let Some(hls) = player["streamingData"]["hlsManifestUrl"].as_str() {
        out.hls = hls.to_string();
    }
    out
}

/// Ask googlevideo for one kilobyte, from this device, with the same UA the desktop
/// app uses. Tells us whether the URL is fetchable here at all.
pub fn probe(client: &reqwest::blocking::Client, url: &str) -> String {
    let result = client
        .get(url)
        .header("Range", "bytes=0-1023")
        .send()
        .map(|resp| {
            let status = resp.status().as_u16();
            let content_type = resp
                .headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .to_string();
            let content_range = resp
                .headers()
                .get("content-range")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .to_string();
            let mut buf = Vec::new();
            let _ = resp.take(4096).read_to_end(&mut buf);
            json!({
                "status": status,
                "bytes": buf.len(),
                "contentType": content_type,
                "contentRange": content_range,
            })
        })
        .unwrap_or_else(|e| json!({"error": e.to_string()}));
    result.to_string()
}

fn to_c(s: String) -> *mut c_char {
    CString::new(s).map(CString::into_raw).unwrap_or(std::ptr::null_mut())
}

fn read_arg(arg: *const c_char) -> Option<String> {
    if arg.is_null() {
        return None;
    }
    Some(unsafe { CStr::from_ptr(arg) }.to_string_lossy().trim().to_string())
}

#[no_mangle]
pub extern "C" fn ytm_search(query: *const c_char) -> *mut c_char {
    let Some(query) = read_arg(query) else {
        return std::ptr::null_mut();
    };
    // The client lives inside the closure: reqwest's blocking Client isn't promised
    // unwind-safe, and a panic must come back as JSON, never as a crash on the phone.
    let out = std::panic::catch_unwind(|| {
        let client = agent();
        search(&client, &query)
    })
    .unwrap_or_else(|_| SearchOut {
        hits: Vec::new(),
        error: "panic while searching".into(),
    });
    to_c(serde_json::to_string(&out).unwrap_or_else(|_| "{}".into()))
}

#[no_mangle]
pub extern "C" fn ytm_resolve(video_id: *const c_char) -> *mut c_char {
    let Some(id) = read_arg(video_id) else {
        return std::ptr::null_mut();
    };
    let resolved = std::panic::catch_unwind(|| {
        let client = agent();
        resolve(&client, &id)
    })
    .unwrap_or_else(|_| Resolved {
        error: "panic while resolving".into(),
        ..Default::default()
    });
    to_c(serde_json::to_string(&resolved).unwrap_or_else(|_| "{}".into()))
}

#[no_mangle]
pub extern "C" fn ytm_probe(url: *const c_char) -> *mut c_char {
    let Some(url) = read_arg(url) else {
        return std::ptr::null_mut();
    };
    let out = std::panic::catch_unwind(|| {
        let client = agent();
        probe(&client, &url)
    })
    .unwrap_or_else(|_| "{\"error\":\"panic\"}".into());
    to_c(out)
}

#[no_mangle]
pub extern "C" fn ytm_free(ptr: *mut c_char) {
    if !ptr.is_null() {
        unsafe { drop(CString::from_raw(ptr)) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Value {
        json!({
            "playabilityStatus": {"status": "OK"},
            "videoDetails": {"title": "Test Song", "lengthSeconds": "213"},
            "streamingData": {
                "hlsManifestUrl": "https://manifest.googlevideo.com/api/manifest/hls_playlist/x.m3u8",
                "adaptiveFormats": [
                    {"itag": 251, "url": "https://rr1.googlevideo.com/videoplayback?ip=1.2.3.4&ipbits=0&expire=1764000000&itag=251"},
                    {"itag": 140, "url": "https://rr1.googlevideo.com/videoplayback?ip=1.2.3.4&ipbits=0&expire=1764000000&itag=140"},
                    {"itag": 137, "url": "https://rr1.googlevideo.com/videoplayback?itag=137"}
                ]
            }
        })
    }

    #[test]
    fn picks_aac_first_and_reads_url_params() {
        let (itag, url) = pick(&fixture(), &[140, 139, 251]).expect("a stream");
        assert_eq!(itag, 140);
        assert_eq!(param(&url, "ipbits"), "0");
        assert_eq!(param(&url, "expire"), "1764000000");
        assert_eq!(url.split('/').nth(2).unwrap(), "rr1.googlevideo.com");
    }

    #[test]
    fn falls_back_when_the_preferred_itag_has_no_url() {
        let mut f = fixture();
        f["streamingData"]["adaptiveFormats"][1]["url"] = Value::Null;
        let (itag, _) = pick(&f, &[140, 139, 251]).expect("a stream");
        assert_eq!(itag, 251);
    }

    #[test]
    fn skips_itags_that_are_absent_entirely() {
        let f = fixture();
        let (itag, _) = pick(&f, &[139, 140]).expect("a stream");
        assert_eq!(itag, 140);
    }

    #[test]
    fn missing_urls_are_reported_not_panicked() {
        let mut f = fixture();
        for fmt in f["streamingData"]["adaptiveFormats"].as_array_mut().unwrap() {
            fmt["url"] = Value::Null;
            fmt["signatureCipher"] = json!("s=abc");
        }
        assert!(pick(&f, &[140, 139, 251]).is_none());
    }

    #[test]
    fn url_params_survive_missing_query() {
        assert_eq!(param("https://x/y", "ipbits"), "");
        assert_eq!(param("https://x/y?a=1&ipbits=0", "ipbits"), "0");
    }

    fn search_fixture() -> Value {
        json!({"contents":{"tabbedSearchResultsRenderer":{"tabs":[{"tabRenderer":{"content":{"sectionListRenderer":{"contents":[{"musicShelfRenderer":{"contents":[
            {"musicResponsiveListItemRenderer":{
                "playlistItemData":{"videoId":"abc123"},
                "flexColumns":[
                    {"musicResponsiveListItemFlexColumnRenderer":{"text":{"runs":[{"text":"Blinding Lights"}]}}},
                    {"musicResponsiveListItemFlexColumnRenderer":{"text":{"runs":[{"text":"The Weeknd"},{"text":" • "},{"text":"After Hours"},{"text":" • "},{"text":"3:20"}]}}}
                ]}},
            {"musicResponsiveListItemRenderer":{
                "flexColumns":[
                    {"musicResponsiveListItemFlexColumnRenderer":{"text":{"runs":[{"text":"Linked song title"}]}}}
                ]}},
            {"musicResponsiveListItemRenderer":{
                "flexColumns":[
                    {"musicResponsiveListItemFlexColumnRenderer":{"text":{"runs":[{"text":"Only endpoint"},{"navigationEndpoint":{"watchEndpoint":{"videoId":"xyz789"}}}]}}}
                ]}}
        ]}}]}}}}]}}})
    }

    #[test]
    fn search_rows_become_hits() {
        let hits = parse_search(&search_fixture());
        assert_eq!(hits.len(), 2);
        assert_eq!(
            hits[0],
            Hit {
                id: "abc123".into(),
                title: "Blinding Lights".into(),
                artist: "The Weeknd".into(),
                duration: "3:20".into()
            }
        );
        assert_eq!(hits[1].id, "xyz789");
        assert_eq!(hits[1].artist, "");
    }

    #[test]
    fn duration_looks_like_a_clock() {
        assert!(looks_like_duration("3:20"));
        assert!(looks_like_duration("1:02:03"));
        assert!(!looks_like_duration("After Hours"));
        assert!(!looks_like_duration("2024"));
    }
}
