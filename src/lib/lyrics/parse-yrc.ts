import type { TimedLine, WordSpan } from "@/lib/lyrics/types";

/**
 * Parse NetEase's word-by-word lyrics (`yrc`).
 *
 * ## The format
 *
 * The `yrc` body is one line per lyric line, and a line is:
 *
 * ```text
 * [line_start_ms,line_duration_ms](word_start_ms,word_duration_ms,X)WORD
 * ```
 *
 * where `WORD` is the text of the word, sitting *after* its tuple, and
 * the tuple's third field `X` is a number the platform emits as `0`.
 * A line with several words is a run of tuples, each followed by its
 * own word:
 *
 * ```text
 * [14090,1870](14090,40,0)月(14130,300,0)光(14430,480,0)温(14910,250,0)柔
 * ```
 *
 * That is the whole grammar, and it is worth stating precisely because
 * the shape is easy to get wrong: the text is *outside* the
 * parentheses, and the third number is not the text.
 *
 * ## Where the numbers come from
 *
 * Measured against the live platform, the word timings are absolute:
 * a word's `word_start_ms` is its position in the track, not an offset
 * from the line. The first word of a line starts exactly at the line's
 * start, and each subsequent word starts where the previous one ended
 * — the platform packs the words back to back, so the durations tile
 * the line without gaps.
 *
 * The line's own `line_duration_ms` is the span the line covers, which
 * is usually a little longer than its last word (the words are sung
 * and then the line rings out).
 *
 * ## The metadata rows
 *
 * The body sometimes starts with rows in a different format — JSON
 * objects with a `t` (start, in milliseconds) and a `c` array of
 * `{tx, li, or}` fragments. Those are the credits ("作词: …"), which
 * the platform keeps as structured entities. They are skipped here:
 * the line-level `lrc` carries the same credits as text, and a
 * word-by-word credit line would be a row of words nobody can sing.
 */
export function parseYRC(yrc: string): TimedLine[] {
  const out: TimedLine[] = [];

  for (const raw of yrc.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("{")) continue;

    const parsed = parseYrcLine(line);
    if (!parsed) continue;
    if (parsed.words.length === 0 && parsed.text.trim() === "") continue;

    out.push({
      start: parsed.start,
      end: parsed.end,
      text: parsed.text,
      words: parsed.words,
    });
  }

  out.sort((a, b) => a.start - b.start);
  return out;
}

/** One parsed yrc line. */
type YrcLine = {
  /** Seconds. */
  start: number;
  /** Seconds. */
  end: number;
  text: string;
  words: WordSpan[];
};

/**
 * Parse one yrc line.
 *
 * Returns `null` for a line that isn't in the yrc grammar at all, so
 * the caller can skip it rather than render a blank line.
 */
function parseYrcLine(line: string): YrcLine | null {
  const head = readHead(line);
  if (!head) return null;
  const { start, duration, rest } = head;

  const words: WordSpan[] = [];
  let text = "";
  let cursor = rest;

  // A run of `(a,b,c)TEXT` tuples. The text of each word runs from
  // the end of its tuple to the start of the next one.
  for (;;) {
    const open = cursor.indexOf("(");
    if (open < 0) break;
    const after = cursor.slice(open + 1);

    const firstComma = after.indexOf(",");
    if (firstComma < 0) break;
    const secondComma = after.indexOf(",", firstComma + 1);
    if (secondComma < 0) break;
    const close = after.indexOf(")", secondComma + 1);
    if (close < 0) break;

    const wordStart = Number(after.slice(0, firstComma).trim());
    const wordDuration = Number(after.slice(firstComma + 1, secondComma).trim());
    if (!Number.isFinite(wordStart) || !Number.isFinite(wordDuration)) break;

    const afterTuple = after.slice(close + 1);
    const nextOpen = afterTuple.indexOf("(");
    const wordText = nextOpen < 0 ? afterTuple : afterTuple.slice(0, nextOpen);

    if (wordText) {
      text += wordText;
      words.push({
        text: wordText,
        start: wordStart / 1000,
        end: (wordStart + wordDuration) / 1000,
      });
    }

    if (nextOpen < 0) break;
    cursor = afterTuple.slice(nextOpen);
  }

  return {
    start: start / 1000,
    end: (start + duration) / 1000,
    text: text.trim(),
    words,
  };
}

/**
 * Read the `[start,duration]` header off a yrc line.
 *
 * Returns the milliseconds and whatever follows the header.
 */
function readHead(
  line: string,
): { start: number; duration: number; rest: string } | null {
  if (!line.startsWith("[")) return null;
  const close = line.indexOf("]");
  if (close < 0) return null;
  const inner = line.slice(1, close);
  const comma = inner.indexOf(",");
  if (comma < 0) return null;
  const start = Number(inner.slice(0, comma).trim());
  const duration = Number(inner.slice(comma + 1).trim());
  if (!Number.isFinite(start) || !Number.isFinite(duration)) return null;
  return { start, duration, rest: line.slice(close + 1) };
}
