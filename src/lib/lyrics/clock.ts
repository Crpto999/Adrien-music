/**
 * The lyric playhead: a clock that runs on its own frames and is *steered*
 * by the player's readings rather than set by them.
 *
 * A port of the reference implementation in the sibling project
 * (`F:\Project-Android\BitChord\web\app\src\lyrics\clock.ts`), which is
 * itself a port of the Kotlin `LyricClock.kt`.
 *
 * ## Why it exists
 *
 * The store's `position` only ticks about four times a second — that is
 * the browser's `timeupdate` cadence — and the panel cannot draw a sweep
 * from a value that only moves four times a second. So the panel needs
 * a clock of its own, running every frame, that knows where the song
 * is *now* rather than where it was when the last reading arrived.
 *
 * The naive version of that (add the elapsed time to the last reading)
 * is wrong in three ways, all of which the original project hit:
 *
 *   1. **A reading is dated by when it was taken, not when it was
 *      seen.** A reading taken at t=0 and delivered at t=0.4 describes
 *      the song at t=0, not at t=0.4. Dating it on arrival makes the
 *      words jump forward on every reading.
 *   2. **Nothing but an announced jump moves the words backwards.** A
 *      reading that disagrees with the song so far is held back until
 *      the next one confirms it — otherwise a single late reading
 *      rewinds the lyrics.
 *   3. **Readings steer, they don't set.** The newest reading, carried
 *      forward at the learned playback rate, is where the song is; the
 *      words close the gap to it by running a little faster or a
 *      little slower. They never reverse to reach it.
 *
 * All times are milliseconds.
 */
export class LyricClock {
  /** Where the lyrics are drawn, in song milliseconds. */
  displayedMs: number;

  private lastNowMs = Number.NaN;
  private lastReportMs = Number.MIN_SAFE_INTEGER;
  private lastSampledAtMs = Number.NaN;
  /**
   * When playback was last seen stopped; a reading taken before then
   * was taken standing still.
   */
  private heldAtMs = Number.NEGATIVE_INFINITY;
  private lastDiscontinuity: number | null = null;
  private jumpPending = false;
  private anchorAtMs = Number.NaN;
  private anchorMs = 0;
  /** The playback rate, learned from how far the song moves between readings. */
  private rate = 1;
  private historyAt: number[] = [];
  private historyMs: number[] = [];
  private rateSettled = false;
  private suspectAtMs = Number.NaN;
  private suspectMs = 0;
  private rejections = 0;
  private glideStartMs = Number.NaN;
  private glideOffsetMs = 0;

  constructor(startMs: number) {
    this.displayedMs = startMs;
  }

  /**
   * Forget the run so far: frames stopped arriving, and the next frame
   * starts a new one.
   */
  restart(): void {
    this.lastNowMs = Number.NaN;
    this.jumpPending = false;
    this.glideStartMs = Number.NaN;
    this.clearSuspect();
  }

  /**
   * Playback is not moving: settle on `positionMs` outright, as of
   * `nowMs`.
   */
  hold(positionMs: number, nowMs: number): void {
    this.restart();
    this.displayedMs = positionMs;
    this.heldAtMs = nowMs;
  }

  /**
   * Advance to the frame at `nowMs` and return where the lyrics should
   * be drawn.
   *
   * `reportedMs` is the player's latest reading and `sampledAtMs` when
   * it was taken (NaN where nobody said — it is then dated by the first
   * frame that sees it, the best that can be done). `discontinuity`
   * changes whenever the playhead jumps on purpose; only its changing
   * matters.
   */
  frame(
    nowMs: number,
    reportedMs: number,
    sampledAtMs: number,
    discontinuity: number,
  ): number {
    const firstOfRun = Number.isNaN(this.lastNowMs);
    if (discontinuity !== this.lastDiscontinuity) {
      if (this.lastDiscontinuity !== null && !firstOfRun) {
        this.jumpPending = true;
      }
      this.lastDiscontinuity = discontinuity;
    }

    const isNew =
      reportedMs !== this.lastReportMs ||
      (!Number.isNaN(sampledAtMs) && sampledAtMs !== this.lastSampledAtMs);
    this.lastReportMs = reportedMs;
    this.lastSampledAtMs = sampledAtMs;

    if (firstOfRun) {
      this.lastNowMs = nowMs;
      // A reading taken while playback stood still is where the song
      // still is now, however long ago it was taken; one taken while
      // playing has moved on since by exactly how long ago that was.
      const takenAt =
        Number.isNaN(sampledAtMs) || sampledAtMs <= this.heldAtMs
          ? nowMs
          : Math.min(sampledAtMs, nowMs);
      this.anchor(takenAt, reportedMs);
      this.displayedMs = this.targetAt(nowMs);
      return Math.trunc(this.displayedMs);
    }

    // Carried up to this frame on what was known before it, and only
    // then corrected by anything new: a jump folded in first would be
    // advanced by this frame a second time.
    const dt = Math.max(0, nowMs - this.lastNowMs);
    this.lastNowMs = nowMs;
    this.advance(nowMs, dt);

    if (isNew) {
      const takenAt = Number.isNaN(sampledAtMs)
        ? nowMs
        : Math.min(sampledAtMs, nowMs);
      if (takenAt >= this.anchorAtMs || this.jumpPending) {
        this.take(nowMs, takenAt, reportedMs);
      }
    }
    return Math.trunc(this.displayedMs);
  }

