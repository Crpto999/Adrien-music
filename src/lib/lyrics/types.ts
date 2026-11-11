/**
 * A single line of synchronized lyrics.
 *
 * `start` is the second at which the line becomes active; `end` is when it
 * stops being active. Some lines have no text ("interlude" markers) — we
 * still render them so the highlight glides naturally.
 */
export type TimedLine = {
  start: number;
  end?: number;
  text: string;
  /**
   * The words of this line, each with its own timing — the
   * word-by-word ("逐字") form. Present only for the sources that
   * have it; a plain LRC line has no word timings.
   */
  words?: WordSpan[];
};

/**
 * One word within a line, with the span of time it is sung over.
 *
 * `start` and `end` are seconds from the beginning of the track, and
 * they are absolute rather than relative to the line — so a word's
 * span can be compared with the player's position directly.
 */
export type WordSpan = {
  text: string;
  start: number;
  end: number;
};

/**
 * A set of lyrics, and optionally its translation.
 *
 * `translation` is the same lyrics in another language, when the
 * platform has them. NetEase serves a separate `tlyric` for the songs
 * whose catalogue entry carries one; the other platforms do not, so
 * the field is optional everywhere.
 */
export type Lyrics =
  | {
      kind: "timed";
      lines: TimedLine[];
      source?: string;
      /** The same lines, translated. */
      translation?: TimedLine[];
    }
  | {
      kind: "plain";
      text: string;
      source?: string;
      /** The same text, translated. */
      translation?: string;
    };
