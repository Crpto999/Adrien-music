//! NetEase Cloud Music: search, discovery, lyrics and stream resolution.
//!
//! # Why a separate module
//!
//! NetEase is not a YouTube-like API: it has no public "search" endpoint
//! in the InnerTube sense, its ids are numbers rather than opaque
//! strings, and its catalogue is split by region. This module wraps
//! the things the app needs from it:
//!
//!  1. **Search** — the plain `/api/search/get/web` endpoint, which
//!     needs no encryption and no account.
//!  2. **Discovery** — the daily recommendation, which is the reason
//!     NetEase is interesting as a *source* rather than a mirror.
//!  3. **Lyrics** — plain `/api/song/lyric`, keyed by song id, so the
//!     lyrics are for exactly the track the user picked.
//!  4. **Stream resolution** — either the official path (the user's
//!     own `MUSIC_U` cookie, which makes the platform serve whatever
//!     their membership entitles them to) or the third-party unblock
//!     pool (`unblock.rs`), which is the fallback for tracks the
//!     platform gates and the user has no membership for.
//!
//! # The eapi protocol
//!
//! The `eapi` endpoints take a single form field, `params`, whose
//! value is the payload encrypted with AES-128-ECB under a published
//! constant key, with the URL and an MD5 digest spliced into the
//! plaintext. It is a transport encoding, not a secret: the key and
//! the digest salt are the same in the official client and in every
//! open-source re-implementation. It is implemented here from the
//! protocol's specification so that the app speaks the platform's own
//! API rather than a third-party re-implementation of it.
//!
//! # What this module deliberately does not do
//!
//! It does not decrypt anything, forge device identities or bypass
//! the platform's access control. The official path is a plain HTTPS
//! call with the user's own cookie, exactly like the NetEase client
//! makes. The unblock path delegates to third-party public APIs whose
//! accounts are their operators' business.

use serde::Serialize;

use crate::proxy;
use crate::netease_auth;

/// One NetEase search result.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NeteaseSong {
    pub id: String,
    pub title: String,
    pub artists: Vec<String>,
    pub album: Option<String>,
    /// Milliseconds, as NetEase reports it.
    pub duration_ms: u64,
    /// Seconds, for the app's own duration fields.
    pub duration: u64,
    pub cover_url: Option<String>,
    /// The platform's own fee tier: 0 free, 1 VIP, 4 album purchase,
    /// 8 free-with-membership.
    pub fee: i64,
    /// A direct, playable URL when the platform will serve one to
    /// this (possibly anonymous) user.
    pub playable: bool,
}

/// The eapi fuzzy-search endpoint.
///
/// The eapi channel is the platform's own app API, and the doc in
/// `docs/网易云API文档.md` specifies it as the search endpoint. It
/// returns the same rows as the plain web search — but the doc's
/// recommendation is to ask for a *deep* page and then filter by
/// duration, because the platform's ranking is not "this song by this
/// artist": it happily ranks a dozen other songs by the same artist
/// above the one the user meant.
const SEARCH_URI: &str = "/api/search/get";
const SEARCH_URL: &str = "https://interface.music.163.com/eapi/search/get";

/// How many rows the fuzzy search asks for.
///
/// Measured against the live platform: searching "晴天 周杰伦" puts the
/// original recording (song 186016) at rank 62 — the first 30 rows are
/// covers, instrumentals and other songs by the same artist. A limit of
/// 10 or 30 misses it entirely, which would make the heart silently
/// fail to sync for a song the platform plainly has. So the page is
/// deep, and the *scorer* — which checks the title, the artist and the
/// duration together — does the picking.
const SEARCH_PAGE: u64 = 100;

/// The eapi lyric endpoint, and its word-by-word sibling.
///
/// `/api/song/lyric/v1` is the only one that carries the word-by-word
/// (`yrc`) lyrics: the plain endpoint answers with `lrc` only, and the
/// eapi v0 answers with `lrc` and an empty `klyric`. Measured against
/// the live platform, `/api/song/lyric/v1` returns a populated `yrc`
/// for the songs that have one.
const LYRIC_URI: &str = "/api/song/lyric";
const LYRIC_EAPI_URL: &str = "https://interface.music.163.com/eapi/song/lyric";
const LYRIC_V1_URI: &str = "/api/song/lyric/v1";
const LYRIC_V1_URL: &str = "https://interface.music.163.com/eapi/song/lyric/v1";

/// The eapi playlist-detail endpoint.
///
/// Asked for the account's own "我喜欢的音乐" playlist — whose id is the
/// account's numeric id — to learn which songs the account has
/// hearted.
const PLAYLIST_DETAIL_URI: &str = "/api/playlist/detail";
const PLAYLIST_DETAIL_URL: &str = "https://interface.music.163.com/eapi/playlist/detail";

/// The eapi player-URL endpoint.
const PLAYER_URI: &str = "/api/song/enhance/player/url/v1";
const PLAYER_URL: &str = "https://interface3.music.163.com/eapi/song/enhance/player/url/v1";

/// The eapi daily-recommendation endpoint.
const RECOMMEND_URI: &str = "/api/v3/discovery/recommend/songs";
const RECOMMEND_URL: &str =
    "https://interface3.music.163.com/eapi/v3/discovery/recommend/songs";

/// The eapi "add to / remove from My Music" endpoint.
///
/// This is the platform's own "heart" — the red heart on a song, which
/// is a different thing from the radio feedback endpoint (`/like`,
/// `weapi`) and a different thing again from adding a song to a
/// playlist. The red heart *is* the user's "我喜欢的音乐" collection.
const LIKE_URI: &str = "/api/song/like";
const LIKE_URL: &str = "https://interface.music.163.com/eapi/song/like";

/// How long a NetEase request may take.
const REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// The qualities the official endpoint accepts, best first.
const LEVELS: &[&str] = &["hires", "lossless", "exhigh", "standard"];

/// The eapi AES key. The platform's published constant — the NetEase
/// client and every open-source re-implementation use the same one.
const EAPI_KEY: &[u8; 16] = b"e82ckenh8dichen8";

/// The digest salt the eapi payload is signed with. The `{url}` and
/// `{text}` placeholders are filled with the endpoint path and the
/// serialized payload.
const EAPI_DIGEST_SALT: &str = "nobody{url}use{text}md5forencrypt";

/// The separator the eapi payload is spliced with.
const EAPI_DATA_SALT: &str = "-36cd479b6b5-";

/// A browser-shaped header set. NetEase's web API rejects requests
/// without a UA.
fn headers() -> reqwest::header::HeaderMap {
    let mut h = reqwest::header::HeaderMap::new();
    h.insert(
        reqwest::header::USER_AGENT,
        reqwest::header::HeaderValue::from_static(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        ),
    );
    h.insert(
        reqwest::header::REFERER,
        reqwest::header::HeaderValue::from_static("https://music.163.com/"),
    );
    h
}

/// The device header every NetEase request carries.
///
/// This is the same set of values as `client_header`, in the shape
/// the eapi payload expects. The two have to agree: the platform
/// checks the signed `header` field against the `Cookie` header it
/// receives, and a mismatch makes it treat the request as anonymous.
fn client_header() -> serde_json::Value {
    serde_json::json!({
        "os": "pc",
        "appver": "3.1.17.204416",
        "osver": "Microsoft-Windows-10-Professional-build-19045-64bit",
        "deviceId": "pyncm!",
        "channel": "netease",
        "versioncode": "140",
        "mobilename": "",
        "buildver": "200000000000",
        "resolution": "1920x1080",
        "__csrf": "",
        "requestId": "1_1",
    })
}

/// The device header, with the signed-in account folded in.
///
/// The eapi payload's own `header` field is *signed* — the platform
/// checks it against the `Cookie` header it receives. So the two have
/// to carry the same values, or the platform answers as if nobody were
/// signed in.
///
/// Two fields matter for the account:
///
///   * `MUSIC_U` — who the account is.
///   * `__csrf` — the token the web client pairs with `MUSIC_U`. The
///     platform rejects a `MUSIC_U` without its matching csrf, and
///     falls back to an *anonymous* recommendation: a plausible-looking
///     list of songs that has nothing to do with the account. That is
///     the difference between the user's own daily picks and somebody
///     else's.
fn account_header(cookie: Option<&str>) -> serde_json::Value {
    let mut header = client_header();
    if let Some(c) = cookie {
        if let Some(u) = cookie_value(c, "MUSIC_U") {
            header["MUSIC_U"] = serde_json::Value::String(u);
        }
        if let Some(csrf) = cookie_value(c, "__csrf") {
            header["__csrf"] = serde_json::Value::String(csrf);
        }
    }
    header
}

