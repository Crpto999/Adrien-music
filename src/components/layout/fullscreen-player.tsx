import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toggleDisliked, toggleLiked } from "@/lib/like-actions";
import { useDislikesStore } from "@/lib/store/dislikes";
import { AnimatePresence, m } from "motion/react";
import {
  IconArrowsShuffle,
  IconLoader2,
  IconPlayerPauseFilled,
  IconPlayerPlayFilled,
  IconPlayerSkipBackFilled,
  IconPlayerSkipForwardFilled,
  IconRepeat,
  IconRepeatOnce,
  IconHeart,
  IconHeartFilled,
  IconThumbDown,
  IconThumbDownFilled,
  IconThumbUp,
  IconThumbUpFilled,
} from "@tabler/icons-react";
import { useShallow } from "zustand/react/shallow";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ArtworkOutline } from "@/components/shared/artwork-outline";
import { ArtistLinks } from "@/components/shared/artist-links";
import { EntityLink } from "@/components/shared/entity-link";
import { useNeteaseLikedIds } from "@/lib/providers/netease-liked";
import { useTrackLikeStatus } from "@/lib/providers/use-like-status";
import { Thumbnail } from "@/components/shared/thumbnail";
import { LyricsBody, useLyricsView } from "@/components/layout/lyrics-view";
import {
  PlaybackTime,
  ProgressSlider,
  VolumeControl,
  formatTime,
  repeatLabel,
  useITunesCover,
} from "@/components/layout/player-bar";
import { PlayerMoreMenu } from "@/components/layout/player-more-menu";
import { SourceIndicator } from "@/components/layout/source-indicator";
import { QueuePopover } from "@/components/layout/queue-panel";
import { LyricsSourceButton } from "@/components/layout/lyrics-view";
import { ImmersivePanel } from "@/components/layout/immersive-panel";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useFullscreenStore } from "@/lib/store/fullscreen";
import { usePlaybackStore, currentTrack } from "@/lib/store/playback";
import { useSettingsStore, type FullscreenLayout } from "@/lib/store/settings";
import type { QueueTrack } from "@/lib/store/playback";
import { useThemeScheme } from "@/lib/theme";
import { isBlankClick } from "@/lib/blank-click";

/**
 * The full-screen now-playing view, per the design handoff: the cover
 * blurred across the whole window with a scrim, a layout switch and an
 * Exit pill on top, one of three bodies in the middle (the cover
 * centred, the cover beside the lyrics, or the art itself with the
 * title over it) and the transport along the bottom.
 *
 * Mounted once in AppShell; the store decides whether it shows. It sits
 * under the title bar (the window controls stay reachable) and under
 * every dialog, so Settings can open on top of it. The lyrics column
 * reuses the player card's own `LyricsBody`, only set larger.
 */
export function FullscreenPlayer() {
  const open = useFullscreenStore((s) => s.open);
  const setOpen = useFullscreenStore((s) => s.setOpen);
  const track = usePlaybackStore(currentTrack);

  // Nothing to show once the queue is cleared underneath it.
  useEffect(() => {
    if (open && !track) setOpen(false);
  }, [open, track, setOpen]);

  return (
    <AnimatePresence>
      {open && track ? <FullscreenView key="fullscreen" track={track} /> : null}
    </AnimatePresence>
  );
}

/* ------------------------------------------------------------------ */
/* Chrome shared by the buttons on the blurred surface                 */
/* ------------------------------------------------------------------ */

/** 34px chip: the design's footer button, on the full-screen surface.
 *  Colours spelled as `[color:…]` so tailwind-merge can pair them with
 *  the button's own text colour and let these win. */
const chip =
  "size-[34px] rounded-[9px] bg-w080 text-[color:var(--fs-txt2)] hover:bg-w160 hover:text-[color:var(--fs-title)] [&_svg]:size-4";

/** The transport's outer pair (shuffle / repeat), 40px, tinted when on. */
const sideButton = (on: boolean) =>
  cn(
    "size-10 rounded-[11px] transition-colors duration-[140ms] hover:bg-w140 [&_svg]:size-[19px]",
    on
      ? "bg-[rgba(var(--acc1rgb),0.16)] text-acc1 hover:text-acc1"
      : "text-(--fs-txt3) hover:text-(--fs-title)",
  );

/* ------------------------------------------------------------------ */
/* The view                                                            */
/* ------------------------------------------------------------------ */

