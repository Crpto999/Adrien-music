import { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback } from "react";
import { IconRefresh } from "@tabler/icons-react";
import { IconNotes } from "@tabler/icons-react";
import { playerIconButton } from "@/components/layout/player-chrome";
// Fork note: IconCheck from upstream's menu restyle is omitted for now —
// this port keeps fork's lyrics on/off toggle + radio group. It will return
// with the shared menu-chrome port (869f271). RotateCw/MicVocal (Lucide)
// were replaced by Tabler IconRefresh/IconMicrophoneFilled in this port.
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { Lyrics, TimedLine } from "@/lib/lyrics/types";
import { currentLyricText, findActiveIdx } from "@/lib/lyrics/current-line";
import { LyricClock } from "@/lib/lyrics/clock";
import { buildSegments, revealedFraction, sweepLineIndex } from "@/lib/lyrics/sweep";
import type { SweepSegment } from "@/lib/lyrics/sweep";
import { currentAudioElement } from "@/lib/audio-engine";
import {
  SOURCE_LABELS,
  SOURCE_ORDER,
  useLyricsSources,
  type LyricsSource,
} from "@/lib/lyrics/sources";
import { usePlaybackStore } from "@/lib/store/playback";
import type { QueueTrack } from "@/lib/store/playback";
import { useScrubStore } from "@/lib/store/scrub";
import { useSettingsStore } from "@/lib/store/settings";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const PREF_KEY = "ytm:lyrics-source";

/**
 * The sources that only apply to a track from their own platform.
 *
 * They are keyed on the platform's own track id, so a YouTube track has
 * nothing for them to answer about.
 */
const CN_SOURCES: LyricsSource[] = ["netease", "migu", "kugou", "qq"];

type Pref = LyricsSource | "auto";
/** "none" means the source answered and has nothing. "error" means it never
 *  answered. Keeping them apart is the whole point of the provider change:
 *  an unreachable source must stay selectable so the user can retry it. */
type Availability = "lrc" | "plain" | "loading" | "none" | "error";

function loadPref(): Pref {
  try {
    const v = localStorage.getItem(PREF_KEY);
    if (v === "auto") return "auto";
    // Checked against SOURCE_ORDER rather than a hardcoded list of names.
    // The list version silently dropped any source added later: pinning
    // one and restarting reverted you to "auto" with no explanation.
    if (v && (SOURCE_ORDER as string[]).includes(v)) return v as Pref;
  } catch {
    /* noop */
  }
  return "auto";
}

function savePref(p: Pref) {
  try {
    localStorage.setItem(PREF_KEY, p);
  } catch {
    /* noop */
  }
}

export type LyricsViewState = {
  active: Lyrics | null;
  isLoading: boolean;
  hasTrack: boolean;
  pref: Pref;
  setPref: (p: Pref) => void;
  best: LyricsSource | null;
  availability: Record<LyricsSource, Availability>;
  /**
   * The sources worth showing for this track.
   *
   * The Chinese platforms are keyed on the platform's own track id, so
   * they only apply to a track that came from that platform. Listing
   * them for a YouTube track would put three permanently-grey rows in
   * the menu — noise that says nothing.
   */
  sources: LyricsSource[];
  /**
   * The provider's own lyrics source, when the track plays from a
   * platform that has one.
   *
   * This is the pairing the app promises: the audio and the words come
   * from the same platform. It is `null` for a track playing from
   * YouTube on a build without YouTube Music lyrics, and for the
   * metadata-only providers.
   */
  ownLyricsSource: LyricsSource | null;
  /** Master on/off, mirrored from the persisted `ytm-settings` store —
   *  shared across the side card and the floating window. */
  enabled: boolean;
  setEnabled: (v: boolean) => void;
  /** Sources that failed to answer at all. */
  failed: LyricsSource[];
  /** A retry is in flight. */
  isRetrying: boolean;
  retryFailed: () => void;
  /** The NetEase song id the track is known by, when it has one. */
  neteaseSongId?: string;
};

/**
 * Drives the inline lyrics panel: fires queries to all three sources,
 * tracks the user's source preference, and exposes a render-ready
 * state. Auto-pick rule: any timed source > any plain source, ordered
 * by `SOURCE_ORDER`.
 *
 * Used by the player bar to render `<LyricsBody>` (the flowing area)
 * and `<LyricsSourceButton>` (the mic-icon dropdown) from the same
 * state — without running the underlying queries twice.
 *
 * When the user has turned lyrics off, `enabled` gates the underlying
 * `useLyricsSources` queries so the three network fetches don't fire
 * at all, and `LyricsBody` skips rendering `<TimedLyrics>` — which is
 * what actually stops its `requestAnimationFrame` auto-scroll loop and
 * high-frequency playback-position subscription.
 */
