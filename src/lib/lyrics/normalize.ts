import type { TimedLine } from "./types";

/**
 * The clean-up applied to lyrics *after* they have been fetched.
 *
 * None of this changes where the lyrics came from, which one was
 * picked, or how they were matched to the track — that all happened
 * before these lines were reached, and it stays that way. What happens
 * here is only about how the words that arrived are *presented*:
 *
 *   - a line that carries an answering vocal in brackets has that
 *     vocal lifted out of the line and given a row of its own;
 *   - a translation is lined up with the original by *when* each line
 *     starts, rather than by which line happens to be in the same
 *     position in the list;
 *   - an instrumental stretch is given a line of its own, so the panel
 *     shows the break instead of jumping straight over it.
 *
 * The rule for all three: when in doubt, do nothing. A lyric set that
 * does not fit these shapes is left exactly as it was.
 */

/**
 * How close a translated line has to start to the line it belongs
 * under, in seconds.
 *
 * Wide enough to absorb the offset between a word-timed original and
 * a line-timed translation — the translation's first line lands on the
 * original's first *word*, a beat or two after the original's own
 * stamp — and narrow enough that a translation which has drifted onto
 * the wrong verse is not accepted as a match.
 */
const ALIGNMENT_WINDOW_S = 1.2;

/**
 * How long an instrumental break has to be, in seconds, before it is
 * given a line of its own.
 *
 * Shorter breaks are not worth interrupting the flow of the words for:
 * they read as a breath between two lines rather than as an interlude.
 */
const MIN_GAP_S = 4;

/**
 * A trailing bracket at the end of a line's text, and where it opens.
 *
 * Only a bracket that *closes* the line counts: a line with a bracket
 * in the middle of it is a line with a bracket in the middle of it,
 * not a line with an answering vocal.
 */
function trailingBracket(
  text: string,
): { open: number; backing: string } | null {
  const trimmed = text.trimEnd();
  if (!trimmed.endsWith(")")) return null;

  let depth = 0;
  for (let i = trimmed.length - 1; i >= 0; i--) {
    const ch = trimmed[i];
    if (ch === ")") depth++;
    else if (ch === "(") {
      depth--;
      if (depth === 0) {
        const open = i;
        if (open === 0) return null;
        const backing = trimmed.slice(open);
        // A bracket with nothing worth reading in it is punctuation, not
        // a vocal.
        if (!/[\p{L}\p{N}]/u.test(backing)) return null;
        return { open, backing };
      }
    }
  }
  return null;
}

/**
 * The index of the word that starts at `offset` characters into the
 * line, or `null` when no word starts there.
 *
 * The words carry their own text, and the words' text is the line's
 * text — so the character offset of the bracket within the line is
 * also the offset within the words.
 */
function wordStartingAt(
  words: { text: string }[],
  offset: number,
): number | null {
  let at = 0;
  for (let i = 0; i < words.length; i++) {
    if (at === offset) return i;
    if (at > offset) return null;
    at += words[i].text.length;
  }
  return null;
}

/**
 * Lift a trailing answering vocal out of its line.
 *
 * `Lead text (Backing vocal)` becomes a lead line reading "Lead text"
 * and a second, quieter line reading "Backing vocal" — drawn under
 * the first, the way a second voice is.
 *
 * The line without it is what the panel highlights, and the answering
 * vocal is drawn beneath it in its own row, so the highlight no
 * longer has to sweep across two voices at once — which is what made
 * the old rendering look like a word was lighting up at the wrong
 * time.
 *
 * When the line carries word timings, the answering vocal's words are
 * split off with it, so each voice keeps its own timing.
 */
export function withBackgroundVocals(lines: TimedLine[]): TimedLine[] {
  return lines.map((line) => {
    // A line with no text is a break marker; there is nothing in it to
    // lift out.
    if (!line.text.trim()) return line;

    const bracket = trailingBracket(line.text);
    if (!bracket) return line;

    const lead = line.text.slice(0, bracket.open).trimEnd();
    if (!lead) return line;

    const words = line.words;
    if (words && words.length > 0) {
      const split = wordStartingAt(words, bracket.open);
      // The bracket has to fall on a word boundary for the two voices to
      // be separable. When it does not, the line is left alone.
      if (split === null || split <= 0) return line;
      return {
        ...line,
        text: lead,
        words: words.slice(0, split),
        background: {
          start: words[split].start,
          end: line.end,
          text: bracket.backing,
          words: words.slice(split),
        },
      };
    }

    return {
      ...line,
      text: lead,
      background: {
        start: line.start,
        end: line.end,
        text: bracket.backing,
      },
    };
  });
}

/**
 * When a line's singing actually stopped.
 *
 * A word-timed line states it: the last word's end is where the
 * singing stopped. A line-timed line does not — its `end` is only the
 * next line's start, which says when the *next* line began, not when
 * this one fell silent.
 */
export function sungUntil(line: TimedLine): number | null {
  if (line.sungUntil !== undefined) return line.sungUntil;
  const last = line.words?.[line.words.length - 1];
  if (last) return last.end;
  return null;
}

