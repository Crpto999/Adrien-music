/**
 * Match diagnostics.
 *
 * ## What this is for
 *
 * The matcher is a judgement call, and a judgement call that is
 * wrong is invisible: the app either plays the right recording or it
 * does not, and "it did not" looks the same as "the platform does not
 * have it". When a user reports that a song is missing from the
 * source switcher, the only way to tell a *catalogue* problem from a
 * *matching* problem is to look at the candidates and at the scores
 * that were computed for them.
 *
 * So every match records what it saw: the query it sent, how many
 * candidates came back, what each of the best few looked like, how
 * each scored on each of the four components, and what the decision
 * was — including the *reason* a candidate was rejected.
 *
 * ## Where the output goes
 *
 * Two places:
 *
 *   - The **console** (`console.debug`), in a dev build. This is the
 *     form a developer reads while working on the matcher.
 *   - The **log file** (`adrify.log`), always. A packaged build has
 *     no console at all — it is launched detached from a terminal —
 *     so the file is the only place the diagnostics can live. The
 *     backend's own lines go into the same file through the same
 *     `log_line` command, so one bug report carries the whole story.
 *
 * ## The volume
 *
 * A NetEase search asks for a hundred rows, and the app asks for a
 * match for every track it shows. Logging every row would bury the
 * log in noise. So only the **best few** candidates are recorded, and
 * the rest are summarised in a count. The summary matters as much as
 * the detail: "100 candidates, none above 0.72" says the search
 * worked and the *matcher* said no, which is a different bug from
 * "0 candidates".
 */

/** A provider's search, with everything the matcher saw. */
export type MatchDebugReport = {
  /** The provider the search was sent to. */
  provider: string;
  /** The query that was sent. */
  query: string;
  /** The track that was being looked for. */
  source: {
    title: string;
    artists: string[];
    album?: string;
    duration?: number;
  };
  /** How many candidates came back. */
  candidateCount: number;
  /** The best candidates, already scored. */
  top: MatchDebugCandidate[];
  /** The chosen candidate's id, when one was chosen. */
  pickedId?: string;
  /** The confidence of the decision. */
  confidence?: string;
  /** Why the decision went the way it did. */
  reason?: string;
  /** How far the winner beat the runner-up. */
  margin?: number;
  /** Why the run failed, when it did. */
  error?: string;
};

/** One candidate, with its score broken down. */
export type MatchDebugCandidate = {
  /** The provider's own id for the candidate. */
  id: string;
  title: string;
  artists: string[];
  album?: string | null;
  duration?: number;
  /** The platform's other names for the recording. */
  aliases?: string[];
  /** Where the platform ranked this candidate, zero-based. */
  rank?: number;
  /** The title tier — the strongest component. */
  score: number;
  /** The title agreement tier. */
  t: number;
  /** The featuring-credit agreement tier. */
  cr?: number;
  /** The artist agreement, 0–1. */
  a: number;
  /** The version agreement, 0–1. */
  v?: number;
  /** The duration agreement tier. */
  d: number;
  /** The album agreement tier. */
  al: number;
  /** The platform's own ranking, 0–1. */
  rk?: number;
  /** The version markers the candidate carries that the source does not. */
  extraVersions?: string[];
  /** The confidence this candidate would reach on its own. */
  confidence?: string;
  /** Why it was rejected, when it was. */
  reason?: string;
};

/**
 * Whether the diagnostics are on.
 *
 * On by default: the whole point is that a user can attach the log
 * to a bug report without having to know a switch exists. It can be
 * turned off from the Settings page, or from the console
 * (`__adrifyMatchDebug = false`) when the volume gets in the way of
 * real work.
 */
let enabled = true;

/**
 * An override set from the console, which wins over the setting.
 *
 * `undefined` means "no override" — the setting decides.
 */
let override: boolean | undefined;

/** Turn the diagnostics on or off. */
export function setMatchDebugEnabled(on: boolean): void {
  enabled = on;
}

/**
 * Override the setting, for a one-off debugging session.
 *
 * `undefined` clears the override and hands the decision back to the
 * setting.
 */