function FullscreenView({ track }: { track: QueueTrack }) {
  const t = useT();
  const setOpen = useFullscreenStore((s) => s.setOpen);
  const layout = useSettingsStore((s) => s.fullscreenLayout);
  const setLayout = useSettingsStore((s) => s.setFullscreenLayout);
  const scheme = useThemeScheme();
  const light = scheme === "light";

  const { playing, status, duration, shuffle, repeat } = usePlaybackStore(
    useShallow((s) => ({
      playing: s.playing,
      status: s.status,
      duration: s.duration,
      shuffle: s.shuffle,
      repeat: s.repeat,
    })),
  );
  const toggle = usePlaybackStore((s) => s.toggle);
  const next = usePlaybackStore((s) => s.next);
  const prev = usePlaybackStore((s) => s.prev);
  const seek = usePlaybackStore((s) => s.seek);
  const setShuffle = usePlaybackStore((s) => s.setShuffle);
  const cycleRepeat = usePlaybackStore((s) => s.cycleRepeat);
  const loading = status === "loading" && playing;

  const iTunesCover = useITunesCover(track);
  const lyricsState = useLyricsView(track);
  // "With lyrics" only means something when there are some. A track the
  // sources came back empty for shows as Centered instead; the setting
  // itself is untouched, so the next track with lyrics gets them again.
  const noLyrics =
    lyricsState.hasTrack && !lyricsState.isLoading && !lyricsState.active;
  const shown: FullscreenLayout =
    layout === "lyrics" && noLyrics ? "cover" : layout;

  // Escape closes the view, unless a dialog, menu or popover on top of
  // it took the key first (Radix marks those keydowns as handled).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setOpen]);

  const immersive = shown === "immersive";

  // Which way the now-playing cover travels into this view. The bottom
  // bar hugs the bottom edge, so its cover rises; the side card hugs
  // the right edge, so its cover slides left. Everything that moves
  // during the transition follows this axis, so the screen shows one
  // consistent direction rather than a cover moving sideways while the
  // page scrolls up.
  const origin = useFullscreenStore((s) => s.origin);

  // Where the sheet comes from and goes back to. The bottom bar's
  // player lives at the bottom of the window, so its sheet rises from
  // the bottom edge; the side card's player lives at the right edge,
  // so its sheet comes in from the right.
  //
  // The distance is a full viewport edge — this is a pull-out, not a
  // nudge. A small offset reads as a fade, which is what the expand
  // used to look like.
  const slideFrom = origin === "bottom" ? { y: "100%" } : { x: "100%" };
  const slideTo = origin === "bottom" ? { y: "100%" } : { x: "100%" };

  // The cover layouts wash the art out under a heavy blur. Immersive
  // keeps it sharp in the middle and blurs only the top and bottom bands
  // (below), where the chrome and the title sit. Light theme brightens
  // instead of darkening.
  const filter = immersive
    ? light
      ? "saturate(1.05) brightness(1.05)"
      : "saturate(1.18) brightness(0.72)"
    : light
      ? "blur(46px) saturate(0.95) brightness(1.34)"
      : "blur(46px) saturate(1.3) brightness(0.62)";

  return (
    <TooltipProvider delayDuration={800} skipDelayDuration={0}>
      {/* The sheet: the whole full-screen view as one layer that slides
          in from the edge the player lives on.
          - from the bottom bar: it rises from the bottom edge
          - from the side card: it comes in from the right edge

          The direction is the whole point: the view is pulled out of
          the player, not faded in over it. The cover is part of the
          sheet, so it rises or slides left together with everything
          else — one direction on screen at a time.

          This replaces the shared-element (layoutId) transition the
          cover used to have. That one animated the OLD element — the
          small cover in the player bar — towards the new one, and the
          old one sits UNDERNEATH this sheet, so the whole flight was
          hidden behind it: the expand read as a cut while the exit
          read as a flight (the sheet was fading out, letting the
          small cover show). Moving the sheet itself is what makes the
          entrance visible. */}
      <m.div
        initial={slideFrom}
        animate={{ x: 0, y: 0 }}
        exit={slideTo}
        transition={{ duration: 0.42, ease: [0.32, 0.72, 0, 1] }}
        className="fixed inset-0 z-40 flex flex-col overflow-hidden bg-background"
        // Clicking the sheet's blank surface collapses the view. The
        // click target is checked so a click on a button, the
        // progress slider or a lyric line never collapses it.
        //
        // The lyrics column opts OUT of that check in this view: only
        // the lyric TEXT is a control, so a click on the background
        // beside the lines lands on empty surface and closes the sheet,
        // while a click on the words themselves seeks. See
        // `LyricsBody`'s `backgroundIsBlank`.
        onClick={(e) => {
          if (!isBlankClick(e.target)) return;
          setOpen(false);
        }}
      >
        {/* The backdrop: the cover, oversized so the blur has no soft
            edge. An <img> through Thumbnail rather than a CSS
            background: the Google image CDNs answer a request that
            carries our Referer with an HTML stub, and only <img> can
            send none. */}
        <div
          aria-hidden
          className="absolute inset-[-8%] scale-110 transition-[filter] duration-500"
          style={{ filter }}
        >
          <Thumbnail
            thumbnails={track.thumbnails}
            alt=""
            className="size-full rounded-none bg-transparent"
            targetSize={1024}
            highRes
            overrideHighRes={iTunesCover}
          />
        </div>
        {immersive ? (
          <>
            {/* Blur bands: strongest at the edges, gone by mid-height. */}
            <div
              aria-hidden
              className="absolute inset-x-0 top-0 h-1/2 [backdrop-filter:blur(28px)] [mask-image:linear-gradient(to_bottom,black_0%,black_12%,transparent_100%)]"
            />
            <div
              aria-hidden
              className="absolute inset-x-0 bottom-0 h-1/2 [backdrop-filter:blur(28px)] [mask-image:linear-gradient(to_top,black_0%,black_12%,transparent_100%)]"
            />
          </>
        ) : null}
        <div
          aria-hidden
          className="absolute inset-0"
          style={{
            background: immersive
              ? "linear-gradient(180deg, var(--g9a) 0%, var(--g9b) 34%, var(--g9c) 100%)"
              : "var(--g9d)",
          }}
        />

        {/* The title bar is transparent and stays on top, so the body
            starts below it and the cover runs up behind it. */}
        <div className="relative flex min-h-0 flex-1 flex-col px-7 pb-6 pt-[calc(var(--titlebar-h)+8px)]">
          {/* Top row: layout switch, Exit. */}
          <div className="flex shrink-0 items-center gap-2.5">
            <div
              role="radiogroup"
              aria-label={t("player.fullScreenLayout")}
              className="flex gap-0.5 rounded-[10px] border border-w080 bg-w070 p-[3px]"
            >
              {LAYOUTS.map(({ value, labelKey, Icon }) => {
                const on = shown === value;
                const label = t(labelKey);
                // Lyrics master switch lives in Settings; tapping "With
                // lyrics" while it is off turns it back on instead of
                // dead-clicking back to the cover view.
                const wakesLyrics = value === "lyrics" && !lyricsState.enabled;
                return (
                  <Tooltip key={value}>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        role="radio"
                        aria-checked={on}
                        aria-label={wakesLyrics ? t("lyrics.turnOn") : label}
                        onClick={() => {
                          if (wakesLyrics) lyricsState.setEnabled(true);
                          setLayout(value);
                        }}
                        className={cn(
                          "grid h-7 w-[30px] cursor-pointer place-items-center rounded-[7px] transition-colors duration-[160ms] hover:text-(--fs-title)",
                          on
                            ? "bg-w160 text-(--fs-title) shadow-[0_1px_2px_var(--k300)]"
                            : "text-(--fs-seg)",
                        )}
                      >
                        <Icon />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>
                      {wakesLyrics ? t("lyrics.turnOn") : label}
                    </TooltipContent>
                  </Tooltip>
                );
              })}
            </div>
            <div className="flex-1" />
          </div>

          {/* Body, one of three. */}
          {shown === "cover" ? (
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-[26px] py-2.5">
              <Cover
                track={track}
                override={iTunesCover}
                className="w-[300px] rounded-[14px] shadow-[0_40px_80px_-28px_var(--k900),inset_0_0_0_1px_var(--w140)]"
              />
              <div className="flex flex-col items-center gap-2 text-center">
                <span className="text-[34px] font-bold leading-tight tracking-[-0.03em] text-(--fs-title)">
                  {track.title}
                </span>
                <Subtitle track={track} className="text-[15px]" />
              </div>
            </div>
          ) : null}

          {shown === "lyrics" ? (
            <div className="mx-auto flex min-h-0 w-full max-w-[1020px] flex-1 items-center gap-14 py-3.5">
              <div className="flex w-[340px] shrink-0 flex-col gap-5">
                <Cover
                  track={track}
                  override={iTunesCover}
                  className="w-full rounded-xl shadow-[0_30px_60px_-26px_var(--k900),inset_0_0_0_1px_var(--w140)]"
                />
                <div className="flex min-w-0 flex-col gap-[7px]">
                  <span className="truncate text-[27px] font-bold leading-tight tracking-[-0.025em] text-(--fs-title)">
                    {track.title}
                  </span>
                  <Subtitle track={track} className="truncate text-sm" />
                </div>
              </div>
              {/* Shorter than the cover column on purpose: a few lines
                  either side of the active one, centred on the cover. */}
              <div className="relative h-[min(400px,100%)] min-w-0 flex-1 overflow-hidden">
                <LyricsBody state={lyricsState} large backgroundIsBlank />
              </div>
            </div>
          ) : null}

          {immersive ? (
            /* The same two-column shape as the lyrics layout: the cover
               and the title on the left, the reading column on the
               right. Only the *content* of the right column differs —
               here it is the comments and the encyclopedia rather than
               the words of the song.

               The two layouts are siblings, not variants: they share a
               shape on purpose, so the view does not jump when the
               user switches between them. */
            <div className="mx-auto flex min-h-0 w-full max-w-[1020px] flex-1 items-stretch gap-14 py-3.5">
              <div className="flex w-[340px] shrink-0 flex-col justify-center gap-5">
                <Cover
                  track={track}
                  override={iTunesCover}
                  className="w-full rounded-xl shadow-[0_30px_60px_-26px_var(--k900),inset_0_0_0_1px_var(--w140)]"
                />
                <div className="flex min-w-0 flex-col gap-[7px]">
                  <span className="truncate text-[27px] font-bold leading-tight tracking-[-0.025em] text-(--fs-title)">
                    {track.title}
                  </span>
                  <Subtitle track={track} className="truncate text-sm" />
                </div>
              </div>
              {/* The reading column: a panel with the three tabs. It
                  takes the *whole* height of the row rather than a
                  fixed slice of it — the comments are read by
                  scrolling, and a short column with a wall of empty
                  space above it wastes the space the reading needs. */}
              <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-w080 bg-background/55 backdrop-blur-2xl">
                <ImmersivePanel track={track} />
              </div>
            </div>
          ) : null}

          {/* Bottom: progress, then the transport with the side clusters. */}
          <div className="flex shrink-0 flex-col gap-2.5">
            <div className="flex items-center gap-3">
              <span className="w-[38px] shrink-0 font-mono text-xs text-(--fs-time)">
                <PlaybackTime />
              </span>
              <div className="min-w-0 flex-1">
                <ProgressSlider
                  duration={duration}
                  seek={seek}
                  disabled={duration <= 0}
                />
              </div>
              <span className="w-[38px] shrink-0 text-right font-mono text-xs text-(--fs-time)">
                {formatTime(duration)}
              </span>
            </div>
            <div className="relative flex items-center justify-center gap-3">
              <div className="absolute left-0 top-1/2 flex -translate-y-1/2 items-center gap-2">
                {/* Which provider is serving the audio, and a way to
                    switch to another one that carries the same
                    recording. */}
                <SourceIndicator track={track} variant="chip" />
              </div>
              <div className="absolute right-0 top-1/2 flex -translate-y-1/2 items-center gap-2">
                <LikePill track={track} />
                <LyricsSourceButton state={lyricsState} className={chip} />
                <QueuePopover className={chip} />
                <VolumeControl className={chip} />
                <PlayerMoreMenu track={track} className={chip} />
              </div>

              <Button
                variant="ghost"
                size="icon"
                aria-label={t("action.shuffle")}
                aria-pressed={shuffle}
                onClick={() => setShuffle(!shuffle)}
                className={sideButton(shuffle)}
              >
                <IconArrowsShuffle className="size-[19px]" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("action.previous")}
                onClick={prev}
                className={ghostButton}
              >
                <IconPlayerSkipBackFilled className="size-[22px]" />
              </Button>
              <Button
                size="icon"
                aria-label={playing ? t("action.pause") : t("action.play")}
                onClick={toggle}
                className="mx-1.5 size-16 rounded-full text-brand-foreground shadow-[0_6px_20px_-4px_rgba(var(--acc1rgb),0.28),inset_0_1px_1px_var(--w220)] transition-[filter,box-shadow] duration-[140ms] hover:brightness-[1.16] hover:shadow-[0_10px_28px_-6px_rgba(var(--acc1rgb),0.36),inset_0_1px_1px_var(--w260)]"
                style={{
                  background:
                    "radial-gradient(circle at 50% 30%, var(--acc5), var(--acc1) 58%)",
                }}
              >
                {/* Sized on the glyphs themselves: the button's own
                    `[&_svg]` rule only yields to an explicit size-*. */}
                {loading ? (
                  <IconLoader2 className="size-[26px] animate-spin" />
                ) : playing ? (
                  <IconPlayerPauseFilled className="size-[26px]" />
                ) : (
                  <IconPlayerPlayFilled className="ml-0.5 size-[26px]" />
                )}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("action.next")}
                onClick={next}
                className={ghostButton}
              >
                <IconPlayerSkipForwardFilled className="size-[22px]" />
              </Button>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={repeatLabel(repeat, t)}
                    aria-pressed={repeat !== "off"}
                    onClick={cycleRepeat}
                    className={sideButton(repeat !== "off")}
                  >
                    {repeat === "one" ? (
                      <IconRepeatOnce className="size-[19px]" />
                    ) : (
                      <IconRepeat className="size-[19px]" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{repeatLabel(repeat, t)}</TooltipContent>
              </Tooltip>
            </div>
          </div>
        </div>
      </m.div>
    </TooltipProvider>
  );
}

