//! The NetEase account.
//!
//! # Why NetEase has its own account store
//!
//! The YouTube account store (`lib.rs`) is a *per-YouTube-account* jar:
//! it holds Google's cookies and nothing else. NetEase needs a
//! completely different credential — `MUSIC_U`, the cookie that
//! identifies a NetEase account — and it must not be tied to whichever
//! YouTube account happens to be active. Signing in and out of NetEase
//! is independent of signing in and out of Google.
//!
//! So NetEase gets its own small store: one encrypted file holding the
//! `MUSIC_U` value (plus the `__csrf` token, which the web client pairs
//! with it).
//!
//! # What the credential buys
//!
//! `MUSIC_U` is what makes the daily recommendation personal. The
//! endpoint answers anonymously with an empty list — there is no
//! "everyone's recommendation" to show. With the cookie it answers with
//! a playlist picked for that account, and the same cookie is what
//! tells the platform which tracks the account may actually play.
//!
//! # How the sign-in works
//!
//! The sign-in is the platform's own QR-code protocol, spoken directly
//! rather than through a browser window:
//!
//!   1. ask the platform for a one-time key (`unikey`);
//!   2. render that key as a QR code *locally* — the picture never
//!      leaves the machine, only the key does;
//!   3. poll the platform for the scan state until the user has
//!      scanned and confirmed on their phone;
//!   4. keep the `MUSIC_U` the platform hands back.
//!
//! An earlier version of this opened NetEase's own login page in a
//! WebView2 window and scraped the cookie out of the browser's cookie
//! store. That worked, but it was slow to start, slow to notice the
//! sign-in, and it needed a whole browser window for a two-field
//! credential — and the window often outlived the moment the user had
//! signed in, which is what "the app takes a few seconds to notice"
//! felt like. The protocol below has no window at all: the credential
//! lands in the app's hands within one poll interval of the user
//! confirming on their phone.
//!
//! # The QR code has to point at the scan-login page
//!
//! The QR code does not point at the platform's login page. It points
//! at `/st/platform/scanlogin` — the page whose whole job is to be
//! opened by the phone's scanner, report the scan back to the
//! platform, and show the "authorise this sign-in?" prompt. The
//! plain `/login?codekey=…` page looks equivalent and is not: the
//! phone's scanner opens it, the platform redirects it to the mobile
//! login form, and the scan is never reported. The poller then waits
//! for a scan that will not arrive, and the user is left staring at a
//! QR code that "did not work".
//!
//! The scan-login page also reads the sign-in attempt's `chainId` from
//! the same URL, and the platform checks that id against the one the
//! poll request carries. So the id travels twice — once inside the QR
//! code, once in the `x-login-chain-id` header — and the two have to
//! be the same one.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use tauri::{Emitter, Manager};

use crate::secure_store;

/// The NetEase credential, as it is stored on disk.
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NeteaseAccount {
    /// The `MUSIC_U` cookie — the account identity.
    pub music_u: String,
    /// The `__csrf` token the web client pairs with `MUSIC_U`.
    pub csrf: String,
    /// The account's numeric id, for display.
    pub user_id: Option<String>,
    /// The account's display name, for display.
    pub nickname: Option<String>,
    /// The account's avatar, for display.
    pub avatar_url: Option<String>,
    /// Unix seconds of the sign-in.
    pub signed_in_at: Option<u64>,
}

impl NeteaseAccount {
    /// Whether the stored credential can be used.
    fn is_valid(&self) -> bool {
        !self.music_u.trim().is_empty()
    }
}

/// Where the NetEase credential lives.
fn credential_path(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("netease.enc")
}

/// Read the stored NetEase credential, if there is one.
pub async fn load(app: &tauri::AppHandle) -> Option<NeteaseAccount> {
    let path = credential_path(app);
    let encrypted = tokio::fs::read(&path).await.ok()?;
    let plain = tokio::task::spawn_blocking(move || secure_store::decrypt(&encrypted))
        .await
        .ok()?
        .ok()?;
    let account: NeteaseAccount = serde_json::from_slice(&plain).ok()?;
    account.is_valid().then_some(account)
}

