import { describe, expect, it, beforeAll } from "vitest";
import {
  MIN_QUERY_LENGTH,
  SETTINGS_INDEX,
  entryId,
  searchSettings,
  settingDescription,
  settingTitle,
} from "./settings-index";
import { en } from "@/lib/i18n/dictionaries/en";
import { zhCN } from "@/lib/i18n/dictionaries/zh-CN";
import { useLocaleStore } from "@/lib/store/locale";

// The tabs' own source, to keep the hand-kept index honest.
const tabSources = import.meta.glob("./*-tab.tsx", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const titles = (q: string) => searchSettings(q).map((m) => m.entry.titleKey);

// The app ships with Simplified Chinese as its default locale, but these
// tests assert on English strings — pin the locale so they don't depend
// on the default.
beforeAll(() => {
  useLocaleStore.setState({ locale: "en" });
});

describe("searchSettings", () => {
  it("does nothing until the query is long enough", () => {
    expect(MIN_QUERY_LENGTH).toBe(3);
    expect(titles("")).toEqual([]);
    expect(titles("fa")).toEqual([]);
    expect(titles("  fa ")).toEqual([]);
    expect(titles("fad").length).toBeGreaterThan(0);
  });

  it("matches letter combinations, not whole words", () => {
    expect(titles("fade")).toContain("settings.playback.crossfade");
    expect(titles("ross")).toContain("settings.playback.crossfade");
    expect(titles("FADE")).toContain("settings.playback.crossfade");
  });

  it("ranks a title hit above a description-only hit", () => {
    // "mix" is in Smart mix timing's title and in other rows' descriptions.
    const out = titles("mix");
    expect(out[0]).toBe("settings.playback.smartMixTiming");
  });

  it("requires every word of the query", () => {
    expect(titles("bass swap")).toEqual(["settings.playback.djBassSwap"]);
    expect(titles("bass zzzzz")).toEqual([]);
  });

  it("finds rows by their extra keywords and by tab name", () => {
    expect(titles("scrobble")).toContain("settings.integrations.lastfm");
    expect(titles("1440p")).toContain("settings.appearance.videoQuality");
    expect(titles("integrations")).toEqual(
      expect.arrayContaining([
        "settings.integrations.lastfm",
        "settings.integrations.discord",
      ]),
    );
  });

  it("treats regex characters in the query literally", () => {
    expect(() => searchSettings("(.*)")).not.toThrow();
    expect(titles("last.fm")).toContain("settings.integrations.lastfm");
  });
});

describe("settings index", () => {
  it("has unique ids", () => {
    const ids = SETTINGS_INDEX.map(entryId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("resolves every title and description in both locales", () => {
    for (const e of SETTINGS_INDEX) {
      // The lookup falls back to English, so a key that resolves to
      // itself is missing from the dictionary.
      expect(settingTitle(e), e.titleKey).not.toBe(e.titleKey);
      expect(settingDescription(e), e.descriptionKey).not.toBe(
        e.descriptionKey,
      );
    }
  });

  it("has a Chinese translation for every key", () => {
    // Walks both dictionaries and compares the key sets, so a key added
    // to English but forgotten in Chinese fails here rather than showing
    // an English string in the Chinese UI.
    const flatten = (tree: unknown, prefix = ""): string[] => {
      if (typeof tree !== "object" || tree === null) return [];
      return Object.entries(tree).flatMap(([k, v]) =>
        typeof v === "string"
          ? [`${prefix}${k}`]
          : flatten(v, `${prefix}${k}.`),
      );
    };
    const enKeys = flatten(en).sort();
    const zhKeys = flatten(zhCN).sort();
    expect(zhKeys).toEqual(enKeys);
  });

  it("only lists rows that exist in their tab", () => {
    for (const e of SETTINGS_INDEX) {
      const src = tabSources[`./${e.tab}-tab.tsx`];
      expect(src, `missing tab file for ${e.tab}`).toBeTruthy();
      // Every indexed row renders a `data-setting` anchor with its id.
      expect(
        src.includes(`settingId="${e.id}"`),
        `"${e.id}" not found in ${e.tab} tab`,
      ).toBe(true);
    }
  });

  it("lists every titled row of every tab", () => {
    // The tabs render their row titles through `t(...)`, so the index is
    // checked against the translation keys the tabs reference. Only
    // `<SettingRow>` blocks count — other elements (badges, buttons) use
    // a `title` prop of their own that isn't a searchable setting.
    const indexed = new Set(SETTINGS_INDEX.map((e) => e.titleKey));
    for (const [file, src] of Object.entries(tabSources)) {
      for (const block of src.matchAll(
        /<SettingRow\b[\s\S]*?\/>/g,
      )) {
        const title = block[0].match(/\btitle=\{t\("([^"]+)"\)\}/);
        if (!title) continue;
        const key = title[1];
        expect(
          indexed.has(key),
          `"${key}" (${file}) is not in the index`,
        ).toBe(true);
      }
    }
  });
});
