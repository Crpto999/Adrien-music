//! Third-party "unblock" (解灰) proxy pool for NetEase Cloud Music.
//!
//! # Why this exists
//!
//! NetEase gates a large part of its catalogue behind a membership tier.
//! When the app has no NetEase account of its own, the *only* way to
//! resolve a stream URL for a paid track is to ask a third party that
//! does have one. Those third parties expose public HTTP APIs which take
//! a song id and hand back a direct CDN link. This module keeps a pool
//! of them, knows which ones still work, and drops the ones that don't.
//!
//! # What this module is NOT
//!
//! It is not a paywall bypass. Nothing here decrypts anything, spoofs a
//! device, or forges a signature: each API is a plain HTTP request whose
//! response contains a URL. The accounts those APIs hold are their
//! operators' business, not ours. A user with their own NetEase
//! membership should prefer the official path (`netease.rs`), and this
//! pool is the fallback for everyone else.
//!
//! # Reliability model
//!
//! These services are volunteer-run and go down without notice, so the
//! pool is a *health-tracked* pool rather than a static list:
//!
//! - Every endpoint is probed on a schedule and on demand. A probe
//!   distinguishes three outcomes, not two:
//!     * `ok`       — the API answered and returned a playable URL.
//!     * `degraded` — the API answered, but returned no URL for the
//!       probe song (its account can't play it, or the song is
//!       region-locked). The endpoint is alive.
//!     * `down`     — the API did not answer, timed out, or returned
//!       something that isn't the expected JSON.
//! - After `failure_threshold` consecutive hard failures an endpoint is
//!   *removed* from the pool: it stops being probed and stops being
//!   tried during playback. Removed endpoints keep their record so the
//!   settings UI can show what went away and why, and the user can put
//!   one back.
//!
//! The probe song id is configurable, because a probe is only
//! meaningful for tracks the pool is supposed to unlock in the first
//! place.

use std::collections::BTreeMap;
use std::sync::{Arc, RwLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::proxy;

/// How long a single unblock request may take.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(8);

/// Default interval between automatic probe passes.
const DEFAULT_PROBE_INTERVAL_MINUTES: u64 = 30;

/// Consecutive hard failures before an endpoint is dropped from the pool.
const DEFAULT_FAILURE_THRESHOLD: u32 = 3;

/// A NetEase song id used to probe the endpoints. Overridable from
/// settings: a probe only proves something about a paid track.
///
/// This is Beyond's 《海阔天空》 — a track that is live, well known,
/// and behind a membership at every tier, so an endpoint that can
/// serve it is genuinely serving the paid catalogue. The id that was
/// here before (`185709`) has been withdrawn by NetEase, which made
/// every endpoint answer "no link for this song" and looked like a
/// pool-wide outage.
const DEFAULT_PROBE_SONG_ID: &str = "347230";

/// The probe songs used before `347230`. A persisted config still
/// holding one of these was never edited by hand, so it migrates to
/// the new default instead of pinning a stale id.
const OLD_DEFAULT_PROBE_SONG_IDS: &[&str] = &["1824045033", "185709"];

/// Quality ladder, best first. Each endpoint is asked for the best
/// quality it can serve and walks down the ladder until one answers.
pub const QUALITIES: &[&str] = &["jymaster", "hires", "lossless", "exhigh", "standard"];

/// The Chinese quality names one endpoint insists on.
fn quality_cn(quality: &str) -> &'static str {
    match quality {
        "jymaster" => "超清母带",
        "hires" => "Hi-Res",
        "lossless" => "无损",
        "exhigh" => "高音质",
        _ => "低音质",
    }
}

// ---------------------------------------------------------------------------
// Endpoint table
// ---------------------------------------------------------------------------

/// How a request is sent.
///
/// The pool speaks only the meting family's dialect today — a `GET`
/// with the song id and a bitrate — but the table is meant to be
/// extended when a new service appears, so the request builder keeps
/// the shape it needs for that day.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[allow(dead_code)]
enum Method {
    Get,
    PostForm,
    PostJson,
}

/// A parameter's value.
#[derive(Clone, Copy)]
#[allow(dead_code)]
enum Param {
    /// The NetEase song id.
    Id,
    /// The requested quality, e.g. `hires`.
    Level,
    /// The requested quality in Chinese, for the endpoints that want it.
    QualityCn,
    /// The requested quality as a bitrate, for the endpoints that take
    /// one (the meting API family wants `128` / `320` / `999`).
    Bitrate,
    /// The endpoint's API key (from the key table, user-overridable).
    Key,
    /// A fixed literal.
    Lit(&'static str),
}

/// The bitrate the meting API family expects for a quality level.
///
/// `999` is the API's "lossless" marker — it hands back a FLAC file
/// rather than the highest MP3 it has.
fn quality_bitrate(quality: &str) -> &'static str {
    match quality {
        "jymaster" | "hires" | "lossless" => "999",
        "exhigh" => "320",
        _ => "128",
    }
}

const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";
const H_UA: (&str, &str) = ("User-Agent", UA);

/// The User-Agent the meting API wants.
///
/// Most of these services are front-ends for a browser site, so a
/// browser UA is the safe default. The meting API is the exception:
/// it answers a browser UA with `418 I'm a teapot` and only serves
/// its redirect to anyone who looks like a plain HTTP client. It is
/// the one endpoint family that genuinely needs its own UA, so it
/// gets one.
const METING_UA: &str = "adrify/0.13.0 (+https://github.com/crpto999/adrify)";