/** Prev / next: 44px, bare until hovered. */
const ghostButton =
  "size-11 rounded-xl text-[color:var(--fs-txt)] hover:bg-w140 hover:text-[color:var(--fs-title)]";

/* ------------------------------------------------------------------ */
/* Pieces                                                              */
/* ------------------------------------------------------------------ */

/**
 * The design's like pill: glyph plus "Liked" / "Like", tinted with the
 * accent while liked. Follows Appearance -> Rating buttons the way the
 * row buttons do, so with thumbs on it grows a thumbs-down chip too.
 */
function LikePill({ track }: { track: QueueTrack }) {
  const t = useT();
  const qc = useQueryClient();
  const both = useSettingsStore((s) => s.ratingButtons === "both");
  const isDisliked = useDislikesStore((s) => !!s.ids[track.videoId]);

  // A NetEase track's heart belongs to the NetEase account, so its
  // filled state comes from the account's own collection rather than
  // the app's YouTube liked list — which knows nothing about a NetEase
  // song id.
  const isNetease = track.provider === "netease";
  const neteaseLiked = useNeteaseLikedIds(isNetease);

  // The rating for the track that is playing, fetched on demand — and
  // for a track from another platform, under the YouTube recording that
  // holds it, so the heart reflects the user's YouTube rating either
  // way.
  const { status } = useTrackLikeStatus(track);

  const isLiked = isNetease
    ? (neteaseLiked.data?.includes(track.providerTrackId ?? "") ?? false) ||
      status === "LIKE"
    : status === "LIKE";
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await action();
    } catch (err) {
      toast.error(String(err));
    } finally {
      setBusy(false);
    }
  };
  const LikeIcon = both
    ? isLiked
      ? IconThumbUpFilled
      : IconThumbUp
    : isLiked
      ? IconHeartFilled
      : IconHeart;
  const DislikeIcon = isDisliked ? IconThumbDownFilled : IconThumbDown;

  return (
    <>
      <button
        type="button"
        disabled={busy}
        aria-pressed={isLiked}
        onClick={() =>
          run(() =>
            toggleLiked({
              queryClient: qc,
              videoId: track.videoId,
              wasLiked: isLiked,
              track,
            }),
          )
        }
        className={cn(
          "flex h-[34px] cursor-pointer items-center gap-[7px] rounded-[9px] px-[13px] text-[12.5px] font-semibold tracking-[-0.005em] transition-colors duration-[140ms] hover:bg-w140",
          isLiked
            ? "bg-[rgba(var(--acc1rgb),0.14)] text-acc1 hover:bg-[rgba(var(--acc1rgb),0.2)]"
            : "bg-w070 text-[color:var(--fs-txt2)]",
        )}
      >
        <LikeIcon className="size-4" stroke={1.9} />
      </button>
      {both ? (
        <button
          type="button"
          disabled={busy}
          aria-label={isDisliked ? t("like.removeDislike") : t("like.dislike")}
          aria-pressed={isDisliked}
          onClick={() =>
            run(() =>
              toggleDisliked({
                queryClient: qc,
                videoId: track.videoId,
                wasDisliked: isDisliked,
                wasLiked: isLiked,
                track,
              }),
            )
          }
          className={cn(
            "grid size-[34px] cursor-pointer place-items-center rounded-[9px] transition-colors duration-[140ms] hover:bg-w160",
            isDisliked
              ? "bg-w160 text-[color:var(--fs-title)]"
              : "bg-w080 text-[color:var(--fs-txt2)]",
          )}
        >
          <DislikeIcon className="size-4" stroke={1.9} />
        </button>
      ) : null}
    </>
  );
}

