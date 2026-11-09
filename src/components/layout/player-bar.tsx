// Transport glyphs (play / pause / prev / next) stay on Lucide — they
// read better filled at this size than the Tabler equivalents. The
// footer row is Tabler, per the design.
import {
  IconArrowsShuffle,
  IconLoader2,
  IconPlayerPauseFilled,
  IconPlayerPlayFilled,
  IconPlayerSkipBackFilled,
  IconPlayerSkipForwardFilled,
  IconRepeat,
  IconRepeatOnce,
} from "@tabler/icons-react";
import {
  IconVolumeFilled,
  IconVolume2Filled,
  IconVolume3Filled,
} from "@/components/shared/filled-icons";
// Fork note: IconLoader2/IconVideoFilled/IconMusicFilled from upstream's
// SourceToggle restyle are omitted — SourceToggle itself is omitted (see
// below); the song/video picker lives in the player menu.
import { QueueBody, QueueToggleButton } from "@/components/layout/queue-panel";
import {
  LyricsBody,
  LyricsSourceButton,
  useLyricsView,
} from "@/components/layout/lyrics-view";
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, m } from "motion/react";
import { useShallow } from "zustand/react/shallow";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Slider } from "@/components/ui/slider";
import { LikeDislikeButtons } from "@/components/shared/like-buttons";
import { ArtistLinks } from "@/components/shared/artist-links";
import { EntityLink } from "@/components/shared/entity-link";
import { PlayerMoreMenu } from "@/components/layout/player-more-menu";
import { PlayerCoverMenu } from "@/components/layout/player-cover-menu";
import {
  NowPlayingCover,
} from "@/components/shared/now-playing-cover";
import {
  playerIconButton,
} from "@/components/layout/player-chrome";
import { cn } from "@/lib/utils";
import { usePlayerCoverDrag } from "@/lib/player-drag";
import { isBlankClick } from "@/lib/blank-click";
import { openFullscreen } from "@/lib/store/fullscreen";
import { usePlaybackStore, currentTrack } from "@/lib/store/playback";
import { usePanelsStore } from "@/lib/store/panels";
import { useScrubStore } from "@/lib/store/scrub";
import { lookupITunesCover, cacheCoverToDisk } from "@/lib/cover-art";
import { translate, useT } from "@/lib/i18n";
import type { QueueTrack, RepeatMode } from "@/lib/store/playback";

/**
 * Look up a 3000×3000 studio cover from iTunes for the now-playing
 * track. We do this only for the big player-bar cover — every other
 * surface keeps the YT thumbnail (smaller surfaces don't need 3K, and
 * substituting iTunes art on cards would visually rewrite content the
 * user picked from YT). Result is cached in localStorage, so repeat
 * tracks don't hit the network.
 */
export function useITunesCover(track: QueueTrack | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  const artistKey = track?.artists?.map((a) => a.name).join(", ") ?? "";
  const titleKey = track?.title ?? "";

  useEffect(() => {
    setUrl(null);
    if (!artistKey || !titleKey) return;
    let cancelled = false;
    (async () => {
      const itunes = await lookupITunesCover(artistKey, titleKey);
      if (cancelled || !itunes) return;
      const cached = await cacheCoverToDisk(itunes);
      if (cancelled) return;
      setUrl(cached);
    })();
    return () => {
      cancelled = true;
    };
  }, [artistKey, titleKey]);

  return url;
}

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * Human label for the current repeat mode. Doubles as the button's
 * tooltip and its `aria-label` so the three states (off → all → one)
 * are distinguishable — otherwise "off" and "all" differ only by the
 * icon's tint, which reads as "nothing happened" on the first click.
 *
 * Takes the translator rather than reading the locale itself, so the
 * label re-renders when the user switches language.
 */
export function repeatLabel(
  repeat: RepeatMode,
  t: (key: string) => string = translate,
): string {
  return repeat === "one"
    ? t("action.repeatOne")
    : repeat === "all"
      ? t("action.repeatAll")
      : t("action.repeatOff");
}

