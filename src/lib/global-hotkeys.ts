import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { queryClient } from "@/lib/query-client";
import { toggleLiked } from "@/lib/like-actions";
import { getLikedIdsSet } from "@/components/shared/like-buttons";
import type { ShelfItem } from "@/lib/innertube/types";
import { usePlaybackStore } from "@/lib/store/playback";
import {
  useHotkeysStore,
  type HotkeyAction,
  type HotkeyBinding,
} from "@/lib/store/hotkeys";
import { translate } from "@/lib/i18n";

/** The event the Rust side emits when a global shortcut fires. */
const EVENT = "global-hotkey";

/**
 * The payload the Rust side sends with the event.
 *
 * The action is the one the shortcut was bound to — Rust keeps the
 * action→id map, because the OS only tells us which key was pressed.
 */
type HotkeyEvent = { action: HotkeyAction };

/** The shape the Rust command expects. */
type RustBinding = {
  action: string;
  kind: string;
  code: string;
  button: string;
  modifiers: string[];
};

/**
 * Turn the stored bindings into the flat list the backend registers.
 *
 * The backend takes the complete set every time, so this is the whole
 * map rather than a diff — the backend replaces its registrations in
 * one go, which keeps "unbind X and bind Y" atomic.
 */
export function toRustBindings(
  bindings: Partial<Record<HotkeyAction, HotkeyBinding>>,
): RustBinding[] {
  const out: RustBinding[] = [];
  for (const [action, binding] of Object.entries(bindings)) {
    if (!binding) continue;
    out.push({
      action,
      kind: binding.kind,
      code: binding.kind === "key" ? (binding.code ?? "") : "",
      button: binding.kind === "mouse" ? (binding.button ?? "") : "",
      modifiers: binding.modifiers,
    });
  }
  return out;
}

/**
 * Push the user's shortcuts to the backend.
 *
 * Mounted once in AppShell: the OS registrations have to be re-made on
 * every launch (they do not survive the process), so this runs right
 * after startup and again whenever the user changes a binding.
 *
 * The backend answers with the bindings it could *not* register — a
 * key another app already owns, say. Those are surfaced as a toast, so
 * a shortcut that silently does nothing is not possible.
 */
export function useGlobalHotkeysSync(): void {
  const bindings = useHotkeysStore((s) => s.bindings);

  useEffect(() => {
    let cancelled = false;
    void invoke<RustBinding[] | null>("set_global_hotkeys", {
      bindings: toRustBindings(bindings),
    })
      .then((errors) => {
        if (cancelled) return;
        if (errors && errors.length) {
          toast.error(translate("settings.shortcuts.registerFailed"), {
            description: errors.join("\n"),
          });
        }
      })
      .catch(() => {
        // A plain-vite dev server has no Tauri backend; nothing to
        // register and nothing to report.
      });
    return () => {
      cancelled = true;
    };
  }, [bindings]);
}

/**
 * React to a fired global shortcut.
 *
 * Mounted once in AppShell. The action drives the same store the
 * taskbar toolbar and the OS media keys drive, so a global shortcut
 * behaves exactly like the button it mirrors.
 */
export function useGlobalHotkeysListener(): void {
  useEffect(() => {
    let cancelled = false;
    let dispose: (() => void) | undefined;

    void listen<HotkeyEvent>(EVENT, (e) => {
      const action = e.payload?.action;
      if (!action) return;
      runAction(action);
    })
      .then((un) => {
        if (cancelled) un();
        else dispose = un;
      })
      .catch(() => {
        // No Tauri backend (plain-vite dev) — nothing to listen to.
      });

    return () => {
      cancelled = true;
      dispose?.();
    };
  }, []);
}

/**
 * Carry out a shortcut's action.
 *
 * Shared by the global shortcut and (in spirit) the taskbar toolbar:
 * "toggle" flips playback, "next" skips ahead, "like" hearts the
 * current track.
 */
export function runAction(action: HotkeyAction): void {
  const store = usePlaybackStore.getState();
  switch (action) {
    case "toggle":
      store.toggle();
      break;
    case "next":
      store.next();
      break;
    case "like": {
      const track = store.index >= 0 ? store.queue[store.index] : undefined;
      if (!track) break;
      // Read the liked state at click time rather than closing over it,
      // so this stays correct for whichever track is playing.
      const cached = queryClient.getQueryData<ShelfItem[]>(["liked-songs"]);
      void toggleLiked({
        queryClient,
        videoId: track.videoId,
        wasLiked: getLikedIdsSet(cached).has(track.videoId),
        track,
      }).catch((err) => toast.error(String(err)));
      break;
    }
  }
}
