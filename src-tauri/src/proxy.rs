//! User-configurable network proxy.
//!
//! The proxy is a single URL the user types into Settings → General. It
//! covers three separate network paths, each of which needs its own
//! plumbing:
//!
//!  1. The webview's own requests, which go through `tauri-plugin-http`
//!     (Rust-side `reqwest`). The plugin accepts a `proxy` client option,
//!     so the frontend passes the URL with every request — see
//!     `src/lib/proxy.ts`.
//!  2. Our own `reqwest` clients: the media stream server (ranged reads
//!     from googlevideo), the cover fetch, the session probe and the
//!     yt-dlp self-update download. They are built through [`apply`] so
//!     they pick the proxy up automatically.
//!  3. The `yt-dlp` child processes, which know nothing about our
//!     clients — they take a `--proxy <url>` argument instead.
//!
//! An empty setting means "no proxy": [`normalize`] maps an empty (or
//! whitespace-only) string to `None`, and every consumer treats `None`
//! as a direct connection.

use std::sync::{OnceLock, RwLock};
use std::time::Duration;

use reqwest::ClientBuilder;

/// Proxy schemes we accept. `socks4` / `socks4a` / `socks5` / `socks5h`
/// need reqwest's `socks` feature (enabled in Cargo.toml); `socks5h`
/// resolves the target host through the proxy, `socks5` locally.
pub const SUPPORTED_SCHEMES: &[&str] = &[
    "http", "https", "socks4", "socks4a", "socks5", "socks5h",
];

/// Timeouts of the shared media client. Mirrors the values the stream
/// server used before the proxy became configurable.
const MEDIA_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const MEDIA_READ_TIMEOUT: Duration = Duration::from_secs(20);

/// The live proxy configuration.
///
/// Deliberately a process-global rather than Tauri managed state: the
/// proxy is needed by the stream server, the cover fetcher and the
/// yt-dlp spawner, none of which have a handle to the app state at the
/// point they need it.
struct ProxyState {
    /// The normalized proxy URL, or `None` when the proxy is disabled.
    url: RwLock<Option<String>>,
    /// Client used for media traffic (googlevideo ranges). Rebuilt when
    /// the proxy changes, so in-flight streams keep their old client
    /// while the next one uses the new proxy.
    media_client: RwLock<reqwest::Client>,
}

impl ProxyState {
    fn new() -> Self {
        // Built directly rather than through `build_client`: that helper
        // reads the current proxy, and reading it means initializing
        // this very state — a re-entrant `OnceLock` init, which
        // deadlocks.
        let client = ClientBuilder::new()
            .connect_timeout(MEDIA_CONNECT_TIMEOUT)
            .read_timeout(MEDIA_READ_TIMEOUT)
            .build()
            .unwrap_or_default();
        Self {
            url: RwLock::new(None),
            media_client: RwLock::new(client),
        }
    }
}

fn state() -> &'static ProxyState {
    static STATE: OnceLock<ProxyState> = OnceLock::new();
    STATE.get_or_init(ProxyState::new)
}

/// The current proxy URL, or `None` when the proxy is disabled.
pub fn url() -> Option<String> {
    state().url.read().ok().and_then(|u| u.clone())
}

/// The shared media client, honouring the current proxy.
pub fn media_client() -> reqwest::Client {
    state()
        .media_client
        .read()
        .map(|c| c.clone())
        .unwrap_or_default()
}

/// Apply the current proxy to a `reqwest` client builder.
///
/// A missing proxy leaves the builder untouched; an unparsable one is
/// ignored as well (the client then connects directly) rather than
/// failing to build — `set` rejects bad values up front, so this is only
/// a safety net.
pub fn apply(builder: ClientBuilder) -> ClientBuilder {
    let Some(raw) = url() else {
        return builder;
    };
    match reqwest::Proxy::all(&raw) {
        Ok(p) => builder.proxy(p),
        Err(e) => {
            crate::log!("[proxy] ignoring unusable proxy {raw:?}: {e}");
            builder
        }
    }
}

/// Build a client with the current proxy applied.
pub fn build_client(builder: ClientBuilder) -> Result<reqwest::Client, String> {
    apply(builder).build().map_err(|e| format!("proxy client: {e}"))
}