export function setMatchDebugOverride(on: boolean | undefined): void {
  override = on;
}

/** Whether the diagnostics are on. */
export function isMatchDebugEnabled(): boolean {
  if (override !== undefined) return override;
  return enabled;
}

/**
 * Format a number for the log: two decimals, and no trailing zeroes
 * noise (`0.5` rather than `0.5000`).
 */
function n(value: number | undefined): string {
  if (value === undefined || value === null) return "-";
  return value.toFixed(2);
}

/** A one-line rendering of a candidate's identity. */
function describe(candidate: MatchDebugCandidate): string {
  const artists = candidate.artists.length > 0 ? candidate.artists.join(", ") : "?";
  const dur = candidate.duration !== undefined ? `${candidate.duration}s` : "?";
  // The album *name* is in quotes, so it cannot be confused with the
  // album *score* (`al=0.86`).
  const album = candidate.album ? ` | "${candidate.album}"` : "";
  const alias =
    candidate.aliases && candidate.aliases.length > 0
      ? ` | alias=${candidate.aliases.join(" / ")}`
      : "";
  const rank = candidate.rank !== undefined ? ` | rank=${candidate.rank}` : "";
  return `"${candidate.title}" — ${artists} | ${dur}${album}${alias}${rank}`;
}

/**
 * The console form: a block per provider, one line per candidate.
 *
 * Grouped and aligned, because it is read by a human looking for the
 * one line that explains the wrong decision.
 */
function consoleText(report: MatchDebugReport): string {
  const lines: string[] = [];
  const src = [
    report.source.title,
    report.source.artists.join(", "),
    report.source.duration !== undefined
      ? `${report.source.duration}s`
      : undefined,
  ]
    .filter((x) => x !== undefined && x !== "")
    .join(" | ");

  lines.push(
    `[match:${report.provider}] query="${report.query}" src="${src}" candidates=${report.candidateCount}`,
  );

  report.top.forEach((candidate, i) => {
    const mark = report.pickedId === candidate.id ? "=>" : "  ";
    const parts = [
      `${mark}#${i + 1}`,
      `t=${n(candidate.t)}`,
      `cr=${n(candidate.cr)}`,
      `a=${n(candidate.a)}`,
      `v=${n(candidate.v)}`,
      `d=${n(candidate.d)}`,
      `al=${n(candidate.al)}`,
      `rk=${n(candidate.rk)}`,
    ];
    if (candidate.extraVersions?.length) {
      parts.push(`extra=${candidate.extraVersions.join("/")}`);
    }
    if (candidate.reason) parts.push(`reason=${candidate.reason}`);
    lines.push(`  ${parts.join(" ")} ${describe(candidate)}`);
  });

  if (report.top.length === 0) {
    lines.push("  (no candidates)");
  } else if (report.candidateCount > report.top.length) {
    lines.push(`  ... ${report.candidateCount - report.top.length} more candidates`);
  }

  if (report.pickedId) {
    lines.push(
      `[match:${report.provider}] PICK ${report.pickedId} conf=${report.confidence} margin=${n(report.margin)}`,
    );
  } else {
    lines.push(
      `[match:${report.provider}] NO MATCH reason=${report.reason ?? "unknown"}${report.error ? ` error=${report.error}` : ""}`,
    );
  }

  return lines.join("\n");
}

/**
 * The log-file form: one line per fact, so the file stays greppable.
 *
 * The console's block form is for reading; this one is for searching
 * (`Select-String`) and for pasting into a bug report.
 */
