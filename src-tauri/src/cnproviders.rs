//! The Chinese music platforms: Migu, Kugou and QQ Music.
//!
//! # Why a separate module
//!
//! YouTube and NetEase have their own modules because their protocols
//! are unlike anything else. These three share a shape the other two
//! do not: a *plain* search endpoint (no encryption, no account) and a
//! *stream* endpoint that is either
//!
//!   1. the platform's own API — reachable without an account, but
//!      refused for the tracks the platform gates behind a membership,
//!      or
//!   2. a third-party resolver — a public API whose operator holds an
//!      account, which hands back a direct CDN link.
//!
//! That is the same arrangement the NetEase unblock pool (`unblock.rs`)
//! has, and for the same reason: the platforms gate their catalogue,
//! and the *only* way to reach a gated track without a membership is to
//! ask someone who has one.
//!
//! # What each platform needed
//!
//! - **Migu** answers its search endpoint in plain JSON, and its
//!   playback endpoint in an *encrypted* body: the response is XORed
//!   against a published key with a per-response seed byte. The
//!   decryption is implemented here (see `decrypt_migu`).
//! - **Kugou**'s search endpoint is plain JSON. Its playback endpoint
//!   wants an MD5-signed parameter set (see `signature_android`).
//! - **QQ Music**'s search endpoint is plain JSON. Its playback
//!   endpoint wants a `vkey` whose filename repeats the song id twice
//!   (see `qq_filename`), and the URL it returns is relative to the
//!   streaming domain.
//!
//! # What this module deliberately does not do
//!
//! It does not decrypt anything belonging to a paid account, forge a
//! signed-in identity, or bypass an access control. The official
//! endpoints are plain HTTPS calls a browser makes; the third-party
//! resolvers are public APIs whose accounts are their operators'
//! business, not ours.

use serde::Serialize;

use crate::proxy;

/// Unix seconds.
fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Unix milliseconds.
fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// How long a platform request may take.
const REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// The browser User-Agent the platforms expect.
const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";

/// One search result from any of the three platforms.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CnSong {
    /// The platform's own id for the song.
    pub id: String,
    pub title: String,
    pub artists: Vec<String>,
    pub album: Option<String>,
    /// Seconds.
    pub duration: u64,
    pub cover_url: Option<String>,
    /// The platform's own fee tier, where it reports one: 0 free,
    /// 1 VIP, 2 album purchase. `None` when the platform does not say.
    pub fee: Option<i64>,
}

// ---------------------------------------------------------------------------
// Migu
// ---------------------------------------------------------------------------

/// Migu's search endpoint. It answers in plain JSON.
const MIGU_SEARCH_URL: &str = "https://c.musicapp.migu.cn/v1.0/content/search_all.do";

/// Migu's playback endpoint. Its body is encrypted — see `decrypt_migu`.
const MIGU_LISTEN_URL: &str = "https://c.musicapp.migu.cn/strategy/listen-url/h5/v2.4";

/// Migu's resource lookup. Given a song's id it answers with the
/// metadata the search row does not carry (album art, the rate
/// formats, the lyric url).
const MIGU_RESOURCE_URL: &str = "https://c.musicapp.migu.cn/v1.0/content/resourceinfo.do";

/// The three bytes that mark an encrypted Migu body.
const MIGU_MAGIC: [u8; 3] = [0xab, 0xcd, 0x01];

/// Migu's published body-encryption key.
const MIGU_KEY: &[u8] = b"Jk8qzuePiJ1qE3mDYhLQ3T73DtDoAhLP";

/// The headers the Migu app client sends.
fn migu_headers() -> reqwest::header::HeaderMap {
    let mut h = reqwest::header::HeaderMap::new();
    h.insert(
        reqwest::header::USER_AGENT,
        reqwest::header::HeaderValue::from_static(UA),
    );
    for (name, value) in [
        ("accept", "application/json, text/plain, */*"),
        ("origin", "https://h5.nf.migu.cn"),
        ("referer", "https://h5.nf.migu.cn/"),
        ("ua", "Android_migu"),
        ("version", "6.8.8"),
        ("channel", "014021I"),
        ("subchannel", "014021I"),
    ] {
        if let (Ok(n), Ok(v)) = (
            reqwest::header::HeaderName::from_bytes(name.as_bytes()),
            reqwest::header::HeaderValue::from_str(value),
        ) {
            h.insert(n, v);
        }
    }
    h
}

/// Decrypt a Migu response body.
///
/// The body is `MAGIC || seed || ciphertext`, where each ciphertext byte
/// is `plaintext + seed - key[i % key.len()]` (mod 256). The seed is
/// per-response, which is why the key alone is not enough to decode a
/// body captured elsewhere.
fn decrypt_migu(raw: &[u8]) -> Option<serde_json::Value> {
    if raw.len() < 4 || raw[0..3] != MIGU_MAGIC {
        // Not encrypted: the endpoint answers in plain JSON when the
        // request does not ask for the encrypted form.
        return serde_json::from_slice(raw).ok();
    }
    let seed = raw[3];
    let plain: Vec<u8> = raw[4..]
        .iter()
        .enumerate()
        .map(|(i, b)| b.wrapping_add(seed).wrapping_sub(MIGU_KEY[i % MIGU_KEY.len()]))
        .collect();
    serde_json::from_slice(&plain).ok()
}

/// Search Migu.
pub async fn migu_search(
    query: String,
    limit: Option<u64>,
) -> Result<Vec<CnSong>, String> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let limit = limit.unwrap_or(20).clamp(1, 100) as usize;

    let client = proxy::build_client(reqwest::Client::builder())
        .map_err(|e| format!("migu client: {e}"))?;
    let resp = client
        .get(MIGU_SEARCH_URL)
        .headers(migu_headers())
        .query(&[
            ("text", query.to_string()),
            ("pageNo", "1".to_string()),
            ("pageSize", limit.to_string()),
            ("isCopyright", "1".to_string()),
            ("sort", "1".to_string()),
            (
                "searchSwitch",
                r#"{"song":1,"album":0,"singer":0,"tagSong":1,"mvSong":0,"bestShow":1}"#
                    .to_string(),
            ),
        ])
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|e| format!("migu search: {e}"))?;
    if !resp.status().is_success() {
        return Ok(Vec::new());
    }
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("migu search json: {e}"))?;

    let rows = body
        .get("songResultData")
        .and_then(|d| d.get("result"))
        .and_then(|r| r.as_array())
        .cloned()
        .unwrap_or_default();

    Ok(rows.iter().take(limit).filter_map(parse_migu_song).collect())
}

