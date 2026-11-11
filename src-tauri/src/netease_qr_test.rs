//! A live check of the NetEase QR sign-in protocol.
//!
//! The sign-in is the platform's own protocol, spoken directly, so the
//! parts that can be checked without a phone are worth checking: that
//! the platform hands out a key, that the key renders as a QR code,
//! and that the scan state comes back as the platform reports it.
//!
//! Run with `cargo test --lib netease_qr -- --ignored` — the test
//! talks to the live platform.

use super::netease_auth::{poll_scan_state, render_qr, NeteaseFailureCode};

/// The platform must hand out a key for a QR sign-in.
#[tokio::test]
#[ignore = "talks to the live NetEase platform"]
async fn the_platform_hands_out_a_key() {
    let client = reqwest::Client::builder()
        .build()
        .expect("client");

    let resp = client
        .post("https://music.163.com/api/login/qrcode/unikey")
        .form(&[("type", "1"), ("noCheckToken", "true")])
        .header(
            reqwest::header::USER_AGENT,
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
        )
        .header(reqwest::header::REFERER, "https://music.163.com/")
        .send()
        .await
        .expect("unikey request");

    let body: serde_json::Value = resp.json().await.expect("unikey json");
    let key = body
        .get("unikey")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .expect("a key");

    assert!(key.contains('-'), "a key looks like a uuid: {key}");
}

/// The key must render as a QR code the phone can read.
#[tokio::test]
#[ignore = "talks to the live NetEase platform"]
async fn the_key_renders_as_a_qr_code() {
    let content = super::netease_auth::qr_content_url(
        "2e6c4e2d-f10d-4d50-8f9d-9bf1989a671c",
        "v1_YD-test_web_login_1",
    );

    let data_url = render_qr(&content).expect("qr");

    assert!(data_url.starts_with("data:image/png;base64,"));
    // A 256×256 QR code is a few kilobytes of PNG; an empty or broken
    // render would be far shorter.
    assert!(
        data_url.len() > 1000,
        "the rendered code should have real pixels, got {} bytes",
        data_url.len()
    );
}

/// The QR code must point at the platform's scan-login page.
///
/// This is the detail the sign-in lives or dies by: the phone's
/// scanner opens the QR code's URL, and only the scan-login page
/// reports the scan back to the platform. The plain login page does
/// not — the phone lands on a login form and the sign-in never
/// completes.
#[test]
fn the_qr_code_points_at_the_scan_login_page() {
    let url = super::netease_auth::qr_content_url("the-key", "the-chain");

    assert!(
        url.starts_with("https://music.163.com/st/platform/scanlogin?"),
        "the QR code must point at the scan-login page: {url}"
    );
    assert!(url.contains("codekey=the-key"), "{url}");
    assert!(url.contains("chainId=the-chain"), "{url}");
}

/// The chain id has to be the same one in the QR code and in the poll
/// request — that is how the platform matches the two.
#[test]
fn the_chain_id_names_one_attempt() {
    let device = super::netease_auth::device_id();
    let chain = super::netease_auth::chain_id(&device);

    assert!(device.starts_with("YD-"), "device id format: {device}");
    assert!(
        chain.starts_with(&format!("v1_{device}_web_login_")),
        "chain id format: {chain}"
    );
}

/// The failure codes have to be the ones the frontend translates.
///
/// The frontend switches on the code to pick a sentence in the user's
/// own language. A code that drifts out of step with the frontend
/// silently produces a missing-translation key instead of a message,
/// so the two sides are pinned here.
#[test]
fn the_failure_codes_are_the_ones_the_frontend_knows() {
    let codes = [
        NeteaseFailureCode::Expired,
        NeteaseFailureCode::Blocked,
        NeteaseFailureCode::NoCredential,
        NeteaseFailureCode::Client,
        NeteaseFailureCode::Storage,
    ];

    let serialized: Vec<String> = codes
        .iter()
        .map(|c| serde_json::to_string(c).expect("a code"))
        .collect();

    assert_eq!(
        serialized,
        vec![
            "\"expired\"",
            "\"blocked\"",
            "\"noCredential\"",
            "\"client\"",
            "\"storage\"",
        ]
    );
}

/// A fresh key must report itself as waiting to be scanned.
#[tokio::test]
#[ignore = "talks to the live NetEase platform"]
async fn a_fresh_code_is_waiting_to_be_scanned() {
    let client = reqwest::Client::builder().build().expect("client");

    let resp = client
        .post("https://music.163.com/api/login/qrcode/unikey")
        .form(&[("type", "1"), ("noCheckToken", "true")])
        .header(
            reqwest::header::USER_AGENT,
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
        )
        .header(reqwest::header::REFERER, "https://music.163.com/")
        .send()
        .await
        .expect("unikey request");
    let body: serde_json::Value = resp.json().await.expect("unikey json");
    let key = body["unikey"].as_str().expect("a key").to_string();

    let device = super::netease_auth::device_id();
    let chain = super::netease_auth::chain_id(&device);

    let status = poll_scan_state(&client, &key, &chain, &device, true)
        .await
        .expect("check");

    // 801 — waiting for a scan. Nobody has scanned this key yet.
    assert_eq!(status.state, crate::netease_auth::ScanState::Waiting);
    assert!(status.music_u.is_none(), "no credential yet");
}

/// A key the platform never issued must be reported as expired, not as
/// waiting.
///
/// This is the check that tells a real sign-in apart from a request
/// the platform is ignoring — which is what a wrong endpoint or a
/// wrong payload looks like from the outside.
#[tokio::test]
#[ignore = "talks to the live NetEase platform"]
async fn a_key_the_platform_never_issued_is_expired() {
    let client = reqwest::Client::builder().build().expect("client");

    let device = super::netease_auth::device_id();
    let chain = super::netease_auth::chain_id(&device);

    let status = poll_scan_state(
        &client,
        "00000000-0000-0000-0000-000000000000",
        &chain,
        &device,
        true,
    )
    .await
    .expect("check");

    assert_eq!(status.state, crate::netease_auth::ScanState::Expired);
}
