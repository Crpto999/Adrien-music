//! The session verdict Rust hands to the frontend.
//!
//! The frontend asks "is the stored session still usable?" with
//! `get_session_state`, and Rust answers from what it can prove
//! locally: the active account's encrypted jar still exists and still
//! carries the identity cookies (`SAPISID` + `__Secure-1PSID`) that an
//! authenticated InnerTube call needs.
//!
//! A jar that is missing, undecryptable or stripped of those cookies
//! is a session Google will not honor, so the account is reported as
//! needing a re-link. The frontend then shows the sign-in button and
//! re-runs the sign-in for THAT account (`relink_account`) instead of
//! adding a second row for the same person.
//!
//! The other half of the story — Google expiring a session server-side
//! while the jar on disk still looks perfect — needs a live probe, which
//! this fork does not run at boot. The frontend covers that case
//! instead: an anonymous `/account_menu` answer is what flips the
//! sidebar to the sign-in button.

use serde::Serialize;

/// Snapshot of the verdict, as the frontend sees it.
#[derive(Clone, Debug, Serialize)]
pub struct SessionSnapshot {
    /// A renewal is in flight.
    ///
    /// Always `false` in this fork: the jar is a static snapshot that
    /// nothing rewrites behind the frontend's back, so there is never
    /// a renewal for the frontend to wait for. The frontend's session
    /// gate uses this to hold the first wave of InnerTube requests;
    /// reporting `false` keeps that gate open, exactly as it behaves
    /// today.
    pub renewing: bool,
    /// Id of the account whose stored jar is provably unusable.
    #[serde(rename = "needsRelink")]
    pub needs_relink: Option<String>,
}

/// Compute the verdict for the currently active account.
///
/// `None` means "nothing wrong that we can prove locally" — which is
/// not the same as "the session is alive". A jar that still holds its
/// identity cookies can still have been revoked on Google's side; that
/// is what the frontend's own `/account_menu` check is for.
pub async fn snapshot(app: &tauri::AppHandle) -> SessionSnapshot {
    SessionSnapshot {
        renewing: false,
        needs_relink: verdict_for(app).await,
    }
}

/// The active account, if its jar can no longer authenticate.
async fn verdict_for(app: &tauri::AppHandle) -> Option<String> {
    let idx = crate::read_index(app).await;
    let active = idx.active.clone()?;
    // The index can name an account whose row was removed underneath
    // it (a torn write, a manual edit). Nothing to re-link then.
    if !idx.accounts.iter().any(|a| a.id == active) {
        return None;
    }
    let header = crate::read_cookie_header(app, "music.youtube.com").await;
    if crate::header_has_auth_cookie(&header) {
        None
    } else {
        Some(active)
    }
}
