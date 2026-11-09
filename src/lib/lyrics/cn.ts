import { invoke } from "@tauri-apps/api/core";
import { parseLRC } from "@/lib/lyrics/parse-lrc";
import type { Lyrics } from "@/lib/lyrics/types";

/**
 * Lyrics from the Chinese music platforms.
 *
 * Like the YouTube Music lyrics, these are keyed on the platform's own
 * track id rather than on a fuzzy title/artist string — the platform is
 * asked about *this* song, so it cannot answer with another song's
 * words. That is the whole reason they are worth having: the
 * text-matching providers (LRCLIB, Musixmatch, Genius) are the ones
 * that occasionally return the wrong song.
 *
 * The request goes through the Rust backend, because all three
 * platforms' lyrics live behind the same kind of signed or encoded
 * endpoint their search does (`src-tauri/src/cnproviders.rs`).
 */

/** The platforms that serve lyrics this way. */
export type CnLyricProvider = "migu" | "kugou" | "qq";

/** The display name each platform's lyrics are attributed to. */
const SOURCE_LABELS: Record<CnLyricProvider, string> = {
  migu: "Migu Music",
  kugou: "Kugou Music",
  qq: "QQ Music",
};

/**
 * The lyrics for a track on one of the Chinese platforms.
 *
 * `null` means the platform has no lyrics for the song — an answer, not
 * a failure — so the caller can fall through to the next source without
 * treating it as an error.
 */
export async function fetchCnLyrics(
  provider: CnLyricProvider,
  trackId: string | undefined,
  signal?: AbortSignal,
): Promise<Lyrics | null> {
  const id = trackId?.trim();
  if (!id) return null;
  if (signal?.aborted) return null;

  try {
    const lrc = await invoke<string | null>("cn_lyric", {
      platform: provider,
      songId: id,
    });
    if (signal?.aborted) return null;
    if (!lrc || !lrc.trim()) return null;

    const lines = parseLRC(lrc);
    if (lines.length > 0) {
      return { kind: "timed", lines, source: SOURCE_LABELS[provider] };
    }
    // A platform that hands back a body without timestamps is still
    // better than nothing: the plain text is the right song's words.
    return { kind: "plain", text: lrc.trim(), source: SOURCE_LABELS[provider] };
  } catch {
    // A provider that cannot answer is one link in the chain being
    // skipped, not a failure of the app.
    return null;
  }
}
