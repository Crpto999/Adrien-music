/**
 * Traditional Chinese → Simplified Chinese.
 *
 * ## Why the app needs this
 *
 * NetEase Cloud Music's catalogue is mainland Chinese, so its song
 * titles are written in Simplified Chinese. A song uploaded to YouTube
 * in Taiwan or Hong Kong carries the *same* title in Traditional
 * characters — "愛你" where NetEase writes "爱你", "聽見" where it
 * writes "听见". Two characters that differ, one song.
 *
 * That matters in two places:
 *
 *   1. **Matching.** A traditional title finds nothing in NetEase's
 *      search, so the track silently falls back to a worse source —
 *      or to no source at all. Converting the query before searching
 *      is the difference between "found on NetEase, lossless" and
 *      "nothing but a YouTube rip".
 *   2. **Lyrics.** A NetEase lyric comes back in Simplified Chinese
 *      (that is how the catalogue is written), while the YouTube
 *      lyric for the same song is often Traditional. Mixing the two
 *      in one panel reads badly, so the display side converts too.
 *
 * ## Which conversion
 *
 * OpenCC's real dictionaries, so the conversion is the linguistic one
 * rather than a codepoint table. The distinction that matters here is
 * between the *character* conversion (`tw`) and the *phrase* one
 * (`twp`):
 *
 *   - `tw` maps characters one for one: 軟體 → 软体.
 *   - `twp` also maps regional *vocabulary*: 軟體 → 软件, 記憶體 →
 *     内存, 滑鼠 → 鼠标.
 *
 * The phrase conversion is the right one here, because NetEase's
 * catalogue is not merely simplified — it is *mainland* Chinese, and
 * it spells "software" the mainland way. A character-level conversion
 * would produce 软体, which the mainland catalogue does not have, so
 * the search would still come up empty.
 *
 * ## Which dialect
 *
 *   - `twp` — Taiwan traditional, with phrases mapped to mainland
 *     forms. The default: a Traditional upload on YouTube is most
 *     often Taiwanese.
 *   - `hkp` — Hong Kong traditional. Its Cantonese-specific
 *     characters (係, 喺) are converted too, because the mainland
 *     catalogue does not carry them either.
 */

import { Converter } from "opencc-js/t2cn";

/**
 * The source dialects.
 *
 * The `p` suffix is OpenCC's marker for the *phrase* dictionaries —
 * the regional vocabulary as well as the characters.
 */
export type ChineseDialect = "twp" | "hkp";

/**
 * The converters, built once.
 *
 * OpenCC's `Converter` builds a trie of the dictionary, which is not
 * free — so it is built at module load rather than per call. There are
 * two of them, one per source dialect.
 */
const CONVERTERS: Record<ChineseDialect, (s: string) => string> = {
  twp: Converter({ from: "twp", to: "cn" }),
  hkp: Converter({ from: "hkp", to: "cn" }),
};

/**
 * Whether a string contains any character that could be Traditional.
 *
 * A cheap pre-check, because most of what the app looks up is not
 * Chinese at all and running the converter over it is wasted work.
 *
 * The ranges cover the CJK ideographs the traditional sets use
 * (`U+3400`–`U+4DBF` extension A, `U+4E00`–`U+9FFF` the main block,
 * and `U+F900`–`U+FAFF` compatibility ideographs). The check is
 * deliberately loose: it asks "could this contain something to
 * convert", not "is this traditional". A false positive costs a
 * conversion that changes nothing.
 */
const MAYBE_CHINESE = /[㐀-䶿一-鿿豈-﫿]/;

/**
 * Convert Traditional Chinese to Simplified.
 *
 * Returns the string unchanged when it holds no Chinese at all, and
 * when the conversion would empty it.
 *
 * `dialect` picks the source dictionary. "twp" is the default
 * because a Traditional upload on YouTube is most often Taiwanese;
 * "hkp" is for Hong Kong material.
 */
export function toSimplified(
  text: string,
  dialect: ChineseDialect = "twp",
): string {
  if (!text) return text;
  if (!MAYBE_CHINESE.test(text)) return text;

  const converted = CONVERTERS[dialect](text);
  // A conversion that empties the string would be a bug in the
  // dictionary, not a legitimate result — keep the original.
  return converted.length > 0 ? converted : text;
}

/**
 * Convert every string in a list.
 *
 * Used for artist lists, where each name is converted on its own so
 * a name that is already simplified is left exactly as it was.
 */
export function toSimplifiedAll(
  texts: readonly string[],
  dialect: ChineseDialect = "twp",
): string[] {
  return texts.map((t) => toSimplified(t, dialect));
}

/**
 * Convert both parts of a title/artist pair.
 *
 * Matching is done on the pair, so both sides have to be in the same
 * script — comparing a traditional title against a simplified
 * candidate would fail on characters that mean the same thing.
 */
export function toSimplifiedPair(
  title: string,
  artists: readonly string[],
  dialect: ChineseDialect = "twp",
): { title: string; artists: string[] } {
  return {
    title: toSimplified(title, dialect),
    artists: toSimplifiedAll(artists, dialect),
  };
}