/* Fork note: SourceToggle intentionally omitted — fork moved the
   song/video picker into the player menu (0209432). Upstream's
   restyled toggle from 77b2c44 is skipped to preserve that decision. */
/** Elapsed-time label. Subscribes to the playhead itself so the 4×/s
 *  position ticks re-render this span, not the whole player. */
export function PlaybackTime() {
  const position = usePlaybackStore((s) => s.position);
  const scrub = useScrubStore((s) => s.scrub);
  return <>{formatTime(scrub ?? position)}</>;
}

/** Reads `position` and `scrub` from their stores (not props) so the
 *  playhead ticks re-render only the slider. */
export function ProgressSlider({
  duration,
  seek,
  disabled,
}: {
  duration: number;
  seek: (v: number) => void;
  disabled: boolean;
}) {
  const position = usePlaybackStore((s) => s.position);
  // Shared rather than local: the lyrics panel reads the live drag
  // target so its text follows the thumb instead of waiting for release.
  const scrub = useScrubStore((s) => s.scrub);
  const setScrub = useScrubStore((s) => s.setScrub);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [hoverX, setHoverX] = useState<number | null>(null);
  const [hoverTime, setHoverTime] = useState<number | null>(null);

  // While the user is dragging the thumb, the slider thumb captures pointer
  // events so onMouseMove on the wrapper stops firing. Sync the tooltip with
  // the live `scrub` value instead.
  useEffect(() => {
    if (scrub === null) return;
    const rect = wrapperRef.current?.getBoundingClientRect();
    if (!rect) return;
    const max = Math.max(duration, 1);
    setHoverX((scrub / max) * rect.width);
    setHoverTime(Math.round(scrub));
  }, [scrub, duration]);

  return (
    <div
      ref={wrapperRef}
      className={cn(
        "relative before:absolute before:-inset-y-2 before:inset-x-0 before:content-['']",
        !disabled && "cursor-pointer",
      )}
      onMouseMove={(e) => {
        if (disabled || scrub !== null) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
        setHoverX(x);
        setHoverTime(Math.round((x / rect.width) * Math.max(duration, 1)));
      }}
      onMouseLeave={() => {
        if (scrub !== null) return;
        setHoverX(null);
        setHoverTime(null);
      }}
    >
      {hoverX !== null && hoverTime !== null ? (
        <div
          className="pointer-events-none absolute -top-8 z-10 -translate-x-1/2 rounded bg-black/85 px-2 py-0.5 text-sm font-medium tabular-nums text-white shadow"
          style={{ left: hoverX }}
        >
          {formatTime(hoverTime)}
        </div>
      ) : null}
      <Slider
        value={[scrub ?? position]}
        max={Math.max(duration, 1)}
        step={1}
        disabled={disabled}
        onValueChange={([v]) => setScrub(v)}
        onValueCommit={([v]) => {
          seek(v);
          setScrub(null);
        }}
      />
    </div>
  );
}

/**
 * The volume control.
 *
 * One layout everywhere: the speaker button plus a slider that pops
 * UP out of it on hover. The bottom bar is where that layout was
 * settled on — a horizontal slider inline in the row only fits the
 * side card, and it left the other surfaces (the full-screen view,
 * the floating window) with a slider whose width had to be guessed
 * per-container.
 *
 * The popup grows upward because the control always sits in a row
 * near the bottom edge of its surface: below the button there is the
 * edge of the window.
 */
