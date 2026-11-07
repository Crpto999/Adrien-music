// Our own MPRIS player for KDE Plasma's taskbar tooltip (Linux only).
//
// WebKitGTK already publishes an MPRIS player for the <audio> element, but
// from its WebKitWebProcess child and with an empty `DesktopEntry`. Plasma's
// task manager attaches a player to a taskbar entry only when the player's
// D-Bus owner pid equals the window's pid, its `kde:pid` metadata does, or its
// `DesktopEntry` names the launcher (libkmpris, `playerForLauncherUrl`) — so
// WebKit's player never matches and the hover tooltip has no media controls.
//
// So on KDE we register a second player from the host process: owner pid is
// ours, `DesktopEntry` is YTubic's, and `kde:pid` carries the pid of WebKit's
// player. Plasma hides every player whose owner pid appears in some player's
// `kde:pid` (the same rule plasma-browser-integration relies on), so WebKit's
// bare entry disappears and this one is the single YTubic player.
//
// Not KDE: other desktops ignore `kde:pid`, so a second player would show up as
// a duplicate there. `init` does nothing and `update` / `clear` are no-ops.
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

use tauri::{AppHandle, Emitter};
use zbus::blocking::{fdo::DBusProxy, Connection};
use zbus::zvariant::{ObjectPath, OwnedValue, Value};

const PATH: &str = "/org/mpris/MediaPlayer2";
const PLAYER_IFACE: &str = "org.mpris.MediaPlayer2.Player";
const NO_TRACK: &str = "/org/mpris/MediaPlayer2/TrackList/NoTrack";
const TRACK_ID: &str = "/org/ytubic/track/current";
/// Position jumps larger than this versus the extrapolated one are reported
/// as `Seeked` so clients re-sync their progress bar.
const SEEK_THRESHOLD_US: i64 = 2_000_000;

#[derive(Default)]
struct State {
    loaded: bool,
    playing: bool,
    title: String,
    artist: String,
    album: String,
    cover: String,
    length_us: i64,
    position_us: i64,
    position_at: Option<Instant>,
    /// Pid of WebKit's own MPRIS owner, advertised as `kde:pid`.
    webkit_pid: Option<u32>,
}

impl State {
    fn position_now(&self) -> i64 {
        let base = self.position_us;
        match (self.playing, self.position_at) {
            (true, Some(at)) => {
                let live = base + at.elapsed().as_micros() as i64;
                if self.length_us > 0 {
                    live.min(self.length_us)
                } else {
                    live
                }
            }
            _ => base,
        }
    }

    fn metadata(&self) -> HashMap<String, OwnedValue> {
        let mut m: HashMap<String, Value> = HashMap::new();
        let track = if self.loaded { TRACK_ID } else { NO_TRACK };
        m.insert(
            "mpris:trackid".into(),
            Value::from(ObjectPath::try_from(track).expect("static path")),
        );
        if self.loaded {
            m.insert("xesam:title".into(), Value::from(self.title.clone()));
            if !self.artist.is_empty() {
                m.insert(
                    "xesam:artist".into(),
                    Value::from(vec![self.artist.clone()]),
                );
            }
            if !self.album.is_empty() {
                m.insert("xesam:album".into(), Value::from(self.album.clone()));
            }
            if !self.cover.is_empty() {
                m.insert("mpris:artUrl".into(), Value::from(self.cover.clone()));
            }
            if self.length_us > 0 {
                m.insert("mpris:length".into(), Value::from(self.length_us));
            }
        }
        if let Some(pid) = self.webkit_pid {
            m.insert("kde:pid".into(), Value::from(pid));
        }
        m.into_iter()
            .filter_map(|(k, v)| OwnedValue::try_from(v).ok().map(|v| (k, v)))
            .collect()
    }

    fn status(&self) -> &'static str {
        if !self.loaded {
            "Stopped"
        } else if self.playing {
            "Playing"
        } else {
            "Paused"
        }
    }
}

type Shared = Arc<Mutex<State>>;

struct Handle {
    conn: Connection,
    state: Shared,
}

static HANDLE: OnceLock<Handle> = OnceLock::new();

fn control(app: &AppHandle, action: &str) {
    let _ = app.emit("media-control", serde_json::json!({ "action": action }));
}

fn seek_to(app: &AppHandle, micros: i64) {
    let _ = app.emit(
        "media-control",
        serde_json::json!({ "action": "seek", "position": micros.max(0) as f64 / 1e6 }),
    );
}

struct Root {
    app: AppHandle,
}

#[zbus::interface(name = "org.mpris.MediaPlayer2")]
impl Root {
    fn raise(&self) {
        let app = self.app.clone();
        let _ = self.app.run_on_main_thread(move || crate::show_main_window(&app));
    }