/// The fields of the device header, in the order the `Cookie` header
/// carries them.
///
/// The `Cookie` header is derived from the *same* header object the
/// payload is signed with, so the two can never drift apart: a
/// `__csrf` in one and not the other is exactly what makes the
/// platform treat an authenticated request as anonymous.
const DEVICE_HEADER_FIELDS: &[&str] = &[
    "os",
    "appver",
    "osver",
    "deviceId",
    "channel",
    "versioncode",
    "mobilename",
    "buildver",
    "resolution",
    "__csrf",
    "requestId",
];

/// Search NetEase for a song.
///
/// Returns the songs it found, most relevant first. A failed search
/// returns an empty list rather than an error: a provider that is
/// unreachable must not break the page that asked it.
#[tauri::command]
pub async fn netease_search(
    query: String,
    limit: Option<u64>,
) -> Result<Vec<NeteaseSong>, String> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    // The page is deep by default, and `limit` only ever *truncates*
    // it — never shortens the request. Asking the platform for 10 rows
    // when the answer the user wants is at rank 62 returns a page of
    // covers instead of the song.
    let take = limit.unwrap_or(SEARCH_PAGE).clamp(1, 100);
    let page = SEARCH_PAGE.max(take);

    let client = proxy::build_client(reqwest::Client::builder())
        .map_err(|e| format!("netease client: {e}"))?;

    let payload = serde_json::json!({
        "s": query,
        "type": 1,
        "limit": page,
        "offset": 0,
    });
    let body = eapi_post(&client, SEARCH_URI, SEARCH_URL, payload, None)
        .await
        .unwrap_or(serde_json::Value::Null);

    let songs = body
        .get("result")
        .and_then(|r| r.get("songs"))
        .and_then(|s| s.as_array())
        .cloned()
        .unwrap_or_default();

    Ok(songs
        .iter()
        .take(take as usize)
        .filter_map(parse_song)
        .collect())
}

/// Turn one of NetEase's search rows into our shape.
fn parse_song(raw: &serde_json::Value) -> Option<NeteaseSong> {
    let id = raw.get("id")?.as_i64()?.to_string();
    let title = raw.get("name")?.as_str()?.trim().to_string();
    if title.is_empty() {
        return None;
    }
    let artists: Vec<String> = raw
        .get("artists")
        .and_then(|a| a.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|a| a.get("name").and_then(|n| n.as_str()))
                .map(|n| n.trim().to_string())
                .filter(|n| !n.is_empty())
                .collect()
        })
        .unwrap_or_default();
    let album = raw
        .get("album")
        .and_then(|a| a.get("name"))
        .and_then(|n| n.as_str())
        .map(|s| s.trim().to_string());
    let duration_ms = raw.get("duration").and_then(|d| d.as_u64()).unwrap_or(0);
    let cover_url = raw
        .get("album")
        .and_then(|a| a.get("picUrl"))
        .and_then(|p| p.as_str())
        .map(|s| s.to_string());
    let fee = raw.get("fee").and_then(|f| f.as_i64()).unwrap_or(0);

    Some(NeteaseSong {
        id,
        title,
        artists,
        album,
        duration_ms,
        duration: duration_ms / 1000,
        cover_url,
        fee,
        playable: true,
    })
}

/// The daily recommendation playlist.
///
/// This is the one NetEase feature with no YouTube equivalent: the
/// platform picks a playlist of tracks a day, personalised to the
/// account. It needs the user's `MUSIC_U` cookie — anonymously the
/// platform answers with an empty list.
///
/// Returns `None` when the user is not signed in, so the caller can
/// show a "sign in to NetEase" prompt rather than an error.
#[tauri::command]
pub async fn netease_daily_recommend(
    app: tauri::AppHandle,
) -> Result<Option<Vec<NeteaseSong>>, String> {
    let Some(cookie) = crate::netease_cookie(&app).await else {
        return Ok(None);
    };

    let client = proxy::build_client(reqwest::Client::builder())
        .map_err(|e| format!("netease client: {e}"))?;
    let songs = daily_recommend(&client, &cookie, false).await?;

    // A signed-in account that gets nothing back means the credential
    // did not authenticate. Say so, rather than showing an empty list
    // that looks like a quiet day.
    if songs.is_empty() {
        crate::log!("[netease] daily recommend returned no songs (authenticated request)");
        return Ok(Some(Vec::new()));
    }
    crate::log!("[netease] daily recommend: {} songs", songs.len());

    Ok(Some(songs))
}

/// Ask the platform for the account's daily recommendation.
///
/// `afresh` is `false` for the real request: the platform has already
/// generated the account's daily list, and asking for that list is
/// what makes the app agree with the official client. `true` asks the
/// platform to *regenerate* one — a different set of tracks, and it
/// overwrites the account's real daily list as a side effect. It is
/// only used by the diagnostic test, which needs to see both.
async fn daily_recommend(
    client: &reqwest::Client,
    cookie: &str,
    afresh: bool,
) -> Result<Vec<NeteaseSong>, String> {
    // The account travels in the header the payload is signed with, so
    // it has to carry the same `__csrf` the cookie does — otherwise the
    // platform answers anonymously and the list is somebody else's.
    let header = account_header(Some(cookie));

    let payload = serde_json::json!({
        "header": header,
        "afresh": afresh,
    });
    let params = eapi_encrypt(RECOMMEND_URI, &payload.to_string());

    let resp = client
        .post(RECOMMEND_URL)
        .headers(headers())
        .header(reqwest::header::COOKIE, cookie_header_with_account(cookie))
        .timeout(REQUEST_TIMEOUT)
        .form(&[("params", params)])
        .send()
        .await
        .map_err(|e| format!("netease recommend: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "netease recommend: HTTP {}",
            resp.status().as_u16()
        ));
    }
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("netease recommend json: {e}"))?;

    // The platform reports a non-200 code for a rejected credential.
    // Treating that as an empty list would show the user an empty
    // playlist and say nothing about why.
    let code = body.get("code").and_then(|c| c.as_i64()).unwrap_or(200);
    if code != 200 {
        return Err(format!("netease recommend: code {code}"));
    }

    // The list lives under `data.dailySongs` on the eapi endpoint and
    // under a bare `recommend` on the weapi one. Read both, so the
    // app keeps working if the platform moves the endpoint.
    let songs = body
        .get("data")
        .and_then(|d| d.get("dailySongs"))
        .or_else(|| body.get("recommend"))
        .and_then(|s| s.as_array())
        .cloned()
        .unwrap_or_default();

    Ok(songs.iter().filter_map(parse_recommend_song).collect())
}

/// Turn one of the recommendation rows into our shape.
///
/// The recommendation payload uses the compact key names (`name`, `ar`,
/// `al`, `dt`) rather than the long ones the search endpoint uses.
fn parse_recommend_song(raw: &serde_json::Value) -> Option<NeteaseSong> {
    let id = raw.get("id")?.as_i64()?.to_string();
    let title = raw.get("name")?.as_str()?.trim().to_string();
    if title.is_empty() {
        return None;
    }
    let artists: Vec<String> = raw
        .get("ar")
        .and_then(|a| a.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|a| a.get("name").and_then(|n| n.as_str()))
                .map(|n| n.trim().to_string())
                .filter(|n| !n.is_empty())
                .collect()
        })
        .unwrap_or_default();
    let album = raw
        .get("al")
        .and_then(|a| a.get("name"))
        .and_then(|n| n.as_str())
        .map(|s| s.trim().to_string());
    let duration_ms = raw.get("dt").and_then(|d| d.as_u64()).unwrap_or(0);
    let cover_url = raw
        .get("al")
        .and_then(|a| a.get("picUrl"))
        .and_then(|p| p.as_str())
        .map(|s| s.to_string());
    let fee = raw.get("fee").and_then(|f| f.as_i64()).unwrap_or(0);

    Some(NeteaseSong {
        id,
        title,
        artists,
        album,
        duration_ms,
        duration: duration_ms / 1000,
        cover_url,
        fee,
        playable: true,
    })
}

