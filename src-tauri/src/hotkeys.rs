//! Global shortcuts: the OS-level bindings that keep working while the
//! app sits in the system tray.
//!
//! Two very different mechanisms live here, because the OS offers two
//! very different mechanisms:
//!
//! * **Keyboard** goes through `global-hotkey`, which wraps
//!   `RegisterHotKey` on Windows, Carbon's `RegisterEventHotKey` on
//!   macOS and X11 grabs on Linux. The OS owns the key while it is
//!   held, so the shortcut fires even with no window focused.
//!
//! * **Mouse buttons** have no `RegisterHotKey` equivalent ? the OS
//!   has no notion of "this button belongs to that app". We install a
//!   low-level mouse hook (`WH_MOUSE_LL`) on a dedicated thread that
//!   pumps messages, and match the button plus the modifier state
//!   ourselves. The hook observes rather than swallows the click, so
//!   the button still works normally everywhere else.
//!
//! The frontend owns the mapping (it lives in a Zustand store) and
//! pushes it here over IPC; this side only registers what it is given
//! and reports the action back through a `global-hotkey` event.

use std::collections::HashMap;
use std::str::FromStr;
use std::sync::mpsc;
use std::sync::Mutex;

use global_hotkey::hotkey::{Code, HotKey, Modifiers};
use global_hotkey::GlobalHotKeyEvent;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

/// The action a global shortcut triggers: `"toggle"`, `"next"` or
/// `"like"`.
pub type Action = String;

/// One binding as the frontend describes it.
///
/// `kind` is `"key"` for a keyboard shortcut and `"mouse"` for a mouse
/// button. For a key, `code` is the physical key (`"KeyP"`, `"Space"`,
/// ?) and `modifiers` lists the held modifiers. For a mouse button,
/// `button` names the button (`"left"`, `"middle"`, `"right"`,
/// `"back"`, `"forward"`) and `modifiers` narrows it down.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HotkeyBinding {
    pub action: Action,
    pub kind: String,
    /// Physical key name, e.g. `KeyP`. Empty for mouse bindings.
    #[serde(default)]
    pub code: String,
    /// Mouse button name. Empty for keyboard bindings.
    #[serde(default)]
    pub button: String,
    /// Modifier names: `ctrl`, `shift`, `alt`, `super`.
    #[serde(default)]
    pub modifiers: Vec<String>,
}

/// The manager that owns the registered system hotkeys.
///
/// `global-hotkey`'s manager holds a raw window handle, so it is
/// neither `Send` nor `Sync` on Windows. We only ever touch it from
/// the main thread (the one that owns the hidden window and pumps its
/// messages), which is what makes the transfer sound.
struct HotkeyManager(global_hotkey::GlobalHotKeyManager);

// SAFETY: the manager is only ever used from the main thread. The
// `Mutex` in `HotkeyState` enforces that at runtime, and the wrapper
// exists only so the state itself can be `Send + Sync` (Tauri
// requires that of anything it manages).
unsafe impl Send for HotkeyManager {}
unsafe impl Sync for HotkeyManager {}

/// Everything the backend keeps between changes.
#[derive(Default)]
pub struct HotkeyState {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    /// The hotkey manager. Created on the main thread at startup.
    manager: Option<HotkeyManager>,
    /// The hotkeys we registered, so we can unregister exactly those
    /// on the next change.
    registered: Vec<HotKey>,
    /// Which action each registered hotkey id belongs to.
    actions: HashMap<u32, Action>,
}

/// The event name the frontend listens on.
pub const EVENT: &str = "global-hotkey";

/// Payload of the `global-hotkey` event.
#[derive(Debug, Clone, Serialize)]
pub struct HotkeyEvent {
    /// The action to run: `"toggle"`, `"next"` or `"like"`.
    pub action: Action,
}

/// Set the active global shortcuts.
///
/// The frontend sends the complete mapping every time it changes, so
/// this replaces whatever was registered before. Failures are reported
/// back per binding: one key already taken by another app must not
/// stop the other two from working.
#[tauri::command]
pub fn set_global_hotkeys(
    app: AppHandle,
    bindings: Vec<HotkeyBinding>,
) -> Result<Vec<String>, String> {
    apply(&app, &bindings)
}