/**
 * Give an instrumental stretch a line of its own.
 *
 * A gap is only inserted where the line before it says when its
 * singing stopped — otherwise the "end" is just the next line's start,
 * and a gap inserted there would be invented rather than observed.
 *
 * The blank line is marked so the panel can draw it as a break rather
 * than as an empty lyric.
 */
export function withInstrumentalGaps(lines: TimedLine[]): TimedLine[] {
  if (lines.length === 0) return lines;

  const out: TimedLine[] = [];

  // The silence before the first line, when there is one.
  const first = lines[0];
  if (first.start >= MIN_GAP_S) {
    out.push({ start: 0, end: first.start, text: "", gap: true });
  }

  lines.forEach((line, index) => {
    out.push(line);

    const end = sungUntil(line);
    if (end === null) return;

    const next = lines[index + 1];
    if (!next) return;

    // The singing has to have stopped before the gap begins, and the
    // gap has to be long enough to be worth a line.
    if (end <= line.start) return;
    if (next.start - end < MIN_GAP_S) return;

    out.push({ start: end, end: next.start, text: "", gap: true });
  });

  return out;
}

/**
 * Line the translation up with the original, by when each line starts.
 *
 * The two are published separately and are not stamped the same way.
 * The translation's first line often lands on the original's first
 * *word* rather than on the original's own start, so matching them by
 * position in the list — which is what the panel used to do — drifts
 * by a line as soon as the two lists differ at all.
 *
 * Matching them by time instead keeps each translation under the line
 * it belongs to. A translated line with no original near enough to sit
 * under gets no translation: it is dropped rather than shown against
 * the wrong words.
 *
 * The result is index for index with the original, with an empty line
 * wherever the translation has nothing to say.
 */
export function alignTranslation(
  lines: TimedLine[],
  translation: TimedLine[],
): TimedLine[] {
  if (translation.length === 0) return [];

  const aligned: (TimedLine | null)[] = new Array(lines.length).fill(null);

  // The translation's lines come in the same order as the words they
  // belong to, so each original line may only claim a translation line
  // at or after the one the previous original line claimed.
  let next = 0;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    // A break carries no words, and a translation cannot belong to it.
    if (!line.text.trim()) continue;

    let best: TimedLine | null = null;
    let bestIndex = -1;
    let bestDistance = Infinity;

    for (let scan = next; scan < translation.length; scan++) {
      const candidate = translation[scan];
      const distance = candidate.start - line.start;
      // The translation's lines are in order, so once one starts well
      // after this line, the rest are further away still.
      if (distance > ALIGNMENT_WINDOW_S) break;
      const absolute = Math.abs(distance);
      if (absolute <= ALIGNMENT_WINDOW_S && absolute < bestDistance) {
        best = candidate;
        bestIndex = scan;
        bestDistance = absolute;
      }
    }

    if (!best || bestIndex < 0) continue;
    next = bestIndex + 1;
    aligned[index] = best;
  }

  // Nothing matched at all: the translation is of a different recording,
  // and drawing it under the words would be a lie. Leave it out.
  if (aligned.every((l) => l === null)) return [];

  return aligned.map((l) => l ?? { start: 0, end: 0, text: "" });
}

/**
 * The clean-up applied to a fetched lyric set.
 *
 * Applied in one place, after the fetch and before the display, so
 * that every source goes through the same preparation and the panel
 * has one shape to draw.
 *
 * The order matters, and it is not the obvious one:
 *
 *   1. The answering vocals are lifted out first, so the break
 *      detection below sees the line as it will be drawn — a line with
 *      two voices in it is one line, and its singing stops when its
 *      last word does.
 *   2. The instrumental breaks are added next, so the break lines are
 *      already in place.
 *   3. The translation is aligned *last*, against the finished list.
 *
 * Aligning the translation earlier would be wrong: the break lines
 * inserted in step 2 would shift every translation line one or more
 * positions away from the words it belongs to — which is the exact
 * drift the time-based matching exists to remove.
 */
export function normalizeLyrics<T extends { lines: TimedLine[]; translation?: TimedLine[] }>(
  lyrics: T,
): T {
  const withBackground = withBackgroundVocals(lyrics.lines);
  const lines = withInstrumentalGaps(withBackground);

  // The translation is replaced, never kept as it was. Keeping the
  // original list would put it back under the wrong words — the
  // original list is aligned to the lines *before* the breaks were
  // inserted, and to nothing at all once the lines are matched by time.
  let translation: TimedLine[] | undefined;
  if (lyrics.translation && lyrics.translation.length > 0) {
    const aligned = alignTranslation(lines, lyrics.translation);
    // Nothing matched at all: the translation is of a different
    // recording, and drawing it under the words would be a lie. It is
    // dropped rather than shown against the wrong lines.
    if (aligned.length > 0) translation = aligned;
  }

  return {
    ...lyrics,
    lines,
    translation,
  };
}