/// Turn a Migu search row into our shape.
fn parse_migu_song(row: &serde_json::Value) -> Option<CnSong> {
    // `contentId` is the id the playback endpoint wants.
    let id = row
        .get("contentId")
        .and_then(|v| v.as_str())
        .or_else(|| row.get("id").and_then(|v| v.as_str()))?
        .to_string();
    let title = row.get("name").and_then(|v| v.as_str())?.to_string();
    let artists: Vec<String> = row
        .get("singers")
        .and_then(|v| v.as_array())
        .map(|list| {
            list.iter()
                .filter_map(|s| s.get("name").and_then(|n| n.as_str()))
                .map(|s| s.to_string())
                .collect()
        })
        .unwrap_or_default();
    let album = row
        .get("albums")
        .and_then(|v| v.as_array())
        .and_then(|list| list.first())
        .and_then(|a| a.get("name"))
        .and_then(|n| n.as_str())
        .map(|s| s.to_string())
        .or_else(|| {
            row.get("album")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        });
    let cover = row
        .get("imgItems")
        .and_then(|v| v.as_array())
        .and_then(|list| list.last())
        .and_then(|i| i.get("img"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    Some(CnSong {
        id,
        title,
        artists,
        album,
        duration: 0,
        cover_url: cover,
        fee: None,
    })
}

/// Resolve a Migu song id to a playable URL.
///
/// The official path asks the platform for a listen URL. The song's
/// `contentId` is enough — the endpoint resolves the copyright id
/// itself — but the *rate formats* (which quality exists, and whether
/// it is behind a membership) come from the resource lookup, so both
/// are asked for.
pub async fn migu_resolve(song_id: &str) -> Option<CnResolved> {
    let song_id = song_id.trim();
    if song_id.is_empty() {
        return None;
    }
    let client = proxy::build_client(reqwest::Client::builder()).ok()?;

    // 1. The rate formats, so we know which quality to ask for.
    let formats = migu_rate_formats(&client, song_id).await;

    // 2. The official listen URL. The quality ladder is walked from
    //    best to worst; the first one the platform serves wins.
    for (tone, resource_type) in quality_ladder(&formats) {
        let Some(url) = migu_listen_url(&client, song_id, resource_type, tone).await else {
            continue;
        };
        return Some(CnResolved {
            url,
            source: "official".into(),
            quality: tone.to_string(),
            size: None,
        });
    }

    // 3. The third-party resolver.
    third_party_resolve(&client, "migu", song_id).await
}

/// The rate formats Migu offers for a song.
async fn migu_rate_formats(
    client: &reqwest::Client,
    song_id: &str,
) -> Vec<(String, String)> {
    let Ok(resp) = client
        .get(MIGU_RESOURCE_URL)
        .headers(migu_headers())
        .query(&[
            ("resourceId", song_id.to_string()),
            ("resourceType", "2".to_string()),
        ])
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
    else {
        return Vec::new();
    };
    let Ok(body) = resp.json::<serde_json::Value>().await else {
        return Vec::new();
    };
    let resource = body.get("resource").and_then(|r| r.as_array());
    let Some(resource) = resource else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in resource {
        for key in ["rateFormats", "newRateFormats", "audioFormats"] {
            let Some(list) = entry.get(key).and_then(|v| v.as_array()) else {
                continue;
            };
            for f in list {
                let (Some(tone), Some(rt)) = (
                    f.get("formatType").and_then(|v| v.as_str()),
                    f.get("resourceType").and_then(|v| v.as_str()),
                ) else {
                    continue;
                };
                // `Z3D` is an encrypted container the player cannot
                // decode; asking for it would only waste a round trip.
                if tone == "Z3D" {
                    continue;
                }
                out.push((tone.to_string(), rt.to_string()));
            }
        }
    }
    out
}

/// The quality ladder, best first, with the resource type each needs.
///
/// Migu's tone flags mean: `LQ` a plain mp3, `PQ`/`HQ` higher
/// bitrates, `SQ` lossless.
fn quality_ladder(formats: &[(String, String)]) -> Vec<(&str, &str)> {
    const ORDER: &[&str] = &["SQ", "HQ", "PQ", "LQ"];
    let mut out: Vec<(&str, &str)> = Vec::new();
    for tone in ORDER {
        if let Some((_, rt)) = formats.iter().find(|(t, _)| t == tone) {
            out.push((tone, rt.as_str()));
        }
    }
    // Nothing known: ask for the plain mp3 shape anyway.
    if out.is_empty() {
        out.push(("PQ", "2"));
    }
    out
}

/// Ask Migu for a listen URL.
async fn migu_listen_url(
    client: &reqwest::Client,
    song_id: &str,
    resource_type: &str,
    tone: &str,
) -> Option<String> {
    let mut headers = migu_headers();
    headers.insert(
        reqwest::header::CONTENT_TYPE,
        reqwest::header::HeaderValue::from_static("application/json;charset=UTF-8"),
    );
    headers.insert("birth", reqwest::header::HeaderValue::from_static("h5page"));
    headers.insert("signature", reqwest::header::HeaderValue::from_static("1"));

    let resp = client
        .get(MIGU_LISTEN_URL)
        .headers(headers)
        .query(&[
            ("contentId", song_id.to_string()),
            ("copyrightId", String::new()),
            ("resourceType", resource_type.to_string()),
            ("netType", "01".to_string()),
            ("toneFlag", tone.to_string()),
            ("scene", String::new()),
            ("lowerQualityContentId", song_id.to_string()),
        ])
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .ok()?;
    let raw = resp.bytes().await.ok()?;
    let body = decrypt_migu(&raw)?;
    let url = body
        .get("data")
        .and_then(|d| d.get("url"))
        .and_then(|v| v.as_str())?;
    (!url.is_empty()).then(|| url.to_string())
}

// ---------------------------------------------------------------------------
// Kugou
// ---------------------------------------------------------------------------

/// Kugou's search endpoint. Plain JSON, no encryption.
const KUGOU_SEARCH_URL: &str = "https://songsearch.kugou.com/song_search_v2";

/// Kugou's playback endpoint. It wants a signed parameter set.
const KUGOU_URL_API: &str = "https://gateway.kugou.com/v5/url";

/// Kugou's lyric search.
const KUGOU_LYRIC_SEARCH_URL: &str = "https://krcs.kugou.com/search";

/// Kugou's lyric download.
const KUGOU_LYRIC_DOWNLOAD_URL: &str = "https://lyrics.kugou.com/download";

/// The app id the signed requests identify as.
const KUGOU_APPID: u32 = 3116;

/// The client version the signed requests identify as.
const KUGOU_CLIENTVER: u32 = 11440;

/// The salt the Android-style signature is computed with.
const KUGOU_SIGNATURE_SECRET: &str = "LnT6xpN3khm36zse0QzvmgTZ3waWdRSA";

/// The salt the playback `key` parameter is computed with.
const KUGOU_KEY_SECRET: &str = "185672dd44712f60bb1736df5a377e82";

/// Search Kugou.
pub async fn kugou_search(
    query: String,
    limit: Option<u64>,
) -> Result<Vec<CnSong>, String> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let limit = limit.unwrap_or(20).clamp(1, 100) as usize;

    let client = proxy::build_client(reqwest::Client::builder())
        .map_err(|e| format!("kugou client: {e}"))?;
    let resp = client
        .get(KUGOU_SEARCH_URL)
        .header(reqwest::header::USER_AGENT, UA)
        .query(&[
            ("format", "json".to_string()),
            ("keyword", query.to_string()),
            ("platform", "WebFilter".to_string()),
            ("page", "1".to_string()),
            ("pagesize", limit.to_string()),
        ])
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|e| format!("kugou search: {e}"))?;
    if !resp.status().is_success() {
        return Ok(Vec::new());
    }
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("kugou search json: {e}"))?;

    let rows = body
        .get("data")
        .and_then(|d| d.get("lists"))
        .and_then(|l| l.as_array())
        .cloned()
        .unwrap_or_default();

    Ok(rows.iter().take(limit).filter_map(parse_kugou_song).collect())
}

