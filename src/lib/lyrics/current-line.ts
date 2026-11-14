import type { Lyrics, TimedLine } from "./types";

/**
 * How long before a line's actual start time we flip it to active.
 *
 * At this moment the previous line's CSS transition begins fading it
 * out and the new line's transition begins fading it in. The
 * `duration-*` value on the line element controls how long that
 * cross-fade takes — set a touch longer than the lookahead so the
 * handoff feels smooth rather than crisp.
 */
export const ACTIVE_LOOKAHEAD_S = 0.72;

/**
 * The index of the line that is active at `position`, or -1 when the
 * playhead is before the first line.
 */
export function findActiveIdx(lines: TimedLine[], position: number): number {
  let active = -1;
  for (let i = 0; i < lines.length; i++) {
    const start = lines[i].start - ACTIVE_LOOKAHEAD_S;
    if (start > position) break;
    const nextStart = lines[i + 1]?.start;
    const end =
      nextStart !== undefined
        ? nextStart - ACTIVE_LOOKAHEAD_S
        : (lines[i].end ?? Infinity);
    if (position < end) {
      active = i;
      break;
    }
    active = i;
  }
  return active;
}

/**
 * The lyric line that is current at `position`.
 *
 * Shared with the bottom bar, which shows the active line as a
 * one-line readout under the track metadata. It resolves the same way
 * the scrolling panel does, so the readout and the panel always name
 * the same line — including the lookahead that starts the cross-fade
 * early.
 *
 * Plain (untimed) lyrics have no positions to resolve, so the first
 * non-empty line stands in for the whole song.
 *
 * Returns `null` when there is nothing to show: no lyrics at all, the
 * playhead is still before the first line, or the active line is a
 * blank interlude marker.
 */
export function currentLyricText(
  lyrics: Lyrics | null,
  position: number,
): string | null {
  if (!lyrics) return null;
  if (lyrics.kind === "plain") {
    const first = lyrics.text
      .split("\n")
      .map((l) => l.trim())
      .find(Boolean);
    return first ?? null;
  }
  const idx = findActiveIdx(lyrics.lines, position);
  if (idx < 0) return null;
  const text = lyrics.lines[idx]?.text?.trim();
  return text || null;
}