export function useLyricsView(track: QueueTrack | undefined): LyricsViewState {
  const [pref, setPrefState] = useState<Pref>(loadPref);
  const setPref = (p: Pref) => {
    setPrefState(p);
    savePref(p);
  };

  const enabled = useSettingsStore((s) => s.lyricsEnabled);
  const setEnabled = useSettingsStore((s) => s.setLyricsEnabled);

  const {
    queries,
    displayLyrics,
    best,
    isLoading,
    failed,
    isRetrying,
    retryFailed,
    sourceOrder,
    ownLyricsSource,
    neteaseSongId,
  } = useLyricsSources(track, !!track && enabled);

  const availability = useMemo(() => {
    const acc = {} as Record<LyricsSource, Availability>;
    for (const s of SOURCE_ORDER) {
      const q = queries[s];
      acc[s] = q.data
        ? q.data.kind === "timed"
          ? "lrc"
          : "plain"
        : q.isLoading
          ? "loading"
          : q.isError
            ? "error"
            : "none";
    }
    return acc;
  }, [queries]);

  const activeSource: LyricsSource | null = pref === "auto" ? best : pref;
  // The displayed lyrics are the Simplified-Chinese ones — the
  // conversion happens once, in the sources hook, so every source is
  // shown in the same script.
  const active = activeSource ? (displayLyrics[activeSource] ?? null) : null;

  // The sources worth showing for this track, in the order they were
  // tried.
  //
  // The provider's own source leads — that is the pairing the app
  // promises: the audio and the words come from the same platform. The
  // rest follow as fallbacks, so a track whose provider has no lyrics
  // still has somewhere to go.
  //
  // The Chinese platforms' rows are dropped for a track that did not
  // come from one of them: they are keyed on the platform's own track
  // id, so there is nothing to ask them about a YouTube track, and
  // listing them would put permanently-grey rows in the menu.
  //
  // NetEase is the exception, when the app knows the song's NetEase
  // id: the daily pick the user hearted is a YouTube row that is also
  // a known NetEase recording, and its NetEase words are exactly the
  // right ones. So the row stays — the user can pick it, and get the
  // platform's own lyrics.
  const sources = useMemo(() => {
    const provider = track?.provider;
    const applicable: LyricsSource[] =
      provider === "netease"
        ? ["netease"]
        : provider === "migu"
          ? ["migu"]
          : provider === "kugou"
            ? ["kugou"]
            : provider === "qq"
              ? ["qq"]
              : [];
    if (applicable.includes("netease")) return sourceOrder;
    // A YouTube track the app knows on NetEase keeps the NetEase row.
    if (neteaseSongId) {
      return sourceOrder.filter(
        (s) => s === "netease" || !CN_SOURCES.includes(s),
      );
    }
    return sourceOrder.filter(
      (s) => applicable.includes(s) || !CN_SOURCES.includes(s),
    );
  }, [sourceOrder, track?.provider, neteaseSongId]);

  return {
    active,
    isLoading,
    hasTrack: !!track,
    pref,
    setPref,
    best,
    availability,
    sources,
    ownLyricsSource,
    neteaseSongId,
    enabled,
    setEnabled,
    failed,
    isRetrying,
    retryFailed,
  };
}

export function LyricsBody({
  state,
  large = false,
  backgroundIsBlank = false,
}: {
  state: LyricsViewState;
  /** Full-screen sizing: bigger type, same motion. */
  large?: boolean;
  /**
   * Whether the space *around* the lines counts as empty surface.
   *
   * The full-screen view wants it to: a click on the background there
   * closes the view, and only the text itself seeks. The player card
   * does not — there, the lyrics column is a region of content, and a
   * stray click beside a line should not blow the card open.
   */
  backgroundIsBlank?: boolean;
}) {
  const t = useT();
  if (!state.hasTrack) return null;
  if (!state.enabled) return null;
  if (state.isLoading && !state.active) {
    return (
      <p className="px-4 py-2 text-sm text-muted-foreground">
        {t("lyrics.loading")}
      </p>
    );
  }
  if (!state.active) {
    // A source that never answered is not a track without lyrics. Say which
    // it was and offer another go, rather than the flat "No lyrics found."
    // that used to cover both and then sat in the disk cache for 24h.
    if (state.failed.length > 0) {
      return (
        <div className="flex flex-col items-start gap-2 px-4 py-2">
          <p className="text-sm text-muted-foreground">
            {t("lyrics.couldNotReach", {
              sources: state.failed.map((s) => SOURCE_LABELS[s]).join(", "),
            })}
          </p>
          <Button
            variant="secondary"
            size="sm"
            onClick={state.retryFailed}
            disabled={state.isRetrying}
          >
            <IconRefresh className={state.isRetrying ? "animate-spin" : ""} />
            {state.isRetrying ? t("lyrics.trying") : t("lyrics.tryAgain")}
          </Button>
        </div>
      );
    }
    return (
      <p className="px-4 py-2 text-sm text-muted-foreground">
        {t("lyrics.notFound")}
      </p>
    );
  }
  if (state.active.kind === "timed") {
    return (
      <TimedLyrics
        lines={state.active.lines}
        translation={state.active.translation}
        large={large}
        backgroundIsBlank={backgroundIsBlank}
      />
    );
  }
  return (
    <PlainLyrics
      text={state.active.text}
      translation={state.active.translation}
      large={large}
    />
  );
}