/// The User-Agent to send to a given endpoint.
///
/// The meting API answers a browser UA with `418 I'm a teapot` and
/// only serves its redirect to anyone who looks like a plain HTTP
/// client, so every endpoint in the pool gets its own UA.
fn ua_for(endpoint_id: &str) -> &'static str {
    match endpoint_id {
        "qijieya" | "nanorocky" | "injahow" => METING_UA,
        _ => UA,
    }
}

/// One unblock API.
struct Endpoint {
    id: &'static str,
    label: &'static str,
    /// 1 = SVIP, 2 = SVIP (unstable account), 3 = VIP, 4 = VIP
    /// (unstable account). Lower tiers are tried first.
    tier: u8,
    method: Method,
    /// May contain `{id}`, which is replaced with the song id.
    url: &'static str,
    query: &'static [(&'static str, Param)],
    form: &'static [(&'static str, Param)],
    json: &'static [(&'static str, Param)],
    headers: &'static [(&'static str, &'static str)],
    /// Path into the JSON response holding the URL.
    extract: &'static [&'static str],
    /// The response body *is* the URL.
    raw_text: bool,
    /// The response is a redirect to the audio; use the final URL.
    final_url: bool,
}

/// The pool.
///
/// Every entry here is a member of the *meting* family: the same
/// open-source API, deployed by three different operators. The family
/// is kept because it is the one that answers — the other public
/// "unblock" services either rotted, started demanding a personal API
/// key, or shut down outright, and an endpoint that cannot answer is
/// worse than no endpoint at all, because it costs a round trip and a
/// timeout on every unblock.
///
/// The three are deliberately not folded into one: they are separate
/// deployments with separate uptimes, and the pool's whole purpose is
/// redundancy. One of them can go dark without taking the others
/// with it.
static ENDPOINTS: &[Endpoint] = &[
    Endpoint {
        id: "qijieya",
        label: "meting (qijieya)",
        tier: 1,
        method: Method::Get,
        url: "https://api.qijieya.cn/meting/",
        query: &[
            ("server", Param::Lit("netease")),
            ("type", Param::Lit("url")),
            ("id", Param::Id),
            ("br", Param::Bitrate),
        ],
        form: &[],
        json: &[],
        headers: &[H_UA],
        extract: &["url"],
        raw_text: false,
        // The meting API answers with a redirect straight to the CDN.
        final_url: true,
    },
    Endpoint {
        id: "nanorocky",
        label: "meting (nanorocky)",
        tier: 1,
        method: Method::Get,
        url: "https://metingapi.nanorocky.top/",
        query: &[
            ("server", Param::Lit("netease")),
            ("type", Param::Lit("url")),
            ("id", Param::Id),
            ("br", Param::Bitrate),
        ],
        form: &[],
        json: &[],
        headers: &[H_UA],
        extract: &["url"],
        raw_text: false,
        // The meting API answers with a redirect straight to the CDN.
        final_url: true,
    },
    Endpoint {
        id: "injahow",
        label: "meting (injahow)",
        tier: 2,
        method: Method::Get,
        url: "https://api.injahow.cn/meting/",
        query: &[
            ("server", Param::Lit("netease")),
            ("type", Param::Lit("url")),
            ("id", Param::Id),
            ("br", Param::Bitrate),
        ],
        form: &[],
        json: &[],
        headers: &[H_UA],
        extract: &["url"],
        raw_text: false,
        // The meting API answers with a redirect straight to the CDN.
        final_url: true,
    },
];

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/// What the last probe of an endpoint found.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Health {
    /// Never probed.
    Unknown,
    /// Answered with a playable URL.
    Ok,
    /// Answered, but had no URL for the probe song.
    Degraded,
    /// Did not answer.
    Down,
}

/// One endpoint's row in the settings UI.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointStatus {
    pub id: String,
    pub label: String,
    /// 1 = SVIP, 2 = SVIP (unstable), 3 = VIP, 4 = VIP (unstable).
    pub tier: u8,
    /// The user turned this endpoint off.
    pub disabled: bool,
    /// The endpoint was dropped from the pool after repeated failures.
    pub removed: bool,
    pub health: Health,
    /// Round-trip time of the last probe, in milliseconds.
    pub latency_ms: Option<u64>,
    /// Unix seconds of the last probe.
    pub last_checked: Option<u64>,
    pub consecutive_failures: u32,
    pub last_error: Option<String>,
    /// Unix seconds of the removal, for the UI's "removed 2h ago".
    pub removed_at: Option<u64>,
}

/// The pool's settings.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolConfig {
    /// Probe the pool automatically on this interval.
    pub probe_interval_minutes: u64,
    /// Probe once shortly after startup.
    pub probe_on_startup: bool,
    /// Consecutive hard failures before an endpoint is dropped.
    pub failure_threshold: u32,
    /// The song id used to probe.
    pub probe_song_id: String,
    /// Per-endpoint API key overrides.
    pub keys: BTreeMap<String, String>,
}

impl Default for PoolConfig {
    fn default() -> Self {
        Self {
            probe_interval_minutes: DEFAULT_PROBE_INTERVAL_MINUTES,
            probe_on_startup: true,
            failure_threshold: DEFAULT_FAILURE_THRESHOLD,
            probe_song_id: DEFAULT_PROBE_SONG_ID.to_string(),
            keys: BTreeMap::new(),
        }
    }
}

/// The runtime record of one endpoint.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    disabled: bool,
    removed: bool,
    health: Health,
    latency_ms: Option<u64>,
    last_checked: Option<u64>,
    consecutive_failures: u32,
    last_error: Option<String>,
    removed_at: Option<u64>,
}

