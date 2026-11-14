//! Where adrify keeps its data on disk.
//!
//! Everything the app writes lives under ONE root directory:
//!
//! ```text
//! <root>/
//!   accounts/            encrypted account + cookie jars
//!   accounts.json        the account index
//!   cookies.enc          legacy cookie jar (pre-accounts layout)
//!   netease.enc          the NetEase credential
//!   cache-limit          the track-cache size cap
//!   unblock-pool.json    the ytdlp unblock pool
//!   bin/                 the managed yt-dlp binary
//!   settings.json        the tauri store plugin (cache-dir preference)
//!   .window-state.json   the window-state plugin
//!   EBWebView/           the WebView2 profile (localStorage, IndexedDB)
//!   caches/stream/       the downloaded audio
//!   caches/covers/       the cover images
//!   caches/stream-ephemeral/
//!   logs/                adrify.log
//! ```
//!
//! By default that root is a `data/` folder next to the executable, so a
//! copy of adrify is self-contained: move the folder and the cache, the
//! login state and the settings move with it. That is what Tauri's
//! `appDirectoriesOverride` config is for — a single `Root` override
//! redirects *every* `app_*_dir` API, ours and the plugins', at once:
//!
//! | API                     | resolves to          |
//! |-------------------------|----------------------|
//! | `app_config_dir`        | `<root>`             |
//! | `app_data_dir`          | `<root>`             |
//! | `app_local_data_dir`    | `<root>`             |
//! | `app_cache_dir`         | `<root>/caches`      |
//! | `app_log_dir`           | `<root>/logs`        |
//!
//! The WebView2 profile lands in `<root>/EBWebView` because WebView2
//! always appends that folder to the user data folder it is handed
//! (`app_local_data_dir`).
//!
//! Two escape hatches:
//!
//! - The user can point the root somewhere else (Settings → Storage). The
//!   choice is remembered in a small pointer file in the OS config dir.
//! - When the executable lives in a read-only folder (a per-machine
//!   install under `Program Files`, an app in a read-only share), there is
//!   nowhere to write. The app then asks the user for a writable folder
//!   instead of silently scattering data across the OS dirs.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// File (inside the OS *config* dir) recording the user's chosen data root.
///
/// It deliberately lives outside the data root: the data root is what we
/// are looking for in the first place, so the pointer to it cannot live
/// inside it. The OS config dir is the one location we can always compute
/// without knowing the override, and it holds a single short text file.
const ROOT_POINTER: &str = "data-root";

/// File (next to the pointer) recording where the data has to be copied
/// *from* on the next launch.
///
/// Changing the root has to move the WebView2 profile too, and that
/// profile is locked by the running instance. Copying it while the app
/// is up would produce a half-written SQLite page, so the move is
/// deferred to the next launch — by then the old instance is gone and
/// the profile is free.
const MIGRATE_FROM_POINTER: &str = "data-root-migrate-from";

/// The folder the data root lives in, relative to the executable's own
/// directory. A dedicated subfolder rather than the install directory
/// itself, so the caches don't sit next to the executable and the
/// uninstaller has one obvious thing to remove. Tauri's own guidance for
/// a portable build is the same shape (`./app-data`).
const ROOT_SUBDIR: &str = "data";

/// Marker written inside the data root once the legacy layout has been
/// migrated, so the migration runs exactly once per root.
const MIGRATION_MARKER: &str = ".adrify-migrated";

/// Key the user-chosen cache root lives under in the store plugin's
/// `settings.json`. Read directly (not through the plugin) by the
/// migration, which runs before the app exists.
const CACHE_DIR_KEY: &str = "cacheDir";

/// Legacy app-data entries that carry the user's state: the accounts
/// index and their encrypted cookie jars, the NetEase credential, the
/// managed yt-dlp binary, the cache-size limit, the unblock pool, the
/// plugin store and the saved window position.
///
/// Losing any of these means logging in again or re-downloading yt-dlp,
/// which is why they are the ones worth migrating.
const LEGACY_STATE_ENTRIES: &[&str] = &[
    "accounts.json",
    "accounts",
    "cookies.enc",
    "netease.enc",
    "cache-limit",
    "unblock-pool.json",
    "bin",
    "settings.json",
    ".window-state.json",
];

/// Legacy cache folders — the audio stream cache and the cover-image
/// cache. They now live under the data root's `caches/` subfolder.
const LEGACY_CACHE_DIRS: &[&str] = &["stream", "covers", "stream-ephemeral"];