/**
 * The lyric line that is current at `position`.
 *
 * Shared with the bottom bar, which shows the active line as a
 * one-line readout under the track metadata. It resolves the same
 * way the scrolling panel does, so the readout and the panel always
 * name the same line — including the lookahead that starts the
 * cross-fade early.
 *
 * Plain (untimed) lyrics have no positions to resolve, so the first
 * non-empty line stands in for the whole song.
 */

/**
 * Subscribes to the playhead and returns the current lyric line.
 *
 * Deliberately a hook of its own: the playhead ticks ~4×/s, and a
 * caller that inlined the subscription would re-render its whole
 * subtree on every tick. Kept in a leaf component, only the readout
 * text re-renders.
 */
export function useCurrentLyricText(state: LyricsViewState): string | null {
  const playbackPosition = usePlaybackStore((s) => s.position);
  // While the slider is being dragged the store's position still follows
  // the audio element, since the seek lands on release. Preview the drag
  // target so the readout tracks the thumb the whole way.
  const scrub = useScrubStore((s) => s.scrub);
  const position = scrub ?? playbackPosition;
  const active = state.active;

  return useMemo(() => currentLyricText(active, position), [active, position]);
}

/** How far from the top of the viewport the active line should sit,
 *  as a fraction of the visible height. 0.5 = perfectly centered;
 *  smaller pushes the active line up and reveals more upcoming text. */
const ACTIVE_LINE_VIEWPORT_RATIO = 0.36;

/** Duration of the auto-scroll that re-centers the active line.
 *  Native `scrollTo({ behavior: "smooth" })` is non-configurable in
 *  Chromium (~300 ms regardless of distance), which feels jumpy on
 *  long jumps — we drive the scroll ourselves with rAF instead. */
const SCROLL_DURATION_MS = 720;

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** Sampler for a CSS-style `cubic-bezier(x1, y1, x2, y2)`, so a scroll we
 *  drive from rAF can share a curve with the CSS transitions running
 *  beside it. Bisection on the x axis: 20 steps resolve the parameter far
 *  finer than a pixel of scroll, and the whole thing runs a few hundred
 *  times per seek, which is nothing. */
function cubicBezier(x1: number, y1: number, x2: number, y2: number) {
  const axis = (a: number, b: number, s: number) =>
    3 * (1 - s) * (1 - s) * s * a + 3 * (1 - s) * s * s * b + s * s * s;
  return (t: number) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    let lo = 0;
    let hi = 1;
    let s = t;
    for (let i = 0; i < 20; i++) {
      s = (lo + hi) / 2;
      if (axis(x1, x2, s) < t) lo = s;
      else hi = s;
    }
    return axis(y1, y2, s);
  };
}

/** Seek curve: hard start, long decelerating tail (the one iOS uses for
 *  sheet transitions). Keep in sync with the `[data-lyrics-seek]` rule in
 *  index.css so the scroll and the line highlight decelerate together. */
const easeOutSeek = cubicBezier(0.32, 0.72, 0, 1);

/** A position change bigger than this is a seek, not playback. The audio
 *  engine pushes the playhead a few times a second, so anything past a
 *  second means it was moved: the progress slider, a click on a line,
 *  media keys, the floating player. */
const SEEK_JUMP_S = 1.2;

/** Auto-scroll duration for a seek. Short enough that dragging the slider
 *  feels like the text is attached to the thumb, long enough to read as
 *  motion rather than a cut. Each new drag step interrupts the previous
 *  animation from wherever it got to, the same way a re-triggered CSS
 *  transition would. */
const SEEK_SCROLL_DURATION_MS = 350;

/**
 * How far the words have to move in one frame before it counts as the
 * player jumping rather than the song playing, in milliseconds.
 *
 * A frame is about 16 ms, so a playing song moves the words by roughly
 * that much. Anything well beyond it is a seek — and a seek has to be
 * announced to the clock, or the words crawl to the new place instead
 * of going there.
 */
const SEEK_JUMP_MS = 250;

/**
 * One piece of a line, as the frame loop sees it: the segment it came
 * from, and the element the stop is written to.
 */
type SweepPiece = {
  /** The segment, with the span of time it is sung over. */
  segment: SweepSegment;
  /** The element the gradient stop is written to. */
  element: HTMLElement;
};

/**
 * The lyric sweep, driven every frame.
 *
 * ## Why this is not React state
 *
 * The highlight has to move continuously, and the store's `position`
 * only ticks about four times a second — that is the browser's
 * `timeupdate` cadence. React would have to re-render the whole lyric
 * list sixty times a second to keep up with a sweep, which rebuilds
 * every line and every piece of every line on every frame.
 *
 * So the sweep is written straight onto the elements instead. React
 * renders the pieces once; the frame loop moves the gradient stops.
 * A gradient stop is a number, and a number written to a custom
 * property repaints that piece and nothing else.
 *
 * ## Where the position comes from
 *
 * The clock (`lib/lyrics/clock.ts`) is a port of the reference
 * implementation: it runs on its own frames and is *steered* by the
 * player's readings rather than set by them, so a reading that arrives
 * late cannot roll the words backwards.
 *
 * The reading itself comes from the audio element's `currentTime`,
 * which is exact and continuous — unlike the store's `position`, which
 * is only as fresh as the last `timeupdate`. When there is no element
 * to read (the floating window, where the audio lives in the main
 * window), the store's position is used instead, and the sweep simply
 * moves in the steps the store moves in.
 */
