import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * The three actions a global shortcut can be bound to.
 *
 * They mirror the actions the taskbar thumbnail toolbar and the OS
 * media keys already drive (see `src-tauri/src/thumbbar.rs` and
 * `src-tauri/src/media.rs`), so a global shortcut behaves exactly like
 * the button it mirrors.
 */
export type HotkeyAction = "toggle" | "next" | "like";

/** The actions, in the order the settings tab lists them. */
export const HOTKEY_ACTIONS: HotkeyAction[] = ["toggle", "next", "like"];

/** Modifier keys a shortcut can be built from. */
export type HotkeyModifier = "ctrl" | "shift" | "alt" | "super";

/** The modifier keys, in the order they are shown in the UI. */
export const HOTKEY_MODIFIERS: HotkeyModifier[] = [
  "ctrl",
  "shift",
  "alt",
  "super",
];

/** The mouse buttons a shortcut can be bound to. */
export type HotkeyButton = "left" | "middle" | "right" | "back" | "forward";

/** The mouse buttons, in the order they are offered in the UI. */
export const HOTKEY_BUTTONS: HotkeyButton[] = [
  "left",
  "middle",
  "right",
  "back",
  "forward",
];

/**
 * One binding.
 *
 * A binding is either a keyboard one (`kind: "key"`, with a `code` and
 * a set of `modifiers`) or a mouse one (`kind: "mouse"`, with a
 * `button` and a set of `modifiers`).
 *
 * The `code` is the physical key as the DOM reports it (`"KeyP"`,
 * `"Space"`, `"ArrowLeft"`, …), which is also what the `global-hotkey`
 * crate's `keyboard-types::Code` parses — so the frontend and the
 * backend speak the same names without a translation table.
 */
export type HotkeyBinding = {
  kind: "key" | "mouse";
  /** Physical key name, e.g. `KeyP`. Only for `kind: "key"`. */
  code?: string;
  /** Mouse button name. Only for `kind: "mouse"`. */
  button?: HotkeyButton;
  modifiers: HotkeyModifier[];
};

/** The bindings, one per action. An action with no binding is unbound. */
export type HotkeyMap = Partial<Record<HotkeyAction, HotkeyBinding>>;

type State = {
  bindings: HotkeyMap;
  /** Bind (or unbind, with `null`) an action's shortcut. */
  setBinding: (action: HotkeyAction, binding: HotkeyBinding | null) => void;
  /** Drop every binding — the "reset" button. */
  clearAll: () => void;
};

/**
 * The user's global shortcuts.
 *
 * Persisted in localStorage like the other preference stores. Rust
 * cannot read them: the OS-level registration has to be redone on
 * every launch, so the frontend pushes the whole map over IPC whenever
 * it changes (see `lib/global-hotkeys.ts`).
 */
export const useHotkeysStore = create<State>()(
  persist(
    (set) => ({
      bindings: {},
      setBinding: (action, binding) =>
        set((state) => {
          const bindings = { ...state.bindings };
          if (binding) bindings[action] = binding;
          else delete bindings[action];
          return { bindings };
        }),
      clearAll: () => set({ bindings: {} }),
    }),
    { name: "ytm-hotkeys" },
  ),
);

/**
 * Whether two bindings would fire on the same physical input.
 *
 * Two shortcuts that match the same key *and* the same modifiers are
 * the same shortcut — registering the second one would fail (the OS
 * gives the key to the first). This is what the settings tab checks
 * before letting the user bind a duplicate.
 */
export function sameBinding(a: HotkeyBinding, b: HotkeyBinding): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "key") return a.code === b.code && sameModifiers(a.modifiers, b.modifiers);
  return a.button === b.button && sameModifiers(a.modifiers, b.modifiers);
}

function sameModifiers(a: HotkeyModifier[], b: HotkeyModifier[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((m) => b.includes(m));
}

/**
 * A human-readable rendering of a binding, e.g. `Ctrl + Shift + P`.
 *
 * Used for the summary under each row in the settings tab.
 */
export function describeBinding(binding: HotkeyBinding | undefined): string {
  if (!binding) return "";
  const parts: string[] = [];
  for (const modifier of HOTKEY_MODIFIERS) {
    if (binding.modifiers.includes(modifier)) parts.push(labelOf(modifier));
  }
  if (binding.kind === "key") parts.push(keyLabel(binding.code ?? ""));
  else parts.push(buttonLabel(binding.button));
  return parts.join(" + ");
}

/** The display name of a modifier. */
export function labelOf(modifier: HotkeyModifier): string {
  switch (modifier) {
    case "ctrl":
      return "Ctrl";
    case "shift":
      return "Shift";
    case "alt":
      return "Alt";
    case "super":
      return "Win";
  }
}

/** The display name of a mouse button. */
export function buttonLabel(button: HotkeyButton | undefined): string {
  switch (button) {
    case "left":
      return "Left Button";
    case "middle":
      return "Middle Button";
    case "right":
      return "Right Button";
    case "back":
      return "Back Button";
    case "forward":
      return "Forward Button";
    default:
      return "Mouse";
  }
}

/**
 * The display name of a physical key.
 *
 * `keyboard-types::Code` names — the same names the backend parses —
 * turned into something readable: `KeyP` becomes `P`, `Digit1` becomes
 * `1`, `ArrowLeft` becomes `←`.
 */
export function keyLabel(code: string): string {
  if (!code) return "";
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  switch (code) {
    case "Space":
      return "Space";
    case "Escape":
      return "Esc";
    case "Enter":
      return "Enter";
    case "Backspace":
      return "Backspace";
    case "Tab":
      return "Tab";
    case "CapsLock":
      return "Caps Lock";
    case "Delete":
      return "Del";
    case "Insert":
      return "Ins";
    case "PageUp":
      return "PgUp";
    case "PageDown":
      return "PgDn";
    case "ArrowLeft":
      return "←";
    case "ArrowRight":
      return "→";
    case "ArrowUp":
      return "↑";
    case "ArrowDown":
      return "↓";
    default:
      return code;
  }
}
