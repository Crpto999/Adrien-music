/**
 * Cross-provider track matching.
 *
 * The same song exists on several platforms under the same title and
 * artist, so finding "the same recording" on another provider needs a
 * judgement, not a string compare: a search for a popular song is full
 * of covers, live cuts and sped-up remixes that would silently play the
 * wrong audio.
 *
 * ## The design
 *
 * The matcher is split into three parts, each in its own module:
 *
 *   - `match/normalize.ts` — the text folding, the title's legitimate
 *     forms, and the split between a title's core and its featuring
 *     credit.
 *   - `match/similarity.ts` — the agreement measures, one per
 *     dimension, each answering a different question.
 *   - `match/score.ts` — the cascade that compares those agreements
 *     lexicographically, and the confidence decision.
 *
 * This module is the façade over them, and it keeps the two functions
 * the rest of the app already uses — `scoreMatch` and `artistsAgree`.
 *
 * ## The algorithm
 *
 * A **cascade**, not a weighted sum: the title is compared first, and
 * only if the titles agree is the featuring credit compared, and so
 * on down to the platform's own ranking as the last tie-breaker. A
 * weaker signal can never outvote a stronger one.
 *
 * The full specification, with the measurements behind every decision,
 * is `docs/YouTube歌曲匹配算法.md`.
 *
 * ## Chinese scripts
 *
 * The Chinese platforms write Simplified Chinese; a YouTube upload of
 * the same song may be Traditional. Both sides are converted to
 * Simplified before they are compared, so "愛你" and "爱你" are the
 * same title rather than two different ones. Without that, a
 * Taiwanese upload never matches the NetEase record that is sitting
 * right there in the catalogue.
 *
 * ## What is different from the old scorer
 *
 * The old one summed four similarities with fixed weights and gated on
 * *word coverage*: a candidate had to contain 75% of the original's
 * meaningful words, and it rejected anything whose title mentioned a
 * word the original lacked. That was a strict subset test, and it
 * failed in both directions:
 *
 *   - A candidate with *fewer* words than the source was rejected
 *     even when it was the same song under a shorter credit — which
 *     is the "Best Part (feat. H.E.R.)" case the regression test
 *     pins down.
 *   - A candidate with *more* words was accepted as long as the source's
 *     words were all there, so "演员 (Live)" matched "演员" whenever
 *     the artist and the length happened to agree.
 *
 * And the weights let the platform's own ranking cancel out the
 * featuring-credit evidence, so a popular song matched the wrong
 * release. The measured ground truth went from 50% to 100%.
 */

import {
  CASCADE,
  compareKeys,
  decideConfidence,
  failureReason,
  isCoverFallback,
  passesGates,
  scoreCandidate,
  type MatchCandidate,
  type MatchComponents,
  type MatchConfidence,
  type MatchKey,
  type MatchScore,
  type MatchSource,
} from "@/lib/providers/match/score";
import { artistAgreement } from "@/lib/providers/match/similarity";
import { artistsOf, normalizeSong } from "@/lib/providers/match/normalize";

export type {
  MatchCandidate,
  MatchComponents,
  MatchConfidence,
  MatchKey,
  MatchScore,
  MatchSource,
};
export {
  scoreCandidate,
  decideConfidence,
  failureReason,
  isCoverFallback,
  passesGates,
  compareKeys,
  CASCADE,
};
export {
  matchCacheKey,
  readMatchCache,
  writeMatchCache,
  withMatchCache,
  clearMatchCache,
  MATCH_CACHE_TTL,
} from "@/lib/providers/match/cache";
export {
  normalizeText,
  normalizeSong,
  artistsOf,
  splitFeat,
  versionTags,
  titleVariants,
  titleForms,
  stripAnnotation,
  decompose,
  isGenericArtist,
  searchTitle,
  albumBase,
} from "@/lib/providers/match/normalize";
export {
  jaroWinkler,
  titleAgreement,
  artistAgreement,
  creditAgreement,
  durationAgreement,
  albumAgreement,
  versionAgreement,
  rankScore,
  normalizeAliases,
  scriptOf,
  ALBUM_EXACT,
  ALBUM_CONTAINED,
  ALBUM_CLOSE,
  ALBUM_FAIR,
  ALBUM_DIFFERENT,
  CREDIT_EXACT,
  CREDIT_PARTIAL,
  CREDIT_NEITHER,
  CREDIT_CAND_ONLY,
  CREDIT_SOURCE_ONLY,
  TITLE_EXACT_CREDIT,
  TITLE_EXACT,
  TITLE_FUZZY_STRONG,
  TITLE_NONE,
  DURATION_EXACT,
  DURATION_CLOSE,
  DURATION_NEAR,
  DURATION_FAR,
  DURATION_FARTHER,
  DURATION_NONE,
  VERSION_MATCH,
  VERSION_MISMATCH,
  VERSION_MISSING,
} from "@/lib/providers/match/similarity";