    fn quit(&self) {}

    #[zbus(property)]
    fn can_quit(&self) -> bool {
        false
    }

    #[zbus(property)]
    fn can_raise(&self) -> bool {
        true
    }

    #[zbus(property)]
    fn has_track_list(&self) -> bool {
        false
    }

    #[zbus(property)]
    fn identity(&self) -> &str {
        "YTubic"
    }

    #[zbus(property)]
    fn desktop_entry(&self) -> &str {
        "YTubic"
    }

    #[zbus(property)]
    fn supported_uri_schemes(&self) -> Vec<String> {
        Vec::new()
    }

    #[zbus(property)]
    fn supported_mime_types(&self) -> Vec<String> {
        Vec::new()
    }
}

struct Player {
    app: AppHandle,
    state: Shared,
}

impl Player {
    fn loaded(&self) -> bool {
        self.state.lock().map(|s| s.loaded).unwrap_or(false)
    }
}

#[zbus::interface(name = "org.mpris.MediaPlayer2.Player")]
impl Player {
    fn next(&self) {
        control(&self.app, "next");
    }

    fn previous(&self) {
        control(&self.app, "previous");
    }

    fn pause(&self) {
        control(&self.app, "pause");
    }

    fn play_pause(&self) {
        control(&self.app, "toggle");
    }

    fn stop(&self) {
        control(&self.app, "pause");
    }

    fn play(&self) {
        control(&self.app, "play");
    }

    fn seek(&self, offset: i64) {
        let now = self.state.lock().map(|s| s.position_now()).unwrap_or(0);
        seek_to(&self.app, now + offset);
    }

    fn set_position(&self, track_id: ObjectPath<'_>, position: i64) {
        if track_id.as_str() == TRACK_ID {
            seek_to(&self.app, position);
        }
    }

    fn open_uri(&self, _uri: &str) {}

    #[zbus(signal)]
    async fn seeked(emitter: &zbus::object_server::SignalEmitter<'_>, position: i64)
        -> zbus::Result<()>;

    #[zbus(property)]
    fn playback_status(&self) -> String {
        self.state
            .lock()
            .map(|s| s.status().to_string())
            .unwrap_or_else(|_| "Stopped".into())
    }

    #[zbus(property)]
    fn rate(&self) -> f64 {
        1.0
    }

    #[zbus(property)]
    fn minimum_rate(&self) -> f64 {
        1.0
    }

    #[zbus(property)]
    fn maximum_rate(&self) -> f64 {
        1.0
    }

    #[zbus(property)]
    fn metadata(&self) -> HashMap<String, OwnedValue> {
        self.state.lock().map(|s| s.metadata()).unwrap_or_default()
    }

    #[zbus(property)]
    fn volume(&self) -> f64 {
        1.0
    }

    #[zbus(property)]
    fn position(&self) -> i64 {
        self.state.lock().map(|s| s.position_now()).unwrap_or(0)
    }

    #[zbus(property)]
    fn can_go_next(&self) -> bool {
        self.loaded()
    }

    #[zbus(property)]
    fn can_go_previous(&self) -> bool {
        self.loaded()
    }

    #[zbus(property)]
    fn can_play(&self) -> bool {
        self.loaded()
    }

    #[zbus(property)]
    fn can_pause(&self) -> bool {
        self.loaded()
    }

    #[zbus(property)]
    fn can_seek(&self) -> bool {
        self.loaded()
    }

    #[zbus(property)]
    fn can_control(&self) -> bool {
        true
    }
}

fn is_kde() -> bool {
    std::env::var("XDG_CURRENT_DESKTOP")
        .map(|d| d.split(':').any(|p| p.eq_ignore_ascii_case("KDE")))
        .unwrap_or(false)
}

/// Register the player on the session bus. Safe to call on any desktop; it
/// only does something under KDE (see the module comment).
pub fn init(app: &AppHandle) {
    if !is_kde() {
        return;
    }
    let state: Shared = Arc::new(Mutex::new(State::default()));
    let name = format!("org.mpris.MediaPlayer2.ytubic.instance{}", std::process::id());
    let built = zbus::blocking::connection::Builder::session()
        .and_then(|b| b.name(name))
        .and_then(|b| b.serve_at(PATH, Root { app: app.clone() }))
        .and_then(|b| {
            b.serve_at(
                PATH,
                Player {
                    app: app.clone(),
                    state: state.clone(),
                },
            )
        })
        .and_then(|b| b.build());
    match built {
        Ok(conn) => {
            let _ = HANDLE.set(Handle { conn, state });
        }
        Err(e) => crate::log!("[mpris] failed to register player: {e}"),
    }
}

/// Parent pid from /proc/<pid>/stat. The comm field may contain spaces and
/// parentheses, so split after its closing paren.
fn parent_pid(pid: u32) -> Option<u32> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let rest = &stat[stat.rfind(')')? + 1..];
    rest.split_whitespace().nth(1)?.parse().ok()
}

