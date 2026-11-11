import { invoke } from "@tauri-apps/api/core";
import { parseLRC } from "@/lib/lyrics/parse-lrc";
import { parseYRC } from "@/lib/lyrics/parse-yrc";
import type { Lyrics } from "@/lib/lyrics/types";

/**
 * Lyrics from NetEase Cloud Music.
 *
 * Like the Chinese platforms' lyrics, these are keyed on the
 * platform's own track id rather than on a fuzzy title/artist string —
 * the platform is asked about *this* song, so it cannot answer with
 * another song's words. That is the whole reason they are worth having:
 * the text-matching providers (LRCLIB, Musixmatch, Genius) are the
 * ones that occasionally return the wrong song.
 *
 * This matters most for the daily recommendation: those picks *are*
 * NetEase records, so their lyrics are exactly the words that go with
 * them, and the platform's own catalogue has them.
 *
 * The request goes through the Rust backend, because NetEase's lyric
 * endpoint lives behind the same eapi encryption its search does
 * (`src-tauri/src/netease.rs`).
 */

/** The display name the lyrics are attributed to. */
const SOURCE_LABEL = "NetEase Cloud Music";

/**
 * The lyrics as the backend reports them.
 *
 * `lrc` is the line-level form and `yrc` the word-by-word one. The
 * platform only has the word-by-word form for some songs, so both are
 * optional and the caller takes whichever is there.
 */
export type NeteaseLyric = {
  lrc: string | null;
  yrc: string | null;
  tlyric: string | null;
};

/**
 * The lyrics for a NetEase song id.
 *
 * `null` means the platform has no lyrics for the song — an answer,
 * not a failure — so the caller can fall through to the next source
 * without treating it as an error.
 *
 * The word-by-word form is preferred when the platform has it: it
 * carries the same words as the line-level form plus the timing of
 * each word, which is what lets the lyrics highlight word by word
 * instead of line by line.
 *
 * The text is left in whatever script the platform wrote it. NetEase's
 * catalogue is Simplified Chinese, but the conversion to Simplified is
 * applied centrally when the lyrics are displayed (see
 * `lyrics/sources.ts`), so every source goes through the same one.
 */
export async function fetchNeteaseLyrics(
  songId: string | undefined,
  signal?: AbortSignal,
): Promise<Lyrics | null> {
  const id = songId?.trim();
  if (!id) return null;
  if (signal?.aborted) return null;

  try {
    const lyric = await invoke<NeteaseLyric | null>("netease_lyric", { songId: id });
    if (signal?.aborted) return null;
    if (!lyric) return null;

    // The translation, when the platform has one. It is timed as well,
    // so it is parsed the same way as the original.
    const translation = lyric.tlyric?.trim() ? parseLRC(lyric.tlyric) : [];

    // The word-by-word form first: it is the same text with better
    // timings, so there is nothing to gain from preferring the plain
    // one when both are there.
    if (lyric.yrc?.trim()) {
      const lines = parseYRC(lyric.yrc);
      if (lines.length > 0) {
        return {
          kind: "timed",
          lines,
          source: SOURCE_LABEL,
          ...(translation.length > 0 ? { translation } : {}),
        };
      }
    }

    if (lyric.lrc?.trim()) {
      const lines = parseLRC(lyric.lrc);
      if (lines.length > 0) {
        return {
          kind: "timed",
          lines,
          source: SOURCE_LABEL,
          ...(translation.length > 0 ? { translation } : {}),
        };
      }
      // A platform that hands back a body without timestamps is still
      // better than nothing: the plain text is the right song's words.
      return {
        kind: "plain",
        text: lyric.lrc.trim(),
        source: SOURCE_LABEL,
        ...(translation.length > 0
          ? { translation: lyric.tlyric!.trim() }
          : {}),
      };
    }

    return null;
  } catch {
    // A provider that cannot answer is one link in the chain being
    // skipped, not a failure of the app.
    return null;
  }
}