/// Turn a Kugou search row into our shape.
fn parse_kugou_song(row: &serde_json::Value) -> Option<CnSong> {
    let id = row
        .get("FileHash")
        .and_then(|v| v.as_str())
        .or_else(|| row.get("Hash").and_then(|v| v.as_str()))?
        .to_string();
    let title = row
        .get("SongName")
        .and_then(|v| v.as_str())
        .or_else(|| row.get("songname").and_then(|v| v.as_str()))?
        .to_string();
    let artists: Vec<String> = match row.get("Singers") {
        Some(serde_json::Value::Array(list)) => list
            .iter()
            .filter_map(|s| s.get("name").and_then(|n| n.as_str()))
            .map(|s| s.to_string())
            .collect(),
        _ => row
            .get("SingerName")
            .and_then(|v| v.as_str())
            .or_else(|| row.get("singername").and_then(|v| v.as_str()))
            .map(|s| vec![s.to_string()])
            .unwrap_or_default(),
    };
    let album = row
        .get("AlbumName")
        .and_then(|v| v.as_str())
        .or_else(|| row.get("album_name").and_then(|v| v.as_str()))
        .map(|s| s.to_string());
    let cover = row
        .get("Image")
        .and_then(|v| v.as_str())
        .or_else(|| {
            row.get("trans_param")
                .and_then(|t| t.get("union_cover"))
                .and_then(|v| v.as_str())
        })
        .map(|s| s.replace("{size}", "400"));
    Some(CnSong {
        id,
        title,
        artists,
        album,
        duration: row
            .get("Duration")
            .and_then(|v| v.as_u64())
            .or_else(|| row.get("duration").and_then(|v| v.as_u64()))
            .unwrap_or(0),
        cover_url: cover,
        fee: None,
    })
}

/// The MD5 the Kugou signature is computed with.
///
/// Kugou's own `md-5` crate is named `md5`; this is the same digest,
/// spelled out so the signing code reads like the protocol.
fn md5_hex(data: &str) -> String {
    use md5::{Digest, Md5};
    let mut hasher = Md5::new();
    hasher.update(data.as_bytes());
    let out = hasher.finalize();
    out.iter().map(|b| format!("{b:02x}")).collect()
}

/// Kugou's Android-style request signature.
///
/// The parameters are sorted by name, joined as `key=value`, and the
/// result is signed with the secret on both ends.
fn signature_android(params: &[(String, String)], body: &str) -> String {
    let mut sorted: Vec<&(String, String)> = params.iter().collect();
    sorted.sort_by(|a, b| a.0.cmp(&b.0));
    let canonical: String = sorted
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("");
    md5_hex(&format!(
        "{KUGOU_SIGNATURE_SECRET}{canonical}{body}{KUGOU_SIGNATURE_SECRET}"
    ))
}

/// The playback `key` parameter.
fn kugou_sign_key(hash: &str, mid: &str, appid: u32) -> String {
    md5_hex(&format!("{hash}{KUGOU_KEY_SECRET}{appid}{mid}0"))
}

/// Resolve a Kugou song hash to a playable URL.
pub async fn kugou_resolve(song_id: &str) -> Option<CnResolved> {
    let song_id = song_id.trim();
    if song_id.is_empty() {
        return None;
    }
    let client = proxy::build_client(reqwest::Client::builder()).ok()?;

    // 1. The official endpoint, for the tracks Kugou serves freely.
    if let Some(resolved) = kugou_official_resolve(&client, song_id).await {
        return Some(resolved);
    }

    // 2. The meting mirrors, for the ones it does not.
    if let Some(resolved) = meting_resolve(&client, "kugou", song_id).await {
        return Some(resolved);
    }

    // 3. The generic resolver pool.
    third_party_resolve(&client, "kugou", song_id).await
}