/// Read the stored NetEase credential from an explicit path.
///
/// The same as `load`, but without a Tauri handle — the diagnostic
/// tests run outside the app's own process, where the only thing
/// available is the path.
#[cfg(test)]
pub(crate) async fn load_from(path: PathBuf) -> Option<NeteaseAccount> {
    let encrypted = tokio::fs::read(&path).await.ok()?;
    let plain = tokio::task::spawn_blocking(move || secure_store::decrypt(&encrypted))
        .await
        .ok()?
        .ok()?;
    let account: NeteaseAccount = serde_json::from_slice(&plain).ok()?;
    account.is_valid().then_some(account)
}

/// Write the NetEase credential.
async fn save(app: &tauri::AppHandle, account: &NeteaseAccount) -> Result<(), String> {
    let path = credential_path(app);
    if let Some(dir) = path.parent() {
        tokio::fs::create_dir_all(dir)
            .await
            .map_err(|e| format!("mkdir netease dir: {e}"))?;
    }
    let plain = serde_json::to_vec(account).map_err(|e| format!("serialize: {e}"))?;
    let encrypted =
        tokio::task::spawn_blocking(move || secure_store::encrypt(&plain))
            .await
            .map_err(|e| format!("encrypt join: {e}"))?
            .map_err(|e| format!("encrypt: {e}"))?;
    crate::write_atomic(&path, &encrypted).await
        .map_err(|e| format!("write netease credential: {e}"))
}

/// Delete the stored NetEase credential.
pub async fn clear(app: &tauri::AppHandle) {
    let path = credential_path(app);
    if let Err(e) = tokio::fs::remove_file(&path).await {
        if e.kind() != std::io::ErrorKind::NotFound {
            crate::log!("[netease] clear credential failed: {e}");
        }
    }
}

/// The `Cookie:` header to send to NetEase, or `None` when nobody is
/// signed in.
///
/// This is the *NetEase* credential, not the YouTube jar's — the two
/// are unrelated and neither depends on the other.
pub async fn cookie_header(app: &tauri::AppHandle) -> Option<String> {
    let account = load(app).await?;
    let mut parts = vec![format!("MUSIC_U={}", account.music_u.trim())];
    if !account.csrf.trim().is_empty() {
        parts.push(format!("__csrf={}", account.csrf.trim()));
    }
    Some(parts.join("; "))
}

/// Why a sign-in attempt failed.
///
/// The backend reports *what* went wrong as a code and the frontend
/// turns that into a sentence in the user's own language. The backend
/// does not send English sentences: the only locale-aware part of the
/// app is the frontend, and a message that only exists in the backend
/// can only ever be in one language.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NeteaseLoginFailure {
    /// The machine-readable reason.
    pub code: NeteaseFailureCode,
    /// Extra detail, when there is any worth showing.
    pub detail: Option<String>,
}

/// The reasons a sign-in attempt can fail.
#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum NeteaseFailureCode {
    /// The QR code was not scanned in time.
    Expired,
    /// The platform's risk control refused the attempt.
    Blocked,
    /// The platform accepted the sign-in but sent no credential.
    NoCredential,
    /// The client could not be built at all.
    Client,
    /// The credential could not be written to disk.
    Storage,
}

impl NeteaseLoginFailure {
    /// A failure with no extra detail.
    fn new(code: NeteaseFailureCode) -> Self {
        NeteaseLoginFailure {
            code,
            detail: None,
        }
    }

    /// A failure with a technical detail attached.
    fn with_detail(code: NeteaseFailureCode, detail: impl Into<String>) -> Self {
        NeteaseLoginFailure {
            code,
            detail: Some(detail.into()),
        }
    }
}

/// What the frontend asks for when it wants to know the NetEase
/// session state.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NeteaseSession {
    /// Somebody is signed in.
    pub signed_in: bool,
    pub user_id: Option<String>,
    pub nickname: Option<String>,
    pub avatar_url: Option<String>,
}

pub async fn session(app: &tauri::AppHandle) -> NeteaseSession {
    match load(app).await {
        Some(account) => NeteaseSession {
            signed_in: true,
            user_id: account.user_id,
            nickname: account.nickname,
            avatar_url: account.avatar_url,
        },
        None => NeteaseSession {
            signed_in: false,
            user_id: None,
            nickname: None,
            avatar_url: None,
        },
    }
}

