import { describe, expect, it } from "vitest";
import {
  alignTranslation,
  normalizeLyrics,
  sungUntil,
  withBackgroundVocals,
  withInstrumentalGaps,
} from "./normalize";
import type { TimedLine } from "./types";

/**
 * The clean-up applied to lyrics after they arrive.
 *
 * None of this touches where the lyrics came from or which one was
 * picked — it is only about how the words are presented. These tests
 * pin that presentation, and in particular that the transformations
 * leave anything they do not understand exactly as it was.
 */

describe("withBackgroundVocals", () => {
  it("lifts a trailing bracket out into a line of its own", () => {
    const lines: TimedLine[] = [
      { start: 0, end: 4, text: "Lead line (Backing vocal)" },
    ];
    const out = withBackgroundVocals(lines);
    expect(out[0].text).toBe("Lead line");
    expect(out[0].background?.text).toBe("(Backing vocal)");
  });

  it("keeps the answering vocal's own words when the line has word timings", () => {
    const lines: TimedLine[] = [
      {
        start: 0,
        end: 4,
        text: "Lead (Backing)",
        words: [
          { text: "Lead", start: 0, end: 1 },
          { text: " ", start: 1, end: 1.1 },
          { text: "(Backing)", start: 1.1, end: 3 },
        ],
      },
    ];
    const out = withBackgroundVocals(lines);
    expect(out[0].text).toBe("Lead");
    expect(out[0].words?.map((w) => w.text)).toEqual(["Lead", " "]);
    expect(out[0].background?.words?.map((w) => w.text)).toEqual(["(Backing)"]);
    expect(out[0].background?.start).toBe(1.1);
  });

  it("leaves a line with no trailing bracket alone", () => {
    const lines: TimedLine[] = [{ start: 0, end: 4, text: "Just a line" }];
    expect(withBackgroundVocals(lines)).toEqual(lines);
  });

  it("leaves a bracket in the middle of a line alone", () => {
    const lines: TimedLine[] = [
      { start: 0, end: 4, text: "A (bracket) in the middle" },
    ];
    const out = withBackgroundVocals(lines);
    expect(out[0].text).toBe("A (bracket) in the middle");
    expect(out[0].background).toBeUndefined();
  });

  it("leaves a line alone when the bracket holds no words", () => {
    const lines: TimedLine[] = [{ start: 0, end: 4, text: "Lead ()" }];
    const out = withBackgroundVocals(lines);
    expect(out[0].text).toBe("Lead ()");
    expect(out[0].background).toBeUndefined();
  });

  it("leaves a break marker alone", () => {
    const lines: TimedLine[] = [{ start: 0, end: 4, text: "" }];
    expect(withBackgroundVocals(lines)).toEqual(lines);
  });
});

describe("sungUntil", () => {
  it("is the last word's end when the line has word timings", () => {
    const line: TimedLine = {
      start: 0,
      end: 10,
      text: "a b",
      words: [
        { text: "a", start: 0, end: 1 },
        { text: " b", start: 1, end: 2 },
      ],
    };
    expect(sungUntil(line)).toBe(2);
  });

  it("is what the source stated, when it stated one", () => {
    expect(sungUntil({ start: 0, end: 10, text: "a", sungUntil: 3 })).toBe(3);
  });

  it("is nothing when the line says neither", () => {
    expect(sungUntil({ start: 0, end: 10, text: "a" })).toBeNull();
  });
});

describe("withInstrumentalGaps", () => {
  it("gives a long silence a line of its own", () => {
    const lines: TimedLine[] = [
      {
        start: 0,
        end: 2,
        text: "sung",
        words: [{ text: "sung", start: 0, end: 2 }],
      },
      { start: 10, end: 12, text: "again" },
    ];
    const out = withInstrumentalGaps(lines);
    expect(out).toHaveLength(3);
    expect(out[1].text).toBe("");
    expect(out[1].start).toBe(2);
    expect(out[1].end).toBe(10);
  });

  it("does not invent a gap where the line does not say when it stopped", () => {
    // The first line's `end` is only the next line's start, so a gap
    // placed there would be invented rather than observed.
    const lines: TimedLine[] = [
      { start: 0, end: 10, text: "sung" },
      { start: 10, end: 12, text: "again" },
    ];
    expect(withInstrumentalGaps(lines)).toHaveLength(2);
  });

  it("does not give a short break a line of its own", () => {
    const lines: TimedLine[] = [
      {
        start: 0,
        end: 2,
        text: "sung",
        words: [{ text: "sung", start: 0, end: 2 }],
      },
      { start: 4, end: 6, text: "again" },
    ];
    expect(withInstrumentalGaps(lines)).toHaveLength(2);
  });

  it("gives the silence before the first line a line of its own", () => {
    const lines: TimedLine[] = [{ start: 8, end: 12, text: "sung" }];
    const out = withInstrumentalGaps(lines);
    expect(out[0].text).toBe("");
    expect(out[0].start).toBe(0);
    expect(out[0].end).toBe(8);
  });
});