/// The official Kugou playback path.
async fn kugou_official_resolve(
    client: &reqwest::Client,
    hash: &str,
) -> Option<CnResolved> {
    // A per-request device id. It identifies a client, not a person:
    // it carries no account information.
    let mid = md5_hex(&format!("{}{}", hash, now_secs()));
    let clienttime = now_secs();

    for quality in ["128", "320", "flac"] {
        let mut params: Vec<(String, String)> = vec![
            ("album_id".into(), "0".into()),
            ("area_code".into(), "1".into()),
            ("hash".into(), hash.to_lowercase()),
            ("ssa_flag".into(), "is_fromtrack".into()),
            ("version".into(), "11436".into()),
            ("page_id".into(), "967177915".into()),
            ("quality".into(), quality.into()),
            ("album_audio_id".into(), "0".into()),
            ("behavior".into(), "play".into()),
            ("pid".into(), "411".into()),
            ("cmd".into(), "26".into()),
            ("pidversion".into(), "3001".into()),
            ("IsFreePart".into(), "0".into()),
            (
                "ppage_id".into(),
                "356753938,823673182,967485191".into(),
            ),
            ("cdnBackup".into(), "1".into()),
            ("kcard".into(), "0".into()),
            ("module".into(), String::new()),
            ("dfid".into(), "-".into()),
            ("mid".into(), mid.clone()),
            ("uuid".into(), "-".into()),
            ("appid".into(), KUGOU_APPID.to_string()),
            ("clientver".into(), KUGOU_CLIENTVER.to_string()),
            ("clienttime".into(), clienttime.to_string()),
        ];
        params.push((
            "key".into(),
            kugou_sign_key(&hash.to_lowercase(), &mid, KUGOU_APPID),
        ));
        let signature = signature_android(&params, "");
        params.push(("signature".into(), signature));

        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            reqwest::header::USER_AGENT,
            reqwest::header::HeaderValue::from_static(
                "Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi",
            ),
        );
        for (name, value) in [
            ("x-router", "trackercdn.kugou.com"),
            ("dfid", "-"),
            ("kg-rc", "1"),
            ("kg-thash", "5d816a0"),
            ("kg-rec", "1"),
            ("kg-rf", "B9EDA08A64250DEFFBCADDEE00F8F25F"),
        ] {
            if let (Ok(n), Ok(v)) = (
                reqwest::header::HeaderName::from_bytes(name.as_bytes()),
                reqwest::header::HeaderValue::from_str(value),
            ) {
                headers.insert(n, v);
            }
        }

        let Ok(resp) = client
            .get(KUGOU_URL_API)
            .headers(headers)
            .query(&params)
            .timeout(REQUEST_TIMEOUT)
            .send()
            .await
        else {
            continue;
        };
        let Ok(body) = resp.json::<serde_json::Value>().await else {
            continue;
        };
        // The platform lists the URLs comma-separated; the first is the
        // primary CDN, the rest are its backups.
        let Some(url) = body
            .get("url")
            .and_then(|v| v.as_str())
            .map(|s| s.split(',').next().unwrap_or("").trim().to_string())
            .filter(|s| !s.is_empty())
        else {
            continue;
        };
        return Some(CnResolved {
            url,
            source: "official".into(),
            quality: quality.to_string(),
            size: None,
        });
    }
    None
}

// ---------------------------------------------------------------------------
// QQ Music
// ---------------------------------------------------------------------------

/// QQ's search endpoint. Plain JSON.
const QQ_SEARCH_URL: &str = "https://c.y.qq.com/soso/fcgi-bin/client_search_cp";

/// QQ's playback endpoint: it hands back a `vkey` and a relative path.
const QQ_VKEY_URL: &str = "https://u.y.qq.com/cgi-bin/musicu.fcg";

/// The streaming domain a QQ `purl` is relative to.
const QQ_STREAM_DOMAIN: &str = "https://isure.stream.qqmusic.qq.com/";

/// QQ's lyric endpoint.
const QQ_LYRIC_URL: &str = "https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg";

/// Search QQ Music.
pub async fn qq_search(query: String, limit: Option<u64>) -> Result<Vec<CnSong>, String> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let limit = limit.unwrap_or(20).clamp(1, 100) as usize;

    let client = proxy::build_client(reqwest::Client::builder())
        .map_err(|e| format!("qq client: {e}"))?;
    let resp = client
        .get(QQ_SEARCH_URL)
        .header(reqwest::header::USER_AGENT, UA)
        .header(reqwest::header::REFERER, "https://y.qq.com/")
        .query(&[
            ("p", "1".to_string()),
            ("n", limit.to_string()),
            ("w", query.to_string()),
            ("format", "json".to_string()),
        ])
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|e| format!("qq search: {e}"))?;
    if !resp.status().is_success() {
        return Ok(Vec::new());
    }
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("qq search json: {e}"))?;

    let rows = body
        .get("data")
        .and_then(|d| d.get("song"))
        .and_then(|s| s.get("list"))
        .and_then(|l| l.as_array())
        .cloned()
        .unwrap_or_default();

    Ok(rows.iter().take(limit).filter_map(parse_qq_song).collect())
}

/// Turn a QQ search row into our shape.
fn parse_qq_song(row: &serde_json::Value) -> Option<CnSong> {
    let id = row
        .get("songmid")
        .and_then(|v| v.as_str())
        .or_else(|| row.get("mid").and_then(|v| v.as_str()))?
        .to_string();
    let title = row
        .get("songname")
        .and_then(|v| v.as_str())
        .or_else(|| row.get("title").and_then(|v| v.as_str()))?
        .to_string();
    let artists: Vec<String> = row
        .get("singer")
        .and_then(|v| v.as_array())
        .map(|list| {
            list.iter()
                .filter_map(|s| s.get("name").and_then(|n| n.as_str()))
                .map(|s| s.to_string())
                .collect()
        })
        .unwrap_or_default();
    let album = row
        .get("albumname")
        .and_then(|v| v.as_str())
        .or_else(|| {
            row.get("album")
                .and_then(|a| a.get("title"))
                .and_then(|v| v.as_str())
        })
        .map(|s| s.to_string());
    let albummid = row
        .get("albummid")
        .and_then(|v| v.as_str())
        .or_else(|| {
            row.get("album")
                .and_then(|a| a.get("mid"))
                .and_then(|v| v.as_str())
        });
    let cover = albummid
        .filter(|m| !m.is_empty())
        .map(|m| format!("https://y.gtimg.cn/music/photo_new/T002R800x800M000{m}.jpg"));
    Some(CnSong {
        id,
        title,
        artists,
        album,
        duration: row
            .get("interval")
            .and_then(|v| v.as_u64())
            .unwrap_or(0),
        cover_url: cover,
        fee: None,
    })
}

/// The filename the QQ `vkey` request carries.
///
/// QQ expects the song id to appear *twice* in the filename, and the
/// prefix encodes the quality. The prefix list is best first.
fn qq_filename(song_id: &str, quality: &str) -> String {
    let (prefix, ext) = match quality {
        "flac" => ("F000", "flac"),
        "320" => ("M800", "mp3"),
        _ => ("M500", "mp3"),
    };
    format!("{prefix}{song_id}{song_id}.{ext}")
}

/// Resolve a QQ song id to a playable URL.
pub async fn qq_resolve(song_id: &str) -> Option<CnResolved> {
    let song_id = song_id.trim();
    if song_id.is_empty() {
        return None;
    }
    let client = proxy::build_client(reqwest::Client::builder()).ok()?;

    // 1. The official endpoint, for the tracks QQ serves freely.
    if let Some(resolved) = qq_official_resolve(&client, song_id).await {
        return Some(resolved);
    }

    // 2. The Tang API, which serves the paid tracks QQ will not.
    if let Some(resolved) = tang_qq_resolve(&client, song_id).await {
        return Some(resolved);
    }

    // 3. The meting mirrors, for the ones it does not.
    if let Some(resolved) = meting_resolve(&client, "qq", song_id).await {
        return Some(resolved);
    }

    // 4. The generic resolver pool.
    third_party_resolve(&client, "qq", song_id).await
}

