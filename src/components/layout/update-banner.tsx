import {
  IconAlertTriangle,
  IconArrowDown,
  IconRefresh,
  type IconProps,
} from "@tabler/icons-react";
import type { ComponentType } from "react";
import { useUpdateStore } from "@/lib/store/update";
import { downloadAvailableUpdate, restartToUpdate } from "@/lib/updater";
import {
  RELEASES_URL,
  systemUpdateGuidance,
  useUpdateSource,
} from "@/lib/update-source";
import { copyToClipboard } from "@/lib/clipboard";
import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";

type CardConfig = {
  icon: ComponentType<IconProps>;
  /** Glyph size inside the tile; the two arrows are drawn at different weights. */
  iconClass: string;
  titleKey: string;
  subKey?: string;
  onClick?: () => void;
};

/**
 * Sits in the sidebar footer, just above Settings, and is the one
 * persistent surface for an update. The download itself runs quietly
 * in the background (see updater.ts), so the card stays hidden until
 * there is something to act on: ready -> click restarts into the new
 * version; error -> click retries the download. The brief installing
 * moment after the click is inert and shows a full progress ring.
 *
 * Deliberately carries no accent at rest: the card reads as a normal
 * sidebar row one step lighter than the panel, and the only accent in
 * the whole thing is the progress arc. A tinted card and a linear bar
 * along the bottom edge were both tried and dropped — the bar gets
 * clipped by the radius, and the tint made a routine notice shout.
 */
