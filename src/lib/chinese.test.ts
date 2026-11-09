import { describe, expect, it } from "vitest";
import {
  toSimplified,
  toSimplifiedAll,
  toSimplifiedPair,
} from "@/lib/chinese";

describe("toSimplified", () => {
  it("converts traditional characters to simplified", () => {
    expect(toSimplified("愛你")).toBe("爱你");
    expect(toSimplified("聽見")).toBe("听见");
    expect(toSimplified("這是一個繁體中文測試")).toBe("这是一个繁体中文测试");
  });

  it("converts Taiwan-specific vocabulary", () => {
    // "軟體" is the Taiwan word for software; the mainland catalogue
    // writes "软件". A character-only conversion would give "软体",
    // which the catalogue does not have.
    expect(toSimplified("軟體")).toBe("软件");
    expect(toSimplified("記憶體")).toBe("内存");
    expect(toSimplified("滑鼠")).toBe("鼠标");
  });

  it("converts Hong Kong traditional", () => {
    expect(toSimplified("恭喜發財", "hkp")).toBe("恭喜发财");
  });

  it("leaves simplified text alone", () => {
    expect(toSimplified("爱你")).toBe("爱你");
    expect(toSimplified("周杰伦")).toBe("周杰伦");
  });

  it("leaves non-Chinese text alone", () => {
    expect(toSimplified("Blinding Lights")).toBe("Blinding Lights");
    expect(toSimplified("")).toBe("");
  });

  it("converts the lyrics of a track with mixed scripts", () => {
    const lyrics = "[00:00.00]作詞 : 周杰倫\n[00:05.00]愛你";
    expect(toSimplified(lyrics)).toContain("作词 : 周杰伦");
    expect(toSimplified(lyrics)).toContain("爱你");
  });
});

describe("toSimplifiedAll", () => {
  it("converts every artist name", () => {
    expect(toSimplifiedAll(["周杰倫", "方文山"])).toEqual(["周杰伦", "方文山"]);
  });

  it("keeps an already-simplified name as it was", () => {
    expect(toSimplifiedAll(["林俊傑"])).toEqual(["林俊杰"]);
  });
});

describe("toSimplifiedPair", () => {
  it("converts the title and the artists together", () => {
    expect(
      toSimplifiedPair("稻香", ["周杰倫"]),
    ).toEqual({ title: "稻香", artists: ["周杰伦"] });
  });
});
