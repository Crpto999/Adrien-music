import { describe, expect, it } from "vitest";
import { LyricClock } from "./clock";

/**
 * The lyric playhead.
 *
 * The reference implementation this is ported from had a test suite for
 * exactly the bugs the clock exists to prevent: readings held up behind
 * a busy main thread rolling the words back, a ratchet freezing them,
 * and a seek cutting instead of gliding. Those are the cases pinned
 * here.
 */

const FRAME_MS = 1000 / 60;

/**
 * A song playing at `rate` from `startMs`, read every 500 ms. Each
 * reading is stamped when it is taken, and then reaches the frame loop
 * up to `maxDelayMs` later — the way a reading did when the main thread
 * was busy.
 */
class Playback {
  private random: () => number;
  private nextPollMs = 0;
  private inFlight: { arrives: number; reading: number; at: number }[] = [];
  report: number;
  sampledAt: number;

  constructor(
    public readonly startMs = 44_500,
    private readonly rate = 1,
    private readonly maxDelayMs = 60,
    private readonly stamped = true,
    seed = 7,
  ) {
    // A small deterministic PRNG, so a failure is reproducible.
    let state = seed >>> 0;
    this.random = () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 0x100000000;
    };
    this.report = startMs;
    this.sampledAt = stamped ? 0 : Number.NaN;
  }

  trueAt(nowMs: number): number {
    return this.startMs + nowMs * this.rate;
  }

  /** Advances deliveries to `nowMs`. */
  deliver(nowMs: number): void {
    while (this.nextPollMs <= nowMs) {
      const reading = Math.trunc(this.trueAt(this.nextPollMs));
      const arrives = this.nextPollMs + this.random() * this.maxDelayMs;
      this.inFlight.push({ arrives, reading, at: this.nextPollMs });
      this.nextPollMs += 500;
    }
    while (this.inFlight.length > 0 && this.inFlight[0].arrives <= nowMs) {
      const { reading, at } = this.inFlight.shift()!;
      this.report = reading;
      if (this.stamped) this.sampledAt = at;
    }
  }
}

function run(
  playback: Playback,
  seconds: number,
  maxStallMs = 0,
  seed = 11,
) {
  let randomState = seed >>> 0;
  const random = () => {
    randomState = (randomState * 1664525 + 1013904223) >>> 0;
    return randomState / 0x100000000;
  };

  const clock = new LyricClock(playback.startMs);
  const frames: number[] = [];
  const shown: number[] = [];
  const truth: number[] = [];
  let now = 0;
  while (now <= seconds * 1000) {
    playback.deliver(now);
    frames.push(now);
    shown.push(clock.frame(now, playback.report, playback.sampledAt, 0));
    truth.push(playback.trueAt(now));
    now += FRAME_MS;
    if (maxStallMs > 0 && random() < 0.02) now += random() * maxStallMs;
  }
  return { frames, shown, truth };
}

function expectNeverBack(shown: number[]): void {
  for (let i = 1; i < shown.length; i++) {
    expect(shown[i]).toBeGreaterThanOrEqual(shown[i - 1]);
  }
}

/**
 * Drives a clock on a song at 1x from 10 s, with `readingAt` deciding
 * what each 500 ms reading says and `discontinuity` announcing jumps.
 */
function steady(
  until: number,
  clock = new LyricClock(10_000),
  discontinuity: (now: number) => number = () => 0,
  readingAt: (taken: number) => number = (taken) => 10_000 + taken,
  onFrame: (now: number, shown: number) => void = () => {},
): number {
  let now = 0;
  let shown = 0;
  while (now <= until) {
    const taken = Math.trunc(now / 500) * 500;
    shown = clock.frame(now, readingAt(taken), taken, discontinuity(now));
    onFrame(now, shown);
    now += FRAME_MS;
  }
  return shown;
}

