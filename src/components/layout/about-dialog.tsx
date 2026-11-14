import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  IconCheck,
  IconLoader2,
  IconX,
} from "@tabler/icons-react";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  frostedDialogOverlay,
  frostedDialogPanel,
} from "@/components/ui/dialog";
import {
  checkForUpdates,
  downloadAvailableUpdate,
  restartToUpdate,
} from "@/lib/updater";
import { useUpdateStore } from "@/lib/store/update";
import { IS_BETA_PLATFORM, IS_MAC } from "@/lib/platform";
import { DiscordIcon, GithubIcon } from "@/components/shared/brand-icons";
import { AppLogo } from "@/components/shared/app-logo";
import { copyToClipboard } from "@/lib/clipboard";
import { toast } from "sonner";
import {
  RELEASES_URL,
  systemUpdateGuidance,
  useUpdateSource,
} from "@/lib/update-source";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";

const REPO_URL = "https://github.com/Crpto999/Adrien-music";
// Fork note: use this fork's Discord (README badge) rather than upstream's.
// Upstream's X + Donate links from e746966 are intentionally skipped — they
// are the upstream author's personal links, not relevant to this fork.
const DISCORD_URL = "https://discord.gg/v7JGAWWWj";

// Rendered column-first into a 4-row grid, so this order reads down the
// left column and then down the right one.
const CREDITS: { name: string; roleKey: string; url: string }[] = [
  { name: "Tauri", roleKey: "about.credit.appShell", url: "https://tauri.app" },
  {
    name: "TanStack",
    roleKey: "about.credit.routerQuery",
    url: "https://tanstack.com",
  },
  {
    name: "shadcn/ui",
    roleKey: "about.credit.components",
    url: "https://ui.shadcn.com",
  },
  {
    name: "yt-dlp",
    roleKey: "about.credit.audioStreaming",
    url: "https://github.com/yt-dlp/yt-dlp",
  },
  {
    name: "LRCLIB",
    roleKey: "about.credit.syncedLyrics",
    url: "https://lrclib.net",
  },
  {
    name: "YouTube Music",
    roleKey: "about.credit.syncedLyrics",
    url: "https://music.youtube.com",
  },
  { name: "Genius", roleKey: "about.credit.lyrics", url: "https://genius.com" },
  {
    name: "Musixmatch",
    roleKey: "about.credit.lyrics",
    url: "https://www.musixmatch.com",
  },
];

// Footer icon button — 38px, 10px radius, on the design's `--w060` fill.
const FOOTER_BTN =
  "grid size-9 place-items-center rounded-[10px] border border-w120 bg-w060 " +
  "text-t3 transition-colors duration-[140ms] hover:bg-w120 hover:text-t1 " +
  "cursor-pointer [&_svg]:size-4";