/// Find the MPRIS owner WebKit spawned for our webview: any other MPRIS name
/// whose owning process is a direct child of this one.
fn find_webkit_pid(conn: &Connection) -> Option<u32> {
    let dbus = DBusProxy::new(conn).ok()?;
    let me = std::process::id();
    let own = conn.unique_name().map(|n| n.to_string());
    for name in dbus.list_names().ok()? {
        let name = name.to_string();
        if !name.starts_with("org.mpris.MediaPlayer2.") {
            continue;
        }
        let Ok(bus_name) = zbus::names::BusName::try_from(name.as_str()) else {
            continue;
        };
        if let Ok(owner) = dbus.get_name_owner(bus_name.clone()) {
            if own.as_deref() == Some(owner.as_str()) {
                continue;
            }
        }
        if let Ok(pid) = dbus.get_connection_unix_process_id(bus_name) {
            if parent_pid(pid) == Some(me) {
                return Some(pid);
            }
        }
    }
    None
}

fn emit_changed(conn: &Connection, changed: HashMap<&str, Value<'_>>) {
    let _ = conn.emit_signal(
        None::<&str>,
        PATH,
        "org.freedesktop.DBus.Properties",
        "PropertiesChanged",
        &(PLAYER_IFACE, changed, Vec::<&str>::new()),
    );
}

/// Push the current track + playback state. Called on the frontend's 2s
/// cadence, so only emit signals when something visible actually changed.
#[allow(clippy::too_many_arguments)]
pub fn update(
    title: &str,
    artist: &str,
    album: &str,
    cover: &str,
    duration: f64,
    elapsed: f64,
    playing: bool,
) {
    let Some(h) = HANDLE.get() else { return };
    let webkit_pid = find_webkit_pid(&h.conn);
    let (meta, status, loaded_changed, seeked) = {
        let Ok(mut s) = h.state.lock() else { return };
        let length_us = (duration.max(0.0) * 1e6) as i64;
        let position_us = (elapsed.max(0.0) * 1e6) as i64;
        let meta_changed = !s.loaded
            || s.title != title
            || s.artist != artist
            || s.album != album
            || s.cover != cover
            || s.length_us != length_us
            || s.webkit_pid != webkit_pid;
        let was_playing = s.playing;
        let was_loaded = s.loaded;
        let seeked = s.loaded && (position_us - s.position_now()).abs() > SEEK_THRESHOLD_US;
        s.loaded = true;
        s.playing = playing;
        s.title = title.into();
        s.artist = artist.into();
        s.album = album.into();
        s.cover = cover.into();
        s.length_us = length_us;
        s.webkit_pid = webkit_pid;
        s.position_us = position_us;
        s.position_at = Some(Instant::now());
        (
            meta_changed.then(|| s.metadata()),
            (was_playing != playing || !was_loaded).then(|| s.status()),
            !was_loaded,
            seeked.then_some(position_us),
        )
    };
    let mut changed: HashMap<&str, Value<'_>> = HashMap::new();
    if let Some(m) = meta {
        changed.insert("Metadata", Value::from(m));
    }
    if let Some(st) = status {
        changed.insert("PlaybackStatus", Value::from(st));
    }
    if loaded_changed {
        for k in ["CanGoNext", "CanGoPrevious", "CanPlay", "CanPause", "CanSeek"] {
            changed.insert(k, Value::from(true));
        }
    }
    if !changed.is_empty() {
        emit_changed(&h.conn, changed);
    }
    if let Some(pos) = seeked {
        let _ = h
            .conn
            .emit_signal(None::<&str>, PATH, PLAYER_IFACE, "Seeked", &(pos,));
    }
}

/// Nothing is playing any more (queue emptied / signed out).
pub fn clear() {
    let Some(h) = HANDLE.get() else { return };
    {
        let Ok(mut s) = h.state.lock() else { return };
        if !s.loaded {
            return;
        }
        let pid = s.webkit_pid;
        *s = State {
            webkit_pid: pid,
            ..State::default()
        };
    }
    let meta = h.state.lock().map(|s| s.metadata()).unwrap_or_default();
    let mut changed: HashMap<&str, Value<'_>> = HashMap::new();
    changed.insert("Metadata", Value::from(meta));
    changed.insert("PlaybackStatus", Value::from("Stopped"));
    for k in ["CanGoNext", "CanGoPrevious", "CanPlay", "CanPause", "CanSeek"] {
        changed.insert(k, Value::from(false));
    }
    emit_changed(&h.conn, changed);
}
