import { useCallback, useEffect, useRef, useState } from "react";
import {
  IconHeartFilled,
  IconKeyboardFilled,
  IconMouseFilled,
  IconPlayerPlayFilled,
  IconPlayerTrackNextFilled,
  IconRefresh,
  IconX,
} from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Group, SettingRow, TabPane } from "@/components/settings/primitives";
import { IS_WINDOWS } from "@/lib/platform";
import { useT } from "@/lib/i18n";
import {
  HOTKEY_ACTIONS,
  describeBinding,
  sameBinding,
  useHotkeysStore,
  type HotkeyAction,
  type HotkeyBinding,
  type HotkeyButton,
  type HotkeyModifier,
} from "@/lib/store/hotkeys";

/**
 * The global shortcuts tab.
 *
 * A shortcut is bound to one of three actions (play/pause, next,
 * like). Each action takes either a keyboard combination or a mouse
 * button, and the binding lives in the OS rather than in the app — which
 * is why it keeps working while adrify sits in the tray.
 *
 * The recorder captures the *next* key the user presses, so there is no
 * "type the combination into a text box" dance: click the field, press
 * the keys, and the binding is set.
 */
export function ShortcutsTab() {
  const t = useT();
  const bindings = useHotkeysStore((s) => s.bindings);
  const clearAll = useHotkeysStore((s) => s.clearAll);

  const any = HOTKEY_ACTIONS.some((action) => bindings[action]);

  return (
    <TabPane>
      <Group>
        <ShortcutRow
          action="toggle"
          settingId="shortcut-toggle"
          icon={IconPlayerPlayFilled}
          title={t("settings.shortcuts.toggle")}
          description={t("settings.shortcuts.toggleDesc")}
        />
        <ShortcutRow
          action="next"
          settingId="shortcut-next"
          icon={IconPlayerTrackNextFilled}
          title={t("settings.shortcuts.next")}
          description={t("settings.shortcuts.nextDesc")}
        />
        <ShortcutRow
          action="like"
          settingId="shortcut-like"
          icon={IconHeartFilled}
          title={t("settings.shortcuts.like")}
          description={t("settings.shortcuts.likeDesc")}
        />
      </Group>

      <div className="flex items-center gap-3 pt-4">
        <Button variant="ghost" size="sm" onClick={clearAll} disabled={!any}>
          <IconRefresh stroke={2.2} />
          {t("settings.shortcuts.resetAll")}
        </Button>
        <p className="text-[12px] leading-snug text-t7">
          {IS_WINDOWS
            ? t("settings.shortcuts.windowsHint")
            : t("settings.shortcuts.genericHint")}
        </p>
      </div>
    </TabPane>
  );
}

function ShortcutRow({
  action,
  settingId,
  icon: Icon,
  title,
  description,
}: {
  action: HotkeyAction;
  settingId: string;
  icon: typeof IconPlayerPlayFilled;
  title: string;
  description: string;
}) {
  const binding = useHotkeysStore((s) => s.bindings[action]);

  return (
    <SettingRow
      icon={Icon}
      settingId={settingId}
      title={title}
      description={description}
      control={
        <HotkeyRecorder
          action={action}
          binding={binding}
          onChange={(next) =>
            useHotkeysStore.getState().setBinding(action, next)
          }
        />
      }
    />
  );
}

/**
 * The control that captures a shortcut.
 *
 * Clicking it puts it into "recording" mode: the next key press (or
 * mouse click, when the mouse mode is picked) becomes the binding.
 * Escape cancels, Backspace clears the binding.
 *
 * While recording, the key event is swallowed so the combination does
 * not also reach the rest of the app — otherwise recording Ctrl+P would
 * trigger the app's own print shortcut.
 */
