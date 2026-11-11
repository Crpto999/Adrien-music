import { useRef } from "react";
import {
  IconArrowsShuffle,
  IconLoader2,
  IconMicrophoneFilled,
  IconPlayerPauseFilled,
  IconPlayerPlayFilled,
  IconPlayerSkipBackFilled,
  IconPlayerSkipForwardFilled,
  IconRepeat,
  IconRepeatOnce,
} from "@tabler/icons-react";
import { useShallow } from "zustand/react/shallow";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { LikeDislikeButtons } from "@/components/shared/like-buttons";
import { ArtistLinks } from "@/components/shared/artist-links";
import { AlbumLink } from "@/components/shared/album-link";
import { QueuePopover } from "@/components/layout/queue-panel";
import {
  LyricsBody,
  LyricsSourceButton,
  useLyricsView,
} from "@/components/layout/lyrics-view";
import {
  PlaybackTime,
  ProgressSlider,
  VolumeControl,
  formatTime,
  repeatLabel,
  useITunesCover,
} from "@/components/layout/player-bar";
import { PlayerMoreMenu } from "@/components/layout/player-more-menu";
import { PlayerCoverMenu } from "@/components/layout/player-cover-menu";
import { SourceIndicator } from "@/components/layout/source-indicator";
import {
  NowPlayingCover,
} from "@/components/shared/now-playing-cover";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { playerIconButton } from "@/components/layout/player-chrome";
import { usePlayerCoverDrag } from "@/lib/player-drag";
import { isBlankClick } from "@/lib/blank-click";
import { openFullscreen } from "@/lib/store/fullscreen";
import { usePlaybackStore, currentTrack } from "@/lib/store/playback";

/**
 * Compact horizontal player bar pinned to the bottom of the content
 * area. Sibling of `<main>` (not fixed-positioned), so it naturally
 * sits between the sidebar on the left and the right window edge —
 * no manual sidebar-width math.
 *
 * Layout: meta + transport + secondary actions in a single top row,
 * progress slider + flanking timecodes in a row below. The transport
 * cluster sits dead-center because the left and right wing sections
 * both use `flex-1`.
 */