/// The official QQ playback path.
async fn qq_official_resolve(client: &reqwest::Client, song_id: &str) -> Option<CnResolved> {
    let guid = md5_hex(&format!("{song_id}{}", now_millis()));

    for quality in ["flac", "320", "128"] {
        let body = serde_json::json!({
            "comm": {
                "ct": "19",
                "cv": "13020508",
                "v": "13020508",
                "tmeAppID": "qqmusic",
                "format": "json",
                "inCharset": "utf-8",
                "outCharset": "utf-8",
                "uid": "3931641530",
            },
            "req": {
                "module": "music.vkey.GetVkey",
                "method": "UrlGetVkey",
                "param": {
                    "filename": [qq_filename(song_id, quality)],
                    "guid": guid,
                    "songmid": [song_id],
                    "songtype": [0],
                },
            },
        });

        let Ok(resp) = client
            .post(QQ_VKEY_URL)
            .header(reqwest::header::USER_AGENT, UA)
            .header(reqwest::header::REFERER, "https://y.qq.com/")
            .header(reqwest::header::ORIGIN, "https://y.qq.com")
            .header(
                reqwest::header::CONTENT_TYPE,
                reqwest::header::HeaderValue::from_static("application/json"),
            )
            .json(&body)
            .timeout(REQUEST_TIMEOUT)
            .send()
            .await
        else {
            continue;
        };
        let Ok(parsed) = resp.json::<serde_json::Value>().await else {
            continue;
        };
        let Some(purl) = parsed
            .get("req")
            .and_then(|r| r.get("data"))
            .and_then(|d| d.get("midurlinfo"))
            .and_then(|m| m.as_array())
            .and_then(|a| a.first())
            .and_then(|i| i.get("purl"))
            .and_then(|v| v.as_str())
            .filter(|p| !p.is_empty())
        else {
            continue;
        };
        return Some(CnResolved {
            url: format!("{QQ_STREAM_DOMAIN}{purl}"),
            source: "official".into(),
            quality: quality.to_string(),
            size: None,
        });
    }
    None
}

// ---------------------------------------------------------------------------
// The third-party resolver
// ---------------------------------------------------------------------------

/// A third-party resolver: a public API whose operator holds an
/// account on the platform, and which hands back a direct CDN link.
struct ThirdParty {
    id: &'static str,
    /// The platform the resolver serves.
    platform: &'static str,
    url: &'static str,
    /// The form field the platform's id goes in.
    id_field: &'static str,
    /// The form field naming the platform.
    type_field: &'static str,
    /// The platform name the resolver expects.
    type_value: &'static str,
}

/// The resolver pool.
///
/// These are the same class of service as the NetEase unblock pool
/// (`unblock.rs`): volunteer-run public APIs. They are tried in order
/// and the first one that answers with a playable URL wins.
static RESOLVERS: &[ThirdParty] = &[
    ThirdParty {
        id: "lzmhhh",
        platform: "any",
        url: "https://music.lzmhhh.com/api/music/url",
        id_field: "id",
        type_field: "type",
        type_value: "",
    },
];

/// A resolver that answers with a meting redirect.
///
/// The meting API is a family of mirrors that all expose the same
/// interface: `server` names the platform, `type=url` asks for a
/// stream and the answer is a redirect straight to the platform's
/// CDN. It is the one resolver that covers all three platforms at
/// once, which is why it is worth a chain of its own rather than a
/// row in `RESOLVERS`.
struct MetingResolver {
    id: &'static str,
    url: &'static str,
}

/// The meting mirrors, in the order they are tried.
///
/// The first two are the ones
/// [musicsquare](https://github.com/CharlesPikachu/musicsquare) uses,
/// which is where they are known to work.
static METING_RESOLVERS: &[MetingResolver] = &[
    MetingResolver {
        id: "qijieya",
        url: "https://api.qijieya.cn/meting/",
    },
    MetingResolver {
        id: "injahow",
        url: "https://api.injahow.cn/meting/",
    },
];

/// The meting API's User-Agent.
///
/// It answers a browser User-Agent with `418 I'm a teapot` and only
/// serves its redirect to a client that looks like a plain HTTP
/// caller.
const METING_UA: &str = "adrify/0.13.0 (+https://github.com/crpto999/adrify)";

/// The meting server name each of our platforms uses.
///
/// `migu` is not among them: the meting API has no Migu backend, so
/// Migu keeps only its official path and the generic resolver pool.
fn meting_server(platform: &str) -> Option<&'static str> {
    match platform {
        "kugou" => Some("kugou"),
        "qq" => Some("tencent"),
        _ => None,
    }
}

/// Resolve a song through the meting mirrors.
///
/// The meting API answers with a redirect straight to the platform's
/// CDN, so the request has to follow it and the *final* URL is the
/// stream. A paid track that the mirror cannot serve comes back as
/// an empty body with a `200`, which is not a link.
async fn meting_resolve(
    client: &reqwest::Client,
    platform: &str,
    song_id: &str,
) -> Option<CnResolved> {
    let server = meting_server(platform)?;
    for resolver in METING_RESOLVERS {
        let Ok(resp) = client
            .get(resolver.url)
            .header(reqwest::header::USER_AGENT, METING_UA)
            .query(&[
                ("server", server.to_string()),
                ("type", "url".to_string()),
                ("id", song_id.to_string()),
                ("br", "999".to_string()),
            ])
            .timeout(REQUEST_TIMEOUT)
            .send()
            .await
        else {
            continue;
        };
        if !resp.status().is_success() {
            continue;
        }
        // The redirect has already been followed; the final URL is
        // the CDN link. It is only a link if it points somewhere else
        // than the API itself — a paid track the mirror declines comes
        // back as the API's own URL.
        let final_url = resp.url().to_string();
        if final_url == resolver.url || !final_url.starts_with("http") {
            continue;
        }
        return Some(CnResolved {
            url: final_url,
            source: resolver.id.to_string(),
            quality: "unknown".into(),
            size: None,
        });
    }
    None
}

/// The Tang QQ API: a public API that resolves a QQ Music track — paid
/// or not — to a direct CDN link.
///
/// It is the resolver that makes a QQ VIP track playable: the official
/// endpoint refuses those without a membership, and this one hands
/// back the lossless stream. The endpoint takes the track's `mid`,
/// which is exactly the id QQ search hands out.
const TANG_QQ_URL: &str = "https://tang.api.s01s.cn/music_open_api.php";

