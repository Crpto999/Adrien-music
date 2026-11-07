//! A plain-text log file next to the app's other data.
//!
//! The backend used to report everything through `eprintln!`, which
//! reaches the terminal during `tauri dev` and goes NOWHERE in a
//! packaged Windows build — the app is launched detached from a
//! console, so stderr is discarded. Every diagnostic the backend has
//! ever produced (session renewals, cookie-jar decrypt failures,
//! yt-dlp spawn errors) was therefore invisible to anyone who was not
//! running from a terminal, which is every user.
//!
//! The `log!` macro writes each line to BOTH stderr and this file, so
//! the terminal output is unchanged and the file keeps the history.
//!
//! The file lives in the app's log directory (`%LOCALAPPDATA%\
//! com.github.ivasy.ytubic\logs` on Windows) and is rotated at
//! 1 MiB: the old file is renamed to `ytubic.log.1` and the previous
//! one is dropped, so the log can never grow without bound.

use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

/// Where the log file lives. Set once during `setup`, when the app's
/// path resolver is available.
static LOG_PATH: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();

/// Bytes at which the log file is rotated.
const MAX_BYTES: u64 = 1024 * 1024;

/// Point the logger at `dir`. Any line logged before this call still
/// goes to stderr, just not to the file.
pub fn init(dir: &std::path::Path) {
    if let Err(e) = std::fs::create_dir_all(dir) {
        eprintln!("[log] create log dir failed: {e}");
        return;
    }
    let path = dir.join("ytubic.log");
    let slot = LOG_PATH.get_or_init(|| Mutex::new(None));
    if let Ok(mut guard) = slot.lock() {
        *guard = Some(path);
    }
}

/// The active log file, if the logger has been initialized.
fn path() -> Option<PathBuf> {
    LOG_PATH
        .get()
        .and_then(|slot| slot.lock().ok())
        .and_then(|guard| guard.clone())
}

/// The path of the log file, for the frontend to show the user.
///
/// A packaged build has no console, so this is the only way a user can
/// get at the diagnostics. `None` when the logger could not be
/// initialized (an unwritable log directory).
pub fn file_path() -> Option<String> {
    path().map(|p| p.to_string_lossy().into_owned())
}

/// Append one line to the log file, rotating it first if it has grown
/// past `MAX_BYTES`.
///
/// Failures here are swallowed on purpose: logging must never be the
/// reason the app misbehaves.
fn append(line: &str) {
    let Some(path) = path() else {
        return;
    };
    // Rotate before writing, so the check and the write are separate
    // steps and a failed rotation cannot lose the line.
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() >= MAX_BYTES {
            let old = path.with_file_name("ytubic.log.1");
            let _ = std::fs::remove_file(&old);
            let _ = std::fs::rename(&path, &old);
        }
    }
    let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    else {
        return;
    };
    let _ = writeln!(file, "{} {line}", timestamp());
    let _ = file.flush();
}

/// A local timestamp for each line. `time` is already a dependency, so
/// this costs nothing extra.
fn timestamp() -> String {
    let now = time::OffsetDateTime::now_utc();
    let fmt = time::macros::format_description!(
        "[year]-[month]-[day] [hour]:[minute]:[second]"
    );
    now.format(&fmt).unwrap_or_else(|_| "????-??-?? ??:??:??".into())
}

/// The write half of the `log!` macro, exposed for the macro's use.
pub fn write_line(line: &str) {
    append(line);
}

/// Write one line to stderr AND the log file.
///
/// Replaces the bare `eprintln!` calls the backend used everywhere, so
/// a packaged build leaves a readable trail.
#[macro_export]
macro_rules! log {
    ($($arg:tt)*) => {{
        let line = format!($($arg)*);
        eprintln!("{line}");
        $crate::logging::write_line(&line);
    }};
}