export function PlayerBarBottom({
  ref,
}: {
  ref?: React.Ref<HTMLElement>;
}) {
  const t = useT();
  const { playing, status, error, duration, shuffle, repeat } =
    usePlaybackStore(
      useShallow((s) => ({
        playing: s.playing,
        status: s.status,
        error: s.error,
        duration: s.duration,
        shuffle: s.shuffle,
        repeat: s.repeat,
      })),
    );
  const track = usePlaybackStore(currentTrack);
  const toggle = usePlaybackStore((s) => s.toggle);
  const next = usePlaybackStore((s) => s.next);
  const prev = usePlaybackStore((s) => s.prev);
  const seek = usePlaybackStore((s) => s.seek);
  const setShuffle = usePlaybackStore((s) => s.setShuffle);
  const cycleRepeat = usePlaybackStore((s) => s.cycleRepeat);

  const iTunesCover = useITunesCover(track);
  const lyricsState = useLyricsView(track);
  const coverRef = useRef<HTMLDivElement>(null);
  // A plain click on the cover opens the full-screen view — that is
  // the cover's job now, rather than opening a raw image preview.
  // The bottom bar hugs the bottom edge, so the cover travels UP into
  // the view.
  const { onPointerDown: onCoverPointerDown } = usePlayerCoverDrag({
    onClick: () => {
      if (!track) return;
      openFullscreen("bottom");
    },
  });

  const hasTrack = !!track;
  // See player-bar.tsx — spinner only while the user has actually
  // requested playback, otherwise eager stream preloading shows a
  // loader where a Play icon should be.
  const loading = status === "loading" && playing;

  return (
    // The compound selector at the end overrides shadcn's ghost-variant
    // gray hover (`hover:bg-accent`) for every Button rendered inside
    // the bar — both the ones we render directly (shuffle/prev/next/
    // repeat) and the ones from imported components (Like, Lyrics,
    // Queue, Volume, More). Matches the right-card's translucent
    // white feel.
    // The bar spans the WHOLE window in this layout: the sidebar and
    // the content column sit above it. So it insets 8px on both sides
    // (the sidebar's own inset from the window-left) and 8px from the
    // bottom — a uniform frame around the bar.
    // SidebarProvider injects a nested TooltipProvider with delay=0
    // that shadows the outer slow one — wrap this surface so its
    // tooltips honor the intended 1s delay. `skipDelayDuration={0}`
    // makes every hover wait the full delay even when moving between
    // adjacent triggers (Radix's 300ms default makes the next one
    // pop up instantly otherwise).
    <TooltipProvider delayDuration={800} skipDelayDuration={0}>
    <aside
      ref={ref}
      className="relative z-10 mx-2 mb-2 flex shrink-0 flex-col gap-2 rounded-[10px] border border-sidebar-border bg-surface px-4 py-3 shadow-sm"
      // Clicking the bar's blank surface opens the full-screen view.
      // The click target is checked so a click on a button, a link or
      // the progress slider never opens it by accident.
      onClick={(e) => {
        if (!track) return;
        // The cover is handled by the drag hook, which tells a click
        // apart from a drag. A native click ALSO fires after a drag
        // that relocated the player, so letting the cover through here
        // would open the full-screen view after every layout drag.
        if (coverRef.current?.contains(e.target as Node)) return;
        if (!isBlankClick(e.target)) return;
        openFullscreen("bottom");
      }}
    >
      {status === "error" && error ? (
        <div className="absolute -top-9 left-3 right-3 truncate rounded-md bg-destructive/90 px-3 py-1 text-xs text-destructive-foreground shadow">
          Playback error: {error}
        </div>
      ) : null}

      {/* Top row — three sections separated by `flex-1` wings so the
          transport cluster always lands centered in the bar. */}
      <div className="flex items-center gap-4">
        {/* LEFT wing: cover + meta. `min-w-0` lets the title truncate
            instead of pushing the transport cluster off-center. */}
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <PlayerCoverMenu track={track}>
            {/* A plain click on the cover opens the full-screen view; a
                drag (the layout switch) must not. The drag handle keeps
                pointer capture, so `click` still fires after a drag and
                the pointer's travel since pointerdown is what tells the
                two apart. */}
            <div
              ref={coverRef}
              onPointerDown={onCoverPointerDown}
              className="shrink-0 touch-none select-none"
            >
              {track ? (
                <NowPlayingCover
                  track={track}
                  override={iTunesCover}
                  className="size-14 shrink-0 rounded-md border border-hairline"
                />
              ) : (
                <div className="size-14 shrink-0 rounded-md border border-hairline bg-muted" />
              )}
            </div>
          </PlayerCoverMenu>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-base font-semibold leading-tight">
              {track?.title ?? t("player.nothingPlaying")}
            </span>
            {track ? (
              <ArtistLinks
                artists={track.artists}
                fallback={track.subtitle ?? ""}
                className="truncate text-sm text-muted-foreground leading-tight"
              />
            ) : (
              <span className="truncate text-sm text-muted-foreground leading-tight">
                {t("player.pickATrack")}
              </span>
            )}
            {track?.album ? (
              <AlbumLink
                albumId={track.albumId}
                name={track.album}
                className="block truncate text-xs text-muted-foreground leading-tight"
              />
            ) : null}
          </div>
        </div>

        {/* CENTER: shuffle | prev | PLAY | next | repeat. Width is
            implicit (no flex-1) so the wings push it to the middle. */}
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("action.shuffle")}
            aria-pressed={shuffle}
            onClick={() => setShuffle(!shuffle)}
            className={cn(shuffle && "text-brand")}
          >
            <IconArrowsShuffle />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("action.previous")}
            onClick={prev}
            disabled={!hasTrack}
          >
            <IconPlayerSkipBackFilled />
          </Button>
          <Button
            size="icon"
            aria-label={playing ? t("action.pause") : t("action.play")}
            onClick={toggle}
            disabled={!hasTrack}
            className="size-12 rounded-full bg-brand text-brand-foreground hover:bg-brand/90"
          >
            {loading ? (
              <IconLoader2 className="animate-spin" />
            ) : playing ? (
              <IconPlayerPauseFilled className="size-5" />
            ) : (
              <IconPlayerPlayFilled className="size-5" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("action.next")}
            onClick={next}
            disabled={!hasTrack}
          >
            <IconPlayerSkipForwardFilled />
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label={repeatLabel(repeat, t)}
                aria-pressed={repeat !== "off"}
                onClick={cycleRepeat}
                className={cn(repeat !== "off" && "text-brand")}
              >
                {repeat === "one" ? <IconRepeatOnce /> : <IconRepeat />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{repeatLabel(repeat, t)}</TooltipContent>
          </Tooltip>
        </div>

        {/* RIGHT wing: secondary actions, justified to the right edge. */}
        <div className="flex flex-1 items-center justify-end gap-0.5">
          {track ? (
            <LikeDislikeButtons
              videoId={track.videoId}
              meta={track}
              buttonClassName={playerIconButton}
            />
          ) : null}
          {/* Which provider is serving the audio, and a way to switch to
              another one that carries the same recording. The control
              reads its list from the cache, so opening it is instant.
              It is the same control the side card uses, with the
              source named in words — the dot alone cannot tell a
              lossy YouTube rip from a lossless NetEase stream. */}
          <SourceIndicator track={track} variant="bar" />
          <LyricsPopover state={lyricsState} />
          <QueuePopover />
          <VolumeControl />
          <PlayerMoreMenu track={track} />
        </div>
      </div>

      {/* Progress row — times sit at the bar's edges (intrinsic
          widths, no padding inside their boxes) so the LEFT time
          starts exactly under cover-left and the RIGHT time ends
          exactly under more-right. The slider fills whatever's left
          between them. */}
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          <PlaybackTime />
        </span>
        <div className="min-w-0 flex-1">
          <ProgressSlider
            duration={duration}
            seek={seek}
            disabled={!hasTrack || duration <= 0}
          />
        </div>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {formatTime(duration)}
        </span>
      </div>
    </aside>
    </TooltipProvider>
  );
}

function LyricsPopover({
  state,
}: {
  state: ReturnType<typeof useLyricsView>;
}) {
  const t = useT();
  if (!state.hasTrack) {
    return (
      <Button
        variant="ghost"
        size="icon"
        disabled
        aria-label={t("action.lyrics")}
        className={playerIconButton}
      >
        <IconMicrophoneFilled />
      </Button>
    );
  }
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("action.lyrics")}
              className={playerIconButton}
            >
              <IconMicrophoneFilled />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{t("action.lyrics")}</TooltipContent>
      </Tooltip>
      <PopoverContent
        align="end"
        side="top"
        sideOffset={12}
        className="flex h-[28rem] w-[24rem] flex-col gap-2 p-0"
      >
        <header className="flex shrink-0 items-center justify-between border-b border-hairline px-3 py-2">
          <span className="text-sm font-medium">{t("action.lyrics")}</span>
          <LyricsSourceButton state={state} />
        </header>
        <div className="min-h-0 flex-1 overflow-hidden px-2 pb-3">
          <LyricsBody state={state} />
        </div>
      </PopoverContent>
    </Popover>
  );
}

