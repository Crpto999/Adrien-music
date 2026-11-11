import {
  compareKeys,
  decideConfidence,
  failureReason,
  isCoverFallback,
  scoreCandidate,
  searchTitle,
} from "@/lib/providers/match";
import { matchCacheKey, withMatchCache } from "@/lib/providers/match/cache";
import {
  logMatchReport,
  type MatchDebugCandidate,
} from "@/lib/providers/match/debug";
import { toSimplified } from "@/lib/chinese";
import {
  PROVIDER_PRIORITY,
  playableProviders,
  searchOrderFor,
  toCanonical,
  type CanonicalTrack,
  type ProviderCandidate,
  type ProviderId,
  type ProviderRef,
  type ScoredCandidate,
} from "@/lib/providers/types";
import { getProviderAdapter, type ProviderSearch } from "@/lib/providers/registry";
// Side-effect import: importing the adapter bundle registers every
// built-in provider. The resolver is the module that *reads* the
// registry, so it is the module that must guarantee the registry is
// populated — otherwise a consumer that imports only the resolver
// silently gets an empty registry and no cross-provider matches at
// all, which is exactly the failure this import prevents.
import "@/lib/providers/adapters";

export type { ProviderSearch };
export { hasProvider, registerProvider } from "@/lib/providers/registry";

/**
 * Searching for a track on another provider, and picking the right one.
 *
 * The flow is deliberately conservative, because the failure mode of
 * getting it wrong is audible: a wrong match plays the wrong recording
 * of the right song — a cover, a live cut, a 30-second snippet — and
 * the user has no way to tell except that it sounds wrong.
 *
 * So the pipeline is:
 *
 *   1. Ask each provider for candidates (`searchProvider`).
 *   2. Score every candidate against the canonical track
 *      (`scoreMatch`). A candidate that isn't *convincingly* the same
 *      recording is dropped, not ranked low.
 *   3. Take the best-scoring candidate per provider.
 *   4. Walk the provider priority chain and use the first provider that
 *      produced a candidate at all.
 */

/**
 * The candidates a provider returned, scored against the canonical
 * track.
 *
 * The decision is the doc's multi-stage one, and it needs the
 * *runner-up's* score ? the margin is what separates "this candidate
 * was identified" from "this candidate came first in a list of
 * equals". So the whole list is scored first and only then judged.
 *
 * Two passes, in this order:
 *
 *   1. The doc's stages. The best candidate is judged against the
 *      runner-up, and the stages decide whether it is `high`,
 *      `medium`, `low`, or nothing at all.
 *   2. The cover fallback. If the first pass found nothing, a
 *      candidate whose title and length both agree strongly may stand
 *      in for the original ? a cover is a serviceable substitute for
 *      *playback*, even though it is never good enough for a library
 *      write.
 *
 * Only the winner is returned: the caller wants one record per
 * provider, and the ranking inside the provider is the scorer's
 * business, not the caller's.
 */
export function rankCandidates(
  candidates: ProviderCandidate[],
  canonical: CanonicalTrack,
  debug?: { provider: string; query: string },
): ScoredCandidate[] {
  if (candidates.length === 0) {
    // An empty result is worth recording on its own: "the provider
    // returned nothing" and "the provider returned things but none of
    // them matched" are different bugs, and only the second one is
    // about the matcher.
    if (debug) {
      logMatchReport({
        provider: debug.provider,
        query: debug.query,
        source: {
          title: canonical.title,
          artists: canonical.artists,
          album: canonical.album,
          duration: canonical.duration,
        },
        candidateCount: 0,
        top: [],
        reason: "no_candidates",
      });
    }
    return [];
  }

  const source = {
    title: canonical.title,
    artists: canonical.artists,
    album: canonical.album,
    duration: canonical.duration,
  };

  const scored = candidates
    .map((candidate) => ({
      candidate,
      match: scoreCandidate(
        {
          title: candidate.title,
          artists: candidate.artists,
          duration: candidate.duration,
          album: candidate.album,
          aliases: candidate.aliases,
          // The platform's own ordering, which the cascade uses as its
          // last tie-breaker.
          rank: candidate.rank,
        },
        source,
      ),
    }))
    .sort((a, b) => compareKeys(b.match.key, a.match.key));

  const best = scored[0];
  const secondKey = scored[1]?.match.key ?? null;

  // Pass 1: the cascade's stages.
  const confidence = decideConfidence(best.match, secondKey);
  if (confidence !== "failed") {
    reportRank(candidates, scored, canonical, debug, {
      pickedId: best.candidate.providerTrackId,
      confidence,
      reason: undefined,
    });
    return [
      {
        candidate: best.candidate,
        score: best.match.key,
        confidence,
      },
    ];
  }

  // Pass 2: the cover fallback.
  if (isCoverFallback(best.match)) {
    reportRank(candidates, scored, canonical, debug, {
      pickedId: best.candidate.providerTrackId,
      confidence: "low",
      reason: "cover_fallback",
    });
    return [
      {
        candidate: best.candidate,
        score: best.match.key,
        confidence: "low",
      },
    ];
  }

  reportRank(candidates, scored, canonical, debug, {
    reason: failureReason(best.match, secondKey),
  });
  return [];
}

