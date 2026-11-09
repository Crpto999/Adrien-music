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

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

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

/// The NetEase web app's sign-in page.
const LOGIN_URL: &str = "https://music.163.com/#/login";

/// The label of the sign-in window.
const LOGIN_WINDOW_LABEL: &str = "netease-login";

/// How many consecutive cookie-read failures to tolerate before giving
/// up on the window.
///
/// A healthy webview answers every time. A webview whose underlying
/// native window has gone — a crashed WebView2 environment, or a
/// window the user closed on us — answers *never*, so without a cap
/// the poller would spin forever against a dead handle, logging the
/// same error every 1.5 s until the app is closed.
const MAX_COOKIE_FAILURES: u32 = 8;

/// Open the NetEase sign-in window and wait for the account cookie.
///
/// The window is a normal browser window pointed at NetEase's own login
/// page: the user types their own credentials into NetEase's own form,
/// over HTTPS, and NetEase sets the cookie. The app never sees the
/// password — it only reads the cookie the browser ends up holding.
///
/// The flow mirrors the YouTube one: poll the webview's cookie store
/// until `MUSIC_U` appears, then write it to the encrypted store and
/// close the window.
#[tauri::command]
pub async fn netease_start_login(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window(LOGIN_WINDOW_LABEL) {
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }

    let url = LOGIN_URL
        .parse::<tauri::Url>()
        .map_err(|e| format!("bad login url: {e}"))?;

    // A dedicated WebView2 profile for the sign-in window.
    //
    // WebView2 keys its browser environment on the user-data folder, and
    // every webview that shares a folder must agree on the browser
    // arguments. This window used to sit on the app's *default* folder
    // with wry's stock arguments, while the main window and the
    // floating player both run with `APP_WEBVIEW_ARGS` — a mismatch
    // that makes WebView2 refuse to create the environment. The window
    // was then torn down the instant it appeared (the "flash"), and
    // every cookie read afterwards failed with "failed to receive
    // message from webview" forever.
    //
    // Its own folder gives the sign-in window a private environment, so
    // it cannot conflict with the app's.
    //
    // The folder is *per attempt*: a fresh profile means the sign-in
    // always starts from a clean cookie jar. A reused profile would
    // still hold the previous account's `MUSIC_U`, so signing out and
    // signing in again would silently restore the old account without
    // the user ever getting to type their credentials.
    let session_id = crate::generate_session_id();
    let webview_data = app
        .path()
        .app_cache_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("netease-login-sessions")
        .join(&session_id);
    if let Err(e) = tokio::fs::create_dir_all(&webview_data).await {
        crate::log!("[netease] mkdir webview-data: {e}");
    }
    // The builder takes ownership of the path, but the poller needs it
    // again to delete the profile when the sign-in ends.
    let cleanup_dir = webview_data.clone();

    let win = WebviewWindowBuilder::new(&app, LOGIN_WINDOW_LABEL, WebviewUrl::External(url))
        .title("Sign in — NetEase Cloud Music")
        .inner_size(520.0, 760.0)
        .min_inner_size(420.0, 560.0)
        .center()
        .data_directory(webview_data)
        // Even on its own folder, keep the args identical to the rest
        // of the app's webviews so the two profiles stay interchangeable.
        .additional_browser_args(crate::APP_WEBVIEW_ARGS)
        .user_agent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
             (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
        )
        // Surface the current origin in the title so the user can spot
        // a redirect to an unexpected host (anti-phishing).
        .on_page_load(|win, payload| {
            let host = payload.url().host_str().unwrap_or("???");
            let _ = win.set_title(&format!("Sign in — {host}"));
        })
        .build()
        .map_err(|e| format!("netease login window: {e}"))?;

    // A `Destroyed` event is the only reliable "the window is gone"
    // signal. Without it the poller can only notice the window's
    // absence on its next tick, and in the meantime it would keep
    // poking a handle whose native window no longer exists.
    let alive = Arc::new(AtomicBool::new(true));
    {
        let alive = alive.clone();
        win.on_window_event(move |event| {
            if let tauri::WindowEvent::Destroyed = event {
                alive.store(false, Ordering::Relaxed);
            }
        });
    }

    let app_poll = app.clone();
    tauri::async_runtime::spawn(async move {
        // Consecutive cookie-read failures. Reset on every success.
        let mut failures: u32 = 0;

        loop {
            tokio::time::sleep(std::time::Duration::from_millis(1500)).await;

            if !alive.load(Ordering::Relaxed) {
                // The window was destroyed — the user closed it, or the
                // webview crashed and took the window with it.
                crate::log!("[netease] login window closed");
                let _ = app_poll.emit("netease-login-cancelled", ());
                let _ = tokio::fs::remove_dir_all(&cleanup_dir).await;
                return;
            }

            let Some(win) = app_poll.get_webview_window(LOGIN_WINDOW_LABEL) else {
                // The user closed the window without signing in.
                let _ = app_poll.emit("netease-login-cancelled", ());
                let _ = tokio::fs::remove_dir_all(&cleanup_dir).await;
                return;
            };

            let cookies = match win.cookies() {
                Ok(c) => {
                    failures = 0;
                    c
                }
                Err(e) => {
                    failures += 1;
                    crate::log!(
                        "[netease] login cookie read failed ({failures}/{MAX_COOKIE_FAILURES}): {e}"
                    );
                    if failures >= MAX_COOKIE_FAILURES {
                        // The window is there but its webview is not
                        // answering. Rather than log forever, tear the
                        // window down and let the user try again.
                        crate::log!("[netease] login webview stopped responding; giving up");
                        let _ = app_poll.emit(
                            "netease-login-failed",
                            "The NetEase sign-in window stopped responding. Please try again.",
                        );
                        let _ = win.close();
                        let _ = tokio::fs::remove_dir_all(&cleanup_dir).await;
                        return;
                    }
                    continue;
                }
            };

            let music_u = cookies.iter().find_map(|c| {
                if c.name() != "MUSIC_U" {
                    return None;
                }
                let domain = c.domain().unwrap_or("");
                let host = domain.trim_start_matches('.');
                // NetEase sets the account cookie for its own domains.
                if !host.ends_with("163.com") && !host.ends_with("126.com") {
                    return None;
                }
                let value = c.value().trim();
                if value.is_empty() {
                    None
                } else {
                    Some(value.to_string())
                }
            });

            let Some(music_u) = music_u else {
                continue;
            };

            let csrf = cookies
                .iter()
                .find(|c| c.name() == "__csrf")
                .map(|c| c.value().to_string())
                .unwrap_or_default();

            let mut account = NeteaseAccount {
                music_u,
                csrf,
                signed_in_at: Some(
                    time::OffsetDateTime::now_utc()
                        .unix_timestamp()
                        .max(0) as u64,
                ),
                ..Default::default()
            };

            // Ask the platform who this account is, so the settings row
            // can show a name and an avatar. Best-effort: the sign-in
            // itself already succeeded, and a failure here must not
            // throw the credential away.
            if let Some(profile) = fetch_profile(&app_poll, &account).await {
                account.user_id = Some(profile.user_id);
                account.nickname = Some(profile.nickname);
                account.avatar_url = Some(profile.avatar_url);
            }

            if let Err(e) = save(&app_poll, &account).await {
                crate::log!("[netease] save credential failed: {e}");
                let _ = app_poll.emit("netease-login-failed", e);
                let _ = win.close();
                let _ = tokio::fs::remove_dir_all(&cleanup_dir).await;
                return;
            }

            crate::log!("[netease] signed in");
            let _ = app_poll.emit("netease-login-success", ());
            let _ = win.close();
            let _ = tokio::fs::remove_dir_all(&cleanup_dir).await;
            return;
        }
    });

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
