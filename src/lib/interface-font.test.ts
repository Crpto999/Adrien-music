import { describe, expect, it } from "vitest";

import {
  NOTO_SANS_SC_CDN_BASE,
  NOTO_SANS_SC_FACES,
  NOTO_SANS_SC_FAMILY,
  NOTO_SANS_SC_TOTAL_BYTES,
} from "./noto-sans-sc-font";
import {
  PINGFANG_CDN_BASE,
  PINGFANG_FAMILY,
  PINGFANG_WEIGHTS,
  PINGFANG_TOTAL_BYTES,
} from "./pingfang-font";
import { INTERFACE_FONTS, interfaceFontStack } from "./interface-font";

/**
 * The downloadable type families.
 *
 * These are the files the app fetches from jsDelivr the first time the
 * user picks a typeface, and the checks below are the ones that catch
 * a mismatch between a face and the weight it is supposed to answer
 * for — a wrong file name here is invisible in the UI (the download
 * still succeeds, the text still renders) but the wrong *weight* gets
 * used, which is exactly the kind of bug that survives review.
 */

/** The first and last weight a face's range covers. */
function weightRange(weight: string): [number, number] {
  const parts = weight.trim().split(/\s+/);
  if (parts.length === 1) {
    const w = Number(parts[0]);
    return [w, w];
  }
  return [Number(parts[0]), Number(parts[parts.length - 1])];
}

describe("Noto Sans SC", () => {
  it("ships a light face for the unbold weights and a semibold one for the bold ones", () => {
    const light = NOTO_SANS_SC_FACES.find((f) => {
      const [lo, hi] = weightRange(f.weight);
      return 400 >= lo && 400 <= hi;
    });
    const semibold = NOTO_SANS_SC_FACES.find((f) => {
      const [lo, hi] = weightRange(f.weight);
      return 600 >= lo && 600 <= hi;
    });

    expect(light).toBeDefined();
    expect(semibold).toBeDefined();

    // The light face has to be the *Light* cut (300), not the Regular
    // one (400) — the user asked for Light, and the two are different
    // designs rather than different renderings of the same one.
    expect(light!.file).toContain("-300.");
    expect(semibold!.file).toContain("-600.");
  });

  it("covers every weight the app asks for", () => {
    // The UI uses 400, 500, 600 and 700 — plus 300 and 900 for good
    // measure. Every one of them has to land on a real face.
    const ranges = NOTO_SANS_SC_FACES.map((f) => weightRange(f.weight));
    for (const w of [300, 400, 500, 600, 700, 900]) {
      expect(
        ranges.some(([lo, hi]) => w >= lo && w <= hi),
        `no face answers for weight ${w}`,
      ).toBe(true);
    }
  });

  it("splits the two faces so no weight is claimed twice", () => {
    const ranges = NOTO_SANS_SC_FACES.map((f) => weightRange(f.weight));
    for (let i = 0; i < ranges.length; i++) {
      for (let j = i + 1; j < ranges.length; j++) {
        const [aLo, aHi] = ranges[i];
        const [bLo, bHi] = ranges[j];
        expect(aHi < bLo || bHi < aLo).toBe(true);
      }
    }
  });

  it("names the family something no system font uses", () => {
    // "Noto Sans SC" is a name the OS may already ship. A `FontFace`
    // sharing it with the system font is a coin toss over which one
    // the browser picks.
    expect(NOTO_SANS_SC_FAMILY).not.toBe("Noto Sans SC");
    expect(NOTO_SANS_SC_FAMILY).toContain("Noto Sans SC");
  });

  it("points at the pinned jsDelivr copy of the package", () => {
    expect(NOTO_SANS_SC_CDN_BASE).toContain("cdn.jsdelivr.net/npm/");
    expect(NOTO_SANS_SC_CDN_BASE).toMatch(
      /noto-sans-sc_chinese-simplified@\d+\.\d+\.\d+/,
    );
    expect(NOTO_SANS_SC_CDN_BASE.endsWith("/")).toBe(true);
  });

  it("gives every face a file name and a size", () => {
    for (const face of NOTO_SANS_SC_FACES) {
      expect(face.file).toMatch(/^noto-sans-sc-chinese-simplified-\d+\.woff2$/);
      expect(NOTO_SANS_SC_TOTAL_BYTES).toBeGreaterThan(0);
    }
  });
});

describe("PingFang SC", () => {
  it("keeps one face per weight", () => {
    const weights = PINGFANG_WEIGHTS.map((w) => w.weight);
    expect(new Set(weights).size).toBe(weights.length);
  });

  it("points at the pinned jsDelivr copy", () => {
    expect(PINGFANG_CDN_BASE).toContain("cdn.jsdelivr.net/npm/");
    expect(PINGFANG_TOTAL_BYTES).toBeGreaterThan(0);
  });

  it("names the family something no system font uses", () => {
    expect(PINGFANG_FAMILY).not.toBe("PingFang SC");
  });
});

describe("the interface font list", () => {
  it("offers the system stack and both downloaded families", () => {
    expect(INTERFACE_FONTS.map((f) => f.id)).toEqual([
      "pingfang",
      "noto-sans-sc",
      "system",
    ]);
  });

  it("resolves every id to a stack that names the family", () => {
    expect(interfaceFontStack("pingfang")).toContain(PINGFANG_FAMILY);
    expect(interfaceFontStack("noto-sans-sc")).toContain(NOTO_SANS_SC_FAMILY);
    expect(interfaceFontStack("system")).toContain("Segoe UI");
  });

  it("falls back to the system stack for an unknown id", () => {
    expect(interfaceFontStack("nope" as never)).toBe(
      interfaceFontStack("system"),
    );
    expect(interfaceFontStack("nope" as never)).toContain("Segoe UI");
  });

  it("keeps the CJK fallbacks on every stack", () => {
    for (const font of INTERFACE_FONTS) {
      expect(font.stack).toContain("Microsoft YaHei");
      expect(font.stack).toContain("sans-serif");
    }
  });
});