export function AboutDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const t = useT();
  const [version, setVersion] = useState<string>("");
  const [checking, setChecking] = useState(false);
  const phase = useUpdateStore((s) => s.phase);
  const nextVersion = useUpdateStore((s) => s.version);

  useEffect(() => {
    if (!open) return;
    getVersion()
      .then(setVersion)
      .catch(() => setVersion(""));
  }, [open]);

  // The design replaces the old "Check for updates" button with a
  // footer status line, so opening the dialog is what runs the check.
  // Silent: the store drives the status line, and a toast on top of it
  // would say the same thing twice.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setChecking(true);
    void checkForUpdates({ silent: true }).finally(() => {
      if (!cancelled) setChecking(false);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const link = (url: string) => () => {
    void openUrl(url);
  };

  // The download runs quietly, so the footer narrates it rather than
  // asking for it: a version is coming, it's ready, or it failed.
  // System installs (AUR, .deb/.rpm) never download — any non-idle phase
  // there means "a release exists", and the action is the manager
  // guidance instead of Download/Restart.
  const { data: updateSource } = useUpdateSource();
  const systemGuidance =
    updateSource?.kind === "system"
      ? systemUpdateGuidance(updateSource.manager, updateSource.helper)
      : null;
  const copyUpdateCommand = (command: string) => () => {
    void copyToClipboard(command).then((ok) => {
      if (ok) toast.success(t("update.commandCopied"));
      else toast.error(t("update.couldNotCopyCommand"));
    });
  };
  const updateLine =
    systemGuidance && phase !== "idle"
      ? {
          text: nextVersion
                ? t("update.versionAvailableVia", {
                version: nextVersion,
                channel: t(systemGuidance.channelLabelKey),
              })
            : t("update.availableVia", {
                channel: t(systemGuidance.channelLabelKey),
              }),
          action: t(systemGuidance.actionLabelKey),
          onClick:
            systemGuidance.command !== undefined
              ? copyUpdateCommand(systemGuidance.command)
              : link(RELEASES_URL),
        }
      : phase === "ready"
        ? {
            text: nextVersion
              ? t("update.versionReady", { version: nextVersion })
              : t("update.ready"),
            action: t("update.restart"),
            onClick: () => void restartToUpdate(),
          }
        : phase === "available"
          ? {
              text: nextVersion
                ? t("update.versionAvailable", { version: nextVersion })
                : t("update.available"),
              action: t("update.download"),
              onClick: () => void downloadAvailableUpdate(),
            }
          : phase === "error"
            ? {
                text: t("update.failed"),
                action: t("update.retry"),
                onClick: () => void downloadAvailableUpdate(),
              }
            : phase === "installing"
              ? { text: t("update.restartingToUpdate") }
              : phase === "downloading"
                ? {
                    text: nextVersion
                      ? t("update.downloadingVersion", { version: nextVersion })
                      : t("update.downloading"),
                  }
                : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className={cn(
          "max-w-[560px] gap-0 overflow-hidden rounded-2xl p-0 shadow-[0_30px_70px_-20px_var(--k850)] sm:max-w-[560px]",
          frostedDialogPanel,
        )}
        overlayClassName={frostedDialogOverlay}
      >
        {/* Catch-light along the top edge, per the design. Inset by 1px
            on each side so it stops at the border rather than over it. */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-px top-0 h-px bg-[linear-gradient(90deg,transparent,var(--w160),transparent)]"
        />
        <DialogClose className="absolute right-4 top-4 z-[2] grid size-7 cursor-pointer place-items-center rounded-lg border border-w070 bg-w030 text-t6 transition-colors duration-[140ms] hover:bg-w080 hover:text-t2">
          <IconX className="size-3" />
          <span className="sr-only">{t("common.close")}</span>
        </DialogClose>

        <div className="flex flex-col gap-4 px-7 pb-0 pt-7">
          {/* Right padding clears the close button. */}
          <div className="flex items-center gap-4 pr-[34px]">
            <AppLogo
              // The mark is a letterform, not a disc, so the old
              // `rounded-full` + circular glow would have cropped it into
              // a circle. The glow now follows the mark's own box.
              className="size-14 shrink-0 object-contain drop-shadow-[0_6px_18px_-6px_rgba(var(--acc1rgb),0.45)]"
            />
            <div className="flex min-w-0 flex-col gap-[9px]">
              <DialogTitle className="text-[23px] font-bold leading-none tracking-[-0.02em] text-t1">
                adrify
              </DialogTitle>
              <div className="flex items-center gap-2">
                <span className="text-[13px] text-t5">
                  {version ? t("about.version", { version }) : " "}
                  {version && IS_BETA_PLATFORM
                    ? ` · ${t("about.betaFor", {
                        platform: IS_MAC ? "macOS" : "Linux",
                      })}`
                    : ""}
                </span>
              </div>
            </div>
          </div>

          <DialogDescription className="text-[13.5px] leading-[1.55] text-t4 text-pretty">
            {t("about.description")}
          </DialogDescription>

          {IS_BETA_PLATFORM && (
            <p className="text-[13.5px] leading-[1.55] text-t4 text-pretty">
              {t("about.betaNotice", {
                platform: IS_MAC ? "macOS" : "Linux",
              })}{" "}
              <button
                type="button"
                onClick={link(`${REPO_URL}/issues`)}
                className="cursor-pointer underline underline-offset-2 hover:text-t2"
              >
                GitHub
              </button>
              .
            </p>
          )}

          <div className="mt-1 flex flex-col gap-3 rounded-xl border border-w075 bg-w028 px-5 py-4">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[10.5px] font-semibold uppercase tracking-[0.09em] text-t5">
                {t("about.poweredBy")}
              </span>
              <span className="text-xs text-t6">
                {t("about.freeSoftware")}{" "}
                <button
                  type="button"
                  onClick={link(`${REPO_URL}/blob/main/LICENSE`)}
                  className="cursor-pointer text-t4 underline underline-offset-2 hover:text-t2"
                >
                  GPL-3.0
                </button>
              </span>
            </div>
            {/* Column-first so the list reads down each column rather
                than across the pair. */}
            <ul className="grid grid-flow-col grid-cols-2 grid-rows-4 gap-x-6 gap-y-[9px]">
              {CREDITS.map((c) => (
                <li
                  key={c.name}
                  className="flex items-baseline gap-[7px] text-[12.5px] text-t6"
                >
                  <button
                    type="button"
                    onClick={link(c.url)}
                    className="cursor-pointer font-semibold text-t2 underline-offset-2 hover:underline"
                  >
                    {c.name}
                  </button>
                  {t(c.roleKey)}
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* No rule above it: the credits panel already reads as a block,
            and the footer sits on the same 28px inset as every other
            edge of the card. */}
        <div className="flex items-center gap-2 p-7">
          <div className="flex min-w-0 flex-1 items-center gap-[9px]">
            {checking ? (
              <>
                <IconLoader2 className="size-3.5 animate-spin text-t6" />
                <span className="text-[12.5px] text-t5">
                  {t("about.checkingForUpdates")}
                </span>
              </>
            ) : updateLine ? (
              <>
                {/* The ring is a box-shadow, not a border, so the dot
                    keeps its 7px size and the glow sits outside it. */}
                <span
                  aria-hidden
                  className="size-[7px] shrink-0 rounded-full bg-acc1 shadow-[0_0_0_4px_rgba(var(--acc1rgb),0.18)]"
                />
                <span className="text-[12.5px] text-t2">{updateLine.text}</span>
                {updateLine.action ? (
                  <button
                    type="button"
                    onClick={updateLine.onClick}
                    className="cursor-pointer text-[12.5px] font-semibold text-acc1 underline-offset-2 hover:underline"
                  >
                    {updateLine.action}
                  </button>
                ) : null}
              </>
            ) : (
              <>
                <IconCheck
                  className="size-3.5 shrink-0 text-status-success"
                  stroke={2.4}
                />
                <span className="text-[12.5px] text-t5">
                  {t("about.upToDate")}
                </span>
              </>
            )}
          </div>
          <button
            type="button"
            onClick={link(DISCORD_URL)}
            aria-label="Discord"
            title="Discord"
            className={FOOTER_BTN}
          >
            <DiscordIcon />
          </button>
          <button
            type="button"
            onClick={link(REPO_URL)}
            aria-label="GitHub"
            title="GitHub"
            className={FOOTER_BTN}
          >
            <GithubIcon />
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