/// Parts of the WebView2 profile that hold *our* state rather than
/// Chromium's scratch data.
///
/// The whole `EBWebView` folder is ~90 MB of HTTP cache, shader caches
/// and crash dumps — none of which is worth moving. What matters is the
/// localStorage (every zustand preference), the IndexedDB (the persisted
/// query cache and the downloadable interface fonts) and the cookies.
const LEGACY_WEBVIEW_STATE: &[&str] = &[
    // The browser-level state (the seed and the encrypted keyring).
    "Local State",
    "Default/Local Storage",
    "Default/IndexedDB",
    "Default/WebStorage",
    "Default/Network",
    "Default/Sessions",
    "Default/Sessions_Encrypted",
    // The per-profile preferences and the saved-password database.
    "Default/Preferences",
    "Default/Secure Preferences",
    "Default/Login Data",
];

/// Where the pointer files live. Computed from the OS dirs directly
/// rather than through Tauri's path API, because that API is exactly
/// what the data-root override redirects.
fn pointer_path(identifier: &str, name: &str) -> Option<PathBuf> {
    dirs::config_dir().map(|dir| dir.join(identifier).join(name))
}

/// The data root the user picked, if any.
pub fn stored_root(identifier: &str) -> Option<PathBuf> {
    let path = pointer_path(identifier, ROOT_POINTER)?;
    let raw = std::fs::read_to_string(path).ok()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(PathBuf::from(trimmed))
}

/// Forget the user's chosen data root, so the next launch falls back to
/// the default.
pub fn clear_stored_root(identifier: &str) {
    if let Some(path) = pointer_path(identifier, ROOT_POINTER) {
        let _ = std::fs::remove_file(path);
    }
}

/// Remember `root` as the data root.
pub fn store_root(identifier: &str, root: &Path) -> Result<(), String> {
    write_pointer(identifier, ROOT_POINTER, &root.display().to_string())
}

/// Remember that the data has to be copied from `from` into the root on
/// the next launch.
pub fn store_migrate_from(identifier: &str, from: &Path) {
    let _ = write_pointer(identifier, MIGRATE_FROM_POINTER, &from.display().to_string());
}

/// The folder the data has to be copied from on the next launch, if the
/// root changed.
pub fn migrate_from(identifier: &str) -> Option<PathBuf> {
    let path = pointer_path(identifier, MIGRATE_FROM_POINTER)?;
    let raw = std::fs::read_to_string(path).ok()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(PathBuf::from(trimmed))
}

/// Clear the pending-migration marker.
pub fn clear_migrate_from(identifier: &str) {
    if let Some(path) = pointer_path(identifier, MIGRATE_FROM_POINTER) {
        let _ = std::fs::remove_file(path);
    }
}

fn write_pointer(identifier: &str, name: &str, value: &str) -> Result<(), String> {
    let path = pointer_path(identifier, name).ok_or("can't locate the OS config directory")?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("can't create {}: {e}", parent.display()))?;
    }
    std::fs::write(&path, value).map_err(|e| format!("can't write {}: {e}", path.display()))
}

/// The folder the executable lives in.
pub fn exe_dir() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    Some(exe.parent()?.to_path_buf())
}

/// The default data root: a `data/` folder next to the executable.
pub fn default_root() -> Option<PathBuf> {
    Some(exe_dir()?.join(ROOT_SUBDIR))
}