function Cover({
  track,
  override,
  className,
}: {
  track: QueueTrack;
  override: string | null;
  className?: string;
}) {
  const setOpen = useFullscreenStore((s) => s.setOpen);
  return (
    <div
      onClick={(e) => {
        // The cover is the one thing here that is not "blank", but it
        // is the other way out: clicking the artwork collapses the
        // view. Stop the bubble so the sheet's own blank-click
        // handler does not also run.
        e.stopPropagation();
        setOpen(false);
      }}
      className={cn(
        "group/cover relative isolate aspect-square shrink-0 cursor-pointer overflow-hidden rounded-[inherit]",
        className,
      )}
    >
      {/* No shared-layout id here. The sheet itself slides in from the
          player's edge, and the cover rides along with it — a second,
          independent flight from the player bar's cover would fight
          that motion and land in the wrong place, since motion would
          have to measure this cover's box inside an already-translated
          ancestor. */}
      <div className="size-full">
        <Thumbnail
          thumbnails={track.thumbnails}
          alt={track.title}
          className="pointer-events-none size-full rounded-[inherit]"
          targetSize={1024}
          highRes
          overrideHighRes={override}
        />
      </div>
      <ArtworkOutline className="rounded-[inherit]" />
    </div>
  );
}

/**
 * Artist line, with the album after a dot when the track has one. Both
 * link through like the player card's; following one lands on a page
 * under this view, so the view closes as the link is taken.
 */