  private take(nowMs: number, takenAt: number, reportedMs: number): void {
    if (this.jumpPending) {
      this.jumpPending = false;
      this.clearSuspect();
      this.anchor(takenAt, reportedMs);
      this.jumpTo(nowMs);
      return;
    }

    const elapsed = takenAt - this.anchorAtMs;
    if (
      Math.abs(reportedMs - (this.anchorMs + elapsed * this.rate)) <=
      this.tolerance(elapsed)
    ) {
      this.clearSuspect();
      this.anchor(takenAt, reportedMs, true);
      return;
    }

    // Off with nothing announced. One reading like that is a bad
    // reading; a second agreeing with it is the song somewhere else.
    const sinceSuspect = takenAt - this.suspectAtMs;
    const agrees =
      !Number.isNaN(this.suspectAtMs) &&
      sinceSuspect >= 0 &&
      Math.abs(reportedMs - (this.suspectMs + sinceSuspect * this.rate)) <=
        this.tolerance(sinceSuspect);

    this.rejections++;
    if (agrees) {
      // The two agree with each other, so between them they are the
      // start of the song's new stretch.
      const firstAt = this.suspectAtMs;
      const first = this.suspectMs;
      this.clearSuspect();
      this.anchor(firstAt, first);
      this.anchor(takenAt, reportedMs, true);
    } else if (this.rejections > MAX_REJECTIONS) {
      this.clearSuspect();
      this.anchor(takenAt, reportedMs);
      // From here `advance` closes the gap: ahead of the words it glides
      // forward; behind them it slows down — still never backwards.
    } else {
      this.suspectAtMs = takenAt;
      this.suspectMs = reportedMs;
    }
  }

  /**
   * How far a reading `elapsedMs` after the last may stray before it is
   * doubted.
   */
  private tolerance(elapsedMs: number): number {
    return (
      OUTLIER_MS +
      Math.abs(elapsedMs) * (this.rateSettled ? RATE_SLACK : UNSETTLED_RATE_SLACK)
    );
  }

  /**
   * Believes a reading. `continues` says it carries on from the one
   * before — the song has not jumped between them.
   */
  private anchor(atMs: number, positionMs: number, continues = false): void {
    this.anchorAtMs = atMs;
    this.anchorMs = positionMs;
    if (!continues) {
      this.historyAt = [];
      this.historyMs = [];
    }
    if (this.historyAt.length === HISTORY) {
      this.historyAt.shift();
      this.historyMs.shift();
    }
    this.historyAt.push(atMs);
    this.historyMs.push(this.anchorMs);
    this.learnRate();
  }

  /**
   * The rate, measured from the oldest reading within `RATE_WINDOW_MS`
   * to the newest.
   */
  private learnRate(): void {
    const newest = this.historyAt.length - 1;
    if (newest < 1) return;
    let oldest = 0;
    while (
      oldest < newest &&
      this.historyAt[newest]! - this.historyAt[oldest]! > RATE_WINDOW_MS
    ) {
      oldest++;
    }
    const span = this.historyAt[newest]! - this.historyAt[oldest]!;
    if (span >= MIN_RATE_SPAN_MS) {
      this.rate = clamp(
        (this.historyMs[newest]! - this.historyMs[oldest]!) / span,
        MIN_RATE,
        MAX_RATE,
      );
      this.rateSettled = true;
      return;
    }
    // Not enough of a stretch yet: a rough step from the last two.
    const pairSpan = this.historyAt[newest]! - this.historyAt[newest - 1]!;
    if (!this.rateSettled && pairSpan >= MIN_PAIR_SPAN_MS) {
      const measured = clamp(
        (this.historyMs[newest]! - this.historyMs[newest - 1]!) / pairSpan,
        MIN_RATE,
        MAX_RATE,
      );
      this.rate += (measured - this.rate) * PAIR_LEARNING;
    }
  }

