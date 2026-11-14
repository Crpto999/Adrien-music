import type { TimedLine, WordSpan } from "./types";

/**
 * One piece of a line, and the span of time it is sung over.
 *
 * The sweep moves across these, so they are the unit the highlight
 * travels in. A segment is as small as a single character (for CJK) or
 * as large as a word (for a language that writes words), and it carries
 * its own timing so the highlight can cross it at its own pace.
 */
export type SweepSegment = {
  /**
   * The whitespace before the segment, if any.
   *
   * Kept out of the segment proper because the highlight should not
   * sweep across the gap between two words — the gap belongs to the
   * line, not to either of the words on either side of it.
   */
  prefix: string;
  /** The text of the segment. */
  text: string;
  /** Seconds from the beginning of the track. */
  start: number;
  /** Seconds from the beginning of the track. */
  end: number;
};

/**
 * How long a character is given when a line carries no timing of its
 * own and there is no end to work back from.
 *
 * Only reached for a line that has no `end` at all, which the parsers
 * always fill in — so this is a floor, not a measurement.
 */
const FALLBACK_SECONDS_PER_CHAR = 0.25;

/**
 * The CJK ideographs, kana and Hangul — the scripts written without
 * spaces between words.
 */
const CJK_CHAR =
  /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]/;

/**
 * The CJK punctuation, which belongs to the character before it.
 */
const CJK_PUNCT = /[\u3001-\u303F\uFF01-\uFF0F\uFF1A-\uFF20\uFF3B-\uFF40\uFF5B-\uFF65]/;

/**
 * The pieces of `line` the sweep travels across.
 *
 * Two cases, and the line's own data decides which:
 *
 *   - The line carries word timings (NetEase's word-by-word form), in
 *     which case the words *are* the segments and the highlight moves
 *     across each one at its own pace.
 *   - The line carries only its own timing (an LRC line), in which case
 *     the line's span of time is divided between its pieces in
 *     proportion to their length, so a long word is sung for longer
 *     than a short one.
 *
 * In the second case the division is a guess — but it is a guess that
 * is right far more often than not, and the alternative (highlighting a
 * whole line at once, or nothing at all) is worse.
 */
export function buildSegments(line: TimedLine): SweepSegment[] {
  const words = line.words;
  if (words && words.length > 0) {
    const segments = wordsToSegments(words);
    // Only trust the words if they really are the line's text: a line
    // whose text says more than its words cover is a line whose words
    // cannot be laid over it, and interpolating over the text is the
    // safer reading.
    if (
      segments.length > 0 &&
      sameText(
        segments.map((s) => s.text).join(""),
        line.text,
      )
    ) {
      return segments;
    }
  }
  return interpolateSegments(line);
}

/**
 * The words of a line, as segments.
 *
 * The words already carry their own timing, so this is a straight
 * mapping — but the word timings are the platform's, and the platform
 * packs them back to back, so a word whose timing runs backwards (some
 * of them do) is widened to at least its predecessor's end.
 */
function wordsToSegments(words: WordSpan[]): SweepSegment[] {
  const out: SweepSegment[] = [];
  let previousEnd = -Infinity;
  for (const word of words) {
    const start = word.start;
    const end = Math.max(word.end, start);
    // A word that claims to start before the one before it ended is a
    // platform artefact, not a fact about the song. Lay it after its
    // predecessor so the sweep never goes backwards.
    const ordered = Math.max(start, previousEnd);
    out.push({
      prefix: "",
      text: word.text,
      start: ordered,
      end: Math.max(ordered, end),
    });
    previousEnd = Math.max(ordered, end);
  }
  return out;
}

/**
 * A line's own text, cut into pieces, with the line's span of time
 * divided between them.
 */
function interpolateSegments(line: TimedLine): SweepSegment[] {
  const tokens = tokenize(line.text);
  if (tokens.length === 0) return [];

  const total = tokens.reduce((n, t) => n + t.text.length, 0);
  if (total <= 0) return [];

  const start = line.start;
  const end =
    line.end !== undefined && line.end > start
      ? line.end
      : start + total * FALLBACK_SECONDS_PER_CHAR;
  const span = end - start;

  let at = 0;
  return tokens.map((token) => {
    const slice = (token.text.length / total) * span;
    const segment: SweepSegment = {
      prefix: token.prefix,
      text: token.text,
      start: start + at,
      end: start + at + slice,
    };
    at += slice;
    return segment;
  });
}

