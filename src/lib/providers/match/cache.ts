/**
 * The match cache.
 *
 * ## What it is for
 *
 * The doc's Stage 0 (`docs/YouTube歌曲匹配算法.md` §10): a match that has
 * already been established is not established again.
 *
 * The cost being avoided is real. A NetEase search is a deep page —
 * 100 rows — and the matcher scores every one of them against the
 * source. That happens for every track in the availability search, for
 * every provider, every time the track's availability is asked about.
 * The availability layer already caches its *result*, but the result
 * cache is keyed by the whole track identity (title + artists +
 * duration + known ids), while the *cross-provider* cache here is
 * keyed by the query that was actually sent — which is coarser and
 * therefore hits far more often.
 *
 * The practical case: the same song is searched for twice in a row.
 * Once when the source switcher asks what else has it, and once when
 * the heart flow looks up the YouTube counterpart of a NetEase pick.
 * The second search asks NetEase for the same hundred rows and scores
 * them again.
 *
 * ## What is cached
 *
 * The *candidate list*, not the ranking. The ranking depends on the
 * user's priority order, which can change at any moment; the
 * candidates are a property of the query and of the catalogue, which
 * barely changes.
 *
 * ## The key
 *
 * The doc's key: the source id when there is one, and otherwise the
 * normalised title plus the sorted artist list. The source id is
 * preferred because it is exact — but it is *only* used when it
 * identifies the source unambiguously, which is why the caller passes
 * the provider's own id rather than the queue's synthetic one.
 */

import type { MatchSource } from "@/lib/providers/match/score";
import { normalizeSong } from "@/lib/providers/match/normalize";

/** A cached search: the candidates and when they were found. */
export type CachedSearch<T> = {
  candidates: T[];
  /** When the entry was written, in milliseconds. */
  at: number;
};

/**
 * How long a cached search stays fresh.
 *
 * A catalogue answer is stable enough to keep for a while — a new
 * upload does not appear in the middle of the user's session, and the
 * platforms' own rankings barely move. Ten minutes matches the
 * availability layer's staleness window, so the two layers expire
 * together.
 */
export const MATCH_CACHE_TTL = 10 * 60 * 1000;

/** The searches in flight, so two callers don't double up. */
const inFlight = new Map<string, Promise<unknown>>();

/** The cache itself. */
const cache = new Map<string, CachedSearch<unknown>>();

/**
 * The cache key for a query.
 *
 * The doc's rule, with the normalised title and artist list. The
 * normalisation happens here rather than at the call site so the key
 * is the same however the caller spelled the query.
 */
export function matchCacheKey(
  source: MatchSource,
  sourceId?: string,
): string {
  if (sourceId) return `src:${sourceId}`;
  const n = normalizeSong(source);
  return `${n.coreTitle}|${[...n.artists].sort().join(",")}`;
}

/**
 * Read a cached search.
 *
 * Returns `undefined` for an entry that is missing or stale — a
 * stale entry is a miss, not an expired one to be returned.
 */
export function readMatchCache<T>(key: string): T[] | undefined {
  const entry = cache.get(key) as CachedSearch<T> | undefined;
  if (!entry) return undefined;
  if (Date.now() - entry.at > MATCH_CACHE_TTL) {
    cache.delete(key);
    return undefined;
  }
  return entry.candidates;
}

/**
 * Write a search to the cache.
 */
export function writeMatchCache<T>(key: string, candidates: T[]): void {
  cache.set(key, { candidates, at: Date.now() });
}

/**
 * Run a search, reusing an in-flight one when there is one.
 *
 * The cache lookup and the in-flight lookup are separate because they
 * answer different questions: the cache answers "has this been
 * searched before", and the in-flight map answers "is this being
 * searched *right now*".
 */
export async function withMatchCache<T>(
  key: string,
  search: () => Promise<T[]>,
): Promise<T[]> {
  const cached = readMatchCache<T>(key);
  if (cached) return cached;

  const pending = inFlight.get(key) as Promise<T[]> | undefined;
  if (pending) return pending;

  const promise = search()
    .then((candidates) => {
      writeMatchCache(key, candidates);
      return candidates;
    })
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, promise);
  return promise;
}

/**
 * Forget the cached searches.
 *
 * Used when the provider set changes under the app, and when the
 * NetEase sign-in changes what NetEase will serve — the answers are
 * the account's, so they go with it.
 */
export function clearMatchCache(): void {
  cache.clear();
  inFlight.clear();
}
