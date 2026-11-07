import type { Locale } from "./locales";

/**
 * Canonical home-shelf identities.
 *
 * The home feed has no stable server-side id per shelf (see
 * `lib/store/home-sections.ts`), so the saved order used to be keyed on
 * the shelf's *title*. That breaks the moment the app speaks another
 * language: InnerTube returns the shelf titles in the active `hl`
 * locale, so an order saved in English would no longer match anything
 * in Chinese.
 *
 * This table gives each known shelf a stable id plus its title in every
 * supported locale. `homeSectionKey` resolves an incoming title — in
 * whatever language the API returned it — to that id, so the persisted
 * order survives a language change. Unknown shelves fall back to their
 * raw title, keeping the previous behaviour.
 */
export type HomeSectionTitle = {
  id: string;
  en: string;
  "zh-CN": string;
};

export const HOME_SECTION_TITLES: HomeSectionTitle[] = [
  { id: "listen-again", en: "Listen again", "zh-CN": "再听一次" },
  { id: "top-songs", en: "Top songs", "zh-CN": "热门歌曲" },
  { id: "new-releases", en: "New releases", "zh-CN": "新发行" },
  {
    id: "daily-discover",
    en: "Your daily discover",
    "zh-CN": "每日发现",
  },
  {
    id: "forgotten-favorites",
    en: "Forgotten favorites",
    "zh-CN": "被遗忘的收藏",
  },
  { id: "quick-picks", en: "Quick picks", "zh-CN": "快速精选" },
  {
    id: "albums-for-you",
    en: "Albums for you",
    "zh-CN": "为你推荐的专辑",
  },
  { id: "rnb-soul", en: "R&B & soul", "zh-CN": "R&B 与灵魂乐" },
  {
    id: "music-videos",
    en: "Music videos for you",
    "zh-CN": "为你推荐的音乐视频",
  },
  { id: "mixed-for-you", en: "Mixed for you", "zh-CN": "为你混音" },
  {
    id: "featured-playlists",
    en: "Featured playlists for you",
    "zh-CN": "为你精选的播放列表",
  },
  { id: "fresh-finds", en: "Fresh finds", "zh-CN": "新鲜发现" },
  { id: "old-favorites", en: "Old favorites", "zh-CN": "怀旧金曲" },
  {
    id: "all-time-essentials",
    en: "All-time essentials",
    "zh-CN": "永恒金曲",
  },
  {
    id: "from-your-library",
    en: "From your library",
    "zh-CN": "来自你的音乐库",
  },
  { id: "shows-for-you", en: "Shows for you", "zh-CN": "为你精选的节目" },
  {
    id: "trending-songs",
    en: "Trending songs for you",
    "zh-CN": "为你精选的热歌",
  },
  {
    id: "from-the-community",
    en: "From the community",
    "zh-CN": "来自社区",
  },
  {
    id: "live-performances",
    en: "Live performances",
    "zh-CN": "现场演出",
  },
  { id: "long-listen", en: "Long listen", "zh-CN": "深度聆听" },
  { id: "recaps", en: "Recaps", "zh-CN": "回顾精选" },
  { id: "charts", en: "Charts", "zh-CN": "排行榜" },
  {
    id: "covers-remixes",
    en: "Covers and remixes",
    "zh-CN": "翻唱与混音",
  },
];

const BY_TITLE = new Map<string, string>();
for (const s of HOME_SECTION_TITLES) {
  BY_TITLE.set(s.en.toLowerCase(), s.id);
  BY_TITLE.set(s["zh-CN"].toLowerCase(), s.id);
}

const BY_ID = new Map(HOME_SECTION_TITLES.map((s) => [s.id, s]));

/**
 * The canonical id for a shelf title, in any supported language.
 * Falls back to the title itself for shelves we don't know about.
 */
export function homeSectionKey(title: string): string {
  return BY_TITLE.get(title.trim().toLowerCase()) ?? title;
}

/** The shelf title in the active locale, from its canonical id. */
export function homeSectionLabel(
  id: string,
  locale: Locale = "en",
): string {
  const s = BY_ID.get(id);
  if (!s) return id;
  return s[locale];
}