/// The NetEase session state, for the settings screen.
#[tauri::command]
pub async fn netease_session(app: tauri::AppHandle) -> Result<NeteaseSession, String> {
    Ok(session(&app).await)
}

// ---------------------------------------------------------------------------
// The QR-code sign-in
// ---------------------------------------------------------------------------

/// The endpoint that hands out a one-time key for a QR sign-in.
///
/// This is the platform's *web* endpoint, not the encrypted app one: it
/// answers a plain form POST, which keeps the sign-in free of any
/// request-signing machinery.
const UNKEY_URL: &str = "https://music.163.com/api/login/qrcode/unikey";

/// The endpoint that reports the scan state for a key.
const CHECK_URL: &str = "https://music.163.com/api/login/qrcode/client/login";

/// The page the QR code points at.
///
/// This has to be the platform's *scan-login* page, not the plain login
/// page. The two look interchangeable — both carry the `codekey` — but
/// they are different pages with different jobs:
///
///   * `/login?codekey=…` is the web client's own login page. The
///     phone's scanner opens it, the platform redirects it to the
///     *mobile* login page (`/m/login?codekey=…`), and the phone
///     ends up looking at a login form. Nothing ever tells the
///     platform that this particular device scanned the code, so the
///     poller sits at "waiting for a scan" forever.
///   * `/st/platform/scanlogin?codekey=…` is the page built for
///     exactly this: the phone's scanner opens it, and it is the
///     page that reports the scan back to the platform and shows the
///     "authorise this sign-in?" prompt.
///
/// The official web client encodes the second one (see the
/// `scanlogin` URL it builds), and so does every working third-party
/// client. The extra query parameters are not decoration — the
/// platform reads `chainId` to tie the phone's confirmation to the
/// request that issued the key, and `hitExp` to enable the
/// experiment flags the scan flow expects.
const QR_CONTENT_URL: &str = "https://music.163.com/st/platform/scanlogin";

/// The query the QR code's URL carries.
///
/// The platform's scan-login page reads `codekey` (the one-time key),
/// `chainId` (the id of the sign-in attempt) and `hitExp` (the
/// experiment flags). `hdw_device` / `hdw_appid` describe the
/// *scanning* hardware, which for a desktop client is the web.
const QR_QUERY_DEVICE: &str = "hdw_device=web&hdw_appid=web&hitExp=1";

/// How often the scan state is polled.
///
/// The official web client polls once a second. That is also the
/// platform's own guidance for the sign-in endpoints — polling faster
/// is what trips the risk control (the `8821` code below). A second
/// between the user confirming on their phone and the app noticing is
/// well within "instant".
const POLL_INTERVAL_MS: u64 = 1000;

/// The scan states the platform reports.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum ScanState {
    /// The key is gone or has expired — the user has to start over.
    Expired,
    /// Nobody has scanned yet.
    Waiting,
    /// Scanned; the user still has to confirm on their phone.
    Confirming,
    /// Signed in. The credential is in the response.
    Authorized,
    /// The platform's risk control blocked the attempt.
    ///
    /// `8821` means "switch to another sign-in method, or upgrade to a
    /// newer client". It is not a bug in the request — it is the
    /// platform refusing *this* client, usually because the sign-in
    /// endpoints were polled too often. The official client shows it
    /// as an explicit "try another way to sign in" prompt rather than
    /// leaving the user on a QR code that will never work.
    Blocked,
}

/// What the platform answers when the scan state is polled.
pub(crate) struct ScanStatus {
    pub(crate) state: ScanState,
    /// The `MUSIC_U` the platform handed back, on success.
    pub(crate) music_u: Option<String>,
    /// The `__csrf` that pairs with it.
    pub(crate) csrf: Option<String>,
    /// The account's name, which the platform knows as soon as the
    /// phone has scanned.
    pub(crate) nickname: Option<String>,
    /// The account's avatar, likewise.
    pub(crate) avatar_url: Option<String>,
    /// The account's numeric id.
    pub(crate) user_id: Option<String>,
}