function useLyricSweep() {
  // The pieces of every line, by line key. The frame loop walks the
  // active line's pieces and writes their stops.
  //
  // The key is a string rather than a number because a line can have
  // two sets of pieces: the lead vocal's and the answering vocal's
  // under it. They are different voices with different timings, and
  // they are highlighted separately.
  const piecesRef = useRef<Map<string, SweepPiece[]>>(new Map());

  /** Registers a line's pieces. */
  const register = useCallback((key: string, pieces: SweepPiece[]) => {
    if (pieces.length === 0) piecesRef.current.delete(key);
    else piecesRef.current.set(key, pieces);
  }, []);

  /**
   * Forgets a line's pieces.
   *
   * A line that unmounts leaves its pieces behind, and the frame loop
   * would keep writing to elements that are no longer in the document.
   */
  const unregister = useCallback((key: string) => {
    piecesRef.current.delete(key);
  }, []);

  return { piecesRef, register, unregister };
}

/**
 * Write the sweep onto the line being sung.
 *
 * The gradient stop of each piece is the percentage of that piece which
 * has been sung. Writing it is a single custom-property set, which
 * repaints that piece and nothing else.
 *
 * The line is chosen from the *smooth* position the clock produces, not
 * from the store's position: the store only moves four times a second,
 * and the sweep has to change lines at the moment the words say so.
 */
function paintSweep(
  lines: TimedLine[],
  pieces: Map<string, SweepPiece[]>,
  positionMs: number,
): void {
  const seconds = positionMs / 1000;

  // The line being sung, and the answering vocal under it if it has one.
  const index = sweepLineIndex(lines, seconds);
  if (index < 0) return;

  const line = lines[index];
  if (!line) return;

  const targets: (SweepPiece[] | undefined)[] = [pieces.get(`${index}`)];
  if (line.background) {
    targets.push(pieces.get(`${index}:bg`));
  }

  for (const linePieces of targets) {
    if (!linePieces || linePieces.length === 0) continue;
    paintPieces(linePieces, seconds);
  }
}

/** Writes the sweep positions of one line's pieces. */
function paintPieces(linePieces: SweepPiece[], seconds: number): void {
  for (const piece of linePieces) {
    const element = piece.element;
    if (!element) continue;

    const percent = revealedFraction(piece.segment, seconds) * 100;

    // Only write when it moved: a custom-property write is cheap but not
    // free, and most frames leave most pieces where they were.
    const rounded = Math.round(percent * 100) / 100;
    if (element.dataset.sweep === String(rounded)) continue;
    element.dataset.sweep = String(rounded);
    element.style.setProperty("--lyric-sweep", `${percent}%`);
  }
}