/// Read a file size out of a JSON value.
///
/// The endpoint reports the size two ways: as a number
/// (`song_size_sq_str`) and as a formatted string (`song_size_sq`,
/// e.g. `"31.36MB"`). Only the number is exact, so only the number
/// is read; the string form is for humans.
fn parse_size(value: &serde_json::Value) -> Option<u64> {
    match value {
        serde_json::Value::Number(n) => n.as_u64(),
        serde_json::Value::String(s) => s.parse().ok(),
        _ => None,
    }
}

/// Resolve a QQ track through the Tang API.
///
/// The endpoint answers a single object. The lossless link lives in
/// `song_play_url_sq`; `song_play_url` is the 194k m4a, and
/// `song_play_url_standard` is the small one.
async fn tang_qq_resolve(client: &reqwest::Client, song_id: &str) -> Option<CnResolved> {
    let resp = client
        .get(TANG_QQ_URL)
        .header(reqwest::header::USER_AGENT, UA)
        .header(reqwest::header::REFERER, "https://y.qq.com/")
        .query(&[
            ("msg", ""),
            ("type", "json"),
            ("mid", song_id),
        ])
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let body: serde_json::Value = resp.json().await.ok()?;

    // The endpoint reports the size next to each link; take it, so
    // the player does not have to ask the CDN for it.
    let mut size = None;
    let mut url = None;
    let mut quality = "unknown";
    for (link_key, size_key, label) in [
        ("song_play_url_sq", "song_size_sq_str", "flac"),
        ("song_play_url", "song_size_str", "320"),
        ("song_play_url_standard", "song_size_standard_str", "128"),
    ] {
        let candidate = body
            .get(link_key)
            .and_then(|v| v.as_str())
            .filter(|s| s.starts_with("http"));
        let Some(candidate) = candidate else { continue };
        size = body.get(size_key).and_then(parse_size);
        url = Some(candidate.to_string());
        quality = label;
        break;
    }

    let url = url?;
    // The endpoint hands out `http://` links to a CDN that serves
    // `https://` perfectly well, and the app only ever serves
    // over TLS.
    let url = url.replace("http://", "https://");
    Some(CnResolved {
        url,
        source: "tang".into(),
        quality: quality.into(),
        size,
    })
}

/// The platform name each resolver expects for a given platform.
fn resolver_type(resolver: &ThirdParty, platform: &str) -> &'static str {
    if resolver.type_value.is_empty() {
        // The resolver names the platform itself: `kg`, `qq`, `wy`.
        match platform {
            "kugou" => "kg",
            "qq" => "qq",
            "migu" => "migu",
            _ => "wy",
        }
    } else {
        resolver.type_value
    }
}

/// Ask the third-party resolvers for a URL.
async fn third_party_resolve(
    client: &reqwest::Client,
    platform: &str,
    song_id: &str,
) -> Option<CnResolved> {
    for resolver in RESOLVERS {
        if resolver.platform != "any" && resolver.platform != platform {
            continue;
        }
        let Ok(resp) = client
            .post(resolver.url)
            .header(reqwest::header::USER_AGENT, UA)
            .header(reqwest::header::REFERER, "https://music.lzmhhh.com/")
            .header(reqwest::header::ORIGIN, "https://music.lzmhhh.com")
            .form(&[
                (resolver.id_field, song_id.to_string()),
                (
                    resolver.type_field,
                    resolver_type(resolver, platform).to_string(),
                ),
            ])
            .timeout(REQUEST_TIMEOUT)
            .send()
            .await
        else {
            continue;
        };
        let Ok(body) = resp.json::<serde_json::Value>().await else {
            continue;
        };
        // The resolver answers `{code, msg, data}` where `data` is the
        // URL. `code` 1 means success; 0 with a message means the
        // resolver's own quota is exhausted.
        let Some(url) = body.get("data").and_then(|v| v.as_str()) else {
            continue;
        };
        if url.is_empty() || !url.starts_with("http") {
            continue;
        }
        return Some(CnResolved {
            url: url.to_string(),
            source: resolver.id.to_string(),
            quality: "unknown".into(),
            size: None,
        });
    }
    None
}

// ---------------------------------------------------------------------------
// The shared result shape
// ---------------------------------------------------------------------------

/// A resolved stream on one of the Chinese platforms.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CnResolved {
    /// The direct CDN URL.
    pub url: String,
    /// Where it came from: `official` or a resolver id.
    pub source: String,
    /// The quality it was served at.
    pub quality: String,
    /// The file size, when the platform reported one.
    pub size: Option<u64>,
}

/// Resolve a song id on any of the three platforms.
///
/// The platform is the prefix of the composite key the app uses, so
/// `migu:123` resolves through Migu and `qq:abc` through QQ.
pub async fn resolve(platform: &str, song_id: &str) -> Option<crate::progressive::ResolvedAudio> {
    let resolved = match platform {
        "migu" => migu_resolve(song_id).await?,
        "kugou" => kugou_resolve(song_id).await?,
        "qq" => qq_resolve(song_id).await?,
        _ => return None,
    };

    // The size has to be known up front: the element needs a correct
    // `Content-Length` to seek, and the background filler needs to know
    // when it is done. None of these platforms report it in the
    // resolution response, so ask the CDN.
    let size = match resolved.size {
        Some(s) if s > 0 => s,
        _ => probe_size(&resolved.url).await?,
    };

    Some(crate::progressive::ResolvedAudio {
        url: resolved.url.clone(),
        size,
        mime: mime_for_url(&resolved.url),
        headers: vec![
            ("User-Agent".to_string(), UA.to_string()),
            ("Referer".to_string(), referer_for(platform).to_string()),
        ],
        available_at: None,
    })
}

/// The `Referer` the platform's CDN expects.
fn referer_for(platform: &str) -> &'static str {
    match platform {
        "kugou" => "https://www.kugou.com/",
        "qq" => "https://y.qq.com/",
        "migu" => "https://music.migu.cn/",
        _ => "",
    }
}