/// A browser-shaped header set. The platform's web API rejects requests
/// without a UA.
fn headers() -> reqwest::header::HeaderMap {
    let mut h = reqwest::header::HeaderMap::new();
    h.insert(
        reqwest::header::USER_AGENT,
        reqwest::header::HeaderValue::from_static(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
        ),
    );
    h.insert(
        reqwest::header::REFERER,
        reqwest::header::HeaderValue::from_static("https://music.163.com/"),
    );
    h
}

// ---------------------------------------------------------------------------
// The device fingerprint
// ---------------------------------------------------------------------------

/// The device id the sign-in attempt is made from.
///
/// The platform's own web client keeps one `sDeviceId` per browser
/// profile and builds every sign-in attempt's `chainId` from it. The
/// id is not a secret and does not identify a person — it identifies
/// *this* client, so the platform can tell the request that issued a
/// key apart from the phone that later confirms it.
pub(crate) fn device_id() -> String {
    // The platform's own format: "YD-" followed by 32 hex digits.
    // It only has to be stable for the lifetime of the attempt and
    // unique enough that two clients never collide.
    let mut bytes = [0u8; 16];
    if getrandom::fill(&mut bytes).is_err() {
        // Without entropy there is no fingerprint to speak of; fall
        // back to the clock, which is still unique enough for the few
        // minutes an attempt lives.
        let now = time::OffsetDateTime::now_utc().unix_timestamp_nanos();
        return format!("YD-{now:032x}");
    }
    let mut hex = String::with_capacity(32);
    for b in bytes {
        hex.push_str(&format!("{b:02x}"));
    }
    format!("YD-{hex}")
}

/// The id of one sign-in attempt.
///
/// The platform builds it the same way for every client:
/// `v1_<device id>_web_login_<milliseconds since the epoch>`. It
/// goes into the QR code's URL *and* into the `x-login-chain-id`
/// header of the poll request — the two have to match, because that
/// is how the platform knows the poll belongs to the code the phone
/// scanned.
pub(crate) fn chain_id(device: &str) -> String {
    let now = time::OffsetDateTime::now_utc().unix_timestamp() * 1000;
    format!("v1_{device}_web_login_{now}")
}

/// The URL the QR code encodes.
///
/// The key, the attempt's chain id and the device description all go
/// into the scan-login page's query string, in the order the official
/// client uses.
pub(crate) fn qr_content_url(key: &str, chain: &str) -> String {
    format!("{QR_CONTENT_URL}?codekey={key}&chainId={chain}&{QR_QUERY_DEVICE}")
}

/// The QR code the frontend shows, and the key it belongs to.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NeteaseQrCode {
    /// The PNG of the QR code, as a `data:` URL.
    pub image: String,
    /// The key the QR encodes, so the frontend can show it as text too.
    pub key: String,
    /// The id of this sign-in attempt, which the poll request has to
    /// repeat so the platform can match it to the code the phone
    /// scanned.
    pub chain_id: String,
    /// The device the attempt is made from, sent along as the
    /// platform's `sDeviceId` cookie.
    pub device_id: String,
}

/// Ask the platform for a one-time key and render it as a QR code.
///
/// The QR code is drawn *here*, on this machine: the picture is a local
/// rendering of the key and never travels anywhere. Only the key does.
#[tauri::command]
pub async fn netease_qr_code(_app: tauri::AppHandle) -> Result<NeteaseQrCode, String> {
    let client = crate::proxy::build_client(reqwest::Client::builder())
        .map_err(|e| format!("netease client: {e}"))?;

    let resp = client
        .post(UNKEY_URL)
        .headers(headers())
        .form(&[("type", "1"), ("noCheckToken", "true")])
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("netease unikey: {e}"))?;

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("netease unikey json: {e}"))?;

    let key = body
        .get("unikey")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| format!("netease unikey: unexpected response {}", body))?
        .to_string();

    let device = device_id();
    let chain = chain_id(&device);
    let image = render_qr(&qr_content_url(&key, &chain))?;
    Ok(NeteaseQrCode {
        image,
        key,
        chain_id: chain,
        device_id: device,
    })
}