export function VolumeControl({ className }: { className?: string }) {
  const t = useT();
  const { volume, muted } = usePlaybackStore(
    useShallow((s) => ({ volume: s.volume, muted: s.muted })),
  );
  const setVolume = usePlaybackStore((s) => s.setVolume);
  const toggleMute = usePlaybackStore((s) => s.toggleMute);
  const [open, setOpen] = useState(false);

  // Tabler ships three speaker states to Lucide's four, so the old
  // "audible but no waves" step folds into the single-wave icon.
  const Icon =
    muted || volume === 0
      ? IconVolume3Filled
      : volume < 0.6
        ? IconVolume2Filled
        : IconVolumeFilled;
  const pct = muted ? 0 : Math.round(volume * 100);

  return (
    <div
      className={cn(
        "relative flex items-center",
        // Two invisible 8px strips (above and below the speaker button)
        // extend the container's hover hit-zone without overlapping the
        // button itself — overlapping it would steal its `:hover` state.
        // Together with the popup's own padding, the cursor gets a
        // comfortable grace area for traveling between icon and slider.
        "before:absolute before:-top-2 before:inset-x-0 before:h-2 before:content-[''] after:absolute after:-bottom-2 after:inset-x-0 after:h-2 after:content-['']",
      )}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onWheel={(e) => {
        // Scroll wheel adjusts volume in 5% increments. Wheel-up
        // raises, wheel-down lowers. Unmutes on any change so the
        // change is audible.
        const delta = e.deltaY < 0 ? 0.05 : -0.05;
        // Adjust from the stored volume even when muted, so unmuting via the
        // wheel restores the real level instead of resetting to 5%.
        // setVolume already clears `muted`, so any wheel tick unmutes.
        const next = Math.max(0, Math.min(1, volume + delta));
        setVolume(next);
      }}
    >
      <Button
        variant="ghost"
        size="icon"
        aria-label={muted ? t("action.unmute") : t("action.mute")}
        onClick={toggleMute}
        className={cn(playerIconButton, className)}
      >
        <AnimatePresence mode="popLayout" initial={false}>
          <m.span
            key={Icon.name}
            initial={{ opacity: 0, scale: 0.7 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.7 }}
            transition={{ duration: 0.12 }}
            className="flex items-center justify-center"
          >
            <Icon />
          </m.span>
        </AnimatePresence>
      </Button>
      {/* Padding on the popup is invisible but counts toward the
          parent's mouseleave hit-test, so the slider doesn't snap shut
          the moment the cursor slips a couple px off the visible bar. */}
      <div
        className={cn(
          "absolute bottom-full left-1/2 z-10 flex -translate-x-1/2 flex-col items-center gap-1 px-3 pb-2 transition-opacity duration-150",
          open ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      >
        <div className="flex w-12 flex-col items-center gap-2 rounded-md border border-hairline bg-surface-active/70 px-4 py-3 shadow backdrop-blur-md">
          <span className="text-xs font-medium tabular-nums text-foreground">
            {pct}
          </span>
          <Slider
            orientation="vertical"
            value={[pct]}
            max={100}
            step={1}
            className="h-16 min-h-0"
            aria-label={t("action.volume")}
            onValueChange={([v]) => setVolume(v / 100)}
          />
        </div>
      </div>
    </div>
  );
}

export type PlayerBarVariant = "right" | "floating";

export function PlayerBar({
  variant = "right",
}: {
  variant?: PlayerBarVariant;
}) {
  const t = useT();
  const {
    playing,
    status,
    error,
    duration,
    shuffle,
    repeat,
  } = usePlaybackStore(
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

  const [queueOpen, setQueueOpen] = useState(false);
  const iTunesCover = useITunesCover(track);
  const lyricsState = useLyricsView(track);
  const coverRef = useRef<HTMLDivElement>(null);
  // The cover doubles as a drag handle for layout switching. In the
  // floating window the OS title bar already owns drag, so we don't
  // attach our own handler there.
  //
  // A plain click on the cover opens the full-screen view — that is
  // the cover's job now, rather than opening a raw image preview.
  const { onPointerDown: onCoverPointerDown } = usePlayerCoverDrag({
    enabled: variant !== "floating",
    onClick: () => {
      if (!track) return;
      // The side card hugs the right edge, so the cover travels LEFT
      // into the full-screen view.
      openFullscreen("right");
    },
  });

  const hasTrack = !!track;
  // Only treat "loading" as user-facing when the user has actually
  // requested playback. The audio engine eagerly resolves the stream
  // URL for the queued track on mount (so the first click on Play is
  // instant), which flips status to "loading" even while playing is
  // still false — without this guard, the freshly-launched player
  // shows a spinner instead of the Play icon.
  const loading = status === "loading" && playing;

  // The right-side variant is fixed-positioned in the main app shell,
  // sized to the user's resizable card width. The floating-window
  // variant fills its parent container (the floating window's body,
  // whose own size the user resizes at the OS level instead), where
  // positioning is owned by that window's own layout.
  const cardWidth = usePanelsStore((s) => s.cardWidth);
  const wrapperClass =
    variant === "right"
      ? "fixed bottom-2 right-2 top-(--titlebar-h) z-10 flex flex-col rounded-[10px] border border-sidebar-border bg-surface"
      : "absolute inset-0 flex flex-col bg-surface";
  const wrapperStyle = variant === "right" ? { width: cardWidth } : undefined;

  return (
    // shadcn's SidebarProvider injects a nested TooltipProvider with
    // delayDuration={0} (for instant sidebar-icon labels), which
    // shadows the outer 800ms provider for everything inside the
    // shell. Wrap the player surface in its own provider so its
    // buttons get the slow delay we actually want here.
    // `skipDelayDuration={0}` makes EVERY hover wait the full delay,
    // even when moving between adjacent triggers (Radix defaults to
    // 300ms, which makes the next tooltip pop up instantly — annoying
    // when the buttons are densely packed).
    <TooltipProvider delayDuration={800} skipDelayDuration={0}>
    <aside
      className={wrapperClass}
      style={wrapperStyle}
      // Clicking the card's blank surface opens the full-screen view.
      // The click target is checked so a click on a button, a link or
      // the lyrics column never opens it by accident.
      onClick={(e) => {
        if (!track || variant === "floating") return;
        // The cover is handled by the drag hook, which tells a click
        // apart from a drag. A native click ALSO fires after a drag
        // that relocated the player, so letting the cover through here
        // would open the full-screen view after every layout drag.
        if (coverRef.current?.contains(e.target as Node)) return;
        if (!isBlankClick(e.target)) return;
        openFullscreen("right");
      }}
    >
      {/* Queue overlay vs. cover-and-lyrics body. AnimatePresence
          crossfades the two when the user toggles the queue button.
          Both branches fill the card above the bottom action row
          (which stays rendered as the next aside child so the queue
          button remains accessible to toggle back). `initial={false}`
          suppresses an opening fade on first mount — the player
          opens with the cover already visible, no need to animate it
          in from blank. */}
      <AnimatePresence initial={false} mode="wait">
        {queueOpen ? (
          <m.div
            key="queue"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.07 }}
            className="flex min-h-0 flex-1 flex-col"
          >
            <QueueBody onClose={() => setQueueOpen(false)} />
          </m.div>
        ) : (
          <m.div
            key="cover"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.07 }}
            className="flex min-h-0 flex-1 flex-col"
          >
      {/* Top fixed section: cover, meta, progress, controls.
          Floating variant drops the top padding so the cover sits
          flush against the window's title bar — there's no card
          border or chrome to motivate inset there. */}
      <div
        className={cn(
          "flex flex-col gap-3 p-4 pb-3",
          variant === "floating" && "pt-0",
        )}
      >
        {status === "error" && error ? (
          <div className="truncate rounded-md bg-destructive/90 px-3 py-1 text-xs text-destructive-foreground shadow">
            Playback error: {error}
          </div>
        ) : null}

        {/* `max-w-[20rem]` caps the cover at 320px so it can't grow
            arbitrarily tall in the floating variant when the user
            resizes the window wider — that would push the Play/Pause
            button below the visible area. The right-card variant has
            an effective inner width of 320 anyway (22rem - p-4*2), so
            the cap is a no-op there. */}
        <PlayerCoverMenu track={track}>
          <div
            ref={coverRef}
            onPointerDown={onCoverPointerDown}
            className={cn(
              "mx-auto w-full max-w-[20rem] touch-none select-none",
            )}
          >
            {track ? (
              // The wrapper carries the shadow so it is cast by the cover's
              // rounded box rather than by the Thumbnail's own square edge.
              //
              // `isolate` is load-bearing: the outline below blends, and a
              // blending element turns its nearest stacking-context ancestor
              // into an isolated group, which is also a backdrop root. Without
              // it that group is the m.div wrapping cover AND lyrics, so
              // the lyrics' backdrop-blur strip loses the card and the app
              // background from its backdrop and paints as a dark band.
              <NowPlayingCover
                track={track}
                override={iTunesCover}
                className="shadow-[0_1px_14px_rgb(0_0_0/0.12)]"
              />
            ) : (
              <div className="aspect-square w-full rounded-md border border-hairline bg-muted" />
            )}
          </div>
        </PlayerCoverMenu>

        {/* Title + artist/album with heart on the right. The heart
            centres against the whole two-line block, per the design. */}
        <div className="flex items-center gap-2">
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-base font-medium">
              {track?.title ?? t("player.nothingPlaying")}
            </span>
            {track ? (
              <span className="truncate text-sm text-muted-foreground">
                <ArtistLinks
                  artists={track.artists}
                  fallback={track.subtitle ?? ""}
                />
                {/* The separator only earns its place between two real
                    halves — a track with no artists must not open with
                    a stray dot. The album links through only when the
                    row it came from carried a browse id. */}
                {track.album ? (
                  <>
                    {track.artists?.length || track.subtitle ? " · " : null}
                    {track.albumId ? (
                      <EntityLink
                        to="/album/$id"
                        id={track.albumId}
                        event="nav:album"
                      >
                        {track.album}
                      </EntityLink>
                    ) : (
                      track.album
                    )}
                  </>
                ) : null}
              </span>
            ) : (
              <span className="truncate text-sm text-muted-foreground">
                Pick a track to start
              </span>
            )}
          </div>
          {track ? (
            <LikeDislikeButtons
              videoId={track.videoId}
              meta={track}
              className="shrink-0"
            />
          ) : null}
        </div>

        {/* Progress */}
        <div className="mt-2 flex flex-col gap-2.5">
          <ProgressSlider
            duration={duration}
            seek={seek}
            disabled={!hasTrack || duration <= 0}
          />
          <div className="flex justify-between text-xs tabular-nums text-muted-foreground">
            <span><PlaybackTime /></span>
            <span>{formatTime(duration)}</span>
          </div>
        </div>

        {/* Main controls */}
        <div className="-mt-2 flex items-center justify-center gap-1">
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
      </div>

            {/* Lyrics flow — fills the rest of the cover-branch flex
                column. Lives inside the same m.div as the cover
                so the whole non-queue body crossfades as one unit. */}
            <div className="flex min-h-0 flex-1 flex-col px-3">
              <LyricsBody state={lyricsState} />
            </div>
          </m.div>
        )}
      </AnimatePresence>

      {/* Bottom row: lyrics-source + queue on the left, volume + more
          menu on the right. The volume control is the same hover-popup
          the bottom bar uses — the inline horizontal slider only ever
          fitted the resizable side card, and it left the other
          surfaces guessing at a width. The song/video source picker
          lives inside `PlayerMoreMenu` now (its default
          `includeSource`) rather than as its own control here, which
          is what used to crowd the volume control. `PlayerMoreMenu`
          handles the floating-window case internally — its
          `onGoToArtist` callback emits a Tauri nav event there
          instead of calling `useNavigate` (which would throw without
          a router). */}
      <div className="flex items-center gap-2 px-3 pt-2 pb-3">
        <div className="flex min-w-0 flex-1 items-center gap-0.5">
          <LyricsSourceButton state={lyricsState} />
          <QueueToggleButton
            open={queueOpen}
            onToggle={() => setQueueOpen((v) => !v)}
          />
        </div>
        <VolumeControl />
        <PlayerMoreMenu track={track} />
      </div>
    </aside>
    </TooltipProvider>
  );
}