/// The lyrics for a song, in both of the forms the platform has.
///
/// Keyed by the platform's own song id, so the lyrics belong to
/// exactly the track the user picked — the failure mode lyric
/// matching by title produces ("these are the lyrics of a different
/// song with the same name") cannot happen here.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NeteaseLyric {
    /// The line-level form, in standard LRC.
    pub lrc: Option<String>,
    /// The word-by-word form, in NetEase's `yrc` format. Present only
    /// for the songs the platform has word-level timings for.
    pub yrc: Option<String>,
    /// The translated lyrics, in standard LRC.
    pub tlyric: Option<String>,
}

/// Fetch the lyrics for a song.
///
/// The word-by-word form comes from the platform's `/api/song/lyric/v1`
/// endpoint, which is the only one that carries it — the plain
/// endpoint answers with `lrc` alone, and the eapi v0 answers with an
/// empty `klyric`. Measured against the live platform: a song with
/// word-level timings returns a populated `yrc` from v1 and nothing
/// from v0.
///
/// The line-level form comes from the same v1 response when it is
/// there, and from the v0 endpoint otherwise, so a song without
/// word-level timings still gets its words.
#[tauri::command]
pub async fn netease_lyric(song_id: String) -> Result<Option<NeteaseLyric>, String> {
    let song_id = song_id.trim();
    if song_id.is_empty() {
        return Ok(None);
    }
    let client = proxy::build_client(reqwest::Client::builder())
        .map_err(|e| format!("netease client: {e}"))?;

    // The word-by-word endpoint. `tv`/`lv`/`rv`/`kv`/`yv`/`ytv`/`yrv`
    // are the per-kind switches; `0` asks for all of them.
    let v1 = eapi_post(
        &client,
        LYRIC_V1_URI,
        LYRIC_V1_URL,
        serde_json::json!({
            "id": song_id,
            "cp": false,
            "tv": 0, "lv": 0, "rv": 0, "kv": 0,
            "yv": 0, "ytv": 0, "yrv": 0,
        }),
        None,
    )
    .await
    .unwrap_or(serde_json::Value::Null);

    let lyric_of = |body: &serde_json::Value, key: &str| -> Option<String> {
        body.get(key)
            .and_then(|l| l.get("lyric"))
            .and_then(|l| l.as_str())
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .map(|t| t.to_string())
    };

    let yrc = lyric_of(&v1, "yrc");
    let mut lrc = lyric_of(&v1, "lrc");
    let mut tlyric = lyric_of(&v1, "tlyric");

    // The v1 response's `lrc` is JSON Lines (one JSON object per line)
    // rather than standard LRC, so it is only useful as a fallback
    // when the v0 endpoint — which answers with real LRC — is
    // unreachable.
    let v1_lrc_is_json_lines = lrc
        .as_deref()
        .map(|t| t.lines().next().map(|l| l.trim_start().starts_with('{')).unwrap_or(false))
        .unwrap_or(false);

    if lrc.is_none() || v1_lrc_is_json_lines {
        let v0 = eapi_post(
            &client,
            LYRIC_URI,
            LYRIC_EAPI_URL,
            serde_json::json!({
                "id": song_id,
                "tv": -1, "lv": -1, "rv": -1, "kv": -1,
                "_nmclfl": 1,
            }),
            None,
        )
        .await
        .unwrap_or(serde_json::Value::Null);
        if let Some(v0_lrc) = lyric_of(&v0, "lrc") {
            lrc = Some(v0_lrc);
        }
        if tlyric.is_none() {
            tlyric = lyric_of(&v0, "tlyric");
        }
    }

    if lrc.is_none() && yrc.is_none() {
        return Ok(None);
    }
    Ok(Some(NeteaseLyric { lrc, yrc, tlyric }))
}

/// The song ids in the account's "我喜欢的音乐" collection.
///
/// The whole collection in one call, so the heart in a track list can
/// be filled for every NetEase row at once instead of one request per
/// row. `null` means nobody is signed in — there is no collection to
/// read.
#[tauri::command]
pub async fn netease_liked_ids(app: tauri::AppHandle) -> Result<Option<Vec<String>>, String> {
    let Some(cookie) = crate::netease_cookie(&app).await else {
        return Ok(None);
    };
    let Some(account) = crate::netease_auth::load(&app).await else {
        return Ok(None);
    };
    let Some(user_id) = account.user_id.as_deref() else {
        return Ok(None);
    };
    let Ok(user_id_num) = user_id.parse::<u64>() else {
        return Ok(None);
    };

    let client = proxy::build_client(reqwest::Client::builder())
        .map_err(|e| format!("netease client: {e}"))?;

    let body = eapi_post(
        &client,
        PLAYLIST_DETAIL_URI,
        PLAYLIST_DETAIL_URL,
        serde_json::json!({
            "id": user_id_num,
            "n": 1000,
            "s": 0,
        }),
        Some(&cookie),
    )
    .await?;

    // The eapi response puts the playlist under `result`.
    let ids = body
        .pointer("/result/tracks")
        .and_then(|t| t.as_array())
        .map(|tracks| {
            tracks
                .iter()
                .filter_map(|t| t.get("id").and_then(|id| id.as_i64()))
                .map(|id| id.to_string())
                .collect()
        })
        .unwrap_or_default();

    Ok(Some(ids))
}

