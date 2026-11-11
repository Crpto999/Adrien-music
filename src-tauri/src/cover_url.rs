//! Cover-art URL normalisation for the Chinese music platforms.
//!
//! The NetEase / Kugou / QQ Music APIs hand out artwork URLs on plain
//! `http://`, pointing at CDNs that serve `https://` perfectly well.
//!
//! Two things break if those URLs are passed through unchanged:
//!
//!   - **Mixed content.** The app is served over `https://` (or the
//!     `tauri://` custom protocol), so a plain-HTTP subresource is
//!     blocked by the webview's mixed-content rules.
//!   - **The CSP `img-src` allowlist.** It lists `https://` sources
//!     only — an `http://` URL matches none of them, so the image is
//!     refused before a request is even made.
//!
//! Rewriting the scheme to `https://` fixes both at once, and it is
//! safe: the same CDN host serves the same bytes over TLS.

/// Rewrite a cover URL to `https://`.
///
/// Only the scheme is touched — the host, path and query are left
/// exactly as the platform sent them. A URL that is already `https://`
/// is returned unchanged, as is one that has no scheme at all (a
/// protocol-relative `//host/path` URL, which the platforms do not
/// send but which is harmless to pass through).
pub fn to_https(url: &str) -> String {
    if let Some(rest) = url.strip_prefix("http://") {
        return format!("https://{rest}");
    }
    url.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_http_becomes_https() {
        assert_eq!(
            to_https("http://p2.music.126.net/abc/123.jpg"),
            "https://p2.music.126.net/abc/123.jpg"
        );
    }

    #[test]
    fn https_is_left_alone() {
        assert_eq!(
            to_https("https://p2.music.126.net/abc/123.jpg"),
            "https://p2.music.126.net/abc/123.jpg"
        );
    }

    #[test]
    fn the_path_is_not_touched() {
        // The 126.net CDN keys its paths on the *exact* string, so
        // rewriting anything past the scheme would break the lookup.
        assert_eq!(
            to_https(
                "http://p1.music.126.net/diGAyEmpymX8G7JcnElncQ==/109951163699673355.jpg"
            ),
            "https://p1.music.126.net/diGAyEmpymX8G7JcnElncQ==/109951163699673355.jpg"
        );
    }

    #[test]
    fn a_query_string_survives() {
        assert_eq!(
            to_https("http://imge.kugou.com/stdmusic/400/x.jpg?param=y"),
            "https://imge.kugou.com/stdmusic/400/x.jpg?param=y"
        );
    }

    #[test]
    fn a_non_http_url_is_left_alone() {
        assert_eq!(
            to_https("data:image/png;base64,AAAA"),
            "data:image/png;base64,AAAA"
        );
        assert_eq!(to_https("//host/path.jpg"), "//host/path.jpg");
        assert_eq!(to_https(""), "");
    }
}