  private clearSuspect(): void {
    this.suspectAtMs = Number.NaN;
    this.rejections = 0;
  }

  private advance(nowMs: number, dt: number): void {
    const target = this.targetAt(nowMs);
    const step = dt * this.rate;
    const error = target - (this.displayedMs + step);

    if (!Number.isNaN(this.glideStartMs)) {
      const progress = (nowMs - this.glideStartMs) / GLIDE_MS;
      if (progress >= 1) {
        this.displayedMs = target;
        this.glideStartMs = Number.NaN;
      } else {
        this.displayedMs =
          target + this.glideOffsetMs * (1 - smoothstep(progress));
      }
    } else if (error <= -LOST_MS || error >= LOST_MS) {
      // Confirmed, unannounced, and far: the song is somewhere else
      // entirely and no amount of slowing down will get there.
      this.displayedMs = target;
    } else if (error >= GLIDE_FROM_MS) {
      this.startGlide(nowMs - dt, this.displayedMs - (target - step));
      this.displayedMs =
        target + this.glideOffsetMs * (1 - smoothstep(dt / GLIDE_MS));
    } else {
      // Behind runs fast, ahead runs slow — and slow is floored well
      // above zero, so the words never stop to wait.
      const closing = error * (dt / (dt + CORRECTION_MS));
      this.displayedMs +=
        step + clamp(closing, -MAX_SLOW * step, MAX_SLEW * step);
    }
  }

  /** An announced jump: rolled to over `GLIDE_MS` when it is near. */
  private jumpTo(nowMs: number): void {
    const offset = this.displayedMs - this.targetAt(nowMs);
    if (Math.abs(offset) > GLIDE_MAX_MS) {
      this.displayedMs = this.targetAt(nowMs);
      this.glideStartMs = Number.NaN;
    } else {
      this.startGlide(nowMs, offset);
    }
  }

  private startGlide(startMs: number, offsetMs: number): void {
    this.glideStartMs = startMs;
    this.glideOffsetMs = offsetMs;
  }

  /** Where the song is at `atMs`: the newest reading believed, carried forward. */
  private targetAt(atMs: number): number {
    return this.anchorMs + (atMs - this.anchorAtMs) * this.rate;
  }
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

function smoothstep(fraction: number): number {
  const t = clamp(fraction, 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * A dated reading this far off where the song should be is not noise.
 * Dated properly, readings land within a few tens of milliseconds.
 */
const OUTLIER_MS = 250;

/**
 * Extra allowance per millisecond between readings, for a rate not
 * known exactly — and a wider one until it has been measured at all.
 */
const RATE_SLACK = 0.2;
const UNSETTLED_RATE_SLACK = 0.75;

/** Readings refused in a row before the next is taken whatever it says. */
const MAX_REJECTIONS = 2;

/**
 * The rate is measured across readings at least `MIN_RATE_SPAN_MS` and
 * at most `RATE_WINDOW_MS` apart.
 */
const MIN_RATE_SPAN_MS = 900;
const RATE_WINDOW_MS = 4000;
const HISTORY = 16;

/** Before then, a rough step from each pair at least this far apart. */
const MIN_PAIR_SPAN_MS = 300;
const PAIR_LEARNING = 0.5;

/** Playback rates the clock is allowed to conclude. */
const MIN_RATE = 0.25;
const MAX_RATE = 4;

/**
 * The gap closes with a time constant of `CORRECTION_MS` — 60 ms
 * behind runs about 10 % fast.
 */
const CORRECTION_MS = 600;
const MAX_SLEW = 0.25;
const MAX_SLOW = 0.5;

/** Behind by this much, the words catch up over `GLIDE_MS`. */
const GLIDE_FROM_MS = 300;
const GLIDE_MS = 260;

/** An announced jump further than this is taken at once. */
const GLIDE_MAX_MS = 2000;

/** A confirmed gap this wide either way is another part of the song. */
const LOST_MS = 3000;
