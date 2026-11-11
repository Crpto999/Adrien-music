/**
 * The cross-provider match scorer.
 *
 * ## What this decides
 *
 * "Is this candidate on another platform the *same recording* as the
 * track we are looking for?"
 *
 * The failure mode is audible: a wrong match plays the wrong recording
 * of the right song — a cover, a live cut, a thirty-second snippet —
 * and the user has no way to tell except that it sounds wrong. So the
 * scorer is deliberately conservative, and it separates two questions
 * that the old scorer conflated:
 *
 *   - **Ranking** — which candidate is the *best* match? A key.
 *   - **Accepting** — is any candidate good enough to use at all?
 *
 * ## The cascade, not the weighted sum
 *
 * The old scorer added the four similarities up with fixed weights.
 * That has a structural flaw, and it is not a matter of tuning: the
 * signals are *not commensurable*, and the evidence is *discrete*.
 *
 * The title either carries the featuring credit or it does not. The
 * album either matches the upload's album or it does not. The length
 * either matches within a second or it does not. When such evidence
 * is folded into continuous weights, a strong signal can be cancelled
 * by an unrelated weak one — and it was: in the ground truth, the
 * platform's ranking bonus cancelled out the featuring-credit
 * evidence, and the *wrong* release won.
 *
 * So the signals are compared **lexicographically**, strongest first:
 *
 *   | signal    | question                                            |
 *   |-----------|-----------------------------------------------------|
 *   | title     | is this the same song?                               |
 *   | credit    | the same *release*?                                  |
 *   | artist    | the same *performer*?                               |
 *   | version   | the same *cut*?                                     |
 *   | duration  | the same *recording*?                               |
 *   | album     | which release?                                       |
 *   | rank      | what does the platform think?                        |
 *
 * A weaker signal can never outvote a stronger one. The order was
 * measured, not assumed: of the 21 single swaps of it, moving the
 * title out of first place or the platform's rank out of last breaks
 * the ground truth.
 *
 * The full specification, with the measurements behind each decision,
 * is `docs/YouTube歌曲匹配算法.md`.
 */

import {
  artistsOf,
  normalizeSong,
  type NormalizedSong,
} from "@/lib/providers/match/normalize";
import {
  albumAgreement,
  artistAgreement,
  creditAgreement,
  durationAgreement,
  normalizeAliases,
  rankScore,
  titleAgreement,
  versionAgreement,
  TITLE_EXACT,
  TITLE_FUZZY_STRONG,
} from "@/lib/providers/match/similarity";

/** How confident the scorer is in a match. */
export type MatchConfidence = "high" | "medium" | "low" | "failed";

/** What we know about the track we are looking for. */
export type MatchSource = {
  title: string;
  artists?: string[];
  album?: string | null;
  /** Seconds, when known. */
  duration?: number;
};

/** A candidate from any provider, in the shape the scorer needs. */
export type MatchCandidate = {
  title: string;
  /** Provider-specific artist names. */
  artists?: string[];
  /** The artist line as a single string, when the provider has one. */
  artistLine?: string;
  /** Seconds, when known. */
  duration?: number;
  /** The album, when the provider reports one. */
  album?: string | null;
  /**
   * The platform's other names for the recording.
   *
   * The platform files a song under an alias as well as its title,
   * and the alias is often the name the recording is known by *on the
   * platform the user came from* — which is exactly the name the
   * source side carries. So an alias that matches is strong evidence.
   */
  aliases?: string[];
  /**
   * Where the platform ranked this candidate, zero-based.
   *
   * The platform's own ordering is a strong prior — the
   * authoritative recording sits at rank 0 in most cases — so it is
   * the last tie-breaker. `undefined` means "not ranked", which is
   * treated as the bottom of the page.
   */
  rank?: number;
};

/**
 * The component scores of one comparison.
 *
 * Each is a *tier*, not a 0–1 similarity: the values are chosen so
 * that they compare meaningfully within their own dimension, and the
 * dimensions are compared in the cascade order rather than summed.
 */
export type MatchComponents = {
  /** The title agreement tier. */
  title: number;
  /** The featuring-credit agreement tier. */
  credit: number;
  /** The artist agreement, 0–1. */
  artist: number;
  /** The version agreement, 0–1. */
  version: number;
  /** The duration agreement tier. */
  duration: number;
  /** The album agreement tier. */
  album: number;
  /** The platform's own ranking, 0–1. */
  rank: number;
};

