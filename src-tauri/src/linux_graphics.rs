//! Startup-only workarounds for the Linux WebKitGTK renderer.

const COMPOSITOR_ENV: &str = "WEBKIT_USE_SKIA_FOR_COMPOSITION";

fn needs_legacy_compositor(major: u32, minor: u32, explicitly_configured: bool) -> bool {
    // 2.54 made Skia composition the default. Keep this limited to that
    // release series rather than assuming later releases need the workaround.
    major == 2 && minor == 54 && !explicitly_configured
}

/// Must run before Tauri/GTK initialization or spawning worker threads:
/// WebKit reads the compositor preference during webview/process creation.
pub fn configure() {
    // SAFETY: These parameterless WebKit API functions return the loaded
    // library's version constants and do not require a WebView or GTK init.
    let (major, minor, micro) = unsafe {
        (
            webkit2gtk::ffi::webkit_get_major_version(),
            webkit2gtk::ffi::webkit_get_minor_version(),
            webkit2gtk::ffi::webkit_get_micro_version(),
        )
    };
    if !needs_legacy_compositor(major, minor, std::env::var_os(COMPOSITOR_ENV).is_some()) {
        return;
    }

    // On WebKitGTK 2.54.1, fading dialogs and menus can briefly reveal the
    // underlying page at animation boundaries. Switching to TextureMapper
    // fixed both directions in visual A/B testing on AMD/Mesa + Wayland.
    // Unlike WEBKIT_DISABLE_DMABUF_RENDERER, this preserves the fast buffer
    // path. Do not change image sources, CSS animations, or acceleration policy.
    // Respect ANY explicit environment value (including an empty/non-Unicode
    // value), allowing users to test Skia with the preference set to 1.
    std::env::set_var(COMPOSITOR_ENV, "0");
    crate::log!(
        "[linux-graphics] WebKitGTK {major}.{minor}.{micro}: using TextureMapper compositor; \
         set {COMPOSITOR_ENV}=1 to opt into Skia (see docs/linux-graphics.md)"
    );
}

#[cfg(test)]
mod tests {
    use super::needs_legacy_compositor;

    #[test]
    fn targets_only_webkitgtk_2_54() {
        assert!(needs_legacy_compositor(2, 54, false));
        for (major, minor) in [(2, 42), (2, 50), (2, 52), (2, 55), (2, 56), (3, 54)] {
            assert!(!needs_legacy_compositor(major, minor, false));
        }
    }

    #[test]
    fn never_overrides_an_explicit_compositor_preference() {
        assert!(!needs_legacy_compositor(2, 54, true));
    }
}
