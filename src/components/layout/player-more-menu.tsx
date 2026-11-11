import { IconDots } from "@tabler/icons-react";
import { playerIconButton } from "@/components/layout/player-chrome";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  NewPlaylistDialog,
  TrackMenuItems,
  dropPrimitives,
  useTrackMenuController,
} from "@/components/shared/track-context-menu";
import type { QueueTrack } from "@/lib/store/playback";
import type { ShelfItem } from "@/lib/innertube/types";
import { useT } from "@/lib/i18n";

type Props = {
  track: QueueTrack | undefined;
  align?: "start" | "end";
  side?: "top" | "right" | "bottom" | "left";
  /** Extra classes for the trigger (the full-screen chip). */
  className?: string;
};

/**
 * Triple-dot overflow menu for the player surfaces. Wraps the same
 * `TrackMenuItems` block used by the right-click context menu on
 * track rows, so the actions (Play next, Add to queue, Start radio,
 * Like / Remove from liked, Add to playlist, Share) stay in sync
 * between every entry point.
 *
 * No main/floating split any more: nothing in the menu navigates, so
 * the router is never touched and the floating window can render the
 * same component.
 *
/**
 * `useTrackMenuController` runs unconditionally even when there's
 * no active track — it owns React Query queries we can't conditionally
 * skip without violating the rules of hooks. We feed it a stub
 * `ShelfItem` in that case and disable the trigger button instead.
 */
export function PlayerMoreMenu({
  track,
  align = "end",
  side = "top",
  className,
}: Props) {
  const t = useT();
  const item: ShelfItem = track
    ? {
        kind: "song",
        id: track.videoId,
        title: track.title,
        thumbnails: track.thumbnails,
        artists: track.artists,
        album: track.album,
        duration: track.duration,
      }
    : { kind: "song", id: "", title: "", thumbnails: [] };

  const controller = useTrackMenuController(item);

  return (
    <>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("common.moreActions")}
                disabled={!track}
                // The design draws this one a hair smaller than its
                // neighbours — three dots read heavy at 17px.
                className={cn(playerIconButton, "[&_svg]:size-4", className)}
              >
                <IconDots />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>{t("common.more")}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align={align} side={side} className="w-56">
          {track ? (
            <TrackMenuItems
              item={item}
              controller={controller}
              primitives={dropPrimitives}
            />
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {track ? (
        <NewPlaylistDialog
          open={controller.newPlaylistOpen}
          onOpenChange={controller.setNewPlaylistOpen}
          defaultTitle={item.title}
          tracks={[item]}
        />
      ) : null}
    </>
  );
}
