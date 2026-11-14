import { describe, expect, it } from "vitest";
import {
  buildSegments,
  revealedFraction,
  segmentPercents,
  sweepLineIndex,
} from "./sweep";
import type { TimedLine } from "./types";

/**
 * The sweep is what makes the highlight travel across a line instead
 * of jumping from word to word. These tests pin the pieces it is built
 * from — where the segments fall, and how much of each is lit at a
 * given moment.
 */

describe("buildSegments", () => {
  it("splits a spaced line into words", () => {
    const line: TimedLine = {
      start: 0,
      end: 4,
      text: "Hello beautiful world",
    };
    const segments = buildSegments(line);
    expect(segments.map((s) => s.text)).toEqual([
      "Hello",
      "beautiful",
      "world",
    ]);
  });

  it("keeps the space that precedes each word out of the word", () => {
    const line: TimedLine = { start: 0, end: 4, text: "Hello beautiful world" };
    const segments = buildSegments(line);
    expect(segments[0].prefix).toBe("");
    expect(segments[1].prefix).toBe(" ");
    expect(segments[2].prefix).toBe(" ");
  });

  it("splits a Chinese line one character at a time", () => {
    const line: TimedLine = { start: 0, end: 4, text: "月光温柔" };
    const segments = buildSegments(line);
    expect(segments.map((s) => s.text)).toEqual(["月", "光", "温", "柔"]);
  });

  it("gives the Chinese punctuation to the character before it", () => {
    const line: TimedLine = { start: 0, end: 4, text: "你好，世界" };
    const segments = buildSegments(line);
    expect(segments.map((s) => s.text)).toEqual(["你", "好，", "世", "界"]);
  });

  it("divides a line's own time between its words in proportion to their length", () => {
    const line: TimedLine = { start: 10, end: 14, text: "aa bbbbb" };
    const segments = buildSegments(line);
    // 2 characters and 5 characters over 4 seconds: 8/7 seconds and
    // 20/7 seconds.
    expect(segments[0].end).toBeCloseTo(10 + (2 / 7) * 4, 6);
    expect(segments[1].start).toBeCloseTo(10 + (2 / 7) * 4, 6);
    expect(segments[1].end).toBeCloseTo(14, 6);
  });

  it("uses the word timings when the line has them", () => {
    const line: TimedLine = {
      start: 0,
      end: 2,
      text: "aa bb",
      words: [
        { text: "aa", start: 0, end: 0.5 },
        { text: " bb", start: 0.5, end: 2 },
      ],
    };
    const segments = buildSegments(line);
    expect(segments.map((s) => s.text)).toEqual(["aa", " bb"]);
    expect(segments[0].start).toBe(0);
    expect(segments[0].end).toBe(0.5);
    expect(segments[1].end).toBe(2);
  });

  it("falls back to the text when the words do not cover it", () => {
    // The words say "aa" but the line says "aa bb" — the words cannot be
    // laid over the text, so the text is interpolated instead.
    const line: TimedLine = {
      start: 0,
      end: 2,
      text: "aa bb",
      words: [{ text: "aa", start: 0, end: 1 }],
    };
    const segments = buildSegments(line);
    expect(segments.map((s) => s.text)).toEqual(["aa", "bb"]);
  });

  it("does not let a word's timing run backwards", () => {
    const line: TimedLine = {
      start: 0,
      end: 2,
      text: "aa bb",
      words: [
        { text: "aa", start: 0, end: 1.5 },
        { text: " bb", start: 0.4, end: 2 },
      ],
    };
    const segments = buildSegments(line);
    expect(segments[1].start).toBeGreaterThanOrEqual(segments[0].end);
  });

  it("returns nothing for a line with no text", () => {
    expect(buildSegments({ start: 0, end: 2, text: "" })).toEqual([]);
  });
});

describe("revealedFraction", () => {
  const segment = { prefix: "", text: "a", start: 10, end: 12 };

  it("is nothing before the segment starts", () => {
    expect(revealedFraction(segment, 9.9)).toBe(0);
  });

  it("is everything once the segment has finished", () => {
    expect(revealedFraction(segment, 12)).toBe(1);
    expect(revealedFraction(segment, 20)).toBe(1);
  });

  it("is a fraction while the highlight is crossing it", () => {
    expect(revealedFraction(segment, 11)).toBeCloseTo(0.5, 6);
  });
});

describe("sweepLineIndex", () => {
  const lines: TimedLine[] = [
    { start: 0, end: 2, text: "one" },
    { start: 2, end: 4, text: "two" },
    { start: 4, end: 6, text: "" , gap: true },
    { start: 6, end: 8, text: "three" },
  ];

  it("finds the line the playhead is inside", () => {
    expect(sweepLineIndex(lines, 1)).toBe(0);
    expect(sweepLineIndex(lines, 3)).toBe(1);
    expect(sweepLineIndex(lines, 7)).toBe(3);
  });

  it("has no line before the first one starts", () => {
    expect(sweepLineIndex(lines, -1)).toBe(-1);
  });

  it("skips a break", () => {
    // The break runs from 4 to 6, but it carries no words, so the
    // sweep has nothing to draw there.
    expect(sweepLineIndex(lines, 5)).toBe(-1);
  });

  it("uses the words' own span when the line has them", () => {
    const withWords: TimedLine[] = [
      {
        start: 0,
        end: 10,
        text: "aa",
        words: [{ text: "aa", start: 0, end: 1 }],
      },
      { start: 1, end: 2, text: "bb" },
    ];
    // The first line's own `end` is 10, but its words stop at 1 — so
    // the second line is the one being sung from 1 onwards.
    expect(sweepLineIndex(withWords, 0.5)).toBe(0);
    expect(sweepLineIndex(withWords, 1.5)).toBe(1);
  });
});

describe("segmentPercents", () => {
  it("lights the segments that have been sung and no others", () => {
    const segments = [
      { prefix: "", text: "a", start: 0, end: 1 },
      { prefix: "", text: "b", start: 1, end: 2 },
      { prefix: "", text: "c", start: 2, end: 3 },
    ];
    expect(segmentPercents(segments, 1.5, true)).toEqual([100, 50, 0]);
  });

  it("lights nothing on a line that is not the one being sung", () => {
    const segments = [
      { prefix: "", text: "a", start: 0, end: 1 },
      { prefix: "", text: "b", start: 1, end: 2 },
    ];
    expect(segmentPercents(segments, 1.5, false)).toEqual([0, 0]);
  });
});