/** The result of comparing one candidate against a source. */
export type MatchScore = {
  /**
   * The comparison key.
   *
   * The components in cascade order, compared as a tuple. This is
   * what the ranking sorts on and what the confidence is decided from.
   */
  key: MatchKey;
  /** The components, for the thresholds and for diagnostics. */
  components: MatchComponents;
  /**
   * The version markers the candidate carries that the source does
   * not — for the diagnostics.
   */
  extraVersions?: string[];
  /**
   * Whether the artist comparison could be *verified*.
   *
   * `false` when the two sides are written in different scripts and
   * the platform carries no alias to bridge them: the mismatch is
   * unverifiable rather than proven.
   */
  artistVerified?: boolean;
  /**
   * Whether the length could be compared at all.
   *
   * `false` when either side has no length — Migu's search endpoint
   * does not report one, and a user upload may not have one either.
   * That is *no evidence*, which is not the same thing as *evidence
   * of a mismatch*: the length requirements are waived rather than
   * failed.
   */
  durationKnown?: boolean;
};

/** The comparison key: the components in cascade order. */
export type MatchKey = readonly [
  number, // title
  number, // credit
  number, // artist
  number, // version
  number, // duration
  number, // album
  number, // rank
];

/**
 * The cascade order.
 *
 * Strongest first — a weaker signal can never outvote a stronger one.
 */
export const CASCADE = [
  "title",
  "credit",
  "artist",
  "version",
  "duration",
  "album",
  "rank",
] as const;

/**
 * The hard gates.
 *
 * A candidate that fails any of them is not a weaker match — it is a
 * *different* thing, and it is dropped rather than ranked low.
 */
const GATE_TITLE = TITLE_FUZZY_STRONG;
const GATE_DURATION = 1.0;

/**
 * The conditional artist gate.
 *
 * A *proven* artist mismatch is fatal — unless the title and the
 * length are both near-exact, which is the signature of the same
 * recording under two writing systems ("Yoko Takahashi" /
 * "高橋洋子").
 */
const STRONG_TITLE = TITLE_EXACT;
const STRONG_DURATION = 4.0;

/**
 * The thresholds each confidence level requires.
 */
const THRESHOLDS = {
  high: { title: TITLE_EXACT, artist: 0.6, duration: 4.0 },
  medium: { title: TITLE_EXACT, artist: 0.4, duration: 2.0 },
  low: { title: TITLE_FUZZY_STRONG, artist: 0, duration: 0 },
} as const;

/**
 * Score one candidate against the source track.
 *
 * The platform's ranking is the last tie-breaker: the platform's
 * ordering is a strong prior, but it must never outvote the title or
 * the length.
 *
 * The rank comes from the candidate's own `rank` field. It is
 * accepted here as well because the field is where the resolver has
 * it — and the two must not disagree: a candidate scored through the
 * field and a candidate scored through the argument would otherwise
 * get different keys for the same row.
 */
export function scoreCandidate(
  candidate: MatchCandidate,
  source: MatchSource,
  rank?: number,
): MatchScore {
  const src = normalizeSong(source);
  const cand = normalizeSong({
    title: candidate.title,
    artists: candidate.artists ?? splitArtistLine(candidate.artistLine),
    album: candidate.album,
    duration: candidate.duration,
  });

  // The candidate's aliases, normalised once. They are compared
  // against the *source* title, which is what they are aliases *of*.
  const aliases = normalizeAliases(candidate.aliases);

  const artist = artistAgreement(artistsOf(src), artistsOf(cand));

  // The rank: the candidate's own field wins, and the argument is the
  // fallback for a caller that has it there instead.
  const effectiveRank = candidate.rank ?? rank ?? -1;

  const components: MatchComponents = {
    title: titleAgreement(src, cand, aliases),
    credit: creditAgreement(src.featArtists, cand.featArtists),
    artist: artist.score,
    version: versionAgreement(src.versions, cand.versions),
    duration: durationAgreement(src.duration, cand.duration),
    album: albumAgreement(src.album, cand.album, aliases),
    rank: rankScore(effectiveRank),
  };

  // Whether the length could be compared at all. Migu's search
  // endpoint reports no length, and a user upload may not have one
  // either — and *no evidence* is not *evidence of a mismatch*.
  const durationKnown =
    !!src.duration && src.duration > 0 && !!cand.duration && cand.duration > 0;

  const key: MatchKey = [
    components.title,
    components.credit,
    components.artist,
    components.version,
    components.duration,
    components.album,
    components.rank,
  ];

  const extraVersions = cand.versions.filter((v) => !src.versions.includes(v));

  return {
    key,
    components,
    extraVersions: extraVersions.length > 0 ? extraVersions : undefined,
    artistVerified: artist.verified,
    durationKnown,
  };
}

/**
 * The artist line, split into names.
 *
 * Some platforms put the whole credit in one string rather than in a
 * list.
 */