/// Ask the CDN for the file's length.
///
/// A one-byte range request is enough: the `Content-Range` header
/// carries the total.
async fn probe_size(url: &str) -> Option<u64> {
    let client = proxy::build_client(reqwest::Client::builder()).ok()?;
    let resp = client
        .get(url)
        .header(reqwest::header::USER_AGENT, UA)
        .header(reqwest::header::RANGE, "bytes=0-0")
        .timeout(REQUEST_TIMEOUT)
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

/// The audio mime to serve a platform URL as.
///
/// The CDNs' own `Content-Type` is unreliable for these platforms —
/// Kugou's reports `text/html` for a perfectly good mp3 — so the
/// container extension is the better signal.
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

// ---------------------------------------------------------------------------
// Lyrics
// ---------------------------------------------------------------------------

/// The lyrics for a song on one of the three platforms.
///
/// The result is LRC text. A platform that has no lyrics for the song
/// returns `None` rather than an empty string, so the caller can fall
/// back to another source.
pub async fn lyric(platform: &str, song_id: &str) -> Option<String> {
    match platform {
        "migu" => migu_lyric(song_id).await,
        "kugou" => kugou_lyric(song_id).await,
        "qq" => qq_lyric(song_id).await,
        _ => None,
    }
}

/// Migu's lyrics.
async fn migu_lyric(song_id: &str) -> Option<String> {
    let client = proxy::build_client(reqwest::Client::builder()).ok()?;
    let resp = client
        .get(MIGU_RESOURCE_URL)
        .headers(migu_headers())
        .query(&[
            ("resourceId", song_id.to_string()),
            ("resourceType", "2".to_string()),
        ])
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .ok()?;
    let body: serde_json::Value = resp.json().await.ok()?;
    let resource = body.get("resource").and_then(|r| r.as_array())?;
    let url = resource
        .first()?
        .get("lrcUrl")
        .and_then(|v| v.as_str())
        .filter(|u| !u.is_empty())?;
    let text = client
        .get(url)
        .headers(migu_headers())
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .ok()?
        .text()
        .await
        .ok()?;
    (!text.trim().is_empty()).then_some(text)
}

/// QQ's lyrics.
///
/// The endpoint answers with the LRC base64-encoded.
async fn qq_lyric(song_id: &str) -> Option<String> {
    let client = proxy::build_client(reqwest::Client::builder()).ok()?;
    let resp = client
        .get(QQ_LYRIC_URL)
        .header(reqwest::header::USER_AGENT, UA)
        .header(reqwest::header::REFERER, "https://y.qq.com/portal/player.html")
        .query(&[
            ("songmid", song_id.to_string()),
            ("g_tk", "5381".to_string()),
            ("loginUin", "0".to_string()),
            ("hostUin", "0".to_string()),
            ("format", "json".to_string()),
            ("inCharset", "utf8".to_string()),
            ("outCharset", "utf-8".to_string()),
            ("platform", "yqq".to_string()),
        ])
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .ok()?;
    let body: serde_json::Value = resp.json().await.ok()?;
    let encoded = body.get("lyric").and_then(|v| v.as_str()).unwrap_or("");
    if encoded.is_empty() {
        return None;
    }
    let decoded = base64_decode(encoded)?;
    (!decoded.trim().is_empty()).then_some(decoded)
}

/// Kugou's lyrics.
///
/// Kugou splits the lookup in two: a search for a candidate (which
/// carries an access key), then a download with that key.
async fn kugou_lyric(song_id: &str) -> Option<String> {
    let client = proxy::build_client(reqwest::Client::builder()).ok()?;

    // The search needs the song's *file name* ("artist - title") and
    // its duration; the hash alone is not enough to find the lyric.
    let meta = client
        .get("https://m.kugou.com/app/i/getSongInfo.php")
        .header(reqwest::header::USER_AGENT, UA)
        .query(&[("cmd", "playInfo"), ("hash", song_id)])
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .ok()?
        .json::<serde_json::Value>()
        .await
        .ok()?;
    let file_name = meta
        .get("fileName")
        .and_then(|v| v.as_str())
        .unwrap_or(song_id)
        .to_string();
    let duration = meta
        .get("timeLength")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);

    let resp = client
        .get(KUGOU_LYRIC_SEARCH_URL)
        .header(reqwest::header::USER_AGENT, UA)
        .query(&[
            ("keyword", file_name),
            ("duration", duration.to_string()),
            ("hash", song_id.to_string()),
            ("ver", "1".to_string()),
            ("man", "yes".to_string()),
            ("client", "mobi".to_string()),
        ])
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .ok()?;
    let body: serde_json::Value = resp.json().await.ok()?;
    let candidate = body
        .get("candidates")
        .and_then(|v| v.as_array())
        .and_then(|a| a.first())?;
    let id = candidate.get("id").and_then(|v| v.as_str())?;
    let access_key = candidate.get("accesskey").and_then(|v| v.as_str())?;

    let resp = client
        .get(KUGOU_LYRIC_DOWNLOAD_URL)
        .header(reqwest::header::USER_AGENT, UA)
        .query(&[
            ("ver", "1".to_string()),
            ("client", "pc".to_string()),
            ("id", id.to_string()),
            ("accesskey", access_key.to_string()),
            ("fmt", "lrc".to_string()),
            ("charset", "utf8".to_string()),
        ])
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .ok()?;
    let body: serde_json::Value = resp.json().await.ok()?;
    let content = body.get("content").and_then(|v| v.as_str()).unwrap_or("");
    if content.is_empty() {
        return None;
    }
    let decoded = base64_decode(content)?;
    (!decoded.trim().is_empty()).then_some(decoded)
}

/// Decode a standard base64 string.
fn base64_decode(input: &str) -> Option<String> {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut lookup = [255u8; 256];
    for (i, b) in TABLE.iter().enumerate() {
        lookup[*b as usize] = i as u8;
    }
    let mut out = Vec::new();
    let mut acc: u32 = 0;
    let mut bits = 0u32;
    for byte in input.bytes() {
        if byte == b'=' || byte.is_ascii_whitespace() {
            continue;
        }
        let v = lookup[byte as usize];
        if v == 255 {
            continue;
        }
        acc = (acc << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((acc >> bits) & 0xff) as u8);
        }
    }
    String::from_utf8(out).ok()
}

// ---------------------------------------------------------------------------
// The Tauri commands
// ---------------------------------------------------------------------------

/// Search Migu.
#[tauri::command]
pub async fn migu_search_cmd(
    query: String,
    limit: Option<u64>,
) -> Result<Vec<CnSong>, String> {
    migu_search(query, limit).await
}

/// Search Kugou.
#[tauri::command]
pub async fn kugou_search_cmd(
    query: String,
    limit: Option<u64>,
) -> Result<Vec<CnSong>, String> {
    kugou_search(query, limit).await
}

/// Search QQ Music.
#[tauri::command]
pub async fn qq_search_cmd(query: String, limit: Option<u64>) -> Result<Vec<CnSong>, String> {
    qq_search(query, limit).await
}

/// Resolve a song on one of the three platforms to a playable URL.
#[tauri::command]
pub async fn cn_resolve(
    platform: String,
    song_id: String,
) -> Result<Option<CnResolved>, String> {
    Ok(match platform.as_str() {
        "migu" => migu_resolve(&song_id).await,
        "kugou" => kugou_resolve(&song_id).await,
        "qq" => qq_resolve(&song_id).await,
        _ => None,
    })
}