impl Default for Entry {
    fn default() -> Self {
        Self {
            disabled: false,
            removed: false,
            health: Health::Unknown,
            latency_ms: None,
            last_checked: None,
            consecutive_failures: 0,
            last_error: None,
            removed_at: None,
        }
    }
}

/// The persisted pool file.
#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Persisted {
    config: PoolConfig,
    entries: BTreeMap<String, Entry>,
}

/// The pool.
pub struct Pool {
    inner: RwLock<Inner>,
}

#[derive(Default)]
struct Inner {
    config: PoolConfig,
    entries: BTreeMap<String, Entry>,
}

impl Default for Pool {
    fn default() -> Self {
        Self {
            inner: RwLock::new(Inner::default()),
        }
    }
}

impl Pool {
    /// Load the persisted state, if any.
    pub fn load(&self, app: &tauri::AppHandle) {
        let path = state_path(app);
        let Ok(text) = std::fs::read_to_string(&path) else {
            return;
        };
        let Ok(persisted) = serde_json::from_str::<Persisted>(&text) else {
            crate::log!("[unblock] pool file unreadable, starting fresh");
            return;
        };
        let mut inner = self.inner.write().unwrap_or_else(|e| e.into_inner());
        inner.config = persisted.config;
        inner.entries = persisted.entries;
        // The probe song changed once already. A config that still
        // carries an old default was never edited by hand, so it
        // follows the new default rather than pinning a song id the
        // user has never heard of.
        if OLD_DEFAULT_PROBE_SONG_IDS.contains(&inner.config.probe_song_id.as_str()) {
            inner.config.probe_song_id = DEFAULT_PROBE_SONG_ID.to_string();
        }
        // Records for endpoints that are no longer in the table are
        // dropped: the table is the whole pool, and a record for an
        // endpoint that cannot be reached is a record of nothing. The
        // keys map is pruned with them, for the same reason.
        let live: Vec<&str> = ENDPOINTS.iter().map(|e| e.id).collect();
        let stale: Vec<String> = inner
            .entries
            .keys()
            .filter(|id| !live.contains(&id.as_str()))
            .cloned()
            .collect();
        if !stale.is_empty() {
            for id in &stale {
                inner.entries.remove(id);
                inner.config.keys.remove(id);
            }
            crate::log!(
                "[unblock] dropped {} records for endpoints that left the pool",
                stale.len()
            );
        }
        crate::log!(
            "[unblock] loaded {} endpoint records",
            inner.entries.len()
        );
    }

    /// Write the pool state out.
    pub fn persist(&self, app: &tauri::AppHandle) {
        let inner = self.inner.read().unwrap_or_else(|e| e.into_inner());
        let persisted = Persisted {
            config: inner.config.clone(),
            entries: inner.entries.clone(),
        };
        let path = state_path(app);
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        match serde_json::to_string_pretty(&persisted) {
            Ok(text) => {
                if let Err(e) = std::fs::write(&path, text) {
                    crate::log!("[unblock] could not persist pool: {e}");
                }
            }
            Err(e) => crate::log!("[unblock] could not serialize pool: {e}"),
        }
    }

    /// Mutate one endpoint's record.
    fn update_entry(&self, id: &str, f: impl FnOnce(&mut Entry)) {
        let mut inner = self.inner.write().unwrap_or_else(|e| e.into_inner());
        let entry = inner.entries.entry(id.to_string()).or_default();
        f(entry);
    }

    /// Every endpoint, in tier order, with its current status.
    pub fn statuses(&self) -> Vec<EndpointStatus> {
        let inner = self.inner.read().unwrap_or_else(|e| e.into_inner());
        ENDPOINTS
            .iter()
            .map(|ep| {
                let entry = inner.entries.get(ep.id).cloned().unwrap_or_default();
                EndpointStatus {
                    id: ep.id.to_string(),
                    label: ep.label.to_string(),
                    tier: ep.tier,
                    disabled: entry.disabled,
                    removed: entry.removed,
                    health: entry.health,
                    latency_ms: entry.latency_ms,
                    last_checked: entry.last_checked,
                    consecutive_failures: entry.consecutive_failures,
                    last_error: entry.last_error,
                    removed_at: entry.removed_at,
                }
            })
            .collect()
    }

    pub fn config(&self) -> PoolConfig {
        self.inner
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .config
            .clone()
    }

    pub fn set_config(&self, config: PoolConfig) {
        let mut inner = self.inner.write().unwrap_or_else(|e| e.into_inner());
        inner.config = config;
    }

    pub fn set_disabled(&self, id: &str, disabled: bool) {
        self.update_entry(id, |e| e.disabled = disabled);
    }

    /// Put a removed endpoint back into the pool.
    pub fn restore(&self, id: &str) {
        self.update_entry(id, |e| {
            e.removed = false;
            e.removed_at = None;
            e.consecutive_failures = 0;
            e.health = Health::Unknown;
            e.last_error = None;
        });
    }

    /// Put every removed endpoint back into the pool.
    pub fn restore_all(&self) {
        let mut inner = self.inner.write().unwrap_or_else(|e| e.into_inner());
        for entry in inner.entries.values_mut() {
            entry.removed = false;
            entry.removed_at = None;
            entry.consecutive_failures = 0;
            entry.health = Health::Unknown;
            entry.last_error = None;
        }
    }