function splitArtistLine(line: string | undefined): string[] {
  if (!line) return [];
  return line
    .split(/[,，、&]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Whether the candidate passes the hard gates.
 *
 * The gates are what separate "a weaker match" from "a different
 * thing".
 */
export function passesGates(best: MatchScore): boolean {
  const c = best.components;
  // A title that is a *different* title is a different song, however
  // well the artist and the length happen to agree.
  if (c.title < GATE_TITLE) return false;
  // A length that is a different length is a different recording —
  // but only when there *is* a length to compare. Migu's search rows
  // carry none, and that is no evidence against them.
  if (c.duration < GATE_DURATION && best.durationKnown !== false) return false;
  // An artist that does not match at all is fatal — but only when the
  // mismatch is *proven*. A mismatch across writing systems is
  // unverifiable rather than proven (NetEase files the same act under
  // a different script and carries no alias to bridge them), and it
  // cannot veto a title and a length that both agree exactly.
  if (c.artist < 0.5) {
    if (best.artistVerified === false) {
      if (c.title < STRONG_TITLE || c.duration < STRONG_DURATION) return false;
    } else {
      return false;
    }
  }
  return true;
}

/**
 * Compare two keys.
 *
 * The tuple comparison *is* the margin: a candidate that only wins on
 * the last component has not been *identified*, it has merely come
 * first in a list of equals.
 */
export function compareKeys(a: MatchKey, b: MatchKey): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  }
  return 0;
}

/**
 * Decide the confidence of a match.
 *
 * `secondKey` is the runner-up's key, or `null` when there is no
 * runner-up. The `medium` and `low` stages need the winner to be
 * *ahead* of it.
 *
 * The length requirements are waived when there is no length to
 * compare — Migu's search rows carry none, and a missing length is
 * not evidence of a mismatch.
 */
export function decideConfidence(
  best: MatchScore,
  secondKey: MatchKey | null,
): MatchConfidence {
  if (!passesGates(best)) return "failed";
  const c = best.components;
  const ahead = secondKey === null || compareKeys(best.key, secondKey) > 0;
  const durationKnown = best.durationKnown !== false;

  const high = THRESHOLDS.high;
  if (
    c.title >= high.title &&
    c.artist >= high.artist &&
    (c.duration >= high.duration || !durationKnown)
  ) {
    return "high";
  }
  const medium = THRESHOLDS.medium;
  if (
    c.title >= medium.title &&
    c.artist >= medium.artist &&
    (c.duration >= medium.duration || !durationKnown) &&
    ahead
  ) {
    return "medium";
  }
  const low = THRESHOLDS.low;
  if (c.title >= low.title && ahead) return "low";
  return "failed";
}

/**
 * The thresholds a candidate has to clear to stand in for the original
 * as a cover.
 *
 * The title has to be the same song and the length has to be the same
 * take — those are the two things a cover cannot fake without being
 * the recording. The artist is the one thing it *can* fake, which is
 * exactly why it is not required here.
 */
const COVER_FALLBACK = { title: TITLE_EXACT, duration: 4.0 } as const;

/**
 * Whether a candidate may stand in for the original as a cover.
 *
 * The old matcher's "the artist does not agree, but the length is all
 * but identical, so accept it" rule — kept, but demoted to the
 * fallback it always should have been. It runs only when nothing
 * better is on offer, and its result is never good enough to write
 * into the user's own library.
 */
export function isCoverFallback(best: MatchScore): boolean {
  return (
    best.components.title >= COVER_FALLBACK.title &&
    best.components.duration >= COVER_FALLBACK.duration
  );
}

/**
 * Why a match failed.
 *
 * The reason is for the diagnostics — the source switcher can say
 * *why* a platform was not offered, which is a far more useful thing
 * to show than an empty list.
 */
export function failureReason(best: MatchScore, secondKey: MatchKey | null): string {
  const c = best.components;
  if (c.title < GATE_TITLE) return "title_mismatch";
  if (c.artist < 0.5) {
    // A proven mismatch is fatal; an unverifiable one only counts when
    // the title or the length is not near-exact.
    if (best.artistVerified === false) return "artist_unverifiable";
    return "artist_mismatch";
  }
  if (c.duration < GATE_DURATION && best.durationKnown !== false) {
    return "duration_mismatch";
  }
  if (secondKey !== null && compareKeys(best.key, secondKey) <= 0) {
    return "ambiguous";
  }
  return "low_score";
}

/**
 * The normalised form of a source track.
 *
 * Exported so the cache can key on it without re-normalising.
 */
export function normalizeSource(source: MatchSource): NormalizedSong {
  return normalizeSong(source);
}