/// Register `bindings`, replacing the previous set.
fn apply(app: &AppHandle, bindings: &[HotkeyBinding]) -> Result<Vec<String>, String> {
    let mut errors: Vec<String> = Vec::new();

    // --- parse ---------------------------------------------------------
    let mut keyboard: Vec<(HotKey, Action)> = Vec::new();
    for binding in bindings.iter().filter(|b| b.kind == "key") {
        match parse_key_binding(binding) {
            Ok(hotkey) => keyboard.push((hotkey, binding.action.clone())),
            Err(e) => errors.push(e),
        }
    }

    // --- keyboard ------------------------------------------------------
    // Registering has to happen on the main thread: that is the thread
    // the hidden hotkey window lives on, and the one whose message
    // pump delivers `WM_HOTKEY`. (On macOS the platform requires it
    // outright.)
    //
    // The lock is taken *inside* the main-thread closure, never while
    // we wait for it: the hotkey dispatch also runs on the main
    // thread and takes the same lock, so holding it across the wait
    // would deadlock the two against each other.
    let (tx, rx) = mpsc::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let state = handle.state::<HotkeyState>();
        let mut inner = state.inner.lock().unwrap();
        let mut errors: Vec<String> = Vec::new();

        // Drop the old registrations first, so a key that is now bound
        // to a different action does not collide with itself.
        if let Some(manager) = inner.manager.as_ref() {
            if !inner.registered.is_empty() {
                if let Err(e) = manager.0.unregister_all(&inner.registered) {
                    errors.push(format!("could not release the previous shortcuts: {e}"));
                }
            }
        }
        inner.registered.clear();
        inner.actions.clear();

        for (hotkey, action) in &keyboard {
            match inner.manager.as_ref().map(|m| m.0.register(*hotkey)) {
                Some(Ok(())) => {
                    inner.registered.push(*hotkey);
                    inner.actions.insert(hotkey.id(), action.clone());
                }
                Some(Err(e)) => errors.push(format!("{action}: {e}")),
                None => errors.push(format!("{action}: the hotkey manager is not running")),
            }
        }

        let _ = tx.send(errors);
    })
    .map_err(|e| format!("could not reach the main thread: {e}"))?;

    // The closure runs inline when we are already on the main thread
    // (which is the case for a synchronous command), so this returns
    // immediately. The timeout is a safety net: a hang here would
    // freeze the app, and the alternative is to report the failure.
    match rx.recv_timeout(std::time::Duration::from_secs(5)) {
        Ok(mut inner_errors) => errors.append(&mut inner_errors),
        Err(_) => errors.push("the shortcuts could not be registered in time".into()),
    }

    // --- mouse ---------------------------------------------------------
    #[cfg(windows)]
    {
        let mut mouse: Vec<crate::hotkeys::mouse::MouseBinding> = Vec::new();
        for binding in bindings.iter().filter(|b| b.kind == "mouse") {
            match crate::hotkeys::mouse::parse(binding) {
                Ok(m) => mouse.push(m),
                Err(e) => errors.push(e),
            }
        }
        crate::hotkeys::mouse::apply(app, mouse);
    }
    #[cfg(not(windows))]
    {
        // Mouse bindings are a Windows-only feature (the hook is a
        // Win32 low-level hook). Say so rather than silently ignoring
        // the user's choice.
        for binding in bindings.iter().filter(|b| b.kind == "mouse") {
            errors.push(format!(
                "{}: mouse shortcuts are only supported on Windows",
                binding.action
            ));
        }
    }

    Ok(errors)
}

/// Turn a key binding into a `HotKey`.
fn parse_key_binding(binding: &HotkeyBinding) -> Result<HotKey, String> {
    let code = Code::from_str(&binding.code)
        .map_err(|_| format!("{}: unknown key '{}'", binding.action, binding.code))?;
    Ok(HotKey::new(Some(modifiers_of(&binding.modifiers)), code))
}

/// Turn the frontend's modifier names into a `Modifiers` mask.
fn modifiers_of(names: &[String]) -> Modifiers {
    let mut mods = Modifiers::empty();
    for name in names {
        match name.to_ascii_lowercase().as_str() {
            "ctrl" | "control" => mods |= Modifiers::CONTROL,
            "shift" => mods |= Modifiers::SHIFT,
            "alt" | "option" => mods |= Modifiers::ALT,
            // `SUPER` is the Windows / Command key. `META` is the same
            // thing under a different name; `HotKey::new` normalises one
            // into the other.
            "super" | "meta" | "cmd" | "command" | "win" => mods |= Modifiers::SUPER,
            _ => {}
        }
    }
    mods
}

