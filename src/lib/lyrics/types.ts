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
  /**
   * When the singing of this line actually stopped, where the source
   * says so.
   *
   * `end` is not the same thing: for a line-timed source it is only
   * the *next* line's start, which says when the next line began and
   * not when this one fell silent. This says the latter, and only
   * exists for the sources that state it — a word-timed line (where
   * the last word's end is the answer) and a line-timed source that
   * publishes an explicit end.
   *
   * It is what tells the panel that a stretch of silence between two
   * lines is really a break rather than a line that simply runs long.
   */
  sungUntil?: number;
  /**
   * The answering vocal of this line, drawn in its own row beneath it.
   *
   * A line like "Lead line (Backing vocal)" carries two voices, and
   * drawing them as one makes the highlight sweep across both at once
   * — which looks like a word lighting up at the wrong time. Lifting
   * the answering voice out gives each voice its own timing.
   */
  background?: TimedLine;
  /**
   * Whether this line stands for an instrumental stretch rather than
   * for words.
   *
   * A blank line in a lyric set is usually a break — the singing stops
   * and nothing is said for a while. The panel draws it as a break
   * marker rather than as an empty lyric.
   */
  gap?: boolean;
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