/**
 * Record what the ranking decided.
 *
 * The candidates are described in full only for the best few — a
 * NetEase search returns a hundred rows, and a log that lists all of
 * them for every track is a log nobody reads. The rest are counted.
 */
function reportRank(
  candidates: ProviderCandidate[],
  scored: { candidate: ProviderCandidate; match: ReturnType<typeof scoreCandidate> }[],
  canonical: CanonicalTrack,
  debug: { provider: string; query: string } | undefined,
  outcome: {
    pickedId?: string;
    confidence?: string;
    reason?: string;
  },
): void {
  if (!debug) return;

  const secondKey = scored[1]?.match.key ?? null;
  const top: MatchDebugCandidate[] = scored
    .slice(0, 8)
    .map((row) => {
      const candidate: MatchDebugCandidate = {
        id: row.candidate.providerTrackId,
        title: row.candidate.title,
        artists: row.candidate.artists,
        album: row.candidate.album,
        duration: row.candidate.duration,
        aliases: row.candidate.aliases,
        rank: row.candidate.rank,
        score: row.match.key[0],
        t: row.match.components.title,
        cr: row.match.components.credit,
        a: row.match.components.artist,
        v: row.match.components.version,
        d: row.match.components.duration,
        al: row.match.components.album,
        rk: row.match.components.rank,
        extraVersions: row.match.extraVersions,
        // What this candidate would reach on its own, ignoring the
        // runner-up. The margin is applied to the winner only.
        confidence: decideConfidence(row.match, null),
      };
      if (candidate.confidence === "failed") {
        candidate.reason = failureReason(row.match, secondKey);
      }
      return candidate;
    });

  logMatchReport({
    provider: debug.provider,
    query: debug.query,
    source: {
      title: canonical.title,
      artists: canonical.artists,
      album: canonical.album,
      duration: canonical.duration,
    },
    candidateCount: candidates.length,
    top,
    pickedId: outcome.pickedId,
    confidence: outcome.confidence,
    reason: outcome.reason,
  });
}

/**
 * The queries to send to a provider, in the order that matters.
 *
 * ## Why the *first* artist and not all of them
 *
 * The old resolver built one query out of the title and *every* artist,
 * and measured against the ground truth that cost it a case: "紳士 -
 * Gentleman Victor Lau Princess Ai" returns exactly one result, and
 * it is the wrong one — while "紳士 - Gentleman" puts the right
 * recording at rank 0.
 *
 * A query that is too specific does not return a better answer; it
 * returns a *shorter* page, and the platform's ranking on a short
 * page is worse. So the primary query names the title and the first
 * artist only.
 *
 * ## Why a second query at all
 *
 * The platform's ranking is a strong prior — the authoritative
 * recording is at rank 0 in most cases — but it is only good for the
 * query that was actually asked, and there are titles the primary
 * query cannot reach: "残酷な天使のテーゼ" alone does not put the song
 * on the page at all, while the romanisation does.
 *
 * So the plan is *staged*: the cheap query goes first, and the broader
 * one only goes out when the first did not produce a confident answer.
 * Measured against the ground truth, the first query alone answers
 * every case — so the second is a safety net, not the main path.
 */