function TimedLyrics({
  lines,
  translation,
  large = false,
  backgroundIsBlank = false,
}: {
  lines: TimedLine[];
  /**
   * The same lines, translated.
   *
   * The translation is lined up with the original by *when* each line
   * starts, not by which line happens to be in the same position in the
   * list — see `normalize.ts`. The two are published separately and
   * their timings drift apart by a fraction of a second here and
   * there, so matching them by position slides the translation under
   * the wrong words as soon as the two lists differ at all.
   */
  translation?: TimedLine[];
  large?: boolean;
  /** See `LyricsBody`'s prop of the same name. */
  backgroundIsBlank?: boolean;
}) {
  const t = useT();
  const scrollRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);
  const seekHoldRef = useRef<number | null>(null);
  const playbackPosition = usePlaybackStore((s) => s.position);
  const playing = usePlaybackStore((s) => s.playing);
  const seek = usePlaybackStore((s) => s.seek);
  // While the slider is being dragged the store's position still follows
  // the audio element, since the seek lands on release. Preview the drag
  // target so the text tracks the thumb the whole way.
  const scrub = useScrubStore((s) => s.scrub);
  const position = scrub ?? playbackPosition;

  const activeIdx = findActiveIdx(lines, position);
  const prevActiveRef = useRef(activeIdx);
  const prevPositionRef = useRef(position);

  const { piecesRef, register, unregister } = useLyricSweep();

  // The values the frame loop reads, held in refs.
  //
  // The loop must not be torn down and rebuilt when they change: it
  // runs every frame, and rebuilding it would reset the clock — the
  // song's position ticks four times a second, so the loop would be
  // restarted four times a second and the words would never move
  // smoothly at all.
  const loopRef = useRef({ lines, position, playing });
  loopRef.current = { lines, position, playing };

  // The frame loop: the sweep's own playhead.
  //
  // It runs on every frame while the panel is mounted, and writes the
  // gradient stops of the active line's pieces straight onto the
  // elements. React is not involved: a re-render per frame would
  // rebuild the whole lyric list sixty times a second.
  //
  // The position it draws comes from the audio element when there is
  // one — `currentTime` is exact, where the store's `position` is only
  // as fresh as the last `timeupdate` — and from the store otherwise.
  useEffect(() => {
    // The clock is created here and only here, so it lives exactly as
    // long as this run of frames. A new lyric set means a new song, and
    // the clock starts over with it.
    const clock = new LyricClock(loopRef.current.position * 1000);

    let frame = 0;
    // The playhead moving on purpose. The clock only rolls the words
    // backwards when this changes, so a reading that merely arrives
    // late — or a track that is still loading — cannot rewind the
    // lyrics.
    let discontinuity = 0;
    let lastReported = Number.NaN;
    // The position the words are drawn at, so a change to it is a jump
    // the player announced.
    let lastShown = loopRef.current.position * 1000;
    // The last position the store reported, so a seek can be seen as
    // the store's own move rather than as a bad reading.
    let lastStore = loopRef.current.position;

    const tick = () => {
      const now = performance.now();
      const {
        lines: currentLines,
        position: storePosition,
        playing: isPlaying,
      } = loopRef.current;

      const audio = currentAudioElement();
      // The element's own time when there is one; the store's when
      // there is not (the floating window, where the audio lives in the
      // main window and only the transport state crosses over).
      const reported =
        (audio ? audio.currentTime : storePosition) * 1000;

      // The store moved: the player seeked. This is announced to the
      // clock below, so the words may roll to the new place rather than
      // crawling there.
      if (Math.abs(storePosition - lastStore) > 0.5) discontinuity++;
      lastStore = storePosition;

      // A jump the player did not announce is a reading that disagrees
      // with the song; the clock holds it back until the next one
      // confirms it. A jump of more than a second is a seek.
      if (
        !Number.isNaN(lastReported) &&
        Math.abs(reported - lastReported) > 1000
      ) {
        discontinuity++;
      }
      lastReported = reported;

      // Paused: the words settle where the song is and stay there.
      if (!isPlaying) {
        clock.hold(reported, now);
        lastShown = reported;
        paintSweep(currentLines, piecesRef.current, reported);
        frame = requestAnimationFrame(tick);
        return;
      }

      const shown = clock.frame(now, reported, now, discontinuity);

      // The words moved further than a frame's worth of playback: the
      // player jumped, and the clock is told so it may roll the words
      // to the new place rather than crawling there.
      if (Math.abs(shown - lastShown) > SEEK_JUMP_MS) discontinuity++;
      lastShown = shown;

      paintSweep(currentLines, piecesRef.current, shown);
      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [lines, piecesRef]);

  // On mount and whenever the lyric set changes (new track), snap the
  // active line into view without animation. Without this the animated
  // effect below never fires on mount (prevActiveRef starts equal to the
  // initial activeIdx), so opening the panel mid-song — or skipping tracks
  // while it stays mounted — leaves the active line off-screen / stale.
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const idx = findActiveIdx(
      lines,
      useScrubStore.getState().scrub ?? usePlaybackStore.getState().position,
    );
    prevActiveRef.current = idx;
    if (idx < 0) {
      container.scrollTop = 0;
      return;
    }
    const el = container.querySelector<HTMLElement>(`[data-line-idx="${idx}"]`);
    if (!el) {
      container.scrollTop = 0;
      return;
    }
    const cRect = container.getBoundingClientRect();
    const eRect = el.getBoundingClientRect();
    const elTopWithinContent = eRect.top - cRect.top + container.scrollTop;
    const target =
      idx === 0
        ? 0
        : container.clientHeight * ACTIVE_LINE_VIEWPORT_RATIO -
          el.clientHeight / 2;
    container.scrollTop = Math.max(0, elTopWithinContent - target);
  }, [lines]);

  // A layout effect, not a passive one: on a seek the container has to be
  // repositioned and the line cross-fade suppressed *before* the browser
  // paints the frame that already carries the new active line.
  useLayoutEffect(() => {
    const previous = prevPositionRef.current;
    prevPositionRef.current = position;
    // Dragging the slider is a continuous seek, so every step of it
    // counts however small: the thumb can crawl a line at a time.
    const isSeek =
      scrub !== null || Math.abs(position - previous) > SEEK_JUMP_S;

    if (activeIdx === prevActiveRef.current) return;
    prevActiveRef.current = activeIdx;
    if (activeIdx < 0) return;
    const container = scrollRef.current;
    if (!container) return;
    const el = container.querySelector<HTMLElement>(
      `[data-line-idx="${activeIdx}"]`,
    );
    if (!el) return;
    // Position the active line above center so more upcoming lines stay
    // visible. getBoundingClientRect avoids depending on offsetParent.
    const cRect = container.getBoundingClientRect();
    const eRect = el.getBoundingClientRect();
    const elTopWithinContent = eRect.top - cRect.top + container.scrollTop;
    // The very first line is treated as a special case: we pin it to
    // the top of the viewport instead of the usual ~36% position. For
    // any later line, the active-line-above-center rule applies.
    const target =
      activeIdx === 0
        ? 0
        : container.clientHeight * ACTIVE_LINE_VIEWPORT_RATIO -
          el.clientHeight / 2;
    const targetTop = Math.max(0, elTopWithinContent - target);

    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;

    if (isSeek) {
      // `data-lyrics-seek` shortens the per-line color/scale transition to
      // match the scroll (see index.css). Set from a layout effect, so it
      // is in place before the browser styles the frame that already
      // carries the new active line — the slow 1.26s cross-fade never gets
      // a chance to start. Held for the length of the scroll rather than
      // cleared next frame: a running transition keeps its original
      // timing, but the next drag step must find the attribute still on.
      container.dataset.lyricsSeek = "true";
      if (seekHoldRef.current !== null) clearTimeout(seekHoldRef.current);
      seekHoldRef.current = window.setTimeout(() => {
        seekHoldRef.current = null;
        delete container.dataset.lyricsSeek;
      }, SEEK_SCROLL_DURATION_MS);
    }

    const startTop = container.scrollTop;
    const delta = targetTop - startTop;
    if (Math.abs(delta) < 1) return;

    // Seeking gets the short decelerating curve; playback keeps the long
    // symmetric glide.
    const duration = isSeek ? SEEK_SCROLL_DURATION_MS : SCROLL_DURATION_MS;
    const ease = isSeek ? easeOutSeek : easeInOutCubic;
    const startTs = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - startTs) / duration);
      container.scrollTop = startTop + delta * ease(t);
      if (t < 1) {
        rafRef.current = requestAnimationFrame(step);
      } else {
        rafRef.current = null;
      }
    };
    rafRef.current = requestAnimationFrame(step);
    // `position` is a dependency even though only `activeIdx` moves the
    // scroll: the seek check has to see every tick, otherwise a jump that
    // lands inside the current line would sit in the ref and snap the
    // *next*, perfectly ordinary line change.
  }, [activeIdx, position, scrub]);

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      if (seekHoldRef.current !== null) clearTimeout(seekHoldRef.current);
    };
  }, []);

  return (
    // The lyrics column is content, not a control: a click on the
    // *background* around the lines is a click on empty surface, and in
    // the full-screen view that closes it. Only the text itself is
    // interactive (the buttons below), so the column no longer opts out
    // of the blank-click check — `data-blank-exclude` used to swallow
    // every background click, which meant the background did nothing
    // at all.
    //
    // `backgroundIsBlank` is the exception: the player card keeps the
    // column excluded, because there a stray click beside a line should
    // not blow the card open.
    <div
      data-blank-exclude={backgroundIsBlank ? undefined : ""}
      className="relative flex h-full min-h-0 flex-col"
    >
      <div
        ref={scrollRef}
        className={cn(
          // The right inset is the room the active line's `scale-[1.06]`
          // needs. Text wraps against the layout box, but the scale is a
          // paint-time transform anchored at `origin-left`, so the active
          // line paints 6% wider than the box it wrapped inside and the
          // tail of the top row fell outside the column (`overflow-y-auto`
          // clips the x axis too). Reserving the overhang here rather than
          // on the active line alone keeps every line wrapping at the same
          // width, so nothing reflows at the moment a line lights up.
          // Percentage, not a fixed inset: the player card is resizable.
          "lyrics-no-scrollbar flex h-full flex-col gap-1 overflow-y-auto pl-1 pr-[6%] pt-0 pb-16",
          // The top fade kicks in only after the karaoke has moved past
          // the first line — that way the first line stays crisp at the
          // top of the column while the song hasn't started or is on
          // line 0. The bottom fade is on throughout: the column runs
          // past the panel edge from the very first line, and without it
          // the last row is sliced through mid-glyph.
          activeIdx >= 1 ? "lyrics-mask" : "lyrics-mask-bottom",
        )}
      >
        {lines.map((line, i) => {
          const isActive = i === activeIdx;
          const isPast = i < activeIdx;
          // A break marker is drawn as a break, not as a line of words.
          if (line.gap) {
            return (
              <div
                key={i}
                data-line-idx={i}
                className="lyrics-line flex items-center gap-3 px-2 py-1"
                aria-hidden
              >
                <span className="h-px w-8 shrink-0 bg-muted-foreground/25" />
                <span className="text-xs tracking-[0.2em] text-muted-foreground/30">
                  {t("lyrics.instrumental")}
                </span>
              </div>
            );
          }
          return (
            // The row is a plain container, not a button: the *text* is
            // what seeks. Making the whole row a button would make its
            // padding a click target too, so a click on the empty space
            // beside a short line would seek instead of letting the
            // background close the full-screen view.
            <div
              key={i}
              data-line-idx={i}
              // The line's state drives the sweep's colours. The
              // attribute is what the CSS keys on, and the colours are
              // registered custom properties, so the change from one
              // state to the next cross-fades instead of snapping.
              data-lyrics-state={isActive ? "active" : isPast ? "past" : "future"}
              className={cn(
                // Same font-size on every line so the active line can't
                // grow into a second row and shove neighbours around.
                // The "active is bigger" feel comes from a transform
                // scale (off the layout flow) plus weight + glow.
                //
                // Cross-fade duration is a touch longer than
                // `ACTIVE_LOOKAHEAD_S` (800 ms) so the highlight is
                // well past the midpoint by the time the new line
                // actually starts, but still feels deliberate rather
                // than abrupt. ease-in-out softens both ends.
                // `scale` lives on its own CSS property in Tailwind v4
                // (not `transform`), so it's listed explicitly in the
                // transition. Both branches set a `scale-*` so the
                // browser has a defined start AND end to interpolate.
                //
                // The row is deliberately NOT interactive and carries no
                // hover: it is the empty space around the words, and in
                // the full-screen view a click there closes the sheet.
                "lyrics-line origin-left rounded-md px-2 py-1 text-left font-[650] leading-snug transition-[scale,color] duration-[1260ms] ease-in-out",
                large
                  ? "px-3 py-3.5 text-[31px] font-bold leading-[1.18] tracking-[-0.025em]"
                  : "text-lg",
                isActive
                  ? "scale-[1.06] text-foreground"
                  : isPast
                    ? "scale-100 text-muted-foreground/40"
                    : "scale-100 text-muted-foreground/70",
              )}
            >
              <button
                type="button"
                onClick={() => seek(line.start)}
                className={cn(
                  // The hover belongs to the TEXT, not to the row's
                  // background: the row keeps its transparent padding, so
                  // hovering near the words does not paint a slab behind
                  // them, and the empty space beside a short line stays
                  // empty space (a click there closes the full-screen
                  // view rather than seeking).
                  //
                  // `w-fit max-w-full` makes the button's box hug the
                  // words: it shrinks to a short line and still wraps a
                  // long one at the column's width, so the hover area is
                  // the text itself either way.
                  //
                  // `group/words` lets the karaoke words pick up the
                  // same hover — they set their own colours, which would
                  // otherwise beat the button's inherited one.
                  "group/words block w-fit max-w-full cursor-pointer text-left transition-colors duration-200",
                  "hover:text-brand",
                )}
              >
                <SweptLine
                  line={line}
                  sweepKey={`${i}`}
                  register={register}
                  unregister={unregister}
                />
              </button>
              {/* The answering vocal, under the line it answers. It is
                  smaller and dimmer than the lead: it is a second
                  voice, not a second lyric line. */}
              {line.background ? (
                <div
                  className={cn(
                    "mt-0.5 pl-3 text-[0.82em] leading-snug",
                    isActive
                      ? "text-muted-foreground/70"
                      : "text-muted-foreground/35",
                  )}
                >
                  <SweptLine
                    line={line.background}
                    secondary
                    sweepKey={`${i}:bg`}
                    register={register}
                    unregister={unregister}
                  />
                </div>
              ) : null}
              {/* The translation, under the line it belongs to. It is
                  dimmer and smaller: it is a reading aid, not the
                  thing the karaoke highlight is following. It seeks
                  too — it is the same line of the same song — and it
                  lights up on its own hover rather than the row's. */}
              {translation?.[i]?.text ? (
                <button
                  type="button"
                  onClick={() => seek(line.start)}
                  className={cn(
                    "mt-0.5 block w-fit max-w-full cursor-pointer text-left text-sm font-normal transition-colors duration-200",
                    "hover:text-brand",
                    isActive
                      ? "text-muted-foreground"
                      : "text-muted-foreground/50",
                  )}
                >
                  {translation[i].text}
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
      {/* Static blur overlay — sits over the top of the lyrics column
          and applies `backdrop-filter` to whatever is visually behind
          it. Lines passing through the strip appear blurred, but the
          blur travels with the viewport, not the content — so when the
          user manually scrolls up to find an earlier line, that line
          becomes clear as it leaves the blurred strip.
          When the very first line is active it sits at viewport top
          (no above-center offset), so we fade the overlay out to keep
          the first line crisp. */}
      <div
        aria-hidden
        className="lyrics-blur-overlay pointer-events-none absolute inset-x-0 top-0 h-[26%] transition-opacity duration-500 ease-in-out"
        style={{ opacity: activeIdx <= 0 ? 0 : 1 }}
      />
      {/* The bottom edge softens the same way as the top, so upcoming
          lines dissolve out of the column instead of stopping on a
          line. */}
      <div
        aria-hidden
        className="lyrics-blur-overlay-bottom pointer-events-none absolute inset-x-0 bottom-0 h-[26%]"
      />
    </div>
  );
}

/**
 * A line of lyrics, with the highlight sweeping across it.
 *
 * The line is cut into pieces — a character each for a script written
 * without spaces, a word each for a script written with them — and each
 * piece carries the span of time it is sung over. The highlight is a
 * gradient across each piece, so it travels *through* the piece rather
 * than jumping from one to the next.
 *
 * The old rendering switched a word on and off at its boundaries,
 * which read as a series of jumps rather than as singing. This one
 * moves continuously, which is what the audio actually does.
 *
 * Only the active line highlights: the pieces that have been sung are
 * bright, the piece being sung is bright at its leading edge, and the
 * rest sit at the line's dimmed colour. The inactive lines keep the
 * plain text — the line-level highlight is enough there, and a
 * per-piece highlight on twenty dim lines would be noise.
 *
 * The sweep's position is written straight onto the elements by the
 * frame loop below rather than being React state: a re-render per
 * frame would rebuild the whole lyric list sixty times a second.
 */
function SweptLine({
  line,
  secondary = false,
  sweepKey,
  register,
  unregister,
}: {
  line: TimedLine;
  /**
   * The answering vocal under a lead line.
   *
   * It is a second voice rather than a second lyric line, so it is
   * dimmer and it does not take the hover the lead does.
   */
  secondary?: boolean;
  /** The key this line's pieces are registered under. */
  sweepKey: string;
  /**
   * Hands the line's pieces to the frame loop, which writes their
   * sweep positions.
   */
  register: (key: string, pieces: SweepPiece[]) => void;
  /** Takes them back, when the line goes away. */
  unregister: (key: string) => void;
}) {
  const segments = useMemo(() => buildSegments(line), [line]);
  const refs = useRef<(HTMLElement | null)[]>([]);

  // The pieces are handed over whenever the line's own shape changes.
  // The frame loop reads them to know where the highlight is.
  useEffect(() => {
    register(
      sweepKey,
      segments.map((segment, index) => ({
        segment,
        element: refs.current[index] as HTMLElement,
      })),
    );
  }, [segments, sweepKey, register]);

  // A line that goes away takes its pieces with it: the frame loop
  // would otherwise keep writing to elements that are no longer in the
  // document.
  useEffect(() => {
    return () => unregister(sweepKey);
  }, [sweepKey, unregister]);

  if (segments.length === 0) {
    return <>{line.text || "♪"}</>;
  }

  return (
    <span className={cn(secondary && "opacity-90")}>
      {segments.map((segment, i) => (
        <span
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          className={cn(
            "lyric-sweep",
            // The hover accent is applied by CSS, not by a Tailwind
            // variant: `lyric-sweep-hover` is a plain class in
            // `index.css`, not a Tailwind utility, so
            // `group-hover/words:lyric-sweep-hover` was never emitted
            // into the bundle and the hover did nothing. The rule now
            // lives in `index.css` as
            // `.lyrics-line:not([data-lyrics-state="active"]) .group\/words:hover .lyric-sweep`.
            //
            // The answering vocal (the `secondary` line) sits outside
            // the button, so it is not a `.group/words` and never
            // matches the rule — it keeps its own dimmed colour.
          )}
        >
          {segment.prefix}
          {segment.text}
        </span>
      ))}
    </span>
  );
}

function PlainLyrics({
  text,
  translation,
  large = false,
}: {
  text: string;
  /** The same text, translated. Shown under the original. */
  translation?: string;
  large?: boolean;
}) {
  return (
    <div
      className={cn(
        "lyrics-mask app-scroll h-full overflow-y-auto whitespace-pre-wrap px-2 pt-0 pb-12 font-medium leading-relaxed text-foreground/90",
        large ? "text-[26px] leading-normal" : "text-lg",
      )}
    >
      {text}
      {translation ? (
        <p className="mt-4 text-sm font-normal text-muted-foreground/70">
          {translation}
        </p>
      ) : null}
    </div>
  );
}

export function LyricsSourceButton({
  state,
  className,
}: {
  state: LyricsViewState;
  className?: string;
}) {
  const { pref, setPref, best, availability, enabled, setEnabled } = state;
  const t = useT();

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("lyrics.source")}
              className={cn(playerIconButton, className)}
            >
              <IconNotes />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>{t("lyrics.source")}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" className="w-52">
        <DropdownMenuCheckboxItem
          checked={enabled}
          onCheckedChange={setEnabled}
          onSelect={(e) => e.preventDefault()}
        >
          {t("lyrics.showLyrics")}
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        {/* `inset` lines the label up with the `pl-8` the checkbox item
            above and the radio items below all reserve for their
            indicator, so every row in this menu starts its text at the
            same left edge instead of three different ones. */}
        <DropdownMenuLabel inset>{t("lyrics.source")}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={pref}
          onValueChange={(v) => setPref(v as Pref)}
        >
          <DropdownMenuRadioItem value="auto" disabled={!enabled}>
            <span className="flex-1">
              {t("lyrics.auto")}
              {best ? (
                <span className="ml-1 text-xs text-muted-foreground">
                  ({SOURCE_LABELS[best]})
                </span>
              ) : null}
            </span>
          </DropdownMenuRadioItem>
          <DropdownMenuSeparator />
          {state.sources.map((s) => {
            const a = availability[s];
            const dot =
              a === "lrc"
                ? "bg-brand"
                : a === "plain"
                  ? "bg-muted-foreground/60"
                  : a === "loading"
                    ? "bg-muted-foreground/30 animate-pulse"
                    : a === "error"
                      ? "bg-destructive"
                      : "bg-transparent";
            return (
              <DropdownMenuRadioItem
                key={s}
                value={s}
                // Only a source that answered and had nothing is
                // unselectable. A failed one stays pickable: selecting it
                // is how the user asks for another attempt.
                disabled={!enabled || a === "none"}
              >
                <span className="flex-1">
                  {SOURCE_LABELS[s]}
                  {/* The provider's own source is marked, because it is
                      the one the app pairs with the audio: a NetEase
                      track's words come from NetEase. */}
                  {s === state.ownLyricsSource ? (
                    <span className="ml-1 text-xs text-muted-foreground">
                      ({t("lyrics.matchingSource")})
                    </span>
                  ) : null}
                </span>
                <span
                  className={cn("ml-2 size-1.5 shrink-0 rounded-full", dot)}
                />
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