/// Render a QR code as a PNG data URL.
pub(crate) fn render_qr(content: &str) -> Result<String, String> {
    let code = qrcode::QrCode::new(content).map_err(|e| format!("qr encode: {e}"))?;

    // The quiet zone is what makes the code scannable — without it
    // some phone cameras cannot find the edges. `min_dimensions` keeps
    // the modules square while growing the picture to a comfortable
    // size for a phone to read off the screen.
    let image = code
        .render::<image::Luma<u8>>()
        .min_dimensions(256, 256)
        .build();

    let mut png = Vec::new();
    image::DynamicImage::ImageLuma8(image)
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .map_err(|e| format!("qr png: {e}"))?;

    Ok(format!(
        "data:image/png;base64,{}",
        base64::Engine::encode(&base64::engine::general_purpose::STANDARD, png)
    ))
}

/// Ask the platform what the scan state is.
///
/// The credential comes back in the response's `Set-Cookie` headers —
/// the platform does not put it in the JSON body (unless asked to).
///
/// The request mirrors the official web client's: a `POST` with the
/// key in the form body, the `X-loginMethod` header that says this
/// is a QR sign-in, and the `x-login-chain-id` header that names the
/// attempt. The chain id is not optional decoration — it is how the
/// platform matches the poll to the code the phone actually scanned,
/// and a poll without it is a poll about no particular sign-in.
pub(crate) async fn poll_scan_state(
    client: &reqwest::Client,
    key: &str,
    chain: &str,
    device: &str,
    no_cookie: bool,
) -> Result<ScanStatus, String> {
    // The platform caches responses, and a cached answer would report
    // the same scan state forever. The timestamp makes every poll a
    // distinct URL.
    let timestamp = time::OffsetDateTime::now_utc().unix_timestamp().to_string();

    let mut query: Vec<(&str, &str)> = vec![("timestamp", timestamp.as_str())];
    if no_cookie {
        query.push(("noCookie", "true"));
    }

    let resp = client
        .post(CHECK_URL)
        .headers(headers())
        .header("x-login-chain-id", chain)
        .header("X-loginMethod", "QrCode")
        .header(reqwest::header::COOKIE, format!("sDeviceId={device}"))
        .query(&query)
        .form(&[("type", "1"), ("noCheckToken", "true"), ("key", key)])
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("netease qr check: {e}"))?;

    // The headers have to be read before the body is consumed.
    let set_cookie = resp
        .headers()
        .get_all(reqwest::header::SET_COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .collect::<Vec<_>>()
        .join("; ");

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("netease qr check json: {e}"))?;

    let code = body.get("code").and_then(|c| c.as_i64()).unwrap_or(0);

    // The credential can arrive two ways: in the `Set-Cookie` headers,
    // or — when `noCookie` was asked for — in a `cookie` field in the
    // body. Read both, and let either one satisfy the lookup.
    let header_value = |name: &str| -> Option<String> {
        set_cookie
            .split(';')
            .filter_map(|part| part.trim().split_once('='))
            .find(|(k, _)| *k == name)
            .map(|(_, v)| v.trim().to_string())
            .filter(|v| !v.is_empty())
    };
    let body_cookie = body
        .get("cookie")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    let cookie_value = |name: &str| -> Option<String> {
        header_value(name).or_else(|| {
            body_cookie
                .split(';')
                .filter_map(|part| part.trim().split_once('='))
                .find(|(k, _)| *k == name)
                .map(|(_, v)| v.trim().to_string())
                .filter(|v| !v.is_empty())
        })
    };

    let state = match code {
        800 => ScanState::Expired,
        801 => ScanState::Waiting,
        802 => ScanState::Confirming,
        803 => ScanState::Authorized,
        // 8821 / 8830: the platform's risk control refused this
        // client. The official client treats these as "try another way
        // to sign in" rather than as an ordinary wait.
        8821 | 8830 => ScanState::Blocked,
        _ => ScanState::Waiting,
    };

    Ok(ScanStatus {
        state,
        music_u: cookie_value("MUSIC_U"),
        csrf: cookie_value("__csrf"),
        nickname: body
            .get("nickname")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        avatar_url: body
            .get("avatarUrl")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        user_id: body
            .get("userId")
            .or_else(|| body.get("user_id"))
            .and_then(|v| v.as_i64())
            .map(|v| v.to_string()),
    })
}

