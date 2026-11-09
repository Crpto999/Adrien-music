import { describe, expect, it } from "vitest";
import { parseYRC } from "@/lib/lyrics/parse-yrc";

describe("parseYRC", () => {
  it("parses a line header and its word tuples", () => {
    const lines = parseYRC("[14090,1870](14090,40,0)月(14130,300,0)光");
    expect(lines).toHaveLength(1);
    expect(lines[0].start).toBeCloseTo(14.09);
    expect(lines[0].end).toBeCloseTo(15.96);
    expect(lines[0].text).toBe("月光");
  });

  it("gives every word its own absolute span", () => {
    const lines = parseYRC("[14090,1870](14090,40,0)月(14130,300,0)光(14430,480,0)温");
    expect(lines[0].words).toEqual([
      { text: "月", start: 14.09, end: 14.13 },
      { text: "光", start: 14.13, end: 14.43 },
      { text: "温", start: 14.43, end: 14.91 },
    ]);
  });

  it("reads the word text from after the tuple, not inside it", () => {
    const lines = parseYRC("[0,1000](0,500,0)hello");
    // The third number in the tuple is a marker, not text.
    expect(lines[0].text).toBe("hello");
    expect(lines[0].words?.[0].text).toBe("hello");
  });

  it("skips the credit rows, which are JSON objects", () => {
    const body = [
      '{"t":-1000,"c":[{"tx":"作词: 方文山"}]}',
      "[0,1000](0,500,0)hello",
    ].join("\n");
    const lines = parseYRC(body);
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe("hello");
  });

  it("keeps the lines in time order", () => {
    const body = "[5000,1000](5000,500,0)second\n[0,1000](0,500,0)first";
    const lines = parseYRC(body);
    expect(lines.map((l) => l.text)).toEqual(["first", "second"]);
  });

  it("drops lines that are not in the grammar at all", () => {
    const lines = parseYRC("not a lyric line\n[0,1000](0,500,0)real");
    expect(lines).toHaveLength(1);
  });

  it("handles a word with no text between two tuples", () => {
    // A trailing tuple with an empty word is a pause; it should not
    // produce an empty word span, and the text should still be right.
    const lines = parseYRC("[0,1000](0,500,0)a(500,0,0)");
    expect(lines[0].text).toBe("a");
    expect(lines[0].words).toHaveLength(1);
  });
});