/// The lyrics for a song on one of the three platforms.
#[tauri::command]
pub async fn cn_lyric(platform: String, song_id: String) -> Result<Option<String>, String> {
    Ok(lyric(&platform, &song_id).await)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_migu_decryption_undoes_its_own_encryption() {
        // The platform's scheme is `plain + seed - key[i]`, so the same
        // operation in reverse must recover the plaintext byte for byte.
        let plain = br#"{"data":{"url":"https://example.test/a.mp3"}}"#;
        let seed: u8 = 0x5a;
        let mut raw = Vec::from(MIGU_MAGIC);
        raw.push(seed);
        for (i, b) in plain.iter().enumerate() {
            raw.push(b.wrapping_sub(seed).wrapping_add(MIGU_KEY[i % MIGU_KEY.len()]));
        }

        let decoded = decrypt_migu(&raw).expect("decodes");
        assert_eq!(
            decoded["data"]["url"].as_str(),
            Some("https://example.test/a.mp3")
        );
    }

    #[test]
    fn a_plain_migu_body_is_read_as_json() {
        let body = br#"{"data":{"url":"https://example.test/b.mp3"}}"#;
        let decoded = decrypt_migu(body).expect("decodes");
        assert_eq!(
            decoded["data"]["url"].as_str(),
            Some("https://example.test/b.mp3")
        );
    }

    #[test]
    fn a_truncated_migu_body_decodes_to_nothing() {
        assert!(decrypt_migu(b"\xab\xcd").is_none());
    }

    #[test]
    fn the_kugou_signature_is_stable_for_the_same_parameters() {
        let params = vec![
            ("hash".to_string(), "abc".to_string()),
            ("appid".to_string(), KUGOU_APPID.to_string()),
        ];
        let a = signature_android(&params, "");
        let b = signature_android(&params, "");
        assert_eq!(a, b);
        // A different body must change it: the body is part of the
        // signed material, not just the parameters.
        assert_ne!(a, signature_android(&params, "other"));
    }

    #[test]
    fn the_kugou_signature_ignores_parameter_order() {
        let a = signature_android(
            &[
                ("a".to_string(), "1".to_string()),
                ("b".to_string(), "2".to_string()),
            ],
            "",
        );
        let b = signature_android(
            &[
                ("b".to_string(), "2".to_string()),
                ("a".to_string(), "1".to_string()),
            ],
            "",
        );
        assert_eq!(a, b);
    }

    #[test]
    fn the_qq_filename_repeats_the_song_id() {
        // QQ's protocol wants the id twice: the mid is both the prefix
        // and the payload of the filename.
        assert_eq!(
            qq_filename("001Qu4I30eVFYb", "128"),
            "M500001Qu4I30eVFYb001Qu4I30eVFYb.mp3"
        );
        assert_eq!(
            qq_filename("001Qu4I30eVFYb", "320"),
            "M800001Qu4I30eVFYb001Qu4I30eVFYb.mp3"
        );
        assert_eq!(
            qq_filename("001Qu4I30eVFYb", "flac"),
            "F000001Qu4I30eVFYb001Qu4I30eVFYb.flac"
        );
    }

    #[test]
    fn base64_decoding_recovers_the_text() {
        // "aGVsbG8=" is "hello".
        assert_eq!(base64_decode("aGVsbG8=").as_deref(), Some("hello"));
    }

    #[test]
    fn the_mime_follows_the_container_not_the_platform() {
        assert_eq!(mime_for_url("https://x.test/a.flac?token=1"), "audio/flac");
        assert_eq!(mime_for_url("https://x.test/a.m4a"), "audio/mp4");
        assert_eq!(mime_for_url("https://x.test/a.mp3"), "audio/mpeg");
        // Kugou's CDN reports `text/html` for a perfectly good mp3, so
        // the extension is the only signal worth trusting.
        assert_eq!(mime_for_url("https://x.test/song.mp3"), "audio/mpeg");
    }

    #[test]
    fn the_resolver_names_the_platform_the_way_each_one_expects() {
        let any = ThirdParty {
            id: "x",
            platform: "any",
            url: "",
            id_field: "id",
            type_field: "type",
            type_value: "",
        };
        assert_eq!(resolver_type(&any, "kugou"), "kg");
        assert_eq!(resolver_type(&any, "qq"), "qq");
        assert_eq!(resolver_type(&any, "migu"), "migu");
        assert_eq!(resolver_type(&any, "netease"), "wy");
    }

    #[test]
    fn the_meting_api_knows_kugou_and_qq_but_not_migu() {
        assert_eq!(meting_server("kugou"), Some("kugou"));
        // The meting API calls QQ Music "tencent".
        assert_eq!(meting_server("qq"), Some("tencent"));
        assert_eq!(meting_server("migu"), None);
    }

    #[test]
    fn every_meting_mirror_is_reachable_over_tls() {
        for resolver in METING_RESOLVERS {
            assert!(
                resolver.url.starts_with("https://"),
                "{} is not over TLS",
                resolver.id
            );
        }
    }

    /// The Tang QQ API is what makes a QQ VIP track playable.
    ///
    /// Run with:
    ///
    /// ```text
    /// cargo test --lib cnproviders::tests::the_tang_api_serves_a_paid_qq_track -- --ignored --nocapture
    /// ```
    #[tokio::test]
    #[ignore = "hits the network"]
    async fn the_tang_api_serves_a_paid_qq_track() {
        // Beyond's 《海阔天空》 on QQ Music, a paid track.
        let client = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .expect("client");
        let resolved = tang_qq_resolve(&client, "001yS0N33yPm1B")
            .await
            .expect("the Tang API serves the track");
        assert!(resolved.url.starts_with("https://"));
        assert!(resolved.url.contains(".flac"), "expected the lossless link");
        assert_eq!(resolved.quality, "flac");
        assert!(resolved.size.unwrap_or(0) > 1_000_000);
    }

    /// The meting mirrors resolve a free Kugou track.
    ///
    /// Run with:
    ///
    /// ```text
    /// cargo test --lib cnproviders::tests::the_meting_mirrors_serve_a_kugou_track -- --ignored --nocapture
    /// ```
    #[tokio::test]
    #[ignore = "hits the network"]
    async fn the_meting_mirrors_serve_a_kugou_track() {
        let client = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .expect("client");
        let resolved = meting_resolve(&client, "kugou", "de076dd936d31eac32049b887d7e3f26")
            .await
            .expect("a meting mirror serves the track");
        assert!(resolved.url.starts_with("http"));
        assert!(!resolved.url.contains("qijieya.cn"));
        assert!(!resolved.url.contains("injahow.cn"));
    }
}