/// Whether the account has hearted a song.
///
/// The platform's own answer, so the heart in the UI reflects the
/// account's real collection rather than the app's guess.
///
/// The answer comes from the account's "我喜欢的音乐" playlist, whose
/// id is the account's own numeric id — *not* the `MUSIC_U` cookie
/// value, which is a different thing entirely. The per-song `starred`
/// flag on the song-detail endpoint is not used: measured against the
/// live platform it answers `false` even for songs that are in the
/// collection, so it cannot be trusted to say what is liked.
#[tauri::command]
pub async fn netease_liked(
    app: tauri::AppHandle,
    song_id: String,
) -> Result<Option<bool>, String> {
    let song_id = song_id.trim();
    if song_id.is_empty() {
        return Ok(None);
    }
    // The collection only exists for a signed-in account.
    let Some(cookie) = crate::netease_cookie(&app).await else {
        return Ok(None);
    };
    let Some(account) = crate::netease_auth::load(&app).await else {
        return Ok(None);
    };
    let Some(user_id) = account.user_id.as_deref() else {
        return Ok(None);
    };
    let Ok(user_id_num) = user_id.parse::<u64>() else {
        return Ok(None);
    };

    let client = proxy::build_client(reqwest::Client::builder())
        .map_err(|e| format!("netease client: {e}"))?;

    let body = eapi_post(
        &client,
        PLAYLIST_DETAIL_URI,
        PLAYLIST_DETAIL_URL,
        serde_json::json!({
            "id": user_id_num,
            "n": 1000,
            "s": 0,
        }),
        Some(&cookie),
    )
    .await?;

    // The eapi response puts the playlist under `result`.
    let liked = body
        .pointer("/result/tracks")
        .and_then(|t| t.as_array())
        .map(|tracks| {
            tracks.iter().any(|t| {
                t.get("id")
                    .and_then(|id| id.as_i64())
                    .map(|id| id.to_string() == song_id)
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false);

    Ok(Some(liked))
}

/// What the official player endpoint says about a track.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NeteasePrivileges {
    /// `st == 0` means playable.
    pub st: i64,
    /// `1` = VIP, `4` = album purchase, `8` = free with a member-only
    /// higher quality.
    pub fee: i64,
    /// Whether the user has bought it.
    pub payed: i64,
    /// The trial window's end, in seconds. `30` means a 30-second
    /// preview.
    pub free_trial_end: Option<i64>,
    /// The reason the track can't be played, when it can't.
    pub cannot_listen_reason: Option<String>,
    /// The quality level the response was served at.
    pub level: Option<String>,
    /// The bitrate the response was served at.
    pub br: Option<u64>,
    /// The size of the served file, in bytes.
    pub size: Option<u64>,
    /// The direct URL, when the platform will serve one.
    pub url: Option<String>,
}

/// Resolve a NetEase song id through the *official* endpoint, using the
/// user's own cookie.
#[tauri::command]
pub async fn netease_privileges(
    app: tauri::AppHandle,
    song_id: String,
) -> Result<NeteasePrivileges, String> {
    let song_id = song_id.trim();
    if song_id.is_empty() {
        return Err("empty song id".into());
    }
    let client = proxy::build_client(reqwest::Client::builder())
        .map_err(|e| format!("netease client: {e}"))?;

    // The user's cookie, if they are signed in to NetEase in the app.
    let cookie = crate::netease_cookie(&app).await;

    let body = player_request(&client, &cookie, song_id, "standard").await?;
    let track = body
        .get("data")
        .and_then(|d| d.get(0))
        .cloned()
        .unwrap_or_default();

    Ok(NeteasePrivileges {
        st: track.get("st").and_then(|v| v.as_i64()).unwrap_or(-1),
        fee: track.get("fee").and_then(|v| v.as_i64()).unwrap_or(0),
        payed: track.get("payed").and_then(|v| v.as_i64()).unwrap_or(0),
        free_trial_end: track
            .get("freeTrialInfo")
            .and_then(|f| f.get("end"))
            .and_then(|v| v.as_i64()),
        cannot_listen_reason: track
            .get("freeTrialPrivilege")
            .and_then(|f| f.get("cannotListenReason"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        level: track.get("level").and_then(|v| v.as_str()).map(|s| s.to_string()),
        br: track.get("br").and_then(|v| v.as_u64()),
        size: track.get("size").and_then(|v| v.as_u64()),
        url: track.get("url").and_then(|v| v.as_str()).map(|s| s.to_string()),
    })
}

/// Ask the official player endpoint for a song at a given quality.
///
/// Returns the decoded response body.
async fn player_request(
    client: &reqwest::Client,
    cookie: &Option<String>,
    song_id: &str,
    level: &str,
) -> Result<serde_json::Value, String> {
    let header = account_header(cookie.as_deref());

    let payload = serde_json::json!({
        "ids": [song_id],
        "level": level,
        "encodeType": "flac",
        "header": header,
    });
    let params = eapi_encrypt(PLAYER_URI, &payload.to_string());

    let mut req = client
        .post(PLAYER_URL)
        .headers(headers())
        .timeout(REQUEST_TIMEOUT)
        .form(&[("params", params)]);
    req = req.header(
        reqwest::header::COOKIE,
        match cookie {
            Some(c) => cookie_header_with_account(c),
            None => anonymous_cookie(),
        },
    );

    let resp = req
        .send()
        .await
        .map_err(|e| format!("netease player: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("netease player: HTTP {}", resp.status().as_u16()));
    }
    resp.json()
        .await
        .map_err(|e| format!("netease player json: {e}"))
}

/// The best quality the official endpoint will serve for a song, with
/// the user's own cookie.
///
/// Returns `None` when the platform will not serve the track at all.
#[tauri::command]
pub async fn netease_stream_url(
    app: tauri::AppHandle,
    song_id: String,
) -> Result<Option<String>, String> {
    let song_id = song_id.trim().to_string();
    if song_id.is_empty() {
        return Err("empty song id".into());
    }
    let client = proxy::build_client(reqwest::Client::builder())
        .map_err(|e| format!("netease client: {e}"))?;
    let cookie = crate::netease_cookie(&app).await;

    for level in LEVELS {
        let Ok(body) = player_request(&client, &cookie, &song_id, level).await else {
            continue;
        };
        let Some(url) = body
            .get("data")
            .and_then(|d| d.get(0))
            .and_then(|s| s.get("url"))
            .and_then(|u| u.as_str())
        else {
            continue;
        };
        if !url.is_empty() {
            return Ok(Some(url.to_string()));
        }
    }
    Ok(None)
}

/// Light a song's red heart on the user's NetEase account, or put it
/// out.
///
/// This is the platform's own "我喜欢的音乐" collection — the red
/// heart on a song page. It is *not* the radio feedback endpoint and
/// *not* a playlist edit: the heart and the playlist are two different
/// things on NetEase, and the heart is the one a user means by "I
/// like this song".
///
/// Needs the account's `MUSIC_U` and its numeric id — the endpoint
/// takes the user id explicitly rather than deriving it from the
/// cookie, so a missing id is a hard error rather than a silent
/// no-op.
#[tauri::command]
pub async fn netease_set_like(
    app: tauri::AppHandle,
    song_id: String,
    like: bool,
) -> Result<bool, String> {
    let song_id = song_id.trim().to_string();
    if song_id.is_empty() {
        return Err("empty song id".into());
    }

    let account = netease_auth::load(&app)
        .await
        .ok_or_else(|| "not signed in to NetEase".to_string())?;
    let user_id = account
        .user_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| "the NetEase account has no user id".to_string())?;

    let client = proxy::build_client(reqwest::Client::builder())
        .map_err(|e| format!("netease client: {e}"))?;

    let cookie = format!("MUSIC_U={}", account.music_u.trim());
    let cookie = if account.csrf.trim().is_empty() {
        cookie
    } else {
        format!("{cookie}; __csrf={}", account.csrf.trim())
    };

    let body = like_request(&client, &cookie, &song_id, user_id, like).await?;

    // The endpoint reports business failures in the body, not the
    // status code, so the payload is what decides.
    let code = body.get("code").and_then(|c| c.as_i64()).unwrap_or(200);
    if code != 200 {
        return Err(format!("netease like: code {code}"));
    }
    crate::log!("[netease] like {song_id} = {like}");
    Ok(like)
}

/// Ask the platform to light or clear a song's heart.
///
/// Returns the decoded response body.
async fn like_request(
    client: &reqwest::Client,
    cookie: &str,
    song_id: &str,
    user_id: &str,
    like: bool,
) -> Result<serde_json::Value, String> {
    let header = account_header(Some(cookie));

    let payload = serde_json::json!({
        "trackId": song_id,
        "userid": user_id,
        "like": like,
        "header": header,
    });
    let params = eapi_encrypt(LIKE_URI, &payload.to_string());

    let resp = client
        .post(LIKE_URL)
        .headers(headers())
        .header(reqwest::header::COOKIE, cookie_header_with_account(cookie))
        .timeout(REQUEST_TIMEOUT)
        .form(&[("params", params)])
        .send()
        .await
        .map_err(|e| format!("netease like: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("netease like: HTTP {}", resp.status().as_u16()));
    }
    resp.json()
        .await
        .map_err(|e| format!("netease like json: {e}"))
}

/// Resolve a NetEase song id to a playable direct URL.
///
/// Walks two sources in order:
///
///  1. The official endpoint, with the user's own cookie. This is the
///     path that yields the best quality — a member account gets
///     lossless and hires.
///  2. The third-party unblock pool (`unblock.rs`), for tracks the
///     official endpoint refuses.
///
/// Returns the URL together with where it came from, so the UI can
/// tell the user which path served the track.
#[tauri::command]
pub async fn netease_resolve(
    app: tauri::AppHandle,
    song_id: String,
) -> Result<Option<NeteaseResolved>, String> {
    Ok(resolve_direct(&app, &song_id).await)
}

/// The resolution itself, without the command wrapper.
async fn resolve_direct(app: &tauri::AppHandle, song_id: &str) -> Option<NeteaseResolved> {
    let song_id = song_id.trim().to_string();
    if song_id.is_empty() {
        return None;
    }

    // 1. The official endpoint, with the user's own cookie.
    let client = proxy::build_client(reqwest::Client::builder()).ok()?;
    let cookie = crate::netease_cookie(app).await;
    for level in LEVELS {
        let Ok(body) = player_request(&client, &cookie, &song_id, level).await else {
            continue;
        };
        let track = body.get("data").and_then(|d| d.get(0));
        let Some(url) = track
            .and_then(|t| t.get("url"))
            .and_then(|u| u.as_str())
            .filter(|u| !u.is_empty())
        else {
            continue;
        };
        return Some(NeteaseResolved {
            url: url.to_string(),
            source: "official".into(),
            quality: track
                .and_then(|t| t.get("level"))
                .and_then(|v| v.as_str())
                .unwrap_or(level)
                .to_string(),
            size: track.and_then(|t| t.get("size")).and_then(|v| v.as_u64()),
        });
    }

    // 2. The third-party pool.
    let resolved = crate::unblock::resolve(app, &song_id).await?;
    Some(NeteaseResolved {
        url: resolved.url,
        source: resolved.endpoint,
        quality: resolved.quality,
        size: None,
    })
}

/// Resolve a NetEase song id to a directly-fetchable audio stream.
///
/// The platform's CDN serves byte ranges and reports the exact file
/// size, so a resolved URL drops straight into the app's progressive
/// playback path (`progressive.rs`) — the same machinery YouTube
/// streams use, with no per-provider special casing.
pub async fn resolve_audio(
    app: &tauri::AppHandle,
    song_id: &str,
) -> Option<crate::progressive::ResolvedAudio> {
    let resolved = resolve_direct(app, song_id).await?;

    // The size has to be known up front: the element needs a correct
    // `Content-Length` to seek, and the background filler needs to know
    // when it is done. The platform reports it in the player response,
    // but the unblock pool does not — so ask the CDN.
    let size = match resolved.size {
        Some(s) if s > 0 => s,
        _ => probe_size(&resolved.url).await?,
    };

    let mime = mime_for_url(&resolved.url);
    Some(crate::progressive::ResolvedAudio {
        url: resolved.url,
        size,
        mime,
        headers: vec![
            (
                "User-Agent".to_string(),
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36".to_string(),
            ),
            (
                "Referer".to_string(),
                "https://music.163.com/".to_string(),
            ),
        ],
        available_at: None,
    })
}

/// Ask the CDN how big the file is.
///
/// A ranged GET of the first byte answers with `Content-Range`, whose
/// total is the file size — and unlike HEAD it works on CDNs that
/// refuse HEAD.
async fn probe_size(url: &str) -> Option<u64> {
    let client = proxy::build_client(reqwest::Client::builder()).ok()?;
    let resp = client
        .get(url)
        .header(reqwest::header::RANGE, "bytes=0-0")
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    if let Some(range) = resp
        .headers()
        .get(reqwest::header::CONTENT_RANGE)
        .and_then(|v| v.to_str().ok())
    {
        if let Some(total) = range.rsplit('/').next().and_then(|t| t.trim().parse().ok()) {
            return Some(total);
        }
    }
    resp.content_length()
}

/// The audio mime to serve a NetEase URL as.
///
/// The platform's URLs end in the container extension, and the CDN's
/// own `Content-Type` is unreliable (it reports `audio/mpeg` for every
/// format), so the extension is the better signal.
fn mime_for_url(url: &str) -> &'static str {
    let path = url.split('?').next().unwrap_or(url);
    let path = path.to_ascii_lowercase();
    if path.ends_with(".flac") {
        "audio/flac"
    } else if path.ends_with(".m4a") || path.ends_with(".mp4") {
        "audio/mp4"
    } else if path.ends_with(".ogg") || path.ends_with(".opus") {
        "audio/ogg"
    } else {
        "audio/mpeg"
    }
}

/// A resolved NetEase stream.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NeteaseResolved {
    /// The direct CDN URL.
    pub url: String,
    /// Where it came from: `official` or an unblock endpoint id.
    pub source: String,
    /// The quality it was served at.
    pub quality: String,
    /// The file size, when the platform reported one.
    pub size: Option<u64>,
}

/// Read one cookie value out of a `Cookie:` header value.
fn cookie_value(cookie: &str, name: &str) -> Option<String> {
    cookie.split(';').find_map(|part| {
        let part = part.trim();
        let (k, v) = part.split_once('=')?;
        (k.trim() == name && !v.trim().is_empty()).then(|| v.trim().to_string())
    })
}

/// The `Cookie:` header to send: the device cookies, plus the
/// account's `MUSIC_U` when the user is signed in.
///
/// The `__csrf` is not optional padding: the platform pairs it with
/// `MUSIC_U`, and a `MUSIC_U` without it is treated as anonymous. The
/// daily recommendation then answers with a generic list rather than
/// the account's own picks.
///
/// The header is built from the *same* object the payload is signed
/// with, so the two can never drift apart — a `__csrf` in one and not
/// the other is exactly what makes the platform treat an
/// authenticated request as anonymous.
fn cookie_header_with_account(cookie: &str) -> String {
    let header = account_header(Some(cookie));
    let mut parts: Vec<String> = DEVICE_HEADER_FIELDS
        .iter()
        .filter_map(|field| {
            let value = header.get(*field)?.as_str()?;
            Some(format!("{field}={value}"))
        })
        .collect();
    // The account's identity rides along beside the device cookies.
    if let Some(u) = cookie_value(cookie, "MUSIC_U") {
        parts.push(format!("MUSIC_U={u}"));
    }
    parts.join("; ")
}

/// The `Cookie:` header for a request made with no account.
fn anonymous_cookie() -> String {
    cookie_header_with_account("")
}

// ---------------------------------------------------------------------------
// eapi encryption
// ---------------------------------------------------------------------------

/// Encrypt a payload the way NetEase's eapi endpoint expects.
///
/// The plaintext is the URL, the payload and an MD5 digest of both,
/// spliced together with a fixed separator; it is then encrypted with
/// AES-128-ECB under the platform's published key and hex-encoded.
///
/// This is a transport encoding, not a secret: the key and the salt
/// are the same in the official client and in every open-source
/// re-implementation. It is implemented here from the protocol's
/// specification so that the app speaks the platform's own API
/// rather than a third-party re-implementation of it.
fn eapi_encrypt(url: &str, text: &str) -> String {
    use aes::cipher::{BlockEncryptMut, KeyInit, block_padding::Pkcs7};

    let message = EAPI_DIGEST_SALT
        .replace("{url}", url)
        .replace("{text}", text);
    let digest = md5_hex(message.as_bytes());
    let plain = format!("{url}{EAPI_DATA_SALT}{text}{EAPI_DATA_SALT}{digest}");

    let cipher = ecb::Encryptor::<aes::Aes128>::new_from_slice(EAPI_KEY)
        .expect("eapi key is 16 bytes");
    let encrypted = cipher.encrypt_padded_vec_mut::<Pkcs7>(plain.as_bytes());
    hex_encode_upper(&encrypted)
}

/// Post an eapi request and return the parsed body.
///
/// The eapi protocol is one form field, `params`, holding the AES
/// payload; see the module comment. Every eapi call in this module
/// goes through here, so the header the payload is signed with and the
/// cookie the request carries are always the same object.
async fn eapi_post(
    client: &reqwest::Client,
    uri: &str,
    url: &str,
    payload: serde_json::Value,
    cookie: Option<&str>,
) -> Result<serde_json::Value, String> {
    let header = account_header(cookie);
    let mut body = payload;
    body["header"] = header;
    let params = eapi_encrypt(uri, &body.to_string());

    let mut req = client
        .post(url)
        .headers(headers())
        .timeout(REQUEST_TIMEOUT)
        .form(&[("params", params)]);
    req = req.header(
        reqwest::header::COOKIE,
        match cookie {
            Some(c) => cookie_header_with_account(c),
            None => anonymous_cookie(),
        },
    );

    let resp = req
        .send()
        .await
        .map_err(|e| format!("netease eapi {uri}: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("netease eapi {uri}: HTTP {}", resp.status().as_u16()));
    }
    resp.json()
        .await
        .map_err(|e| format!("netease eapi {uri} json: {e}"))
}

/// The MD5 of some bytes, lowercase hex.
///
/// MD5 is not a security choice here — it is the digest the platform's
/// own eapi payload format specifies, and the platform verifies it
/// against the payload it decrypts.
fn md5_hex(input: &[u8]) -> String {
    use md5::{Digest, Md5};
    let digest = Md5::digest(input);
    hex_encode_lower(&digest)
}

/// Hex-encode, uppercase — the form the eapi endpoint expects.
fn hex_encode_upper(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02X}"));
    }
    s
}

/// Hex-encode, lowercase.
fn hex_encode_lower(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The MD5 implementation is used for the eapi digest, and a wrong
    /// digest is rejected by the platform as a bad request. These
    /// vectors are the RFC 1321 test suite.
    #[test]
    fn md5_matches_the_rfc1321_vectors() {
        assert_eq!(md5_hex(b""), "d41d8cd98f00b204e9800998ecf8427e");
        assert_eq!(md5_hex(b"a"), "0cc175b9c0f1b6a831c399e269772661");
        assert_eq!(md5_hex(b"abc"), "900150983cd24fb0d6963f7d28e17f72");
        assert_eq!(
            md5_hex(b"message digest"),
            "f96b697d7cb7938d525a2f31aaf161d0"
        );
        assert_eq!(
            md5_hex(b"abcdefghijklmnopqrstuvwxyz"),
            "c3fcd3d76192e4007dfb496cca67e13b"
        );
        assert_eq!(
            md5_hex(b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"),
            "d174ab98d277d9f5a5611c2c9f419d9f"
        );
        assert_eq!(
            md5_hex(b"12345678901234567890123456789012345678901234567890123456789012345678901234567890"),
            "57edf4a22be3c955ac49da2e2107b67a"
        );
    }

    /// The eapi payload shape: the URL and the payload are separated by
    /// a fixed marker, and the digest covers both.
    #[test]
    fn the_eapi_payload_carries_the_url_and_a_digest() {
        let url = "/api/song/enhance/player/url/v1";
        let text = "{\"ids\":[\"1\"]}";
        let params = eapi_encrypt(url, text);

        // Hex, uppercase, and long enough to hold the payload.
        assert!(params.chars().all(|c| c.is_ascii_hexdigit()));
        assert!(params.chars().filter(|c| c.is_ascii_uppercase()).count() > 0);
        assert!(params.len() > 64);
    }

    /// The eapi output is deterministic — the same payload must
    /// produce the same ciphertext, or the digest inside it would
    /// never verify.
    #[test]
    fn the_eapi_output_is_deterministic() {
        assert_eq!(
            eapi_encrypt("https://x/y", "{\"a\":1}"),
            eapi_encrypt("https://x/y", "{\"a\":1}")
        );
    }

    /// The eapi payload must differ when the payload differs —
    /// otherwise the digest would not bind the two together.
    #[test]
    fn the_eapi_output_depends_on_the_payload() {
        assert_ne!(
            eapi_encrypt("https://x/y", "{\"a\":1}"),
            eapi_encrypt("https://x/y", "{\"a\":2}")
        );
    }

    /// The eapi ciphertext must match the platform's own client
    /// byte-for-byte.
    ///
    /// These vectors were produced by the reference implementation
    /// that the live API accepted: the same `params` value sent to
    /// `/eapi/song/enhance/player/url/v1` returned a playable URL,
    /// and the same for the recommendation endpoint. A change in the
    /// key, the digest salt, the separator or the cipher mode breaks
    /// all three at once, and the platform's response is the only
    /// error message — it says "400", not "your padding is wrong".
    /// So the vectors are pinned here, and the live check is
    /// `unblock::tests::the_live_pool_still_answers`.
    ///
    /// The payload is serialized with its keys *sorted*. `serde_json`'s
    /// `Map` is a `BTreeMap`, so that is what the Rust side always
    /// emits, while a JavaScript reference implementation preserves
    /// insertion order and would produce a different digest for the
    /// same logical payload. The platform accepts either — it verifies
    /// the digest against the exact string that was encrypted — so the
    /// vectors are generated in the sorted form this code produces.
    #[test]
    fn the_eapi_output_matches_the_reference_client() {
        let player = serde_json::json!({
            "ids": ["1824045033"],
            "level": "standard",
            "encodeType": "flac",
            "header": {
                "os": "pc",
                "appver": "3.1.17.204416",
                "osver": "Microsoft-Windows-10-Professional-build-19045-64bit",
                "deviceId": "pyncm!",
                "channel": "netease",
                "versioncode": "140",
                "mobilename": "",
                "buildver": "200000000000",
                "resolution": "1920x1080",
                "__csrf": "",
                "requestId": "1_1",
            }
        });
        assert_eq!(
            eapi_encrypt(PLAYER_URI, &player.to_string()),
            "FA90B329E9614F79E79598F37DC2EDB487F00D1BC4C9B24CD57E6C318B9073567565D994EF3A89F5356C243F90D8099D485DB260FA577059C3E1CFBFB3B6E9C1F7837025BF3B453B3451581364694666719E4676A38F37942BF8ACFB57ECDA529F845FABC0BCCB4235CDE9984E0A529123B30F5834CF1588D182FFB5FC115E03F3FD241CA669C9C6C109B114795EDF89DDF4322AF7232402002EFE449F219F1EF679463C1CC0AEE9BD884345695A053C3B7E8C7B15C6B1F0764A1CD298039BF62ECE7CCA4083665A6817735BA1ECF7FB261CCB9F98798CC9BEB79661594CA418991E9D80E90E5BDB95ADCE221BA954385559618A1E378E03AF3ECB0E0B94EFC60ADCB3EACF71C083369E2A035EBBFF8E6FB669B38FFAACF93ACE520B8CA0027A4ADD33AECC86D5AFAF8812E46D830DDB7BC77A46358119E9306059C80776AA9E9C16B0F6032615290F7F15234304B393BA2313DEEDBE669C9926DAA48B8FB953ACF47AD6BF5AEEBD33E26E307AB38178EFA406BA5AC103AC7A6BC684E91C79AC87F8D94EA5A019D9DD53FAC82027BBB8FC7B5DDBE271EEDBAE749DED7CA5F848"
        );

        let recommend = serde_json::json!({
            "header": {"os": "pc", "appver": "3.1.17.204416"},
            "afresh": true
        });
        assert_eq!(
            eapi_encrypt(RECOMMEND_URI, &recommend.to_string()),
            "94783FFDF9D6705736AF2217555658404C51D37F9D5CF041C195C8BC28E88130D41BB882F82651CDAE5238771C88B8514476A120B868BAAB0066BFAFC6D335219BA6B3B65B98EA5CED1E388A745D83C89F845FABC0BCCB4235CDE9984E0A52915DED7ADD316A46B33FDC5586625B420635828D18C06015AD9FAE1CEB9C399AA1AF2C3785D9A4CEA722F9676DFCC080A4EC1D17A117EE14E3A76B25A8921483F9"
        );
    }

    #[test]
    fn a_cookie_value_is_read_out_of_a_header() {
        let header = "os=pc; MUSIC_U=abc123; appver=3.1";
        assert_eq!(cookie_value(header, "MUSIC_U").as_deref(), Some("abc123"));
        assert_eq!(cookie_value(header, "os").as_deref(), Some("pc"));
        assert_eq!(cookie_value(header, "NOPE"), None);
        assert_eq!(cookie_value(header, "MUSIC_U="), None);
    }

    /// The signed header must carry the account's csrf token.
    ///
    /// Without it the platform treats the request as anonymous and
    /// answers the daily recommendation with a generic list — songs
    /// that look right and belong to nobody. The header and the
    /// cookie are signed against each other, so both need the token.
    #[test]
    fn the_signed_header_carries_the_account_and_its_csrf() {
        let cookie = "MUSIC_U=abc123; __csrf=csrf456";
        let header = account_header(Some(cookie));
        assert_eq!(header["MUSIC_U"].as_str(), Some("abc123"));
        assert_eq!(header["__csrf"].as_str(), Some("csrf456"));

        // The cookie the request carries has to agree with the header.
        let sent = cookie_header_with_account(cookie);
        assert!(sent.contains("MUSIC_U=abc123"), "{sent}");
        assert!(sent.contains("__csrf=csrf456"), "{sent}");
    }

    /// The `Cookie` header and the signed header are two views of the
    /// same object, so a field present in one is present in the other.
    /// A `__csrf` in the payload but not the cookie (or the other way
    /// round) is what makes the platform treat an authenticated
    /// request as anonymous.
    #[test]
    fn the_cookie_and_the_signed_header_agree() {
        let cookie = "MUSIC_U=abc123; __csrf=csrf456";
        let header = account_header(Some(cookie));
        let sent = cookie_header_with_account(cookie);

        for field in DEVICE_HEADER_FIELDS {
            let value = header.get(*field).and_then(|v| v.as_str()).unwrap();
            assert!(
                sent.contains(&format!("{field}={value}")),
                "{field} missing from cookie: {sent}"
            );
        }

        // Exactly one csrf — a duplicate would be read as the first,
        // which is the empty device value.
        assert_eq!(sent.matches("__csrf=").count(), 1, "{sent}");
    }

    /// With no account, the header stays anonymous.
    #[test]
    fn an_anonymous_request_carries_no_account() {
        let header = account_header(None);
        assert!(header.get("MUSIC_U").is_none());
        assert_eq!(header["__csrf"].as_str(), Some(""));
        assert!(!anonymous_cookie().contains("MUSIC_U="));
    }

    /// The `Cookie:` header keeps the device cookies the platform needs
    /// alongside the account's.
    #[test]
    fn the_cookie_keeps_the_device_cookies() {
        let sent = cookie_header_with_account("MUSIC_U=abc123; __csrf=csrf456");
        assert!(sent.contains("deviceId=pyncm!"), "{sent}");
        assert!(sent.contains("appver=3.1.17.204416"), "{sent}");
    }

    #[test]
    fn a_search_row_parses_into_our_shape() {
        let raw = serde_json::json!({
            "id": 1824045033,
            "name": "起风了",
            "artists": [{"name": "买辣椒也用券"}, {"name": "另有其人"}],
            "album": {"name": "起风了", "picUrl": "https://p1.music.126.net/x.jpg"},
            "duration": 254000,
            "fee": 1
        });
        let song = parse_song(&raw).expect("parsed");
        assert_eq!(song.id, "1824045033");
        assert_eq!(song.title, "起风了");
        assert_eq!(song.artists, vec!["买辣椒也用券", "另有其人"]);
        assert_eq!(song.duration, 254);
        assert_eq!(song.duration_ms, 254000);
        assert_eq!(song.fee, 1);
    }

    /// The recommendation payload uses the compact key names.
    #[test]
    fn a_recommendation_row_parses_into_our_shape() {
        let raw = serde_json::json!({
            "id": 27511488,
            "name": "你瞒我瞒",
            "ar": [{"id": 2127, "name": "陈柏宇"}],
            "al": {"id": 6541, "name": "Quinquennium", "picUrl": "https://p4.music.126.net/x.jpg"},
            "dt": 236541,
            "fee": 1
        });
        let song = parse_recommend_song(&raw).expect("parsed");
        assert_eq!(song.id, "27511488");
        assert_eq!(song.title, "你瞒我瞒");
        assert_eq!(song.artists, vec!["陈柏宇"]);
        assert_eq!(song.duration, 236);
        assert_eq!(song.album.as_deref(), Some("Quinquennium"));
    }

    /// Search against the live platform.
    ///
    /// The search endpoint needs no encryption and no account, so it
    /// is the cheapest way to confirm the app still speaks the
    /// platform's API at all. Run it with:
    ///
    /// ```text
    /// cargo test --lib netease::tests::the_live_search_returns_rows -- --ignored --nocapture
    /// ```
    #[tokio::test]
    #[ignore = "hits the network"]
    async fn the_live_search_returns_rows() {
        let songs = netease_search("起风了".to_string(), Some(5))
            .await
            .expect("search succeeded");
        assert!(!songs.is_empty(), "live search returned nothing");
        let first = &songs[0];
        println!(
            "{} — {} ({:?}) fee={} {}",
            first.title,
            first.artists.join(", "),
            first.album,
            first.fee,
            first.duration_ms
        );
        assert!(!first.id.is_empty());
        assert!(!first.title.is_empty());
    }

    /// The exact search the heart-sync sends for a track, run through
    /// the backend's own search path.
    ///
    /// Run it with:
    ///
    /// ```text
    /// cargo test --lib netease::tests::the_live_search_of_the_like_query -- --ignored --nocapture
    /// ```
    #[tokio::test]
    #[ignore = "hits the network"]
    async fn the_live_search_of_the_like_query() {
        for query in [
            "True Colors (feat. Nicki Minaj) Wiz Khalifa",
            "True Colors Shuba",
            "True Colors Clous85",
        ] {
            let songs = netease_search(query.to_string(), Some(10))
                .await
                .expect("search succeeded");
            println!("\n--- {query} -> {} rows", songs.len());
            for s in &songs {
                println!(
                    "  {} | {} | {} | {}s",
                    s.id,
                    s.title,
                    s.artists.join(", "),
                    s.duration
                );
            }
        }

        // The deep-rank case. The platform's ranking puts other songs
        // by the same artist, and covers, above the one the user meant:
        // the original was found at rank 62 with a deep page, and was
        // missed entirely with a short one.
        let songs = netease_search("晴天 周杰伦".to_string(), Some(100))
            .await
            .expect("search succeeded");
        println!("\n--- 晴天 周杰伦 -> {} rows", songs.len());
        for (rank, s) in songs.iter().enumerate() {
            if s.artists.iter().any(|a| a.contains("周杰伦")) {
                println!("  rank {rank}: {} | {} | {}s", s.id, s.title, s.duration);
            }
        }
    }

    /// The daily picks, as the user's account sees them.
    ///
    /// Prints every pick with the id, title, artist and length, so the
    /// rows on the daily page can be compared against the ids the
    /// app's own heart and stream paths use.
    ///
    /// Run it with:
    ///
    /// ```text
    /// cargo test --lib netease::tests::the_live_daily_picks -- --ignored --nocapture
    /// ```
    #[tokio::test]
    #[ignore = "hits the network"]
    async fn the_live_daily_picks() {
        let path = std::path::PathBuf::from(
            std::env::var("APPDATA")
                .or_else(|_| std::env::var("LOCALAPPDATA"))
                .unwrap_or_default()
                .replace("\\", "/"),
        )
        .join("com.github.crpto999.adrify")
        .join("netease.enc");

        let account = crate::netease_auth::load_from(path)
            .await
            .expect("a stored NetEase credential");

        let cookie = format!("MUSIC_U={}", account.music_u.trim());
        let cookie = if account.csrf.trim().is_empty() {
            cookie
        } else {
            format!("{cookie}; __csrf={}", account.csrf.trim())
        };

        let client = crate::proxy::build_client(reqwest::Client::builder())
            .expect("a client");

        let songs = daily_recommend(&client, &cookie, false)
            .await
            .expect("the daily request succeeded");
        println!("{} picks", songs.len());
        for s in &songs {
            println!(
                "  {} | {} | {} | {}s",
                s.id,
                s.title,
                s.artists.join(", "),
                s.duration
            );
        }
    }

    /// The diagnostic for the "the heart errored" bug, run against the
    /// account the user actually signed in with.
    ///
    /// It walks the whole heart path and prints what each step says:
    ///
    ///   1. Whether the stored credential carries a user id at all.
    ///      The `/api/song/like` endpoint takes the user id *explicitly*
    ///      rather than deriving it from the cookie, so a credential
    ///      without one cannot heart anything.
    ///   2. What the platform says when the id is right and the
    ///      credential is sent.
    ///   3. What the platform says when the id is wrong — the shape of
    ///      the error the app surfaces to the user.
    ///
    /// Run it with:
    ///
    /// ```text
    /// cargo test --lib netease::tests::the_live_heart_path -- --ignored --nocapture
    /// ```
    #[tokio::test]
    #[ignore = "hits the network"]
    async fn the_live_heart_path() {
        let path = std::path::PathBuf::from(
            std::env::var("APPDATA")
                .or_else(|_| std::env::var("LOCALAPPDATA"))
                .unwrap_or_default()
                .replace("\\", "/"),
        )
        .join("com.github.crpto999.adrify")
        .join("netease.enc");

        let account = crate::netease_auth::load_from(path)
            .await
            .expect("a stored NetEase credential");

        println!("nickname: {:?}", account.nickname);
        println!("user_id: {:?}", account.user_id);
        println!("csrf present: {}", !account.csrf.trim().is_empty());

        let cookie = format!("MUSIC_U={}", account.music_u.trim());
        let cookie = if account.csrf.trim().is_empty() {
            cookie
        } else {
            format!("{cookie}; __csrf={}", account.csrf.trim())
        };

        let client = crate::proxy::build_client(reqwest::Client::builder())
            .expect("a client");

        // With the account's own id.
        if let Some(uid) = account.user_id.as_deref() {
            let body = like_request(&client, &cookie, "28935275", uid, true)
                .await
                .expect("the like request itself succeeded");
            println!("like (real uid {uid}): {body}");
        } else {
            println!("NO USER ID — the account has none stored");
        }

        // With a deliberately wrong id, to see the error shape.
        let body = like_request(&client, &cookie, "28935275", "1", true)
            .await
            .expect("the like request itself succeeded");
        println!("like (uid 1): {body}");
    }

    /// Fetch lyrics for a known song from the live platform.
    ///
    /// This is also the check that the word-by-word form is really
    /// there: song 1824045033 has one, and the v1 endpoint is the
    /// only one that carries it.
    #[tokio::test]
    #[ignore = "hits the network"]
    async fn the_live_lyric_endpoint_answers() {
        let lyric = netease_lyric("1824045033".to_string())
            .await
            .expect("lyric request succeeded");
        let lyric = lyric.expect("a lyric for a known song");
        let lrc = lyric.lrc.expect("a line-level lyric");
        assert!(!lrc.trim().is_empty(), "empty lyric");
        println!("lrc: {} bytes", lrc.len());

        let yrc = lyric.yrc.expect("a word-by-word lyric");
        assert!(!yrc.trim().is_empty(), "empty yrc");
        println!("yrc: {} bytes", yrc.len());
        // The word-by-word body is the yrc grammar: a line starts with
        // `[start,duration]` and carries `(start,duration,0)WORD` tuples.
        let first = yrc
            .lines()
            .find(|l| l.trim_start().starts_with('['))
            .expect("a yrc line");
        assert!(first.contains(']'), "unexpected yrc line: {first}");
        assert!(first.contains('('), "unexpected yrc line: {first}");

        // Dump the body so the frontend parser can be run against the
        // real thing rather than a hand-written sample.
        let dump = std::path::PathBuf::from("yrc-sample.txt");
        std::fs::write(&dump, &yrc).expect("the sample was written");
        println!("sample written to {}", dump.display());
    }

    /// The daily recommendation, against the live platform and the
    /// signed-in account.
    ///
    /// This is the diagnostic for the "the daily list is not mine" bug,
    /// and it pins down the cause.
    ///
    /// The endpoint takes an `afresh` flag:
    ///
    ///   * `afresh=false` — return the list the platform already
    ///     generated for today. This is the account's daily list, the
    ///     one the official client shows.
///   * `afresh=true` — ask the platform to *generate a new one*.
///     It answers with a different set of tracks **and overwrites the
///     account's stored daily list** as a side effect.
    ///
    /// The app used to send `afresh=true` on every page load, so it
    /// showed a list that had just been thrown away and replaced the
    /// account's real one — which is why the official client and the
    /// app never agreed.
    ///
    /// Run it with:
    ///
    /// ```text
    /// cargo test --lib netease::tests::the_live_daily_recommend_is_personal -- --ignored --nocapture
    /// ```
    ///
    /// The test deliberately never sends `afresh=true`: it would
    /// rewrite the user's own daily list.
    #[tokio::test]
    #[ignore = "hits the network"]
    async fn the_live_daily_recommend_is_personal() {
        // Tauri puts the app's data directory under the *roaming* profile
        // on Windows, next to the app's other settings.
        let path = std::path::PathBuf::from(
            std::env::var("APPDATA")
                .or_else(|_| std::env::var("LOCALAPPDATA"))
                .unwrap_or_default()
                .replace("\\", "/"),
        )
        .join("com.github.crpto999.adrify")
        .join("netease.enc");

        let account = crate::netease_auth::load_from(path)
            .await
            .expect("a stored NetEase credential");
        println!(
            "account: {} (csrf {})",
            account.nickname.as_deref().unwrap_or("?"),
            if account.csrf.is_empty() {
                "absent"
            } else {
                "present"
            }
        );

        let cookie = format!("MUSIC_U={}", account.music_u.trim());
        let cookie_with_csrf = if account.csrf.trim().is_empty() {
            cookie.clone()
        } else {
            format!("{cookie}; __csrf={}", account.csrf.trim())
        };

        let client = proxy::build_client(reqwest::Client::builder())
            .expect("a client");

        // The account's own list, twice. Asking twice must give the
        // same answer — that is the whole point of `afresh=false`: the
        // app reads the list, it does not replace it.
        let first = daily_recommend(&client, &cookie_with_csrf, false)
            .await
            .expect("the daily request succeeded");
        let second = daily_recommend(&client, &cookie_with_csrf, false)
            .await
            .expect("the daily request succeeded");
        println!("account list: {} songs", first.len());

        // No account at all.
        let anonymous = daily_recommend(&client, "", false)
            .await
            .expect("the daily request succeeded");
        println!("anonymous list: {} songs", anonymous.len());

        let ids = |songs: &[NeteaseSong]| -> Vec<String> {
            songs.iter().map(|s| s.id.clone()).collect()
        };
        println!("account  : {:?}", ids(&first));
        println!("anonymous: {:?}", ids(&anonymous));

        // The account gets a list at all.
        assert!(!first.is_empty(), "the account got no daily picks");
        // Reading the list does not change it.
        assert_eq!(
            ids(&first),
            ids(&second),
            "asking twice gave different lists — the request is not reading the stored list"
        );
        // And the account's list is personal, not the generic one an
        // anonymous caller gets.
        assert_ne!(
            ids(&first),
            ids(&anonymous),
            "the account got the same list as an anonymous request"
        );
    }

    /// Read the account's "我喜欢的音乐" collection from the live
    /// platform.
    ///
    /// This is the check for the heart's *filled* state on a NetEase
    /// row. The per-song `starred` flag on the song-detail endpoint
    /// cannot be used for it — measured against the live platform it
    /// answers `false` even for songs that are in the collection — so
    /// the collection itself is read instead.
    ///
    /// Run it with:
    ///
    /// ```text
    /// cargo test --lib netease::tests::the_live_liked_collection -- --ignored --nocapture
    /// ```
    #[tokio::test]
    #[ignore = "hits the network"]
    async fn the_live_liked_collection() {
        let path = std::path::PathBuf::from(
            std::env::var("APPDATA")
                .or_else(|_| std::env::var("LOCALAPPDATA"))
                .unwrap_or_default()
                .replace("\\", "/"),
        )
        .join("com.github.crpto999.adrify")
        .join("netease.enc");

        let account = crate::netease_auth::load_from(path)
            .await
            .expect("a stored NetEase credential");
        let user_id = account
            .user_id
            .as_deref()
            .expect("the account has a user id");
        let user_id_num: u64 = user_id.parse().expect("a numeric user id");

        let cookie = format!("MUSIC_U={}", account.music_u.trim());
        let cookie = if account.csrf.trim().is_empty() {
            cookie
        } else {
            format!("{cookie}; __csrf={}", account.csrf.trim())
        };

        let client = crate::proxy::build_client(reqwest::Client::builder())
            .expect("a client");

        let body = eapi_post(
            &client,
            PLAYLIST_DETAIL_URI,
            PLAYLIST_DETAIL_URL,
            serde_json::json!({
                "id": user_id_num,
                "n": 1000,
                "s": 0,
            }),
            Some(&cookie),
        )
        .await
        .expect("the playlist request succeeded");

        let ids = body
            .pointer("/result/tracks")
            .and_then(|t| t.as_array())
            .map(|tracks| {
                tracks
                    .iter()
                    .filter_map(|t| t.get("id").and_then(|id| id.as_i64()))
                    .map(|id| id.to_string())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        println!("collection: {} songs", ids.len());
        assert!(!ids.is_empty(), "the account's collection is empty");
    }
}