export function buildQueries(canonical: CanonicalTrack): string[] {
  const queries: string[] = [];

  const add = (text: string): void => {
    const t = (text ?? "").replace(/\s+/g, " ").trim();
    if (t && !queries.includes(t)) queries.push(t);
  };

  // The query is sent in Simplified Chinese. The Chinese platforms'
  // catalogues are written that way, so a Traditional title would
  // search for a song the platform does not have under that name.
  // (The scorer compares in Simplified too, so the two sides agree.)
  //
  // The title is also *translated* into the platforms' own spelling:
  // the Chinese credit marker ("合作音乐人:") is not something the
  // platforms can match, and searching for it returns a page of
  // unrelated songs. Measured: "True Colors(合作音乐人:Nicki Minaj) Wiz
  // Khalifa" does not put NetEase's 28935275 on the page at all,
  // while "True Colors (feat. Nicki Minaj) Wiz Khalifa" puts it at
  // rank 0.
  const title = toSimplified(searchTitle(canonical.title));
  const firstArtist = canonical.artists[0]
    ? toSimplified(canonical.artists[0])
    : "";

  // Stage 1: the title and the first artist.
  add(firstArtist ? `${title} ${firstArtist}` : title);
  // Stage 2: the title on its own.
  add(title);

  return queries;
}

/**
 * Find the best match for a track on each of the given providers.
 *
 * Providers are searched concurrently — they are independent
 * third parties and a serial pass would multiply the wait.
 *
 * ## The two rounds
 *
 * The first query is sent to every provider at once. Only the
 * providers that did not produce a *confident* answer are asked the
 * second question, so the common case costs one request per provider.
 *
 * ## The candidates' ranks
 *
 * The platform's own ordering is a signal — it is the cascade's last
 * tie-breaker — so each candidate keeps the best (lowest) rank it
 * reached across every query that produced it.
 *
 * ## The cache
 *
 * The doc's Stage 0: a search that has already been done is not done
 * again. The key is the normalised title and artist list, so the same
 * song asked for from two different places — the source switcher and
 * the heart flow, say — is searched once.
 */
export async function findMatches(
  canonical: CanonicalTrack,
  providers: ProviderId[],
  signal?: AbortSignal,
): Promise<Map<ProviderId, ProviderCandidate>> {
  const results = new Map<ProviderId, ProviderCandidate>();

  const queries = buildQueries(canonical);

  // The cache key. The source id is used when there is one — it is
  // exact — and the normalised title and artists otherwise.
  const cacheKey = matchCacheKey(
    {
      title: canonical.title,
      artists: canonical.artists,
      album: canonical.album,
      duration: canonical.duration,
    },
    // The origin's id identifies the *source*, not the search: the
    // search is for the same song on *other* platforms, so it is keyed
    // by the song rather than by where the user found it.
    undefined,
  );

  const searches = providers.map(async (provider) => {
    const adapter = getProviderAdapter(provider);
    if (!adapter) return;

    // The merged candidate list, and each candidate's best rank across
    // every query that produced it.
    const merged = new Map<string, ProviderCandidate>();
    const bestRank = new Map<string, number>();

    const runQuery = async (query: string): Promise<void> => {
      let rows: ProviderCandidate[];
      try {
        rows = await withMatchCache(`${cacheKey}|${provider}|${query}`, () =>
          adapter(query, signal),
        );
      } catch (e) {
        // A provider that is down must not take the whole search with
        // it — the others may still have the track.
        logMatchReport({
          provider,
          query,
          source: {
            title: canonical.title,
            artists: canonical.artists,
            album: canonical.album,
            duration: canonical.duration,
          },
          candidateCount: 0,
          top: [],
          reason: "search_failed",
          error: e instanceof Error ? e.message : String(e),
        });
        return;
      }

      rows.forEach((row, index) => {
        const id = row.providerTrackId;
        const existing = merged.get(id);
        const rank = bestRank.get(id);
        if (existing === undefined) {
          merged.set(id, { ...row, rank: index });
          bestRank.set(id, index);
        } else if (rank === undefined || index < rank) {
          bestRank.set(id, index);
          // Keep the *better* rank, and refresh the metadata from the
          // query that produced it — a later row may carry the album
          // or the aliases that the first one lacked.
          merged.set(id, { ...row, rank: index });
        }
      });
    };

    // Round 1: the precise query.
    await runQuery(queries[0]);

    const firstRound = Array.from(merged.values());
    const ranked = rankCandidates(firstRound, canonical, {
      provider,
      query: queries[0],
    });
    const best = ranked[0];
    if (best && (best.confidence === "high" || best.confidence === "medium")) {
      results.set(provider, best.candidate);
      return;
    }

    // Round 2: only for the providers that did not answer confidently.
    if (queries.length > 1) {
      await runQuery(queries[1]);
      const secondRound = Array.from(merged.values());
      const reranked = rankCandidates(secondRound, canonical, {
        provider,
        query: queries.join(" | "),
      });
      const winner = reranked[0];
      if (winner) {
        results.set(provider, winner.candidate);
        return;
      }
    }

    // Nothing confident: fall back to whatever the first round found,
    // which may still be a serviceable cover.
    if (best) results.set(provider, best.candidate);
  });

  await Promise.all(searches);
  return results;
}