function Subtitle({
  track,
  className,
}: {
  track: QueueTrack;
  className?: string;
}) {
  const setOpen = useFullscreenStore((s) => s.setOpen);
  return (
    <span
      className={cn("text-(--fs-sub)", className)}
      onClickCapture={(e) => {
        if ((e.target as HTMLElement).closest("a, button")) setOpen(false);
      }}
    >
      <ArtistLinks artists={track.artists} fallback={track.subtitle ?? ""} />
      {track.album ? (
        <>
          {track.artists?.length || track.subtitle ? " · " : null}
          {track.albumId ? (
            <EntityLink to="/album/$id" id={track.albumId} event="nav:album">
              {track.album}
            </EntityLink>
          ) : (
            track.album
          )}
        </>
      ) : null}
    </span>
  );
}

/* The layout switch's three glyphs, drawn as in the design. */

function CoverGlyph() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <rect
        x="9.5"
        y="8"
        width="5"
        height="5"
        rx="1.2"
        fill="currentColor"
        stroke="none"
      />
      <path d="M9 16h6" strokeLinecap="round" />
    </svg>
  );
}

function LyricsGlyph() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <rect
        x="6"
        y="8"
        width="4.5"
        height="4.5"
        rx="1.2"
        fill="currentColor"
        stroke="none"
      />
      <path d="M13 9h5M13 12h5M13 15h3" strokeLinecap="round" />
    </svg>
  );
}

function ImmersiveGlyph() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect
        x="3"
        y="4"
        width="18"
        height="16"
        rx="2.5"
        fill="currentColor"
        fillOpacity="0.34"
      />
      <path d="M6.5 16h7M6.5 12.8h4" strokeLinecap="round" />
    </svg>
  );
}

const LAYOUTS: {
  value: FullscreenLayout;
  labelKey: string;
  Icon: () => React.JSX.Element;
}[] = [
  { value: "cover", labelKey: "player.fsCentered", Icon: CoverGlyph },
  { value: "lyrics", labelKey: "player.fsWithLyrics", Icon: LyricsGlyph },
  {
    value: "immersive",
    labelKey: "player.fsImmersive",
    Icon: ImmersiveGlyph,
  },
];
