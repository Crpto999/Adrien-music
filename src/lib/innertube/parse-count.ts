import { TRACK_COUNT_SUFFIXES } from "./locale-tokens";

/**
 * Parse a track count out of a header subtitle, tolerating a thousands
 * separator ("5,000 songs" → 5000, not 0 — the old /(\d+)/ only matched
 * the digits after the last comma) and the locale's own wording.
 *
 * English ships "5,000 songs"; Simplified Chinese ships "56 首歌曲"
 * (and the bare "56 首" on some headers). Both forms are verified
 * against live responses.
 *
 * Pure + dependency-free so it's shared by playlist.ts and album.ts and is
 * unit-testable.
 */
export function parseTrackCount(text: string): number | undefined {
  // Digits first (allowing a thousands separator), then the locale's
  // suffix. The suffix list is checked longest-first so "首歌曲" wins
  // over "首".
  const digits = "([\\d,]+)";
  const suffix = [...TRACK_COUNT_SUFFIXES]
    .sort((a, b) => b.length - a.length)
    // Escape the suffix for the regex; the Chinese ones have no special
    // characters, but the English ones don't either — this keeps the
    // list safe to extend.
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const re = new RegExp(`${digits}\\s*(?:${suffix})`, "i");
  const m = text.match(re);
  if (!m) return undefined;
  return parseInt(m[1].replace(/,/g, ""), 10) || undefined;
}