function HotkeyRecorder({
  action,
  binding,
  onChange,
}: {
  action: HotkeyAction;
  binding: HotkeyBinding | undefined;
  onChange: (binding: HotkeyBinding | null) => void;
}) {
  const t = useT();
  const bindings = useHotkeysStore((s) => s.bindings);
  const [recording, setRecording] = useState(false);
  /** Which kind of input the next press is captured from. */
  const [mode, setMode] = useState<"key" | "mouse">(
    binding?.kind === "mouse" ? "mouse" : "key",
  );
  const buttonRef = useRef<HTMLButtonElement>(null);

  const cancel = useCallback(() => {
    setRecording(false);
    buttonRef.current?.focus();
  }, []);

  // Leaving recording mode when the user clicks elsewhere: the field
  // would otherwise stay armed, and the next key the user presses would
  // silently rebind the shortcut.
  useEffect(() => {
    if (!recording) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!buttonRef.current?.contains(e.target as Node)) setRecording(false);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [recording]);

  // The capture handler. It lives on `window` in the capture phase so
  // it sees the key before any other handler can act on it.
  useEffect(() => {
    if (!recording || mode !== "key") return;

    const onKeyDown = (e: KeyboardEvent) => {
      // Escape cancels, Backspace clears. Both are handled before the
      // "any key is a binding" rule below.
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cancel();
        return;
      }
      if (e.key === "Backspace" && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        onChange(null);
        setRecording(false);
        return;
      }
      // A bare modifier is not a shortcut on its own — the user is on
      // their way to a combination.
      if (["Control", "Shift", "Alt", "Meta", "OS"].includes(e.key)) return;

      e.preventDefault();
      e.stopPropagation();

      const modifiers: HotkeyModifier[] = [];
      if (e.ctrlKey) modifiers.push("ctrl");
      if (e.shiftKey) modifiers.push("shift");
      if (e.altKey) modifiers.push("alt");
      if (e.metaKey) modifiers.push("super");

      const next: HotkeyBinding = { kind: "key", code: e.code, modifiers };

      // The same combination twice would fight over the same OS
      // registration, so the older binding is dropped in favour of the
      // new one.
      for (const [other, otherBinding] of Object.entries(bindings)) {
        if (other === action || !otherBinding) continue;
        if (sameBinding(otherBinding, next)) {
          useHotkeysStore.getState().setBinding(other as HotkeyAction, null);
        }
      }

      onChange(next);
      setRecording(false);
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [recording, mode, action, bindings, onChange, cancel]);

  // The mouse capture. Recorded through a short-lived `mousedown`
  // listener on the window, so the click that arms the recorder does
  // not also count as the binding.
  useEffect(() => {
    if (!recording || mode !== "mouse") return;

    const onMouseDown = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const button = buttonOf(e.button);
      const modifiers: HotkeyModifier[] = [];
      if (e.ctrlKey) modifiers.push("ctrl");
      if (e.shiftKey) modifiers.push("shift");
      if (e.altKey) modifiers.push("alt");
      if (e.metaKey) modifiers.push("super");

      const next: HotkeyBinding = { kind: "mouse", button, modifiers };

      for (const [other, otherBinding] of Object.entries(bindings)) {
        if (other === action || !otherBinding) continue;
        if (sameBinding(otherBinding, next)) {
          useHotkeysStore.getState().setBinding(other as HotkeyAction, null);
        }
      }

      onChange(next);
      setRecording(false);
    };

    // Arm the listener on the next tick, so the click that switched
    // to mouse mode is not itself captured.
    const id = window.setTimeout(
      () => window.addEventListener("mousedown", onMouseDown, true),
      0,
    );
    return () => {
      window.clearTimeout(id);
      window.removeEventListener("mousedown", onMouseDown, true);
    };
  }, [recording, mode, action, bindings, onChange]);

  const summary = describeBinding(binding);

  return (
    <div className="flex w-[300px] items-center justify-end gap-2">
      {/* Which kind of input the recorder captures. */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-[10px] border border-w090 bg-w040 px-2.5 text-[12.5px] text-t3 transition-colors duration-[140ms] hover:bg-w070 data-[state=open]:border-w200"
            aria-label={t("settings.shortcuts.inputType")}
          >
            {mode === "key" ? (
              <IconKeyboardFilled className="size-3.5" />
            ) : (
              <IconMouseFilled className="size-3.5" />
            )}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-[184px]">
          <DropdownMenuItem onSelect={() => setMode("key")}>
            <IconKeyboardFilled className="size-4" />
            {t("settings.shortcuts.keyboard")}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => setMode("mouse")}
            // Mouse-button shortcuts need the Windows low-level hook —
            // there is no equivalent on macOS or Linux.
            disabled={!IS_WINDOWS}
          >
            <IconMouseFilled className="size-4" />
            {t("settings.shortcuts.mouse")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* The recorded shortcut itself. */}
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setRecording((r) => !r)}
        onKeyDown={(e) => {
          // The recorder's own key handling is on the window, but the
          // button must not also act as a button (Space would "click"
          // it and toggle the recording state).
          if (recording) e.preventDefault();
        }}
        className={[
          "flex h-8 min-w-0 flex-1 cursor-pointer items-center justify-between gap-2 rounded-[10px] border px-3 text-[13px] transition-colors duration-[140ms]",
          recording
            ? "border-w200 bg-w070 text-t1"
            : "border-w090 bg-w040 text-t2 hover:bg-w070",
        ].join(" ")}
        aria-label={t("settings.shortcuts.record")}
      >
        <span className="min-w-0 flex-1 truncate text-start">
          {recording
            ? t("settings.shortcuts.recording")
            : summary || t("settings.shortcuts.unbound")}
        </span>
        {binding && !recording ? (
          <span
            role="button"
            tabIndex={-1}
            onClick={(e) => {
              e.stopPropagation();
              onChange(null);
            }}
            className="grid size-4 shrink-0 place-items-center rounded text-t6 transition-colors hover:text-t1"
            aria-label={t("settings.shortcuts.clear")}
          >
            <IconX className="size-3.5" />
          </span>
        ) : null}
      </button>
    </div>
  );
}

/** The mouse button a `mousedown` event came from. */
function buttonOf(button: number): HotkeyButton {
  switch (button) {
    case 0:
      return "left";
    case 1:
      return "middle";
    case 2:
      return "right";
    case 3:
      return "back";
    case 4:
      return "forward";
    default:
      return "left";
  }
}