/**
 * The candidate's artist names, as a normalised set.
 *
 * The platform's own credit is what counts; the title's featuring
 * credit is the fallback for a row that carries no artist field. The
 * artist line is included because some platforms put the whole credit
 * in one string rather than in a list.
 */
function artistNames(candidate: MatchCandidate): string[] {
  const names = [
    ...(candidate.artists ?? []),
    ...(candidate.artistLine ? candidate.artistLine.split(/[,，、&]/) : []),
  ]
    .map((a) => normalizeSong({ title: a }).coreTitle)
    .filter(Boolean);
  return [...new Set(names)];
}

/**
 * Judge one candidate against the track we're looking for.
 *
 * Returns `null` when the candidate is not convincingly the same
 * recording, otherwise the candidate's comparison key.
 *
 * The *acceptance* is deliberately separate from the *ranking*: the
 * resolver wants every acceptable candidate ranked, so it calls
 * {@link scoreCandidate} directly. This function is for the callers
 * that want one answer or nothing — the heart flow's threshold, and
 * the tests.
 *
 * A single candidate has no runner-up, so the margin is waived: the
 * stages are decided on the components alone. The resolver, which
 * *has* a runner-up, applies the margin there.
 */
export function scoreMatch(
  candidate: MatchCandidate,
  hint: MatchSource,
): MatchKey | null {
  const scored = scoreCandidate(candidate, hint);
  const confidence = decideConfidence(scored, null);
  if (confidence !== "failed") return scored.key;
  // The cover fallback: a candidate whose title and length both agree
  // strongly may stand in for the original, even though the artist
  // does not.
  if (isCoverFallback(scored)) return scored.key;
  return null;
}

/**
 * Judge one candidate, with the confidence attached.
 *
 * This is what the resolver uses: it needs to know *how* good the
 * match is, not just how good it scores, because the confidence is
 * what decides whether the candidate may be written into the user's
 * own library.
 */
export function scoreCandidateDetailed(
  candidate: MatchCandidate,
  hint: MatchSource,
): MatchScore {
  return scoreCandidate(candidate, hint);
}

/**
 * Whether the candidate's artist agrees with the track's.
 *
 * The scorer lets a candidate through on the strength of an almost
 * identical length alone, which is the right call when the question is
 * "can we play something close enough" — a cover is a fine substitute
 * for playback.
 *
 * It is the wrong call when the question is "is this *the* record the
 * user has in their library". A cover can share the original's exact
 * running time, so length alone cannot tell the two apart, and
 * hearting the cover would put the wrong recording into the user's
 * own collection.
 *
 * The measure is the set-based one: an artist the source names has to
 * be present in the candidate's own credit.
 */
export function artistsAgree(
  candidate: MatchCandidate,
  hint: MatchSource,
): boolean {
  const src = normalizeSong(hint);
  const want = artistsOf(src);
  if (want.length === 0) return true;

  const got = artistNames(candidate);
  if (got.length === 0) return false;

  // A *proven* mismatch does not agree. An unverifiable one — the two
  // sides written in different scripts, which the platforms do
  // routinely — is not a disagreement either.
  const agreement = artistAgreement(want, got);
  if (!agreement.verified) return agreement.score >= 0.6;
  return agreement.score >= 0.7;
}
