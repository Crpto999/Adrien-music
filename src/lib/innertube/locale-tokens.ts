/**
 * Locale-aware vocabulary for the InnerTube parsers.
 *
 * YTM renders its type labels, counters and dates in the language of
 * the request's `hl`, so the parsers cannot assume English. The tokens
 * below were taken from live `zh-CN` responses (verified against the
 * API), not guessed:
 *
 *   search row subtitles   "歌曲 • 周杰倫 • 播放次数：2057万"
 *                          "专辑 • 周杰倫 • 2026年"
 *                          "视频 • … • 98万次观看"
 *                          "播放列表 • … • 56 首歌曲"
 *                          "音乐人 • 每月听众：155万"
 *                          "分集 • 2025年7月22日 • …"
 *   search filter chips    音乐人 / 专辑 / 歌曲 / 视频 / 社区播放列表 /
 *                          分集 / 个人资料 / 精选播放列表 / 播客
 *
 * Every entry keeps its English counterpart, so a request made in one
 * locale still parses correctly if the response comes back in another
 * (a cached response, or a region-locked fallback).
 */

/** Result-type token → search group. */
export const SEARCH_TYPE_TOKENS: Record<string, string> = {
  // English
  Song: "song",
  Album: "album",
  Single: "album",
  EP: "album",
  Artist: "artist",
  Playlist: "playlist",
  // Simplified Chinese
  歌曲: "song",
  专辑: "album",
  单曲: "album",
  音乐人: "artist",
  艺人: "artist",
  艺术家: "artist",
  播放列表: "playlist",
  歌单: "playlist",
};

/**
 * Tokens that mark a number as a counter (play count, view count,
 * subscriber count) rather than a date or a duration.
 */
export const COUNTER_TOKENS: readonly string[] = [
  "plays",
  "views",
  "просл",
  "просмотр",
  "播放",
  "观看",
  "听众",
  "订阅",
  "粉絲",
];

/**
 * Tokens that mark a date. Chinese relative dates ("昨天", "3 天前")
 * and absolute ones ("2026年", "2025年7月22日") both appear.
 */
export const DATE_TOKENS: readonly string[] = [
  "ago",
  "назад",
  "yesterday",
  "today",
  "сегодня",
  "вчера",
  "昨天",
  "今天",
  "前天",
  "天前",
  "小时前",
  "分钟前",
  "个月前",
  "年前",
  "月",
  "日",
  "年",
];

/**
 * Month names, matched as whole tokens so "may" doesn't fire on a
 * title that merely contains those letters.
 */
export const MONTH_TOKENS: readonly string[] = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
  "янв",
  "фев",
  "мар",
  "апр",
  "мая",
  "июн",
  "июл",
  "авг",
  "сен",
  "окт",
  "ноя",
  "дек",
];

/**
 * Track-count suffixes. English uses "N songs", Chinese uses
 * "N 首歌曲" (and the bare "N 首" on some headers).
 */
export const TRACK_COUNT_SUFFIXES: readonly string[] = [
  "songs",
  "song",
  "首歌曲",
  "首",
  "首歌",
  "曲",
];

/** Case-insensitive substring test against a token list. */
export function hasToken(text: string, tokens: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return tokens.some((t) => lower.includes(t.toLowerCase()));
}
