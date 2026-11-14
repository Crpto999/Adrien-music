import { describe, expect, it } from "vitest";
import {
  ACTIVE_LOOKAHEAD_S,
  currentLyricText,
  findActiveIdx,
} from "./current-line";
import type { Lyrics, TimedLine } from "./types";

/**
 * The bottom bar shows the lyric line that is playing right now.
 *
 * It has to agree with the scrolling lyrics panel — if the readout
 * named a different line than the highlighted one, the two would
 * contradict each other on screen. Both read the same helper, and
 * this test pins the helper's behaviour.
 */

const lines: TimedLine[] = [
  { start: 0, end: 5, text: "First line" },
  { start: 5, end: 10, text: "Second line" },
  { start: 10, end: 15, text: "Third line" },
];

const timed: Lyrics = { kind: "timed", lines };

describe("findActiveIdx", () => {
  it("returns -1 before the first line", () => {
    expect(findActiveIdx(lines, -5)).toBe(-1);
  });

  it("resolves the line that covers the position", () => {
    expect(findActiveIdx(lines, 1)).toBe(0);
    expect(findActiveIdx(lines, 7)).toBe(1);
    expect(findActiveIdx(lines, 12)).toBe(2);
  });

  it("flips to the next line during the lookahead", () => {
    // The cross-fade starts before the line's own start time, so the
    // panel already highlights the next line slightly early. The
    // readout has to flip at the same moment.
    expect(findActiveIdx(lines, 5 - ACTIVE_LOOKAHEAD_S - 0.01)).toBe(0);
    expect(findActiveIdx(lines, 5 - ACTIVE_LOOKAHEAD_S)).toBe(1);
  });
});

describe("currentLyricText", () => {
  it("returns null when there are no lyrics", () => {
    expect(currentLyricText(null, 3)).toBeNull();
  });

  it("returns the active line's text", () => {
    expect(currentLyricText(timed, 1)).toBe("First line");
    expect(currentLyricText(timed, 7)).toBe("Second line");
    expect(currentLyricText(timed, 12)).toBe("Third line");
  });

  it("returns null before the first line starts", () => {
    // The first line starts at 3 s, so nothing is active at 1 s —
    // even with the lookahead, which only reaches 2.28 s back.
    const late: Lyrics = {
      kind: "timed",
      lines: [{ start: 3, end: 8, text: "Later line" }],
    };
    expect(currentLyricText(late, 1)).toBeNull();
    expect(currentLyricText(late, 3)).toBe("Later line");
  });

  it("trims the text", () => {
    const padded: Lyrics = {
      kind: "timed",
      lines: [{ start: 0, end: 5, text: "  padded  " }],
    };
    expect(currentLyricText(padded, 1)).toBe("padded");
  });

  it("treats a blank interlude marker as nothing to show", () => {
    const withGap: Lyrics = {
      kind: "timed",
      lines: [
        { start: 0, end: 2, text: "Sing" },
        { start: 2, end: 4, text: "   " },
      ],
    };
    expect(currentLyricText(withGap, 3)).toBeNull();
  });

  it("falls back to the first non-empty line for untimed lyrics", () => {
    const plain: Lyrics = { kind: "plain", text: "\n\n  First line\nSecond" };
    expect(currentLyricText(plain, 0)).toBe("First line");
    expect(currentLyricText(plain, 900)).toBe("First line");
  });

  it("returns null for untimed lyrics with nothing in them", () => {
    expect(currentLyricText({ kind: "plain", text: "  \n  " }, 0)).toBeNull();
  });
});
