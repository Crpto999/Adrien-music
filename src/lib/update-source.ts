import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { IS_LINUX } from "@/lib/platform";

/**
 * Where updates come from for this install. Decided once by the Rust
 * `update_source` command (it can see the executable path and the
 * `APPIMAGE` env; the webview cannot):
 *
 * - `inApp` — the Tauri updater owns the files (Windows NSIS, macOS
 *   dmg, Linux AppImage, dev builds): check, background-download and
 *   restart-to-install all apply.
 * - `system` — a system package manager owns the files (AUR/pacman, a
 *   manually installed .deb/.rpm): the app must never download over
 *   them. It still checks the release manifest so it can *notify*,
 *   but the action is manager guidance instead of Download/Restart.
 */
export type UpdateManager = "aur" | "apt" | "dnf" | "unknown";

export type UpdateSource = {
  kind: "inApp" | "system";
  /** Meaningful only when kind === "system". */
  manager: UpdateManager;
  /** AUR helper binary ("paru" | "yay" | "pikaur"), "" otherwise. */
  helper: string;
};

export const AUR_URL = "https://aur.archlinux.org/packages/ytubic";
export const RELEASES_URL =
  "https://github.com/ameenalasady/YTubic/releases";
/** Refresh command for the given helper; unknown helpers fall back. */
export function aurUpdateCmd(helper: string): string {
  const h =
    helper === "paru" || helper === "yay" || helper === "pikaur"
      ? helper
      : "yay";
  return `${h} -Syu ytubic`;
}

const IN_APP: UpdateSource = { kind: "inApp", manager: "unknown", helper: "" };

export function normalizeManager(manager: unknown): UpdateManager {
  return manager === "aur" ||
    manager === "apt" ||
    manager === "dnf" ||
    manager === "unknown"
    ? manager
    : "unknown";
}

let cached: Promise<UpdateSource> | null = null;

/** One IPC round-trip per session; non-Linux short-circuits with no IPC. */
export function fetchUpdateSource(): Promise<UpdateSource> {
  if (!cached) {
    cached = (async () => {
      if (!IS_LINUX) return IN_APP;
      try {
        const src = await invoke<UpdateSource>("update_source");
        if (src?.kind === "system") {
          const manager = normalizeManager(src.manager);
          return {
            kind: "system",
            manager,
            helper: manager === "aur" && typeof src.helper === "string" ? src.helper : "",
          };
        }
        return IN_APP;
      } catch {
        // Browser preview / invoke unavailable: behave like a portable
        // build (the dev updater mock covers the UI flow anyway).
        return IN_APP;
      }
    })();
  }
  return cached;
}

export function useUpdateSource() {
  return useQuery({
    queryKey: ["update-source"],
    queryFn: fetchUpdateSource,
    staleTime: Infinity,
    retry: false,
  });
}

export type SystemUpdateGuidance = {
  /** Short channel label: "AUR", "package manager". */
  channel: string;
  /**
   * i18n key for the channel label, so the label reads in the app's
   * language ("package manager" → "系统包管理器").
   */
  channelLabelKey: string;
  /** One-line explanation for the About footer / banner sub. */
  blurb: string;
  /** i18n key for the one-line explanation. */
  blurbKey: string;
  /** Action button label. */
  actionLabel: string;
  /** i18n key for the action button label. */
  actionLabelKey: string;
  /** Set for AUR (copied); otherwise the Releases page is opened. */
  command?: string;
};

/**
 * Pure mapping from install manager to user-facing guidance. Unit
 * tested; the only copy in the app that names update channels, so the
 * Settings toggle, About footer and sidebar banner can never disagree.
 */
export function systemUpdateGuidance(
  manager: UpdateManager,
  helper = "",
): SystemUpdateGuidance {
  if (manager === "aur") {
    const command = aurUpdateCmd(helper);
    return {
      channel: "AUR",
      channelLabelKey: "update.channelAur",
      blurb: `Installed via the AUR — refresh it with ${command}.`,
      blurbKey: "update.blurbAur",
      actionLabel: "Copy command",
      actionLabelKey: "update.copyCommand",
      command,
    };
  }
  return {
    channel: "package manager",
    channelLabelKey: "update.channelPackageManager",
    blurb: "Installed as a system package — grab the new release below.",
    blurbKey: "update.blurbPackage",
    actionLabel: "Releases",
    actionLabelKey: "update.releases",
  };
}