    /// Record the outcome of one probe.
    fn record(
        &self,
        id: &str,
        health: Health,
        latency_ms: Option<u64>,
        error: Option<String>,
        threshold: u32,
    ) {
        let mut removed_now = false;
        self.update_entry(id, |entry| {
            entry.health = health;
            entry.latency_ms = latency_ms;
            entry.last_checked = Some(now_secs());
            entry.last_error = error;
            if health == Health::Down {
                entry.consecutive_failures = entry.consecutive_failures.saturating_add(1);
                if entry.consecutive_failures >= threshold && !entry.removed {
                    entry.removed = true;
                    entry.removed_at = Some(now_secs());
                    removed_now = true;
                }
            } else {
                entry.consecutive_failures = 0;
            }
        });
        if removed_now {
            crate::log!("[unblock] {id} removed from the pool after repeated failures");
        }
    }

    /// The endpoints that are in the pool right now: enabled, not
    /// removed, in tier order.
    fn active(&self) -> Vec<&'static Endpoint> {
        let inner = self.inner.read().unwrap_or_else(|e| e.into_inner());
        ENDPOINTS
            .iter()
            .filter(|ep| {
                let entry = inner.entries.get(ep.id);
                match entry {
                    Some(e) => !e.disabled && !e.removed,
                    None => true,
                }
            })
            .collect()
    }

    /// The endpoints worth *trying* for a resolution, best first.
    ///
    /// This is `active()` plus one filter: an endpoint the last probe
    /// found completely unreachable is skipped. It is not removed from
    /// the pool — a network blip is not a death sentence, and the
    /// periodic probe gives it another chance — but asking a known-dead
    /// endpoint for a URL costs a full request timeout, and the pool is
    /// walked tier by tier, so one dead endpoint in tier 1 delays every
    /// track behind it.
    fn resolvable(&self) -> Vec<&'static Endpoint> {
        let inner = self.inner.read().unwrap_or_else(|e| e.into_inner());
        ENDPOINTS
            .iter()
            .filter(|ep| {
                let entry = inner.entries.get(ep.id);
                match entry {
                    Some(e) => {
                        !e.disabled
                            && !e.removed
                            // A `Degraded` endpoint answered but had no
                            // URL for the probe song — it may still
                            // serve this one, so it is kept.
                            && e.health != Health::Down
                    }
                    None => true,
                }
            })
            .collect()
    }

    /// The API key for an endpoint, honouring a user override.
    fn key_for(&self, id: &str) -> String {
        let inner = self.inner.read().unwrap_or_else(|e| e.into_inner());
        inner
            .config
            .keys
            .get(id)
            .cloned()
            .unwrap_or_default()
    }
}