/// The sign-in state that is shared between the command and its
/// poller.
///
/// The *generation* is what makes a replacement code work. Every
/// attempt takes the next number; the poller checks its own number
/// against the current one on every tick and gives up as soon as they
/// differ. That is what lets the user ask for a fresh code — or close
/// the dialog — without the old poller carrying on in the background
/// and racing the new one for the credential.
struct LoginState {
    /// The attempt that is currently in progress.
    generation: AtomicU64,
}

impl LoginState {
    /// The shared instance.
    fn get() -> &'static LoginState {
        static STATE: std::sync::OnceLock<LoginState> = std::sync::OnceLock::new();
        STATE.get_or_init(|| LoginState {
            generation: AtomicU64::new(0),
        })
    }

    /// Begin a new attempt and return its number.
    fn begin(&self) -> u64 {
        self.generation.fetch_add(1, Ordering::SeqCst) + 1
    }

    /// Whether the given attempt is still the current one.
    fn is_current(&self, generation: u64) -> bool {
        self.generation.load(Ordering::SeqCst) == generation
    }
}

/// Wait for the user to scan the code and confirm on their phone.
///
/// Returns the QR code so the caller can show it straight away — an
/// event would race the dialog's own mount, and a code that arrives
/// before anyone is listening is a code nobody ever sees.
///
/// The credential is stored, announced and *then* the profile is
/// enriched in the background — the profile is decoration, and asking
/// the platform for it before telling the user they are signed in is
/// what used to leave the app looking stuck.
#[tauri::command]
pub async fn netease_start_login(app: tauri::AppHandle) -> Result<NeteaseQrCode, String> {
    // Starting a new attempt supersedes any attempt already running:
    // the platform invalidates the old key when a new one is issued,
    // so the old poller would only be waiting for a key that can never
    // come back.
    let generation = LoginState::get().begin();

    let qr = netease_qr_code(app.clone()).await?;

    let key = qr.key.clone();
    let chain = qr.chain_id.clone();
    let device = qr.device_id.clone();

    let poll_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let client = match crate::proxy::build_client(reqwest::Client::builder()) {
            Ok(c) => c,
            Err(e) => {
                crate::log!("[netease] qr client failed: {e}");
                let _ = poll_app.emit(
                    "netease-login-failed",
                    NeteaseLoginFailure::with_detail(NeteaseFailureCode::Client, e),
                );
                return;
            }
        };

        // The platform answers a successful scan with a `Set-Cookie`
        // header carrying the credential. That header is large, and
        // the platform's own edge occasionally rejects it with a 502 —
        // at which point the credential is still there, just in the
        // response body instead. So the poll asks for the cookie in
        // the body (`noCookie`), which is both smaller on the wire and
        // immune to the oversized-header rejection. If the platform
        // does not honour that request, the header form is tried.
        let mut no_cookie = true;

        loop {
            tokio::time::sleep(std::time::Duration::from_millis(POLL_INTERVAL_MS)).await;

            // A newer attempt (or a cancelled one) has superseded this
            // one: its key is dead and its poller has no business
            // competing for the credential.
            if !LoginState::get().is_current(generation) {
                crate::log!("[netease] qr sign-in superseded");
                return;
            }

            let status = match poll_scan_state(&client, &key, &chain, &device, no_cookie).await {
                Ok(s) => s,
                Err(e) => {
                    crate::log!("[netease] qr check failed: {e}");
                    // The other form of the request may work where this
                    // one was rejected.
                    no_cookie = !no_cookie;
                    continue;
                }
            };

            match status.state {
                ScanState::Waiting | ScanState::Confirming => continue,
                ScanState::Expired => {
                    crate::log!("[netease] qr code expired");
                    let _ = poll_app.emit(
                        "netease-login-failed",
                        NeteaseLoginFailure::new(NeteaseFailureCode::Expired),
                    );
                    return;
                }
                ScanState::Blocked => {
                    // The platform refused this client outright. There
                    // is no point in waiting for a scan that will never
                    // be accepted.
                    crate::log!("[netease] qr sign-in blocked by risk control");
                    let _ = poll_app.emit(
                        "netease-login-failed",
                        NeteaseLoginFailure::new(NeteaseFailureCode::Blocked),
                    );
                    return;
                }
                ScanState::Authorized => {
                    // The credential is missing from the answer — try
                    // the other form of the request once before giving
                    // up on it.
                    let music_u = match status.music_u.clone() {
                        Some(m) => m,
                        None if no_cookie => {
                            no_cookie = false;
                            continue;
                        }
                        None => {
                            crate::log!("[netease] authorized but no MUSIC_U in the response");
                            let _ = poll_app.emit(
                                "netease-login-failed",
                                NeteaseLoginFailure::new(NeteaseFailureCode::NoCredential),
                            );
                            return;
                        }
                    };

                    let mut account = NeteaseAccount {
                        music_u,
                        csrf: status.csrf.unwrap_or_default(),
                        nickname: status.nickname,
                        avatar_url: status.avatar_url,
                        user_id: status.user_id,
                        signed_in_at: Some(
                            time::OffsetDateTime::now_utc().unix_timestamp().max(0) as u64,
                        ),
                    };

                    if let Err(e) = save(&poll_app, &account).await {
                        crate::log!("[netease] save credential failed: {e}");
                        let _ = poll_app.emit(
                            "netease-login-failed",
                            NeteaseLoginFailure::with_detail(NeteaseFailureCode::Storage, e),
                        );
                        return;
                    }

                    crate::log!("[netease] signed in");
                    let _ = poll_app.emit("netease-login-success", ());

                    // The profile is decoration, and the platform's own
                    // profile endpoint can be slow. Fetch it after the
                    // sign-in is already announced, and update the
                    // stored credential when it lands.
                    let profile_app = poll_app.clone();
                    tauri::async_runtime::spawn(async move {
                        let Some(profile) = fetch_profile(&profile_app, &account).await else {
                            crate::log!("[netease] profile fetch failed; signed in without it");
                            return;
                        };
                        account.user_id = Some(profile.user_id);
                        account.nickname = Some(profile.nickname);
                        account.avatar_url = Some(profile.avatar_url);
                        if let Err(e) = save(&profile_app, &account).await {
                            crate::log!("[netease] save profile failed: {e}");
                            return;
                        }
                        let _ = profile_app.emit("netease-profile-ready", ());
                    });

                    return;
                }
            }
        }
    });

    Ok(qr)
}