/// Whether `dir` exists (or can be created) and accepts writes.
///
/// A plain `metadata()` check is not enough: the folder may exist and be
/// owned by an administrator, which is exactly the per-machine install
/// case. Writing a probe file is the only reliable test.
pub fn is_writable(dir: &Path) -> bool {
    if std::fs::create_dir_all(dir).is_err() {
        return false;
    }
    let probe = dir.join(".adrify-write-test");
    match std::fs::write(&probe, b"ok") {
        Ok(()) => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

/// The data root to use for this launch.
///
/// Returns `None` when neither the default nor a previously chosen root
/// can be written to — the caller then has to ask the user for a folder
/// before it can run.
///
/// A previously chosen root that has become unwritable (a removable
/// drive that is no longer plugged in, a folder whose permissions
/// changed) is *not* silently replaced by the default: the data the user
/// asked to keep there would vanish from view. We report "no root" so the
/// caller asks the user again.
pub fn resolve_root(identifier: &str) -> Option<PathBuf> {
    // An explicit choice always wins, as long as it is still writable.
    if let Some(stored) = stored_root(identifier) {
        if is_writable(&stored) {
            return Some(stored);
        }
        eprintln!(
            "[data-root] the chosen data root {:?} is not writable anymore",
            stored
        );
        return None;
    }
    // Otherwise a `data/` folder next to the executable, which makes a
    // portable copy of the app self-contained.
    let candidate = default_root()?;
    if is_writable(&candidate) {
        return Some(candidate);
    }
    None
}

/// The legacy (pre-override) directories the app used to write to.
///
/// These are computed with the same formulas Tauri uses, so the migration
/// finds exactly the folders the previous build populated.
fn legacy_dirs(identifier: &str) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(d) = dirs::data_dir() {
        dirs.push(d.join(identifier));
    }
    if let Some(d) = dirs::data_local_dir() {
        dirs.push(d.join(identifier));
    }
    if let Some(d) = dirs::cache_dir() {
        dirs.push(d.join(identifier));
    }
    if let Some(d) = dirs::config_dir() {
        dirs.push(d.join(identifier));
    }
    dirs
}

/// Copy `src` to `dst`, creating the destination's parents. Missing
/// sources are not an error — most of them won't exist for a given
/// platform or a given install.
///
/// WebView2's lock files are skipped wherever they appear: they belong
/// to the instance that wrote them, and copying one over would make the
/// new profile think it is still in use.
fn copy_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    let meta = std::fs::symlink_metadata(src)?;
    if meta.is_dir() {
        std::fs::create_dir_all(dst)?;
        for entry in std::fs::read_dir(src)? {
            let entry = entry?;
            copy_recursive(&entry.path(), &dst.join(entry.file_name()))?;
        }
        Ok(())
    } else {
        if is_webview_lock(src) {
            return Ok(());
        }
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::copy(src, dst)?;
        Ok(())
    }
}

/// Move the data of the pre-override layout into `root`.
///
/// Best effort by design: a failure to copy one file must never stop the
/// app from starting. The migration runs once per root — a marker file
/// inside the root records that it happened.
pub fn migrate_legacy_data(identifier: &str, root: &Path) {
    let marker = root.join(MIGRATION_MARKER);
    if marker.exists() {
        return;
    }

    let legacy = legacy_dirs(identifier);
    if !legacy.iter().any(|d| d.exists()) {
        // Nothing to migrate (a fresh install). Still write the marker so
        // we don't probe the legacy folders on every launch.
        let _ = std::fs::write(&marker, b"");
        return;
    }

    // `legacy` overlaps (on Windows the data, local-data and cache dirs
    // are all `%LOCALAPPDATA%\<id>`), so remember what we already handled.
    let mut handled: HashSet<PathBuf> = HashSet::new();
    let copy = |src: PathBuf, dst: PathBuf, handled: &mut HashSet<PathBuf>| {
        if !src.exists() {
            return;
        }
        if !handled.insert(src.clone()) {
            return;
        }
        // Copying a folder onto itself would truncate it.
        if src == dst {
            return;
        }
        match copy_recursive(&src, &dst) {
            Ok(()) => eprintln!("[data-root] migrated {:?} -> {:?}", src, dst),
            Err(e) => eprintln!("[data-root] couldn't migrate {:?}: {e}", src),
        }
    };

    for dir in &legacy {
        // The user state: accounts, encrypted cookies, the managed yt-dlp.
        for name in LEGACY_STATE_ENTRIES {
            copy(dir.join(name), root.join(name), &mut handled);
        }
        // The WebView2 profile's own state — our localStorage and
        // IndexedDB, not Chromium's caches.
        for name in LEGACY_WEBVIEW_STATE {
            copy(
                dir.join("EBWebView").join(name),
                root.join("EBWebView").join(name),
                &mut handled,
            );
        }
        // The audio/cover caches now live under `caches/`.
        for name in LEGACY_CACHE_DIRS {
            copy(dir.join(name), root.join("caches").join(name), &mut handled);
        }
        // The logs now live under `logs/`.
        copy(dir.join("logs"), root.join("logs"), &mut handled);
    }

    // The user may have pointed the *cache* at a folder of their own
    // while the rest of the data lived in the OS dirs. Carry that folder
    // over too, so the tracks don't seem to vanish.
    if let Some(custom) = legacy_custom_cache_dir(&legacy) {
        for name in LEGACY_CACHE_DIRS {
            copy(
                custom.join(name),
                root.join("caches").join(name),
                &mut handled,
            );
        }
    }

    let _ = std::fs::write(&marker, b"");
}