/**
 * Cut a line into the pieces the sweep moves across.
 *
 * A script written without spaces is cut one character at a time, so
 * each character gets its own moment; a script written with spaces is
 * cut at the spaces, so each word keeps its own letters together (and
 * with them the kerning between them).
 */
function tokenize(text: string): { prefix: string; text: string }[] {
  const out: { prefix: string; text: string }[] = [];
  let pending = "";
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (/\s/.test(ch)) {
      pending += ch;
      i++;
      continue;
    }

    // CJK punctuation belongs to the character before it.
    if (CJK_PUNCT.test(ch)) {
      if (out.length > 0) out[out.length - 1].text += ch;
      else out.push({ prefix: pending, text: ch });
      pending = "";
      i++;
      continue;
    }

    if (CJK_CHAR.test(ch)) {
      out.push({ prefix: pending, text: ch });
      pending = "";
      i++;
      continue;
    }

    let j = i;
    while (
      j < text.length &&
      !/\s/.test(text[j]) &&
      !CJK_CHAR.test(text[j]) &&
      !CJK_PUNCT.test(text[j])
    ) {
      j++;
    }
    out.push({ prefix: pending, text: text.slice(i, j) });
    pending = "";
    i = j;
  }

  // Whatever whitespace was left over trails the last piece.
  if (pending) {
    if (out.length > 0) out[out.length - 1].text += pending;
    else out.push({ prefix: "", text: pending });
  }

  return out;
}

/**
 * Whether two texts are the same words, ignoring whitespace.
 *
 * Used to check that a line's word timings really cover its text
 * before laying them over it.
 */
function sameText(a: string, b: string): boolean {
  return stripSpace(a) === stripSpace(b);
}

function stripSpace(text: string): string {
  return text.replace(/\s+/g, "");
}

/**
 * The index of the line being *sung* at `position`, or -1 when no line
 * is.
 *
 * This is not the same as the line the panel highlights. The panel
 * highlights a line slightly *before* it is sung — the cross-fade has
 * to start early for the handoff to look smooth — but the sweep
 * follows the words themselves, so it has to pick the line the
 * playhead is actually inside.
 *
 * A line's span is the span of its own words when it has them. That
 * matters: a line-timed source's `end` is only the *next* line's
 * start, so a word-timed line whose `end` runs to the next line would
 * swallow it.
 *
 * A break carries no words, so it is never the answer.
 */
export function sweepLineIndex(lines: TimedLine[], position: number): number {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.gap) continue;
    if (!line.text.trim()) continue;

    const words = line.words;
    const start = line.start;
    let end: number;
    if (words && words.length > 0) {
      end = words[words.length - 1].end;
    } else if (line.sungUntil !== undefined) {
      end = line.sungUntil;
    } else {
      end = line.end ?? lines[i + 1]?.start ?? Infinity;
    }

    // Half-open, so the instant a line ends is the instant the next one
    // begins: the boundary belongs to the later line, not to both.
    if (position >= start && position < end) return i;
    // The last line has nothing after it to take over, so it holds the
    // playhead for the rest of the song.
    if (
      i === lines.length - 1 &&
      position >= start &&
      position <= end
    ) {
      return i;
    }
  }
  return -1;
}

/**
 * How much of `segment` has been sung at `position`.
 *
 * A number between 0 and 1: 0 before the segment starts, 1 once it has
 * finished, and a fraction in between while the highlight is crossing
 * it. That fraction is what makes the highlight a sweep rather than a
 * series of jumps.
 */
export function revealedFraction(
  segment: SweepSegment,
  position: number,
): number {
  if (position <= segment.start) return 0;
  if (position >= segment.end) return 1;
  const span = segment.end - segment.start;
  if (span <= 0) return 1;
  return (position - segment.start) / span;
}

/**
 * The highlight of a line at `position`, as one percentage per segment.
 *
 * The percentages are what the renderer puts into each segment's
 * gradient stop — 0 meaning nothing of that segment is lit yet, 100
 * meaning all of it is.
 *
 * A line that is not the one being sung has no highlight of its own:
 * every segment is at 0, and the line's own colour carries the state
 * instead. That is what keeps twenty dim lines from each drawing a
 * highlight.
 */
export function segmentPercents(
  segments: SweepSegment[],
  position: number,
  active: boolean,
): number[] {
  return segments.map((segment) =>
    active ? revealedFraction(segment, position) * 100 : 0,
  );
}