export function UpdateBanner() {
  const t = useT();
  const phase = useUpdateStore((s) => s.phase);
  const version = useUpdateStore((s) => s.version);
  const { data: updateSource } = useUpdateSource();
  const systemGuidance =
    updateSource?.kind === "system"
      ? systemUpdateGuidance(updateSource.manager, updateSource.helper)
      : null;

  // System installs never download, so "available" is the only phase
  // that needs a nudge there — and it points at the package manager,
  // not a restart. Everywhere else the download stays silent and
  // About owns the parked version.
  if (systemGuidance) {
    if (phase === "idle") return null;
    return (
      <button
        type="button"
        onClick={() => {
          if (systemGuidance.command !== undefined) {
            void copyToClipboard(systemGuidance.command).then((ok) => {
              if (ok) toast.success(t("update.commandCopied"));
              else toast.error(t("update.couldNotCopyCommand"));
            });
          } else {
            void openUrl(RELEASES_URL);
          }
        }}
        title={
          version
            ? t("update.versionAvailableVia", {
                version,
                channel: t(systemGuidance.channelLabelKey),
              })
            : t("update.availableVia", {
                channel: t(systemGuidance.channelLabelKey),
              })
        }
        aria-label={t("update.available")}
        className={cn(
          "group/upd flex w-full items-center gap-[9px] rounded-[11px] border border-w080 bg-w050 px-[9px] py-2 text-left",
          "shadow-[inset_0_1px_0_var(--w060)] enabled:cursor-pointer enabled:hover:bg-w090 disabled:cursor-default",
          "transition-[padding,border-width,border-color,border-radius,background-color,box-shadow] duration-[220ms] ease-[cubic-bezier(.32,.72,0,1)]",
          "group-data-[collapsible=icon]:rounded-[9px] group-data-[collapsible=icon]:border-0",
          "group-data-[collapsible=icon]:bg-transparent group-data-[collapsible=icon]:p-0",
          "group-data-[collapsible=icon]:shadow-none group-data-[collapsible=icon]:hover:bg-transparent",
          // On the rail the tile is the whole control, so it has to sit
          // on the rail's axis like every nav glyph above it. The label
          // column gives up its width (and the gap with it), leaving the
          // tile alone in the row to centre itself.
          "group-data-[collapsible=icon]:gap-0 group-data-[collapsible=icon]:justify-center",
        )}
      >
        <span className="relative grid w-[26px] shrink-0 place-items-center transition-[width] duration-[220ms] ease-[cubic-bezier(.32,.72,0,1)] group-data-[collapsible=icon]:w-9">
          <span className="grid size-[26px] place-items-center rounded-md bg-w070 text-t3 shadow-[inset_0_0_0_1px_var(--w080)] transition-[width,height,border-radius,background-color,color] duration-[220ms] ease-[cubic-bezier(.32,.72,0,1)] group-data-[collapsible=icon]:h-7 group-data-[collapsible=icon]:w-9 group-data-[collapsible=icon]:group-hover/upd:bg-w110">
            <IconRefresh className="size-[15px]" />
          </span>
        </span>
        <span data-sidebar-label className="flex min-w-0 flex-1 flex-col gap-px group-data-[collapsible=icon]:w-0 group-data-[collapsible=icon]:flex-none">
          <span className="truncate text-[12.5px] font-semibold leading-tight tracking-[-0.005em] text-t1">
            {t("update.available")}
          </span>
          <span className="truncate text-[10.5px] font-medium leading-tight text-t5">
            {systemGuidance.channel === "AUR"
              ? t("update.viaAur")
              : t("update.viaPackageManager")}          </span>
        </span>
      </button>
    );
  }

  // Nothing to show before the package has landed: the download is
  // deliberately silent, and with auto-update off the found version is
  // About's business, not a sidebar nag.
  if (phase === "idle" || phase === "available" || phase === "downloading") {
    return null;
  }

  const busy = phase === "installing";
  // `installing` has no progress of its own, it's the moment between
  // the click and the process handing over to the installer, so it
  // keeps the ring and pins it full.
  const pct = 100;

  const cfg: CardConfig = {
    installing: {
      icon: IconArrowDown,
      iconClass: "size-[13px]",
      titleKey: "update.installing",
      subKey: "update.restarting",
    },
    ready: {
      icon: IconRefresh,
      iconClass: "size-[15px]",
      titleKey: "update.restartToUpdate",
      subKey: version
        ? "update.versionReady"
        : "update.readyToInstall",
      onClick: () => void restartToUpdate(),
    },
    error: {
      icon: IconAlertTriangle,
      iconClass: "size-[15px]",
      titleKey: "update.failed",
      subKey: "update.clickToRetry",
      onClick: () => void downloadAvailableUpdate(),
    },
  }[phase];

  const Icon = cfg.icon;
  const title = t(cfg.titleKey);
  const sub = cfg.subKey
    ? t(cfg.subKey, version ? { version } : undefined)
    : undefined;
  const label = sub ? `${title} · ${sub}` : title;

  return (
    <button
      type="button"
      onClick={cfg.onClick}
      disabled={!cfg.onClick}
      // Collapsed, the label is gone, so the state has to survive in the
      // native tooltip.
      title={label}
      aria-label={title}
      className={cn(
        "group/upd flex w-full items-center gap-[9px] rounded-[11px] border border-w080 bg-w050 px-[9px] py-2 text-left",
        "shadow-[inset_0_1px_0_var(--w060)] enabled:cursor-pointer enabled:hover:bg-w090 disabled:cursor-default",
        // Everything that separates the card from the rail's bare tile
        // is a value the browser can interpolate, so the chrome dissolves
        // over the same 220ms the panel takes rather than snapping off on
        // the first frame. The text column keeps its slot and simply
        // fades (see `data-sidebar-label` in index.css); `flex-1` with
        // `min-w-0` squeezes it to nothing as the panel narrows.
        "transition-[padding,border-width,border-color,border-radius,background-color,box-shadow] duration-[220ms] ease-[cubic-bezier(.32,.72,0,1)]",
        // On the rail the card's own chrome drops away and the tile
        // becomes the whole control — it keeps its fill and ring so the
        // update still stands out among the flat nav rows. Hover moves
        // onto the tile with it, since an opaque tile would hide any
        // wash painted behind it. Border and padding go to zero so the
        // tile is the card: it then covers exactly the same 36x28 as a
        // nav row's hover pill, instead of a smaller square inset inside
        // one.
        "group-data-[collapsible=icon]:rounded-[9px] group-data-[collapsible=icon]:border-0",
        "group-data-[collapsible=icon]:bg-transparent group-data-[collapsible=icon]:p-0",
        "group-data-[collapsible=icon]:shadow-none group-data-[collapsible=icon]:hover:bg-transparent",
        // Same as the system card above: on the rail the tile is the
        // whole control, so it centres on the rail's axis and the label
        // column gives up its width and the gap with it.
        "group-data-[collapsible=icon]:gap-0 group-data-[collapsible=icon]:justify-center",
      )}
    >
      <span
        // A fixed box the width of the control, so whatever the tile is
        // doing inside it — full-width pill at rest, square while the
        // ring is up — stays centred. Without it the tile is just the
        // first flex item and a narrower one sits flush left.
        className={cn(
          "relative grid w-[26px] shrink-0 place-items-center",
          "transition-[width] duration-[220ms] ease-[cubic-bezier(.32,.72,0,1)]",
          "group-data-[collapsible=icon]:w-9",
        )}
        role={busy ? "progressbar" : undefined}
        aria-valuenow={busy ? pct : undefined}
        aria-valuemin={busy ? 0 : undefined}
        aria-valuemax={busy ? 100 : undefined}
      >
        <span
          className={cn(
            "grid size-[26px] place-items-center rounded-md bg-w070 text-t3 shadow-[inset_0_0_0_1px_var(--w080)]",
            "transition-[width,height,border-radius,background-color,color] duration-[220ms] ease-[cubic-bezier(.32,.72,0,1)]",
            // The ring is round, so the tile under it goes round too
            // while the ring is up.
            busy && "rounded-full",
            // On the rail the tile takes a nav row's footprint exactly,
            // so hovering it lights the same shape as hovering any row
            // above it. While the ring is up it pulls back to a square
            // for the ring to circle — the size is transitioned, so that
            // is a glide, and it only happens while progress is showing.
            "group-data-[collapsible=icon]:h-7 group-data-[collapsible=icon]:w-9",
            busy && "group-data-[collapsible=icon]:size-7",
            "group-data-[collapsible=icon]:group-hover/upd:bg-w110",
          )}
        >
          <Icon className={cn(cfg.iconClass, phase === "error" && "text-status-error")} />
        </span>
        {busy ? (
          // A 2px arc 4px out from the tile: a conic gradient masked down
          // to a ring. Sized and centred rather than inset from the tile's
          // edges, so it stays a circle even when the tile under it is a
          // wider pill. No transition on the gradient — only `pct` moves,
          // and animating a conic stop just smears it.
          <span
            aria-hidden
            className="pointer-events-none absolute left-1/2 top-1/2 size-[34px] -translate-x-1/2 -translate-y-1/2 rounded-full group-data-[collapsible=icon]:size-9"
            style={{
              background: `conic-gradient(var(--acc1) ${pct}%, var(--w110) 0)`,
              mask: RING_MASK,
              WebkitMask: RING_MASK,
            }}
          />
        ) : null}
      </span>

      <span data-sidebar-label className="flex min-w-0 flex-1 flex-col gap-px group-data-[collapsible=icon]:w-0 group-data-[collapsible=icon]:flex-none">
        <span className="truncate text-[12.5px] font-semibold leading-tight tracking-[-0.005em] text-t1">
          {title}
        </span>
        {sub ? (
          <span className="truncate text-[10.5px] font-medium leading-tight text-t5">
            {sub}
          </span>
        ) : null}
      </span>
    </button>
  );
}

const RING_MASK =
  "radial-gradient(farthest-side, transparent calc(100% - 2.5px), #000 calc(100% - 2px))";