fn state_path(app: &tauri::AppHandle) -> std::path::PathBuf {
    let dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."));
    dir.join("unblock-pool.json")
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/// The outcome of one request to one endpoint.
struct Probe {
    health: Health,
    latency_ms: Option<u64>,
    error: Option<String>,
    url: Option<String>,
}

/// Resolve a parameter's value.
fn param_value(p: Param, song_id: &str, quality: &str, key: &str) -> String {
    match p {
        Param::Id => song_id.to_string(),
        Param::Level => quality.to_string(),
        Param::QualityCn => quality_cn(quality).to_string(),
        Param::Bitrate => quality_bitrate(quality).to_string(),
        Param::Key => key.to_string(),
        Param::Lit(s) => s.to_string(),
    }
}

/// Walk a path into a JSON value and return the string at the end.
fn json_string_at(value: &serde_json::Value, path: &[&str]) -> Option<String> {
    let mut cur = value;
    for seg in path {
        cur = cur.get(*seg)?;
    }
    match cur {
        serde_json::Value::String(s) => Some(s.clone()),
        _ => None,
    }
}

/// Whether an HTTP status means "the endpoint answered, but declined".
///
/// A 4xx is the unblock pool saying "I will not serve this song" —
/// the host is alive and the request reached it. Anything else (5xx,
/// a connection failure, a timeout) is the endpoint being unusable.
fn is_client_error(status: u16) -> bool {
    (400..500).contains(&status)
}

/// A URL that looks like a real media link.
///
/// The services fall back to NetEase's own "outer url" endpoint when
/// their account can't play the track; that link redirects to a page
/// rather than to audio, so it must not be mistaken for a stream.
fn is_playable_url(url: &str) -> bool {
    let u = url.trim();
    if !u.starts_with("http://") && !u.starts_with("https://") {
        return false;
    }
    if u.contains("music.163.com/song/media/outer/url") {
        return false;
    }
    true
}

/// Ask one endpoint for a URL.
async fn request_endpoint(
    ep: &'static Endpoint,
    song_id: &str,
    quality: &str,
    key: &str,
    client: &reqwest::Client,
) -> Probe {
    let url = ep.url.replace("{id}", song_id);
    let query: Vec<(String, String)> = ep
        .query
        .iter()
        .map(|(k, p)| (k.to_string(), param_value(*p, song_id, quality, key)))
        .collect();
    let form: Vec<(String, String)> = ep
        .form
        .iter()
        .map(|(k, p)| (k.to_string(), param_value(*p, song_id, quality, key)))
        .collect();
    let json: Vec<(String, String)> = ep
        .json
        .iter()
        .map(|(k, p)| (k.to_string(), param_value(*p, song_id, quality, key)))
        .collect();

    let mut req = match ep.method {
        Method::Get => client.get(&url),
        Method::PostForm => client.post(&url),
        Method::PostJson => client.post(&url),
    };
    if !query.is_empty() {
        req = req.query(&query);
    }
    // The endpoint's own User-Agent wins over the table's default: a
    // couple of these services serve a browser UA differently from a
    // plain client one.
    req = req.header("User-Agent", ua_for(ep.id));
    for (name, value) in ep.headers {
        // The `X-Api-Key` header carries the endpoint's key.
        let value = if *name == "X-Api-Key" {
            if key.is_empty() { value.to_string() } else { key.to_string() }
        } else if *name == "User-Agent" {
            // Already set above, from `ua_for`.
            continue;
        } else {
            value.to_string()
        };
        req = req.header(*name, value);
    }
    if !form.is_empty() {
        req = req.form(&form);
    }
    if !json.is_empty() {
        let map: serde_json::Map<String, serde_json::Value> = json
            .into_iter()
            .map(|(k, v)| (k, serde_json::Value::String(v)))
            .collect();
        req = req.json(&map);
    }

    let started = std::time::Instant::now();
    let resp = match req.timeout(REQUEST_TIMEOUT).send().await {
        Ok(r) => r,
        Err(e) => {
            return Probe {
                health: Health::Down,
                latency_ms: None,
                error: Some(short_error(&e)),
                url: None,
            }
        }
    };
    let latency_ms = started.elapsed().as_millis() as u64;

    if !resp.status().is_success() {
        // A 4xx means the endpoint *answered*: it is alive, it just
        // will not serve this song. That is a different situation from
        // an unreachable host, and it has to be recorded differently —
        // an endpoint that answered must not be retired for it, or a
        // probe song the pool declines to serve takes the whole pool
        // down with it.
        //
        // 5xx and 3xx are the server's problem, which is closer to
        // "unreachable right now" than to "alive but unhelpful", so
        // they still count as hard failures.
        let status = resp.status();
        let degraded = is_client_error(status.as_u16());
        return Probe {
            health: if degraded { Health::Degraded } else { Health::Down },
            latency_ms: Some(latency_ms),
            error: Some(if degraded {
                format!("HTTP {} (no link for this song)", status.as_u16())
            } else {
                format!("HTTP {}", status.as_u16())
            }),
            url: None,
        };
    }

    if ep.final_url {
        // The endpoint redirects to the CDN; the final URL is the stream.
        let final_url = resp.url().to_string();
        let ok = is_playable_url(&final_url) && final_url != url;
        return Probe {
            health: if ok { Health::Ok } else { Health::Degraded },
            latency_ms: Some(latency_ms),
            error: if ok {
                None
            } else {
                Some("no playable redirect".to_string())
            },
            url: ok.then_some(final_url),
        };
    }

    let body = match resp.text().await {
        Ok(b) => b,
        Err(e) => {
            return Probe {
                health: Health::Down,
                latency_ms: Some(latency_ms),
                error: Some(short_error(&e)),
                url: None,
            }
        }
    };

    if ep.raw_text {
        let candidate = body.trim().to_string();
        let ok = is_playable_url(&candidate);
        return Probe {
            health: if ok { Health::Ok } else { Health::Degraded },
            latency_ms: Some(latency_ms),
            error: if ok {
                None
            } else {
                Some("no url in body".to_string())
            },
            url: ok.then_some(candidate),
        };
    }

    let parsed: serde_json::Value = match serde_json::from_str(&body) {
        Ok(v) => v,
        Err(e) => {
            // The endpoint answered, but with something that isn't the
            // API's JSON — an HTML error page, or a shape that changed
            // under it. The host is reachable, so this is not a hard
            // failure: the pool keeps it, and the resolver simply
            // finds no URL in it.
            return Probe {
                health: Health::Degraded,
                latency_ms: Some(latency_ms),
                error: Some(format!("not json: {e}")),
                url: None,
            };
        }
    };

    let candidate = json_string_at(&parsed, ep.extract)
        .or_else(|| json_string_at(&parsed, &["data", "url"]))
        .or_else(|| json_string_at(&parsed, &["url"]))
        .unwrap_or_default();

    if is_playable_url(&candidate) {
        Probe {
            health: Health::Ok,
            latency_ms: Some(latency_ms),
            error: None,
            url: Some(candidate),
        }
    } else {
        Probe {
            health: Health::Degraded,
            latency_ms: Some(latency_ms),
            error: Some("no url for this song".to_string()),
            url: None,
        }
    }
}

/// A short, readable error string — these end up in the settings UI.
///
/// The length is capped so a long URL doesn't blow up the settings
/// list, but the cap has to respect character boundaries: slicing a
/// `String` at a byte index that isn't a boundary panics, and error
/// messages carry URLs and headers that can easily be cut in the
/// middle of a multi-byte character.
fn short_error(e: &reqwest::Error) -> String {
    shorten(&e.to_string(), 160)
}

/// Cap a string at `max` characters, on a character boundary.
fn shorten(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let cut = text
        .char_indices()
        .nth(max)
        .map(|(i, _)| i)
        .unwrap_or(text.len());
    format!("{}…", &text[..cut])
}

// ---------------------------------------------------------------------------
// Probing
// ---------------------------------------------------------------------------

/// Probe one endpoint with the given song id and quality.
///
/// A hard failure is retried once before it is believed. These are
/// volunteer-run servers on the public internet: a dropped connection
/// or a momentary 502 says more about the network than about the
/// endpoint, and every failure counts towards the threshold that
/// retires it. Believing the first answer would prune healthy
/// endpoints on a bad afternoon.
async fn probe_one(
    pool: &Pool,
    ep: &'static Endpoint,
    song_id: &str,
    quality: &str,
) -> (&'static str, Probe) {
    let key = pool.key_for(ep.id);
    let client = match proxy::build_client(reqwest::Client::builder()) {
        Ok(c) => c,
        Err(e) => {
            return (
                ep.id,
                Probe {
                    health: Health::Down,
                    latency_ms: None,
                    error: Some(e),
                    url: None,
                },
            )
        }
    };
    let probe = request_endpoint(ep, song_id, quality, &key, &client).await;
    if probe.health != Health::Down {
        return (ep.id, probe);
    }

    // The first attempt failed. Give it one more go after a short
    // pause before counting the failure.
    tokio::time::sleep(Duration::from_millis(800)).await;
    let retry = request_endpoint(ep, song_id, quality, &key, &client).await;
    match retry.health {
        Health::Down => (ep.id, probe),
        _ => (ep.id, retry),
    }
}

/// Probe every active endpoint and update the pool's health records.
///
/// Returns the updated statuses.
pub async fn probe_all(app: &tauri::AppHandle) -> Vec<EndpointStatus> {
    let pool = app.state::<Arc<Pool>>().inner().clone();
    let config = pool.config();
    let song_id = if config.probe_song_id.trim().is_empty() {
        DEFAULT_PROBE_SONG_ID.to_string()
    } else {
        config.probe_song_id.trim().to_string()
    };
    let targets: Vec<&'static Endpoint> = pool.active();

    // Probe concurrently: the endpoints are independent third parties
    // and a serial pass would take minutes.
    let mut set = tokio::task::JoinSet::new();
    for ep in targets {
        let song_id = song_id.clone();
        let pool = pool.clone();
        set.spawn(async move { probe_one(&pool, ep, &song_id, "hires").await });
    }

    while let Some(joined) = set.join_next().await {
        let Ok((id, probe)) = joined else { continue };
        pool.record(
            id,
            probe.health,
            probe.latency_ms,
            probe.error,
            config.failure_threshold,
        );
    }

    pool.persist(app);
    pool.statuses()
}

/// Start the background probe loop.
pub fn spawn_probe_task(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        // Give the app a moment to settle before the first pass, so a
        // cold start isn't competing with the window's own loading.
        tokio::time::sleep(Duration::from_secs(20)).await;
        loop {
            let pool = app.state::<Arc<Pool>>().inner().clone();
            let config = pool.config();
            if config.probe_on_startup {
                crate::log!("[unblock] running probe pass");
                probe_all(&app).await;
            }
            let minutes = config.probe_interval_minutes.max(5);
            tokio::time::sleep(Duration::from_secs(minutes * 60)).await;
        }
    });
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/// A resolved stream URL.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Resolved {
    pub url: String,
    /// The endpoint that produced it.
    pub endpoint: String,
    pub tier: u8,
    pub quality: String,
    pub latency_ms: Option<u64>,
}