/**
 * Resolve a track to a playable provider reference.
 *
 * The provider chain is walked in priority order and the first
 * provider that produced a match wins. When the track's own origin
 * provider is in the chain, it is preferred — the user already found
 * it there, so that match is the most trustworthy one.
 */
export async function resolveProviderRef(
  canonical: CanonicalTrack,
  options?: {
    priority?: ProviderId[];
    signal?: AbortSignal;
  },
): Promise<ProviderRef | null> {
  const priority = options?.priority ?? PROVIDER_PRIORITY;

  // The origin provider's own id is authoritative: no matching needed.
  if (canonical.origin && canonical.originId) {
    const origin = canonical.origin;
    if (priority.includes(origin)) {
      return { provider: origin, providerTrackId: canonical.originId };
    }
  }

  const searchable = searchOrderFor(
    canonical.origin ?? "youtube",
    playableProviders(priority),
  );
  if (searchable.length === 0) return null;

  const matches = await findMatches(
    canonical,
    searchable,
    options?.signal,
  );
  for (const provider of searchable) {
    const candidate = matches.get(provider);
    if (candidate) {
      return {
        provider,
        providerTrackId: candidate.providerTrackId,
      };
    }
  }
  return null;
}

/**
 * The full picture for a track: the canonical form plus where it can
 * be played.
 *
 * The UI shows this as "now playing from YouTube Music", and the
 * source-switch control offers the alternatives.
 */
export async function resolveSources(
  canonical: CanonicalTrack,
  options?: {
    priority?: ProviderId[];
    signal?: AbortSignal;
  },
): Promise<{
  canonical: CanonicalTrack;
  /** The provider the track will play from. */
  active: ProviderRef | null;
  /** Every provider that has a match, in priority order. */
  available: ProviderRef[];
}> {
  const priority = options?.priority ?? PROVIDER_PRIORITY;
  const playable = playableProviders(priority);
  const matches = await findMatches(
    canonical,
    searchOrderFor(canonical.origin ?? "youtube", playable),
    options?.signal,
  );

  const available: ProviderRef[] = [];
  if (canonical.origin && canonical.originId) {
    available.push({
      provider: canonical.origin,
      providerTrackId: canonical.originId,
    });
  }
  for (const provider of playable) {
    const candidate = matches.get(provider);
    if (candidate) {
      available.push({
        provider,
        providerTrackId: candidate.providerTrackId,
      });
    }
  }

  return {
    canonical,
    active: available[0] ?? null,
    available,
  };
}

/**
 * Build a canonical track from a provider candidate.
 *
 * Re-exported from `./types` so callers that already import the
 * resolver don't need a second import.
 */
export { toCanonical };
