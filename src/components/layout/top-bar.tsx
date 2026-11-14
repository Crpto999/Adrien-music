import { useEffect, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { IconArrowLeft, IconArrowRight } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { useFullscreenStore } from "@/lib/store/fullscreen";
import { WINDOW_CHROME_ATTR } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { IS_MAC } from "@/lib/platform";
import { useT } from "@/lib/i18n";

// Caption-bar nav buttons get just an icon-color shift on hover —
// the default ghost-button square highlight competes visually with
// the Windows-style min/max/close cells on the right side of the bar.
const NAV_BTN_CLS =
  "size-7 text-foreground/65 hover:bg-transparent hover:text-foreground dark:hover:bg-transparent";

// Plain-vite dev in a regular browser has no Tauri backend —
// `getCurrentWindow()` throws on missing `__TAURI_INTERNALS__`, which
// used to crash the whole shell through the router's error boundary.
// Window controls are meaningless in a browser tab anyway.
const IS_TAURI =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * Cross-platform title bar. Windows and Linux use the frameless base config,
 * so we draw the caption controls ourselves. macOS uses native traffic lights
 * over an overlay title bar; the navigation cluster is inset around them and
 * the Windows-style controls are omitted.
 *
 * The bar only carries what belongs to a title bar: the sidebar toggle and
 * the history buttons. The app menu (settings, layout, theme, feedback,
 * about, quit) lives on the sidebar's logo instead — see `AppLogoMenu`.
 *
 * Clicking our close button still goes through the Rust
 * `WindowEvent::CloseRequested` handler, which either hides the window
 * into the tray (default) or quits, per the "Close button" choice on
 * the Settings page. The "Quit" item in the app menu always
 * terminates the process regardless of that setting.
 */
export function TopBar() {
  const t = useT();
  const router = useRouter();
  const fullscreen = useFullscreenStore((s) => s.open);
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    // macOS has no custom maximize glyph to keep in sync; native traffic
    // lights own that state entirely.
    if (!IS_TAURI || IS_MAC) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    const win = getCurrentWindow();
    win.isMaximized().then((m) => {
      if (!cancelled) setMaximized(m);
    });
    // Mirrors the cancelled-flag pattern used in audio-engine / app-shell:
    // `.onResized` is async, so its `.then` may resolve AFTER cleanup ran
    // in StrictMode's mount → unmount → remount cycle. Without the flag the
    // listener leaks twice and we get duplicated maximized-state updates.
    win
      .onResized(() => {
        win.isMaximized().then((m) => {
          if (!cancelled) setMaximized(m);
        });
      })
      .then((u) => {
        if (cancelled) u();
        else unlisten = u;
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const win = () => getCurrentWindow();

  return (
    <>
      <header
        data-tauri-drag-region
        // Above the full-screen player (z-40) so the bar's buttons stay
        // reachable there; the bar itself is transparent, so the blurred
        // cover runs up behind it.
        className={cn(
          "relative flex h-9 shrink-0 select-none items-center",
          fullscreen ? "z-[45]" : "z-30",
        )}
      >
        <div
          className={`flex items-center gap-1 ${IS_MAC ? "pl-[78px]" : "pl-2"}`}
        >
          {/* No page and no sidebar to navigate while the full-screen
              player is up, so the three go with it. */}
          {fullscreen ? null : (
            <>
              <SidebarTrigger className={NAV_BTN_CLS} />
              <Button
                variant="ghost"
                size="icon"
                className={NAV_BTN_CLS}
                onClick={() => router.history.back()}
                aria-label={t("common.back")}
              >
                <IconArrowLeft />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className={NAV_BTN_CLS}
                onClick={() => router.history.forward()}
                aria-label={t("common.forward")}
              >
                <IconArrowRight />
              </Button>
            </>
          )}
        </div>

        {/* Drag spacer — fills remaining width so the user can grab
            almost anywhere in the bar to move the window. */}
        <div data-tauri-drag-region className="h-full flex-1" />
      </header>

      {/* Keeps the window draggable by its title bar while a dialog is
          open. The overlay covers the real header, so this transparent
          strip carries the drag region above it; `titlebar-drag-shield`
          (index.css) only turns pointer events on while Radix has the
          body scroll-locked, so at rest it can't steal clicks from the
          history buttons below it. It sits under the window controls,
          which need their own clicks. */}
      <div
        {...{ [WINDOW_CHROME_ATTR]: "" }}
        data-tauri-drag-region
        aria-hidden
        className="titlebar-drag-shield fixed inset-x-0 top-0 z-[55] h-(--titlebar-h) select-none"
      />

      {/* Rendered outside <header> on purpose. A dialog overlay covers
          the title bar, but minimize / maximize / close must stay usable
          — and `z-[60]` can only clear the overlay from the root
          stacking context. The header's own `relative z-30` establishes
          one, which would trap any z-index set inside it. Also
          `pointer-events-auto`, because Radix pins `pointer-events: none`
          on the body for as long as a dialog is open.

          The header's drag spacer runs the full width underneath this
          cluster; the buttons sit on top of it, so they take the click
          rather than starting a window drag.

          macOS is excluded: its traffic lights are native chrome and no
          web overlay reaches them. */}
      {!IS_MAC && (
        <div
          {...{ [WINDOW_CHROME_ATTR]: "" }}
          className="pointer-events-auto fixed right-0 top-0 z-[60] flex h-9 items-center"
        >
          <button
            type="button"
            onClick={() => win().minimize()}
            aria-label={t("menu.minimize")}
            className="flex h-full w-11 items-center justify-center text-foreground/85 transition-colors hover:bg-titlebar-hover"
          >
            <MinimizeGlyph />
          </button>
          <button
            type="button"
            onClick={() => win().toggleMaximize()}
            aria-label={maximized ? t("menu.restore") : t("menu.maximize")}
            className="flex h-full w-11 items-center justify-center text-foreground/85 transition-colors hover:bg-titlebar-hover"
          >
            {maximized ? <RestoreGlyph /> : <MaximizeGlyph />}
          </button>
          <button
            type="button"
            onClick={() => win().close()}
            aria-label={t("common.close")}
            className="flex h-full w-11 items-center justify-center text-foreground/85 transition-colors hover:bg-[var(--close-hover)] hover:text-[var(--close-hover-fg)]"
          >
            <CloseGlyph />
          </button>
        </div>
      )}
    </>
  );
}

/* Hand-drawn 10×10 SVGs match the Windows 11 caption-button glyphs
   more faithfully than Lucide icons (which are designed at 24px and
   look chunky at this size). */

function MinimizeGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
      <path d="M0 5 H10" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

function MaximizeGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
      <rect
        x="0.5"
        y="0.5"
        width="9"
        height="9"
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
      />
    </svg>
  );
}

function RestoreGlyph() {
  // Front square is a full outlined rect; back square is drawn as a
  // L-shape (top + right edge only) so we don't have to fill the
  // front rect with the background color — important here because
  // the title bar is transparent over the blurred album art behind.
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
      <path
        d="M2.5 0.5 H9.5 V7.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
      />
      <rect
        x="0.5"
        y="2.5"
        width="7"
        height="7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
      />
    </svg>
  );
}

function CloseGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
      <path d="M0 0 L10 10 M10 0 L0 10" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}