/// Cancel a sign-in that is in progress.
///
/// The poller notices on its next tick and gives up, so the key the
/// user was looking at stops being polled for a credential that would
/// never arrive.
#[tauri::command]
pub async fn netease_cancel_login(app: tauri::AppHandle) -> Result<(), String> {
    // Advancing the generation retires the running attempt.
    LoginState::get().begin();
    let _ = app.emit("netease-login-cancelled", ());
    Ok(())
}

/// Forget the NetEase account.
#[tauri::command]
pub async fn netease_logout(app: tauri::AppHandle) -> Result<(), String> {
    clear(&app).await;
    let _ = app.emit("netease-login-cancelled", ());
    Ok(())
}

/// The account's own profile, as the platform reports it.
struct NeteaseProfile {
    user_id: String,
    nickname: String,
    avatar_url: String,
}

/// Ask the platform who the signed-in account is.
async fn fetch_profile(
    _app: &tauri::AppHandle,
    account: &NeteaseAccount,
) -> Option<NeteaseProfile> {
    let header = {
        let mut parts = vec![format!("MUSIC_U={}", account.music_u.trim())];
        if !account.csrf.trim().is_empty() {
            parts.push(format!("__csrf={}", account.csrf.trim()));
        }
        parts.join("; ")
    };

    let client = crate::proxy::build_client(reqwest::Client::builder()).ok()?;
    let resp = client
        .get("https://music.163.com/api/nuser/account/get")
        .header(reqwest::header::USER_AGENT, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36")
        .header(reqwest::header::REFERER, "https://music.163.com/")
        .header(reqwest::header::COOKIE, header)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .ok()?;

    if !resp.status().is_success() {
        return None;
    }
    let body: serde_json::Value = resp.json().await.ok()?;
    let profile = body.get("profile")?;
    Some(NeteaseProfile {
        user_id: profile
            .get("userId")
            .and_then(|v| v.as_i64())
            .map(|v| v.to_string())
            .unwrap_or_default(),
        nickname: profile
            .get("nickname")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        avatar_url: profile
            .get("avatarUrl")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
    })
}
