import { useCallback, useState } from "react";
import { IconCircleFilled, IconCircleOff, IconLoader2 } from "@tabler/icons-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { type QueueTrack } from "@/lib/store/playback";
import { useAlternativeSources, usePlayability } from "@/lib/providers/alternatives";
import { switchTrackProvider } from "@/lib/providers/switch";
import {
  PROVIDER_LABELS,
  type ProviderId,
  type ProviderRef,
} from "@/lib/providers/types";

/**
 * Where the current track is coming from, and a way to change that.
 *
 * Two problems in one control:
 *
 *   1. **Which source is this?** With several providers in play, the
 *      player bar shows a title and an artist, and those look the same
 *      whichever platform served the audio. The user cannot tell
 *      whether they are listening to a 128 kbps YouTube rip or a
 *      lossless NetEase stream. The pill names the source.
 *
 *   2. **Can I hear the other one?** The same recording often exists
 *      on two platforms, and the two are genuinely different files ??
 *      one may be lossy, one lossless; one may be a different master.
 *      The dropdown lists the providers that also have the track and
 *      switches to them.
 *
 * The switch is deliberately explicit: nothing is changed behind the
 * user's back. A wrong automatic switch plays the wrong recording of
 * the right song, and the user has no way to tell except that it
 * sounds wrong.
 */

/** How the control looks in the player bar. */
export type SourceIndicatorProps = {
  /** The track currently playing. */
  track: QueueTrack | undefined;
  /** Extra classes for the trigger. */
  className?: string;
  /**
   * `chip` for the full-screen player, `ghost` for the side card,
   * `bar` for the bottom bar. All three name the source in words —
   * the dot alone cannot tell a 128 kbps YouTube rip from a lossless
   * NetEase stream — and all three open the same list of alternative
   * sources to switch to.
   */
  variant?: "chip" | "ghost" | "bar";
};

export function SourceIndicator({
  track,
  className,
  variant = "ghost",
}: SourceIndicatorProps) {
  const t = useT();
  const [switching, setSwitching] = useState<ProviderId | null>(null);

  // The alternatives live in the query cache, not in this component's
  // state: the list is a property of the track, so re-opening the
  // menu reads the cache instead of firing a fresh search every time.
  const { alternatives, isLoading } = useAlternativeSources(track);

  // Which of those sources will actually serve the track. A source
  // that merely lists it is not the same as one that will play it, and
  // the difference is worth showing before the user switches.
  const playability = usePlayability(alternatives);

  const provider = track?.provider ?? "youtube";
  const providerTrackId = track?.providerTrackId ?? track?.videoId ?? "";

  const switchTo = useCallback(
    async (ref: ProviderRef) => {
      if (!track) return;
      if (ref.provider === provider && ref.providerTrackId === providerTrackId) {
        return;
      }
      setSwitching(ref.provider);
      try {
        const ok = await switchTrackProvider(ref);
        if (!ok) {
          toast.error(t("settings.providers.switchFailed", { source: PROVIDER_LABELS[ref.provider] }));
        } else {
          toast.success(
            t("settings.providers.switchedTo", { source: PROVIDER_LABELS[ref.provider] }),
          );
        }
      } catch (e) {
        toast.error(String(e));
      } finally {
        setSwitching(null);
      }
    },
    [track, provider, providerTrackId, t],
  );

  if (!track) return null;

  const others = alternatives.filter(
    (a) =>
      !(a.provider === provider && a.providerTrackId === providerTrackId),
  );

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              disabled={switching !== null}
              aria-label={t("settings.providers.currentSource")}
              className={cn(
                "h-7 gap-1.5 px-2 text-[11.5px] font-medium text-muted-foreground hover:text-foreground",
                variant === "chip" &&
                  "h-8 rounded-full border border-hairline bg-surface/60 px-3",
                // The bottom bar's row of secondary actions is dense, so
                // the label is capped rather than allowed to push the
                // transport cluster off centre.
                variant === "bar" && "max-w-[7.5rem]",
                className,
              )}
            >
              {switching ? (
                <IconLoader2 className="size-3 animate-spin" />
              ) : (
                <IconCircleFilled className="size-2 text-brand" />
              )}
              <span className="max-w-[9rem] truncate">
                {PROVIDER_LABELS[provider]}
              </span>
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>
          {t("settings.providers.currentSource")} ·{" "}
          {PROVIDER_LABELS[provider]}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" side="top" className="w-60">
        <DropdownMenuLabel>
          {t("settings.providers.playingFrom", {
            provider: PROVIDER_LABELS[provider],
          })}
        </DropdownMenuLabel>
        <DropdownMenuItem disabled className="gap-2">
          <IconCircleFilled className="size-2 shrink-0 text-brand" />
          <span className="truncate">{PROVIDER_LABELS[provider]}</span>
        </DropdownMenuItem>

        {track.discoveredOn && track.discoveredOn !== provider ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="font-normal text-t8">
              {t("settings.providers.discoveredOn", {
                provider: PROVIDER_LABELS[track.discoveredOn],
              })}
            </DropdownMenuLabel>
          </>
        ) : null}

        <DropdownMenuSeparator />
        <DropdownMenuLabel className="font-normal text-t8">
          {t("settings.providers.switchSource")}
        </DropdownMenuLabel>

        {isLoading ? (
          <DropdownMenuItem disabled className="gap-2">
            <IconLoader2 className="size-3.5 animate-spin" />
            {t("settings.providers.searchingSources")}
          </DropdownMenuItem>
        ) : others.length === 0 ? (
          <DropdownMenuItem disabled>
            {t("settings.providers.noOtherSource")}
          </DropdownMenuItem>
        ) : (
          others.map((ref) => {
            const key = `${ref.provider}:${ref.providerTrackId}`;
            // `undefined` means the answer is not in yet.
            const canPlay = playability.get(key);
            return (
              <DropdownMenuItem
                key={key}
                onSelect={() => void switchTo(ref)}
                className="gap-2"
              >
                {switching === ref.provider ? (
                  <IconLoader2 className="size-3.5 animate-spin" />
                ) : canPlay === false ? (
                  // The source has the track but will not serve it — a
                  // membership gate, most likely. Switching to it would
                  // fail, so it is dimmed and marked.
                  <IconCircleOff className="size-3.5 shrink-0 text-t8" />
                ) : (
                  <IconCircleFilled className="size-2 shrink-0 text-t8" />
                )}
                <span className="truncate">{PROVIDER_LABELS[ref.provider]}</span>
                {canPlay === false ? (
                  <span className="ml-auto shrink-0 text-[10.5px] text-t8">
                    {t("settings.providers.sourceUnavailable")}
                  </span>
                ) : null}
              </DropdownMenuItem>
            );
          })
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The provider labels, for consumers that want them. */
export const SOURCE_LABELS = PROVIDER_LABELS;