/// Start listening for hotkey events.
///
/// `global-hotkey` has a single global event handler, set once for the
/// lifetime of the process. We install it here, at startup, and route
/// every event to the action it was registered for.
pub fn init(app: &AppHandle) {
    // The manager's hidden window has to be created on the thread that
    // pumps its messages ? the main thread, which is where `setup`
    // runs.
    {
        let state = app.state::<HotkeyState>();
        let mut inner = state.inner.lock().unwrap();
        match global_hotkey::GlobalHotKeyManager::new() {
            Ok(manager) => inner.manager = Some(HotkeyManager(manager)),
            Err(e) => {
                crate::log!("[hotkeys] could not create the hotkey manager: {e}");
                return;
            }
        }
    }

    let handle = app.clone();
    GlobalHotKeyEvent::set_event_handler(Some(move |event: GlobalHotKeyEvent| {
        if event.state != global_hotkey::HotKeyState::Pressed {
            return;
        }
        // The event carries the hotkey's id; we need the action it was
        // bound to.
        let action = {
            let state = handle.state::<HotkeyState>();
            let inner = state.inner.lock().unwrap();
            inner.actions.get(&event.id).cloned()
        };
        if let Some(action) = action {
            let _ = handle.emit(EVENT, HotkeyEvent { action });
        }
    }));
}

/// The Windows mouse-button side of the feature.
#[cfg(windows)]
pub mod mouse {
    use super::{Action, HotkeyBinding, HotkeyEvent, Modifiers};
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use std::sync::mpsc;
    use std::sync::Mutex;
    use tauri::{AppHandle, Emitter};

