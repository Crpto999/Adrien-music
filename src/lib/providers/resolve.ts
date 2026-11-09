import { scoreMatch, type MatchCandidate } from "@/lib/providers/match";
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
 * Rejected candidates are dropped rather than ranked: a low score here
 * means "this is probably a different recording", and picking it would
 * be worse than picking nothing.
 */
export function rankCandidates(
  candidates: ProviderCandidate[],
  canonical: CanonicalTrack,
): ScoredCandidate[] {
  const out: ScoredCandidate[] = [];
  for (const candidate of candidates) {
    const match: MatchCandidate = {
      title: candidate.title,
      artists: candidate.artists,
      duration: candidate.duration,
    };
    const score = scoreMatch(match, {
      title: canonical.title,
      artists: canonical.artists,
      duration: canonical.duration,
    });
    if (score === null) continue;
    out.push({ candidate, score });
  }
  out.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return out;
}

/**
 * Find the best match for a track on each of the given providers.
 *
 * Providers are searched concurrently — they are independent
 * third parties and a serial pass would multiply the wait.
 */
export async function findMatches(
  canonical: CanonicalTrack,
  providers: ProviderId[],
  signal?: AbortSignal,
): Promise<Map<ProviderId, ProviderCandidate>> {
  const results = new Map<ProviderId, ProviderCandidate>();
  // The query is sent in Simplified Chinese. The Chinese platforms'
  // catalogues are written that way, so a Traditional title would
  // search for a song the platform does not have under that name.
  // (The scorer compares in Simplified too, so the two sides agree.)
  const query = [
    toSimplified(canonical.title),
    ...canonical.artists.map((a) => toSimplified(a)),
  ]
    .join(" ")
    .trim();

  const searches = providers.map(async (provider) => {
    const adapter = getProviderAdapter(provider);
    if (!adapter) return;
    let candidates: ProviderCandidate[];
    try {
      candidates = await adapter(query, signal);
    } catch {
      // A provider that is down must not take the whole search with
      // it — the others may still have the track.
      return;
    }
    const ranked = rankCandidates(candidates, canonical);
    const best = ranked[0];
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
