import { describe, expect, it } from "vitest";
import { en } from "./dictionaries/en";
import { zhCN } from "./dictionaries/zh-CN";
import { translate, useT } from "./index";
import { INTL_LOCALE, LOCALES, LOCALE_REGIONS } from "./locales";
import { HOME_SECTION_TITLES, homeSectionKey, homeSectionLabel } from "./home-sections";

/** Flatten a nested dictionary into dotted keys. */
function flatten(tree: unknown, prefix = ""): string[] {
  if (typeof tree !== "object" || tree === null) return [];
  const out: string[] = [];
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") out.push(path);
    else out.push(...flatten(value, path));
  }
  return out;
}

const enKeys = flatten(en).sort();
const zhKeys = flatten(zhCN).sort();

describe("dictionary parity", () => {
  it("zh-CN defines exactly the same keys as en", () => {
    const missing = enKeys.filter((k) => !zhKeys.includes(k));
    const extra = zhKeys.filter((k) => !enKeys.includes(k));
    expect({ missing, extra }).toEqual({ missing: [], extra: [] });
  });

  it("has no empty strings", () => {
    const empty = [...flatten(en), ...flatten(zhCN)].filter((path) => {
      const value = path
        .split(".")
        .reduce<unknown>(
          (node, part) =>
            typeof node === "object" && node !== null
              ? (node as Record<string, unknown>)[part]
              : undefined,
          en,
        );
      return value === "";
    });
    expect(empty).toEqual([]);
  });

  it("keeps the same placeholders in both languages", () => {
    const placeholders = (s: string) =>
      (s.match(/\{(\w+)\}/g) ?? []).sort().join(",");
    const lookup = (tree: unknown, path: string): string | undefined => {
      const value = path
        .split(".")
        .reduce<unknown>(
          (node, part) =>
            typeof node === "object" && node !== null
              ? (node as Record<string, unknown>)[part]
              : undefined,
          tree,
        );
      return typeof value === "string" ? value : undefined;
    };
    const mismatched = enKeys.filter((key) => {
      const a = lookup(en, key);
      const b = lookup(zhCN, key);
      if (a === undefined || b === undefined) return true;
      return placeholders(a) !== placeholders(b);
    });
    expect(mismatched).toEqual([]);
  });
});

describe("translate", () => {
  it("returns the localized string for the active locale", () => {
    expect(translate("nav.home", undefined, "en")).toBe("Home");
    expect(translate("nav.home", undefined, "zh-CN")).toBe("首页");
  });
  it("interpolates parameters", () => {
    expect(translate("search.resultsFor", { query: "abc" }, "en")).toContain(
      "abc",
    );
  });

  it("falls back to English for an unknown locale", () => {
    expect(
      translate("nav.home", undefined, "de-DE" as unknown as "en"),
    ).toBe("Home");
  });

  it("returns the key itself when nothing matches", () => {
    expect(translate("nope.not.here", undefined, "en")).toBe("nope.not.here");
  });

  it("leaves unknown placeholders in place", () => {
    expect(translate("search.resultsFor", {}, "en")).toContain("{query}");
  });

  it("exposes a hook with the same signature", () => {
    expect(typeof useT).toBe("function");
  });
});

/**
 * Every translation key the app asks for must exist.
 *
 * A missing key does not throw — `translate` returns the key itself —
 * so a typo like `t("providers.neteaseDaily")` instead of
 * `t("settings.providers.neteaseDaily")` renders the raw key in the
 * UI and nothing else complains. This walks the source and checks every
 * key against the dictionary.
 */
describe("translation keys used in the app", () => {
  const sources = import.meta.glob("../../**/*.{ts,tsx}", {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>;

  it("finds every key the app asks for", () => {
    const missing: string[] = [];
    let scanned = 0;

    for (const [file, source] of Object.entries(sources)) {
      // Skip the test files themselves — they mention keys on purpose.
      if (file.includes(".test.")) continue;
      scanned += 1;

      // `t("...")` and `translate("...")`, in both quote styles.
      const pattern = /\b(?:t|translate)\(\s*["'`]([\w.]+)["'`]/g;
      for (const match of source.matchAll(pattern)) {
        const key = match[1];
        // A key that is not in the dictionary and is not itself a
        // dictionary path is a typo. The check is "does it resolve",
        // which is exactly what `translate` does.
        if (translate(key, undefined, "en") === key) {
          missing.push(`${file}: ${key}`);
        }
      }
    }

    expect(missing).toEqual([]);
    // The walk has to actually cover the app, or the test proves
    // nothing. The app is a couple of hundred files.
    expect(scanned).toBeGreaterThan(50);
  });
});

describe("locales", () => {
  it("maps every locale to an Intl tag and a region", () => {
    for (const locale of LOCALES) {
      expect(INTL_LOCALE[locale]).toBeTruthy();
      expect(LOCALE_REGIONS[locale]).toBeTruthy();
    }
  });

  it("never asks InnerTube for CN or MO (both return HTTP 400)", () => {
    for (const locale of LOCALES) {
      expect(LOCALE_REGIONS[locale]).not.toBe("CN");
      expect(LOCALE_REGIONS[locale]).not.toBe("MO");
    }
  });
});

describe("home section titles", () => {
  it("gives every section a unique id", () => {
    const ids = HOME_SECTION_TITLES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("resolves a title in either language to the same id", () => {
    for (const s of HOME_SECTION_TITLES) {
      expect(homeSectionKey(s.en)).toBe(s.id);
      expect(homeSectionKey(s["zh-CN"])).toBe(s.id);
    }
  });

  it("falls back to the raw title for unknown shelves", () => {
    expect(homeSectionKey("Something Else")).toBe("Something Else");
  });

  it("labels a section in the requested locale", () => {
    const first = HOME_SECTION_TITLES[0];
    expect(homeSectionLabel(first.id, "en")).toBe(first.en);
    expect(homeSectionLabel(first.id, "zh-CN")).toBe(first["zh-CN"]);
  });
});