    /// The buttons a binding can name.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum MouseButton {
        Left,
        Middle,
        Right,
        Back,
        Forward,
    }

    /// A mouse binding, resolved into the concrete button + modifier
    /// mask the hook compares against.
    #[derive(Debug, Clone)]
    pub struct MouseBinding {
        pub action: Action,
        pub button: MouseButton,
        pub modifiers: Modifiers,
    }

    /// The bindings the hook compares against. The hook runs on its own
    /// thread, so this is shared with it through a plain static rather
    /// than the Tauri state (which would need the app handle to reach).
    static BINDINGS: Mutex<Vec<MouseBinding>> = Mutex::new(Vec::new());

    /// Whether the hook thread is running.
    static RUNNING: AtomicBool = AtomicBool::new(false);

    /// The id of the hook thread, so we can ask it to stop.
    static THREAD_ID: AtomicU32 = AtomicU32::new(0);

    /// The hook thread itself, so stopping it can wait for it to exit
    /// rather than leaving a stray hook behind.
    static THREAD: Mutex<Option<std::thread::JoinHandle<()>>> = Mutex::new(None);

    /// The app handle the hook emits through.
    static APP: Mutex<Option<AppHandle>> = Mutex::new(None);

    /// The message that tells the hook thread to unhook and exit.
    const WM_STOP_HOOK: u32 = 0x8001;

    /// Parse a mouse binding.
    pub fn parse(binding: &HotkeyBinding) -> Result<MouseBinding, String> {
        let button = match binding.button.to_ascii_lowercase().as_str() {
            "left" => MouseButton::Left,
            "middle" => MouseButton::Middle,
            "right" => MouseButton::Right,
            "back" | "xbutton1" => MouseButton::Back,
            "forward" | "xbutton2" => MouseButton::Forward,
            other => {
                return Err(format!(
                    "{}: unknown mouse button '{other}'",
                    binding.action
                ))
            }
        };
        Ok(MouseBinding {
            action: binding.action.clone(),
            button,
            modifiers: super::modifiers_of(&binding.modifiers),
        })
    }

    /// Install the bindings, starting or stopping the hook as needed.
    pub fn apply(app: &AppHandle, bindings: Vec<MouseBinding>) {
        let wanted = !bindings.is_empty();
        *BINDINGS.lock().unwrap() = bindings;

        if wanted {
            start(app);
        } else {
            stop();
        }
    }

    /// Start the hook thread (once).
    fn start(app: &AppHandle) {
        if RUNNING.swap(true, Ordering::SeqCst) {
            return;
        }
        *APP.lock().unwrap() = Some(app.clone());

        let (tx, rx) = mpsc::channel();
        let spawned = std::thread::Builder::new()
            .name("adrify-mouse-hook".into())
            .spawn(move || hook_thread(tx));
        let handle = match spawned {
            Ok(h) => h,
            Err(_) => {
                RUNNING.store(false, Ordering::SeqCst);
                crate::log!("[hotkeys] could not start the mouse hook thread");
                return;
            }
        };

        // Wait for the thread to report its id, so we can stop it
        // later. It sends the id once the hook is installed, so a
        // success here means the hook is live.
        match rx.recv_timeout(std::time::Duration::from_secs(5)) {
            Ok(id) if id != 0 => {
                THREAD_ID.store(id, Ordering::SeqCst);
                *THREAD.lock().unwrap() = Some(handle);
            }
            _ => {
                RUNNING.store(false, Ordering::SeqCst);
                crate::log!("[hotkeys] the mouse hook could not be installed");
            }
        }
    }

    /// Ask the hook thread to unhook and exit.
    fn stop() {
        if !RUNNING.swap(false, Ordering::SeqCst) {
            return;
        }
        let id = THREAD_ID.swap(0, Ordering::SeqCst);
        if id != 0 {
            unsafe {
                use windows_sys::Win32::UI::WindowsAndMessaging::PostThreadMessageW;
                let _ = PostThreadMessageW(id, WM_STOP_HOOK, 0, 0);
            }
        }
        // Wait for the thread to finish so the hook is really gone
        // before another one is installed.
        if let Some(handle) = THREAD.lock().unwrap().take() {
            let _ = handle.join();
        }
    }

    /// The modifier state at the moment the hook fired.
    fn current_modifiers() -> Modifiers {
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
            GetAsyncKeyState, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT,
        };
        let pressed = |key: u16| unsafe { GetAsyncKeyState(key as i32) < 0 };
        let mut mods = Modifiers::empty();
        if pressed(VK_SHIFT) {
            mods |= Modifiers::SHIFT;
        }
        if pressed(VK_CONTROL) {
            mods |= Modifiers::CONTROL;
        }
        if pressed(VK_MENU) {
            mods |= Modifiers::ALT;
        }
        if pressed(VK_LWIN) || pressed(VK_RWIN) {
            mods |= Modifiers::SUPER;
        }
        mods
    }

    /// The hook procedure.
    ///
    /// # Safety
    ///
    /// Called by Windows with the documented low-level-hook contract.
    unsafe extern "system" fn hook_proc(
        code: i32,
        wparam: usize,
        lparam: isize,
    ) -> isize {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            CallNextHookEx, HC_ACTION, MSLLHOOKSTRUCT, WM_LBUTTONDOWN, WM_MBUTTONDOWN,
            WM_RBUTTONDOWN, WM_XBUTTONDOWN, XBUTTON1, XBUTTON2,
        };

        if code == HC_ACTION as i32 {
            let message = wparam as u32;
            // We only care about the button going down; the up events
            // would fire the action a second time.
            let button = match message {
                WM_LBUTTONDOWN => Some(MouseButton::Left),
                WM_MBUTTONDOWN => Some(MouseButton::Middle),
                WM_RBUTTONDOWN => Some(MouseButton::Right),
                WM_XBUTTONDOWN => {
                    // The X buttons arrive with the button id in the
                    // high word of the mouse data.
                    let info = *(lparam as *const MSLLHOOKSTRUCT);
                    match (info.mouseData >> 16) & 0xFFFF {
                        x if x == XBUTTON1 as u32 => Some(MouseButton::Back),
                        x if x == XBUTTON2 as u32 => Some(MouseButton::Forward),
                        _ => None,
                    }
                }
                _ => None,
            };

            if let Some(button) = button {
                let mods = current_modifiers();
                // Clone the action out under the lock: the guard is
                // released at the end of this statement, so a borrow
                // out of it would dangle.
                let matched = BINDINGS
                    .lock()
                    .unwrap()
                    .iter()
                    .find(|b| b.button == button && b.modifiers == mods)
                    .map(|b| b.action.clone());

                if let Some(action) = matched {
                    let app = APP.lock().unwrap().clone();
                    if let Some(app) = app {
                        let _ = app.emit(super::EVENT, HotkeyEvent { action });
                    }
                }
            }
        }

        CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam)
    }

    /// The hook's message loop.
    ///
    /// A low-level hook is only delivered while the installing thread
    /// pumps messages, so this thread has to run a message loop for as
    /// long as the hook is installed.
    fn hook_thread(id_tx: mpsc::Sender<u32>) {
        use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
        use windows_sys::Win32::System::Threading::GetCurrentThreadId;
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            DispatchMessageW, GetMessageW, MSG, SetWindowsHookExW, TranslateMessage,
            UnhookWindowsHookEx, WH_MOUSE_LL,
        };

        unsafe {
            // The hook procedure lives in our own executable, so the
            // module handle is the one of the running process.
            let module = GetModuleHandleW(std::ptr::null());
            let hook = SetWindowsHookExW(WH_MOUSE_LL, Some(hook_proc), module, 0);
            if hook.is_null() {
                crate::log!("[hotkeys] the mouse hook could not be installed");
                let _ = id_tx.send(0);
                return;
            }

            // Only now is the hook live, so this is the point at which
            // the thread is safe to stop.
            let _ = id_tx.send(GetCurrentThreadId());

            let mut msg: MSG = std::mem::zeroed();
            loop {
                let result = GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0);
                if result <= 0 {
                    break;
                }
                if msg.message == WM_STOP_HOOK {
                    break;
                }
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }

            let _ = UnhookWindowsHookEx(hook);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn binding(action: &str, kind: &str, code: &str, mods: &[&str]) -> HotkeyBinding {
        HotkeyBinding {
            action: action.into(),
            kind: kind.into(),
            code: code.into(),
            button: String::new(),
            modifiers: mods.iter().map(|m| m.to_string()).collect(),
        }
    }

    #[test]
    fn parses_a_single_key() {
        let hotkey = parse_key_binding(&binding("toggle", "key", "KeyP", &[])).unwrap();
        assert_eq!(hotkey.key, Code::KeyP);
        assert!(hotkey.mods.is_empty());
    }

    #[test]
    fn parses_a_combination() {
        let hotkey =
            parse_key_binding(&binding("next", "key", "KeyN", &["ctrl", "shift"])).unwrap();
        assert_eq!(hotkey.key, Code::KeyN);
        assert!(hotkey.mods.contains(Modifiers::CONTROL));
        assert!(hotkey.mods.contains(Modifiers::SHIFT));
        assert!(!hotkey.mods.contains(Modifiers::ALT));
    }

    #[test]
    fn parses_the_special_keys() {
        assert_eq!(
            parse_key_binding(&binding("toggle", "key", "Space", &[]))
                .unwrap()
                .key,
            Code::Space
        );
        assert_eq!(
            parse_key_binding(&binding("toggle", "key", "Digit1", &[]))
                .unwrap()
                .key,
            Code::Digit1
        );
        assert_eq!(
            parse_key_binding(&binding("toggle", "key", "ArrowLeft", &[]))
                .unwrap()
                .key,
            Code::ArrowLeft
        );
    }

    #[test]
    fn rejects_an_unknown_key() {
        let err = parse_key_binding(&binding("toggle", "key", "NotAKey", &[])).unwrap_err();
        assert!(err.contains("unknown key"), "{err}");
    }

    #[test]
    fn maps_the_modifier_names() {
        let mods = modifiers_of(&[
            "ctrl".into(),
            "alt".into(),
            "super".into(),
            "nonsense".into(),
        ]);
        assert!(mods.contains(Modifiers::CONTROL));
        assert!(mods.contains(Modifiers::ALT));
        assert!(mods.contains(Modifiers::SUPER));
        assert!(!mods.contains(Modifiers::SHIFT));
    }

    #[cfg(windows)]
    #[test]
    fn parses_the_mouse_buttons() {
        use mouse::MouseButton;
        for (name, expected) in [
            ("left", MouseButton::Left),
            ("middle", MouseButton::Middle),
            ("right", MouseButton::Right),
            ("back", MouseButton::Back),
            ("forward", MouseButton::Forward),
        ] {
            let mut b = binding("like", "mouse", "", &[]);
            b.button = name.into();
            let parsed = mouse::parse(&b).unwrap();
            assert_eq!(parsed.button, expected);
            assert_eq!(parsed.action, "like");
        }
    }

    #[cfg(windows)]
    #[test]
    fn rejects_an_unknown_mouse_button() {
        let mut b = binding("like", "mouse", "", &[]);
        b.button = "wheel".into();
        assert!(mouse::parse(&b).is_err());
    }
}