/// The custom cache root from the legacy store plugin's `settings.json`.
///
/// The plugin stores a plain JSON object at the app-data dir, so the key
/// can be read without the plugin itself.
fn legacy_custom_cache_dir(legacy: &[PathBuf]) -> Option<PathBuf> {
    for dir in legacy {
        let path = dir.join("settings.json");
        let Ok(raw) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else {
            continue;
        };
        let Some(custom) = value.get(CACHE_DIR_KEY).and_then(|v| v.as_str()) else {
            continue;
        };
        let custom = custom.trim();
        if custom.is_empty() {
            continue;
        }
        let dir = PathBuf::from(custom);
        if dir.is_dir() {
            return Some(dir);
        }
    }
    None
}

/// Whether `path` is one of the OS directories the app used before the
/// data-root override.
///
/// The store plugin's `cacheDir` preference may point at one of them —
/// it used to *be* the default. After the override the cache follows the
/// data root, so such a preference is stale: honouring it would send the
/// tracks back to the old location and leave the migrated cache
/// untouched.
pub fn is_legacy_dir(identifier: &str, path: &Path) -> bool {
    legacy_dirs(identifier)
        .iter()
        .any(|dir| dir == path || path.starts_with(dir))
}

/// Copy the contents of one data root into another.
///
/// Used when the user points the root somewhere else: the data should
/// follow them rather than being left behind in the old folder. The
/// marker file is skipped — the new root still needs its own migration
/// pass, and the marker is what records that it already happened.
pub fn copy_root_contents(from: &Path, dst: &Path) {
    if from == dst || !from.is_dir() {
        return;
    }
    let entries = match std::fs::read_dir(from) {
        Ok(entries) => entries,
        Err(e) => {
            eprintln!("[data-root] can't read {:?}: {e}", from);
            return;
        }
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        if name == std::ffi::OsStr::new(MIGRATION_MARKER) {
            continue;
        }
        let src = entry.path();
        let target = dst.join(&name);
        if src == target {
            continue;
        }
        if let Err(e) = copy_recursive(&src, &target) {
            eprintln!("[data-root] couldn't copy {:?} -> {:?}: {e}", src, target);
        }
    }
}

/// Whether `path` is one of WebView2's lock files.
fn is_webview_lock(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    matches!(name, "LOCK" | "lockfile")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writable_dir_is_detected() {
        let dir = std::env::temp_dir().join("adrify-data-root-test");
        let _ = std::fs::remove_dir_all(&dir);
        assert!(is_writable(&dir));
        assert!(!dir.join(".adrify-write-test").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn copy_recursive_moves_files() {
        let base = std::env::temp_dir().join("adrify-data-root-copy-test");
        let _ = std::fs::remove_dir_all(&base);
        let src = base.join("src");
        let dst = base.join("dst");
        std::fs::create_dir_all(src.join("nested")).unwrap();
        std::fs::write(src.join("nested").join("file.txt"), b"hi").unwrap();
        copy_recursive(&src, &dst).unwrap();
        assert_eq!(
            std::fs::read_to_string(dst.join("nested").join("file.txt")).unwrap(),
            "hi"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn copy_root_contents_skips_the_marker() {
        let base = std::env::temp_dir().join("adrify-data-root-move-test");
        let _ = std::fs::remove_dir_all(&base);
        let from = base.join("from");
        let to = base.join("to");
        std::fs::create_dir_all(from.join("caches")).unwrap();
        std::fs::write(from.join(MIGRATION_MARKER), b"").unwrap();
        std::fs::write(from.join("caches").join("a.bin"), b"x").unwrap();
        copy_root_contents(&from, &to);
        assert!(!to.join(MIGRATION_MARKER).exists());
        assert!(to.join("caches").join("a.bin").exists());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn copy_root_contents_skips_webview_locks() {
        let base = std::env::temp_dir().join("adrify-data-root-lock-test");
        let _ = std::fs::remove_dir_all(&base);
        let from = base.join("from");
        let to = base.join("to");
        std::fs::create_dir_all(from.join("EBWebView").join("Default")).unwrap();
        std::fs::write(from.join("EBWebView").join("Default").join("LOCK"), b"").unwrap();
        std::fs::write(from.join("EBWebView").join("Default").join("Preferences"), b"x").unwrap();
        copy_root_contents(&from, &to);
        assert!(!to.join("EBWebView").join("Default").join("LOCK").exists());
        assert!(to.join("EBWebView").join("Default").join("Preferences").exists());
        let _ = std::fs::remove_dir_all(&base);
    }
}