/// Normalize a user-supplied proxy URL.
///
/// Returns `Ok(None)` for an empty / whitespace-only value — the proxy
/// is then disabled. Otherwise the scheme must be one of
/// [`SUPPORTED_SCHEMES`] and a host must be present.
pub fn normalize(raw: &str) -> Result<Option<String>, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    // A bare `host:port` is a common way to write an HTTP proxy; assume
    // HTTP rather than rejecting it.
    let candidate = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("http://{trimmed}")
    };
    let parsed = reqwest::Url::parse(&candidate)
        .map_err(|e| format!("invalid proxy URL: {e}"))?;
    let scheme = parsed.scheme().to_ascii_lowercase();
    if !SUPPORTED_SCHEMES.contains(&scheme.as_str()) {
        return Err(format!(
            "unsupported proxy scheme '{scheme}' (expected one of: {})",
            SUPPORTED_SCHEMES.join(", ")
        ));
    }
    if parsed.host_str().unwrap_or("").is_empty() {
        return Err("proxy URL has no host".into());
    }
    Ok(Some(candidate))
}

/// Store a new proxy URL (already normalized) and rebuild the media
/// client so the next request goes through it.
pub fn set(url: Option<String>) -> Result<(), String> {
    {
        let mut slot = state().url.write().map_err(|_| "proxy lock poisoned")?;
        *slot = url.clone();
    }
    let builder = ClientBuilder::new()
        .connect_timeout(MEDIA_CONNECT_TIMEOUT)
        .read_timeout(MEDIA_READ_TIMEOUT);
    // `apply` reads the URL we just stored, so the new client already
    // carries the proxy.
    let client = apply(builder).build().map_err(|e| format!("proxy client: {e}"))?;
    {
        let mut slot = state()
            .media_client
            .write()
            .map_err(|_| "proxy lock poisoned")?;
        *slot = client;
    }
    Ok(())
}

/// The `--proxy` argument for a `yt-dlp` child process, if any.
///
/// `yt-dlp` supports the same scheme set, but it wants the URL as a
/// single argument; the credentials embedded in the URL are passed
/// through untouched.
pub fn ytdlp_proxy_args() -> Vec<String> {
    match url() {
        Some(u) => vec!["--proxy".to_string(), u],
        None => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_is_disabled() {
        assert_eq!(normalize("").unwrap(), None);
        assert_eq!(normalize("   ").unwrap(), None);
    }

    #[test]
    fn accepts_supported_schemes() {
        for s in SUPPORTED_SCHEMES {
            let url = format!("{s}://127.0.0.1:1080");
            assert_eq!(normalize(&url).unwrap(), Some(url));
        }
    }

    #[test]
    fn assumes_http_for_a_bare_host_port() {
        assert_eq!(
            normalize("127.0.0.1:8080").unwrap(),
            Some("http://127.0.0.1:8080".to_string())
        );
    }

    #[test]
    fn rejects_unknown_schemes_and_hosts() {
        assert!(normalize("ftp://127.0.0.1:21").is_err());
        assert!(normalize("http://").is_err());
        assert!(normalize("not a url").is_err());
    }

    #[test]
    fn keeps_credentials_in_the_url() {
        let url = "socks5://user:pass@127.0.0.1:1080";
        assert_eq!(normalize(url).unwrap(), Some(url.to_string()));
    }

    /// The whole point of the `socks` feature: reqwest must accept a
    /// SOCKS proxy URL and build a client with it. Without the feature
    /// `Proxy::all` rejects the scheme, and the whole proxy setting
    /// silently degrades to "direct connection".
    #[test]
    fn reqwest_accepts_every_supported_scheme() {
        for s in SUPPORTED_SCHEMES {
            let url = format!("{s}://127.0.0.1:1080");
            assert!(
                reqwest::Proxy::all(&url).is_ok(),
                "reqwest rejected the {s} proxy scheme",
            );
        }
    }

    #[test]
    fn a_socks_proxy_client_builds() {
        let client = build_client(
            reqwest::Client::builder().proxy(
                reqwest::Proxy::all("socks5://127.0.0.1:1080").expect("proxy"),
            ),
        );
        assert!(client.is_ok());
    }

    #[test]
    fn no_proxy_args_when_disabled() {
        let _guard = global_test_lock();
        set(None).unwrap();
        assert!(ytdlp_proxy_args().is_empty());
        assert!(url().is_none());
    }

    #[test]
    fn proxy_args_carry_the_url() {
        let _guard = global_test_lock();
        set(Some("socks5h://127.0.0.1:1080".to_string())).unwrap();
        let args = ytdlp_proxy_args();
        assert_eq!(args, vec!["--proxy", "socks5h://127.0.0.1:1080"]);
    }

    /// The proxy state is process-global, so the tests that touch it
    /// have to run one at a time.
    fn global_test_lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }
}