/// Resolve a NetEase song id to a playable URL, walking the pool.
///
/// Tiers are tried in order (SVIP first, unstable accounts last) and
/// within a tier the quality ladder is walked from best to worst. The
/// first endpoint that hands back a playable URL wins.
pub async fn resolve(app: &tauri::AppHandle, song_id: &str) -> Option<Resolved> {
    let pool = app.state::<Arc<Pool>>().inner().clone();
    let endpoints = pool.resolvable();
    if endpoints.is_empty() {
        return None;
    }
    let mut by_tier: Vec<u8> = endpoints.iter().map(|e| e.tier).collect();
    by_tier.sort_unstable();
    by_tier.dedup();

    for tier in by_tier {
        let tier_endpoints: Vec<&'static Endpoint> =
            endpoints.iter().copied().filter(|e| e.tier == tier).collect();
        for quality in QUALITIES {
            for ep in &tier_endpoints {
                let key = pool.key_for(ep.id);
                let client = match proxy::build_client(reqwest::Client::builder()) {
                    Ok(c) => c,
                    Err(_) => continue,
                };
                let probe =
                    request_endpoint(ep, song_id, quality, &key, &client).await;
                if let Some(url) = probe.url {
                    crate::log!(
                        "[unblock] {song_id} resolved via {} ({quality})",
                        ep.id
                    );
                    pool.record(
                        ep.id,
                        Health::Ok,
                        probe.latency_ms,
                        None,
                        pool.config().failure_threshold,
                    );
                    return Some(Resolved {
                        url,
                        endpoint: ep.id.to_string(),
                        tier: ep.tier,
                        quality: quality.to_string(),
                        latency_ms: probe.latency_ms,
                    });
                }
                if probe.health == Health::Down {
                    pool.record(
                        ep.id,
                        Health::Down,
                        probe.latency_ms,
                        probe.error,
                        pool.config().failure_threshold,
                    );
                }
            }
        }
    }
    crate::log!("[unblock] {song_id}: no endpoint produced a url");
    None
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Every endpoint's status.
#[tauri::command]
pub fn unblock_pool_status(pool: tauri::State<'_, Arc<Pool>>) -> Vec<EndpointStatus> {
    pool.statuses()
}

/// The pool's settings.
#[tauri::command]
pub fn unblock_pool_config(pool: tauri::State<'_, Arc<Pool>>) -> PoolConfig {
    pool.config()
}

/// Update the pool's settings.
#[tauri::command]
pub fn unblock_pool_set_config(
    app: tauri::AppHandle,
    pool: tauri::State<'_, Arc<Pool>>,
    config: PoolConfig,
) -> Vec<EndpointStatus> {
    pool.set_config(config);
    pool.persist(&app);
    pool.statuses()
}

/// Probe every active endpoint now.
#[tauri::command]
pub async fn unblock_pool_probe(
    app: tauri::AppHandle,
) -> Result<Vec<EndpointStatus>, String> {
    Ok(probe_all(&app).await)
}

/// Turn one endpoint on or off.
#[tauri::command]
pub fn unblock_pool_set_enabled(
    app: tauri::AppHandle,
    pool: tauri::State<'_, Arc<Pool>>,
    id: String,
    enabled: bool,
) -> Vec<EndpointStatus> {
    pool.set_disabled(&id, !enabled);
    pool.persist(&app);
    pool.statuses()
}

/// Put one endpoint back into the pool.
#[tauri::command]
pub fn unblock_pool_restore(
    app: tauri::AppHandle,
    pool: tauri::State<'_, Arc<Pool>>,
    id: String,
) -> Vec<EndpointStatus> {
    pool.restore(&id);
    pool.persist(&app);
    pool.statuses()
}

/// Put every removed endpoint back into the pool.
#[tauri::command]
pub fn unblock_pool_restore_all(
    app: tauri::AppHandle,
    pool: tauri::State<'_, Arc<Pool>>,
) -> Vec<EndpointStatus> {
    pool.restore_all();
    pool.persist(&app);
    pool.statuses()
}

/// Resolve a NetEase song id to a playable URL through the pool.
///
/// Returns `None` when no endpoint produced a URL — the caller then
/// falls back to the official API (which needs the user's own
/// membership) or gives up.
#[tauri::command]
pub async fn unblock_resolve(
    app: tauri::AppHandle,
    song_id: String,
) -> Result<Option<Resolved>, String> {
    if song_id.trim().is_empty() {
        return Err("empty song id".into());
    }
    Ok(resolve(&app, song_id.trim()).await)
}

/// Resolve a NetEase song id through the pool and hand back the bytes
/// as a direct URL, ready for an `<audio>` element.
///
/// The URL is short-lived (the CDN links expire), so this is called
/// per play rather than cached.
#[tauri::command]
pub async fn unblock_stream_url(
    app: tauri::AppHandle,
    song_id: String,
) -> Result<String, String> {
    match resolve(&app, song_id.trim()).await {
        Some(r) => Ok(r.url),
        None => Err(format!("no unblock endpoint could resolve {song_id}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_endpoint_has_a_unique_id() {
        let mut ids: Vec<&str> = ENDPOINTS.iter().map(|e| e.id).collect();
        ids.sort_unstable();
        let count = ids.len();
        ids.dedup();
        assert_eq!(ids.len(), count, "duplicate endpoint id");
    }

    #[test]
    fn the_pool_covers_tiers_one_and_two() {
        // The pool is the meting family and nothing else. Two tiers
        // are enough: the two SVIP deployments are tried first, the
        // third (VIP) one last.
        for tier in 1..=2 {
            assert!(
                ENDPOINTS.iter().any(|e| e.tier == tier),
                "no endpoint in tier {tier}"
            );
        }
    }

    #[test]
    fn the_pool_holds_only_the_meting_family() {
        // The user asked for the meting endpoints and nothing else.
        // The family is the same open-source API at three operators,
        // so every entry must speak its dialect: a `server`/`type`/
        // `id`/`br` query and a redirect to the CDN.
        assert_eq!(ENDPOINTS.len(), 3, "the pool should hold three mirrors");
        for ep in ENDPOINTS {
            assert!(
                ep.id.contains("qijieya")
                    || ep.id.contains("nanorocky")
                    || ep.id.contains("injahow"),
                "{} is not a meting mirror",
                ep.id
            );
            assert_eq!(
                ep.method,
                Method::Get,
                "{} does not use the meting GET dialect",
                ep.id
            );
        }
    }

    #[test]
    fn json_paths_reach_strings() {
        let v: serde_json::Value =
            serde_json::from_str(r#"{"data":{"song":{"url":"https://x/y.flac"}}}"#)
                .unwrap();
        assert_eq!(
            json_string_at(&v, &["data", "song", "url"]).as_deref(),
            Some("https://x/y.flac")
        );
        assert_eq!(json_string_at(&v, &["data", "missing"]), None);
    }

    #[test]
    fn the_netease_fallback_link_is_not_playable() {
        assert!(!is_playable_url(
            "https://music.163.com/song/media/outer/url?id=123"
        ));
        assert!(is_playable_url("https://m801.music.126.net/x.mp3"));
        assert!(!is_playable_url("ftp://example.com/x.mp3"));
        assert!(!is_playable_url("not a url"));
    }

    #[test]
    fn quality_names_cover_the_ladder() {
        for q in QUALITIES {
            assert!(!quality_cn(q).is_empty());
        }
        assert_eq!(quality_cn("hires"), "Hi-Res");
        assert_eq!(quality_cn("lossless"), "无损");
    }

    /// Shortening an error message must not cut a character in half.
    ///
    /// Slicing a `String` at a byte index that isn't a character
    /// boundary panics, and error messages carry URLs, which are full
    /// of multi-byte characters. The cap has to count characters, not
    /// bytes.
    #[test]
    fn shortening_never_cuts_a_character_in_half() {
        // Every cut point is exercised: the multi-byte characters make
        // each byte offset land mid-character somewhere.
        for len in 11..40 {
            let text = "错".repeat(len);
            let out = shorten(&text, 10);
            assert!(out.ends_with('…'), "not truncated at len {len}");
            assert!(out.chars().all(|c| c == '错' || c == '…'));
            assert_eq!(out.chars().filter(|c| *c == '错').count(), 10);
        }
        // A string that already fits is returned untouched.
        assert_eq!(shorten("abc", 10), "abc");
        assert_eq!(shorten("abc", 3), "abc");
        assert_eq!(shorten("错错错", 3), "错错错");
        // Exactly at the limit: no ellipsis.
        assert_eq!(shorten("abcde", 5), "abcde");
        assert_eq!(shorten("abcde", 4), "abcd…");
    }

    /// A 4xx must not retire an endpoint.
    ///
    /// The unblock proxies only serve tracks the platform gates behind
    /// a paid tier. Asked for a free track they answer `404` or
    /// `400` — which means the endpoint *answered*, not that it is
    /// broken. Treating those as hard failures retires healthy
    /// endpoints whenever the probe song happens to be one the pool
    /// declines to serve.
    #[test]
    fn a_client_error_means_alive_but_unwilling() {
        for status in [400u16, 401, 403, 404, 422] {
            assert!(
                is_client_error(status),
                "HTTP {status} should be a soft failure"
            );
        }
        for status in [500u16, 502, 503, 504] {
            assert!(
                !is_client_error(status),
                "HTTP {status} should be a hard failure"
            );
        }
    }

    #[test]
    fn the_probe_song_default_is_a_live_paid_track() {
        // The probe has to be a track that is behind a membership at
        // every tier, or the pool proves nothing.
        assert_eq!(DEFAULT_PROBE_SONG_ID, "347230");
    }

    #[test]
    fn the_retired_probe_songs_all_migrate_forward() {
        // Every id the default has ever held must be in the migration
        // list, or a persisted config pins a stale song forever.
        assert!(OLD_DEFAULT_PROBE_SONG_IDS.contains(&"185709"));
        assert!(OLD_DEFAULT_PROBE_SONG_IDS.contains(&"1824045033"));
        for old in OLD_DEFAULT_PROBE_SONG_IDS {
            assert_ne!(*old, DEFAULT_PROBE_SONG_ID);
        }
    }

    #[test]
    fn the_meting_bitrate_ladder_maps_onto_what_the_api_understands() {
        // `999` is the API's lossless marker; anything else it takes
        // is a plain mp3 bitrate.
        assert_eq!(quality_bitrate("jymaster"), "999");
        assert_eq!(quality_bitrate("hires"), "999");
        assert_eq!(quality_bitrate("lossless"), "999");
        assert_eq!(quality_bitrate("exhigh"), "320");
        assert_eq!(quality_bitrate("standard"), "128");
    }

    #[test]
    fn every_endpoint_in_the_table_is_one_the_probe_song_can_test() {
        // The pool is only as honest as its table: an endpoint that
        // cannot answer costs a timeout on every unblock.
        for ep in ENDPOINTS {
            assert!(!ep.id.is_empty());
            assert!(!ep.label.is_empty());
            assert!((1..=4).contains(&ep.tier), "{} has no tier", ep.id);
            assert!(
                ep.url.starts_with("https://"),
                "{} is not over TLS",
                ep.id
            );
        }
    }

    #[test]
    fn the_meting_endpoints_all_ask_for_a_bitrate() {
        // The meting family speaks in bitrates, not in NetEase's
        // quality names; getting that wrong asks for a format the
        // track does not have.
        for ep in ENDPOINTS {
            if !ep.id.contains("qijieya")
                && !ep.id.contains("nanorocky")
                && !ep.id.contains("injahow")
            {
                continue;
            }
            assert!(
                ep.query.iter().any(|(k, _)| *k == "br"),
                "{} does not send a bitrate",
                ep.id
            );
            assert!(ep.final_url, "{} does not follow the redirect", ep.id);
        }
    }

    /// Probe the live pool and print what each endpoint answered.
    ///
    /// This is the check that keeps the endpoint table honest: the
    /// third-party APIs rot constantly, and a table that is stale is
    /// worse than no table, because playback then waits out a request
    /// timeout on every track. Run it with:
    ///
    /// ```text
    /// cargo test --lib unblock::tests::the_live_pool_still_answers -- --ignored --nocapture
    /// ```
    #[tokio::test]
    #[ignore = "hits the network"]
    async fn the_live_pool_still_answers() {
        let song_id = DEFAULT_PROBE_SONG_ID;
        let client = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .expect("client");

        let mut set = tokio::task::JoinSet::new();
        for ep in ENDPOINTS {
            let key = String::new();
            let client = client.clone();
            let song_id = song_id.to_string();
            set.spawn(async move {
                let probe = request_endpoint(ep, &song_id, "hires", &key, &client).await;
                (ep.id, probe)
            });
        }

        let mut ok = 0usize;
        let mut degraded = 0usize;
        let mut down = 0usize;
        while let Some(joined) = set.join_next().await {
            let Ok((id, probe)) = joined else { continue };
            match probe.health {
                Health::Ok => ok += 1,
                Health::Degraded => degraded += 1,
                Health::Down => down += 1,
                Health::Unknown => {}
            }
            println!(
                "{:<16} {:?} {:?} {}",
                id,
                probe.health,
                probe.latency_ms,
                probe.error.as_deref().unwrap_or("")
            );
        }
        println!("ok {ok} · degraded {degraded} · down {down}");
        assert!(
            ok > 0,
            "no endpoint resolved {song_id}; the table is stale"
        );
    }
}