describe("LyricClock", () => {
  it("never moves the words back when readings arrive late", () => {
    const r = run(new Playback(undefined, 1, 800), 90, 600);
    expectNeverBack(r.shown);
  });

  it("does not pull the words off the song when readings arrive late", () => {
    const r = run(new Playback(undefined, 1, 800), 60, 600);
    for (let i = 0; i < r.frames.length; i++) {
      if (r.frames[i] < 2000) continue;
      expect(Math.abs(r.shown[i] - r.truth[i])).toBeLessThan(40);
    }
  });

  it("never stalls the words when readings arrive late", () => {
    const r = run(new Playback(undefined, 1, 800), 60);
    const window = 15;
    for (let i = window; i < r.shown.length; i++) {
      const moved = r.shown[i] - r.shown[i - window];
      const elapsed = r.frames[i] - r.frames[i - window];
      expect(moved).toBeGreaterThanOrEqual(elapsed * 0.5);
    }
  });

  it("never moves the words back when the readings carry no stamp", () => {
    const r = run(new Playback(undefined, 1, 800, false), 60, 600);
    expectNeverBack(r.shown);
  });

  it("learns a faster playback rate", () => {
    const r = run(new Playback(undefined, 1.25, 300), 30);
    for (let i = 0; i < r.frames.length; i++) {
      if (r.frames[i] < 4000) continue;
      expect(Math.abs(r.shown[i] - r.truth[i])).toBeLessThan(40);
    }
    expectNeverBack(r.shown);
  });

  it("ignores a single wrong reading", () => {
    let previous = Number.MIN_SAFE_INTEGER;
    const last = steady(
      8000,
      new LyricClock(10_000),
      () => 0,
      (taken) =>
        10_000 +
        taken +
        (taken === 3000 ? 1500 : taken === 5000 ? -1500 : 0),
      (now, shown) => {
        expect(shown).toBeGreaterThanOrEqual(previous);
        if (now > 1000) {
          expect(Math.abs(shown - (10_000 + now))).toBeLessThan(40);
        }
        previous = shown;
      },
    );
    expect(Math.abs(last - 18_000)).toBeLessThan(40);
  });

  it("glides back to an announced backward seek rather than cutting", () => {
    let shown = 0;
    let largestStep = 0;
    const seekAt = 4000;
    steady(
      5000,
      new LyricClock(10_000),
      (now) => (now >= seekAt ? 1 : 0),
      (taken) => 10_000 + taken - (taken >= seekAt ? 1000 : 0),
      (now, next) => {
        if (now > seekAt) largestStep = Math.max(largestStep, Math.abs(next - shown));
        shown = next;
      },
    );
    expect(largestStep).toBeLessThan(150);
    expect(Math.abs(shown - 14_000)).toBeLessThan(40);
  });

  it("takes an announced far seek at once", () => {
    const clock = new LyricClock(30_000);
    clock.frame(0, 30_000, 0, 0);
    clock.frame(16, 30_000, 0, 0);
    expect(clock.frame(33, 4_000, 30, 1)).toBe(4_003);
  });

  it("slows down rather than reversing for an unannounced small rewind", () => {
    let previous = Number.MIN_SAFE_INTEGER;
    const last = steady(
      12_000,
      new LyricClock(10_000),
      () => 0,
      (taken) => 10_000 + taken - (taken >= 4000 ? 800 : 0),
      (_now, shown) => {
        expect(shown).toBeGreaterThanOrEqual(previous);
        previous = shown;
      },
    );
    expect(Math.abs(last - (22_000 - 800))).toBeLessThan(40);
  });

  it("follows an unannounced far jump", () => {
    const last = steady(
      8000,
      new LyricClock(10_000),
      () => 0,
      (taken) => 10_000 + taken - (taken >= 4000 ? 20_000 : 0),
    );
    expect(Math.abs(last - (18_000 - 20_000))).toBeLessThan(40);
  });

  it("catches up with an unannounced forward jump", () => {
    let previous = Number.MIN_SAFE_INTEGER;
    const last = steady(
      8000,
      new LyricClock(10_000),
      () => 0,
      (taken) => 10_000 + taken + (taken >= 4000 ? 1000 : 0),
      (_now, shown) => {
        expect(shown).toBeGreaterThanOrEqual(previous);
        previous = shown;
      },
    );
    expect(Math.abs(last - 19_000)).toBeLessThan(40);
  });

  it("settles at once when playback holds still", () => {
    const clock = new LyricClock(10_000);
    clock.frame(0, 10_000, 0, 0);
    clock.frame(400, 10_400, 400, 0);
    clock.hold(10_380, 420);
    expect(clock.displayedMs).toBe(10_380);
  });

  it("starts where it stopped when playback resumes", () => {
    const clock = new LyricClock(10_000);
    clock.frame(0, 10_000, 0, 0);
    clock.hold(10_000, 5);
    clock.restart();
    expect(clock.frame(60_000, 10_000, 0, 0)).toBe(10_000);
    expect(clock.frame(60_016, 10_000, 0, 0)).toBe(10_016);
  });

  it("extrapolates from the last reading when the app comes back", () => {
    const clock = new LyricClock(10_000);
    clock.frame(0, 10_000, 0, 0);
    clock.restart();
    expect(clock.frame(30_000, 10_000, 0, 0)).toBe(40_000);
  });
});