describe("alignTranslation", () => {
  it("matches a translation to the line it starts nearest", () => {
    const lines: TimedLine[] = [
      { start: 0, end: 4, text: "one" },
      { start: 10, end: 14, text: "two" },
    ];
    const translation: TimedLine[] = [
      { start: 0.2, end: 4, text: "一" },
      { start: 10.1, end: 14, text: "二" },
    ];
    const out = alignTranslation(lines, translation);
    expect(out).toHaveLength(2);
    expect(out[0].text).toBe("一");
    expect(out[1].text).toBe("二");
  });

  it("does not match a translation that has drifted onto another verse", () => {
    const lines: TimedLine[] = [
      { start: 0, end: 4, text: "one" },
      { start: 10, end: 14, text: "two" },
    ];
    // The second translated line starts five seconds after the line it
    // would belong to — well outside the window.
    const translation: TimedLine[] = [
      { start: 0.2, end: 4, text: "一" },
      { start: 19.9, end: 24, text: "二" },
    ];
    const out = alignTranslation(lines, translation);
    expect(out[0].text).toBe("一");
    expect(out[1].text).toBe("");
  });

  it("gives a break line no translation", () => {
    const lines: TimedLine[] = [
      { start: 0, end: 4, text: "one" },
      { start: 10, end: 14, text: "" },
    ];
    const translation: TimedLine[] = [{ start: 0.2, end: 4, text: "一" }];
    const out = alignTranslation(lines, translation);
    expect(out[1].text).toBe("");
  });

  it("leaves the translation out entirely when none of it matches", () => {
    const lines: TimedLine[] = [{ start: 0, end: 4, text: "one" }];
    const translation: TimedLine[] = [{ start: 90, end: 94, text: "一" }];
    expect(alignTranslation(lines, translation)).toEqual([]);
  });
});

describe("normalizeLyrics", () => {
  it("keeps the translation lined up with the words after a break is inserted", () => {
    // The break is inserted before the translation is aligned, so the
    // translated line stays under the words it belongs to rather than
    // sliding one place down the list.
    const lines: TimedLine[] = [
      {
        start: 0,
        end: 2,
        text: "one",
        words: [{ text: "one", start: 0, end: 2 }],
      },
      { start: 10, end: 14, text: "two" },
    ];
    const translation: TimedLine[] = [
      { start: 0.2, end: 2, text: "一" },
      { start: 10.2, end: 14, text: "二" },
    ];
    const out = normalizeLyrics({ lines, translation });
    // three lines: the word, the break, the second word.
    expect(out.lines).toHaveLength(3);
    expect(out.translation).toHaveLength(3);
    expect(out.translation?.[0].text).toBe("一");
    // The break took the second translation's place, and the second
    // word's own translation moved with it.
    expect(out.translation?.[1].text).toBe("");
    expect(out.translation?.[2].text).toBe("二");
  });

  it("drops the translation rather than showing it under the wrong words", () => {
    // The translation belongs to a different recording: none of its
    // lines land near the words. Keeping it — aligned by position, as
    // it used to be — would put it under the wrong lines, so it is
    // dropped instead.
    const lines: TimedLine[] = [{ start: 0, end: 4, text: "one" }];
    const translation: TimedLine[] = [{ start: 90, end: 94, text: "一" }];
    const out = normalizeLyrics({ lines, translation });
    expect(out.translation).toBeUndefined();
  });

  it("keeps the source and kind of the lyric set", () => {
    const out = normalizeLyrics({
      kind: "timed" as const,
      source: "netease",
      lines: [{ start: 0, end: 4, text: "one" }],
    });
    expect(out.kind).toBe("timed");
    expect(out.source).toBe("netease");
  });
});