function fileLines(report: MatchDebugReport): string[] {
  const lines: string[] = [];
  const src = [
    report.source.title,
    report.source.artists.join(","),
    report.source.duration !== undefined
      ? `${report.source.duration}s`
      : undefined,
  ]
    .filter((x) => x !== undefined && x !== "")
    .join("|");
  lines.push(
    `[match:${report.provider}] query="${report.query}" src="${src}" candidates=${report.candidateCount}`,
  );

  for (const candidate of report.top) {
    const parts = [
      `conf=${candidate.confidence ?? "-"}`,
      `t=${n(candidate.t)}`,
      `cr=${n(candidate.cr)}`,
      `a=${n(candidate.a)}`,
      `v=${n(candidate.v)}`,
      `d=${n(candidate.d)}`,
      `al=${n(candidate.al)}`,
      `rk=${n(candidate.rk)}`,
    ];
    if (candidate.extraVersions?.length) {
      parts.push(`extra=${candidate.extraVersions.join("/")}`);
    }
    if (candidate.reason) parts.push(`reason=${candidate.reason}`);
    const album = candidate.album ? ` album="${candidate.album}"` : "";
    const dur =
      candidate.duration !== undefined ? ` dur=${candidate.duration}` : "";
    const alias =
      candidate.aliases && candidate.aliases.length > 0
        ? ` alias="${candidate.aliases.join("/")}"`
        : "";
    const rank = candidate.rank !== undefined ? ` rank=${candidate.rank}` : "";
    lines.push(
      `[match:${report.provider}]   ${parts.join(" ")} title="${candidate.title}" artists=${candidate.artists.join(",")}${dur}${album}${alias}${rank} id=${candidate.id}`,
    );
  }

  if (report.pickedId) {
    lines.push(
      `[match:${report.provider}] PICK id=${report.pickedId} conf=${report.confidence} margin=${n(report.margin)}`,
    );
  } else {
    lines.push(
      `[match:${report.provider}] NO MATCH reason=${report.reason ?? "unknown"}${report.error ? ` error=${report.error}` : ""}`,
    );
  }

  return lines;
}

/**
 * The reports already written, so the same one is not written twice.
 *
 * The availability layer asks for the same track's matches repeatedly
 * — the source-switcher panel, the player's source decision, the heart
 * flow — and each of those asks every provider in turn. Without this,
 * one song the user hovers over would write the same ten lines ten
 * times, and the log would be unreadable exactly when it is needed.
 *
 * The key is the *whole* report, so a report that differs in any way
 * — a different candidate count, a different winner — is written
 * again. Only an identical repeat is dropped.
 */
const seen = new Set<string>();

/** How many distinct reports to remember. */
const SEEN_LIMIT = 200;

/**
 * Forget the reports already written.
 *
 * Used by the tests, and by the settings toggle when it is switched
 * off and on again — a report that was suppressed while the switch
 * was off should be written when it comes back.
 */
export function clearMatchDebugHistory(): void {
  seen.clear();
}

/**
 * Send lines to the app's log file.
 *
 * One round trip for the whole report: a match report is a dozen
 * lines, and a dozen IPC calls per match is a lot of overhead for
 * something that only ever writes to a file.
 *
 * Best-effort: a failure here must never affect the match itself.
 * The import is dynamic so that a plain browser build (no Tauri) and
 * the unit tests do not have to stub it.
 */
async function toLogFile(lines: string[]): Promise<void> {
  if (lines.length === 0) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("log_lines", { lines });
  } catch {
    // Not running under Tauri, or the backend refused. The console
    // output is still there.
  }
}

/**
 * The lines a report writes to the log file.
 *
 * Exported so the deduplication can be tested without the Tauri
 * runtime — the writing itself is best-effort, but the *decision* to
 * write is not.
 */
export function matchReportFileLines(
  report: MatchDebugReport,
): string[] {
  return fileLines(report);
}

/**
 * Record one match.
 *
 * Called from the resolver and from the heart-sync lookups. It never
 * throws and never blocks the match: the diagnostics are a side
 * effect, and a side effect that can fail must not fail the feature.
 *
 * The console always, so a developer in devtools sees it without
 * hunting for the log file. The log file gets the same information,
 * deduplicated.
 */
export function logMatchReport(report: MatchDebugReport): void {
  if (!isMatchDebugEnabled()) return;

  console.debug(consoleText(report));

  const lines = fileLines(report);
  const key = lines.join("\n");
  if (seen.has(key)) return;
  seen.add(key);
  // The set is a *recent* history, not a full archive: an old report
  // repeating after a hundred others is worth writing again.
  if (seen.size > SEEN_LIMIT) {
    const oldest = seen.values().next().value;
    if (oldest !== undefined) seen.delete(oldest);
  }

  void toLogFile(lines);
}
