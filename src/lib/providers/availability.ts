import { findMatches } from "@/lib/providers/resolve";
import { getProviderOrder } from "@/lib/providers/order";
import {
  playableProviders,
  type CanonicalTrack,
  type ProviderId,
  type ProviderRef,
} from "@/lib/providers/types";

/**
 * Where every track can be played from.
 *
 * ## What this is for
 *
 * Two parts of the app need the same answer to the same question —
 * "which of my sources have this song?":
 *
 *   - The **player** needs it to decide which source actually serves
 *     the track, in the user's priority order.
 *   - The **source-switcher panel** needs it to show what else the
 *     track exists on.
 *
 * Answering it twice means two identical cross-provider searches —
 * five parallel requests each — and the two answers can disagree, so
 * the panel offers a source the player never considered. So the answer
 * is computed once, here, and both read it.
 *
 * ## The search is concurrent, and it always covers every source
 *
 * Every source is asked *at the same time*, not one after another and
 * not "until the first hit". That is deliberate, and it is the whole
 * point of the module:
 *
 *   - The panel needs to know about *every* source that has the
 *     track, including the ones below the winner in the priority
 *     order. A search that stopped at the first hit could never
 *     populate that list.
 *   - The player's choice must not depend on which source happened to
 *     answer first. With the search spread across all the sources in
 *     parallel, the ranking is decided by the *priority order alone*
 *     — not by network latency. A serial search would let a slow
 *     YouTube response cost the track its NetEase membership.
 *
 * So the search gathers everything, then the priority order decides.
 *
 * ## The cache
 *
 * The answer for a track is a property of the track, not of the moment:
 * a song's availability across platforms barely changes. So it is
 * cached by the track's identity — its title, artists and duration —
 * and reused. That is what keeps the panel from firing a fresh
 * five-request search every time it is opened.
 */

/** How long a fetched availability list is considered fresh. */
export const AVAILABILITY_STALE_TIME = 10 * 60 * 1000;

/** How long an unused entry is kept around. */
export const AVAILABILITY_GC_TIME = 30 * 60 * 1000;

/**
 * The stable key for a track's availability.
 *
 * The provider and the provider's own id are deliberately *not* part of
 * the key: availability is "everywhere else this song lives", which
 * does not depend on where it is currently playing from. The title,
 * the artists and the duration do, because they are what the matcher
 * uses to decide what counts as the same recording.
 *
 * The *known* ids are part of the key, though, because they change the
 * answer: a track whose NetEase id is known is answered with that
 * record, while one without it is answered with whatever the search
 * matched. Two tracks with the same title and artist but different
 * known ids are not the same lookup, so they must not share a cache
 * entry.
 */
export function availabilityKey(canonical: CanonicalTrack): string {
  const title = canonical.title.trim().toLowerCase();
  const artists = canonical.artists
    .map((a) => a.trim().toLowerCase())
    .sort()
    .join(",");
  const duration = canonical.duration ? Math.round(canonical.duration) : "";
  const known = canonical.knownIds
    ? Object.entries(canonical.knownIds)
        .filter(([, id]) => !!id)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([p, id]) => `${p}:${id}`)
        .join(",")
    : "";
  return `availability:${title}|${artists}|${duration}|${known}`;
}

/**
 * The cached matches, keyed by `availabilityKey`.
 *
 * Only the *matches* are cached — never the ranking. The priority
 * order can change at any moment, and a cached ranking would then
 * disagree with the user's setting. The matches are a property of the
 * track; the ranking is a property of the setting.
 *
 * The entry also records *which* sources were asked, because a narrow
 * search (the daily picks, which only care about the other sources)
 * must not be mistaken for a full one.
 */
type CacheEntry = {
  /** The matches found. */
  matches: Map<ProviderId, ProviderRef>;
  /** The sources that were actually searched. */
  searched: Set<ProviderId>;
};

const cache = new Map<string, CacheEntry>();

/** The searches currently in flight, so two callers don't double up. */
const inFlight = new Map<string, Promise<CacheEntry>>();

/**
 * Rank the matches into the order the sources should be tried.
 *
 * The order is the user's priority order and nothing else. The origin
 * provider gets no special treatment: its *own* id is used when the
 * ranking reaches it (that id is authoritative — the user picked that
 * track there), but it sits wherever the priority order puts it.
 *
 * That distinction matters. An earlier version of this module put the
 * origin first unconditionally, which meant a YouTube track always
 * played from YouTube no matter where the user had put NetEase — the
 * priority setting was, in effect, ignored for ordinary songs.
 */
export function rankAvailability(
  matches: Map<ProviderId, ProviderRef>,
  canonical: CanonicalTrack,
  priority: ProviderId[],
): ProviderRef[] {
  const playable = playableProviders(priority);
  const out: ProviderRef[] = [];

  for (const provider of playable) {
    // The origin's own record wins over a *match* for it: the id the
    // user actually picked is the authoritative one.
    if (
      provider === canonical.origin &&
      canonical.originId
    ) {
      out.push({
        provider,
        providerTrackId: canonical.originId,
      });
      continue;
    }
    // So does an id the app *knows* the track by — a NetEase daily
    // pick the user hearted is one recording under two ids, and the
    // NetEase side must be the pick's own record rather than whatever
    // the search matched. A search result can be a cover of the same
    // song; the known id cannot.
    const known = canonical.knownIds?.[provider];
    if (known) {
      out.push({ provider, providerTrackId: known });
      continue;
    }
    const m = matches.get(provider);
    if (m) out.push(m);
  }
  return out;
}

/**
 * The sources that have to be asked about a track.
 *
 * The origin is not among them: the user already has that result, and
 * asking for it again wastes a round trip.
 *
 * Neither is a provider whose id the app already *knows*: a known id
 * is the authoritative record, so a search for it could only turn up a
 * worse answer — a cover of the same song, filed under a different id.
 */
function searchableFor(
  canonical: CanonicalTrack,
  priority: ProviderId[],
): ProviderId[] {
  return playableProviders(priority).filter(
    (p) => p !== canonical.origin && !canonical.knownIds?.[p],
  );
}

/**
 * Search the given sources for a track, concurrently.
 *
 * Returns the matches — a provider that has the track maps to its own
 * id for it.
 */
async function searchSources(
  canonical: CanonicalTrack,
  sources: ProviderId[],
  signal?: AbortSignal,
): Promise<Map<ProviderId, ProviderRef>> {
  if (sources.length === 0) return new Map();
  const matches = await findMatches(canonical, sources, signal);
  const out = new Map<ProviderId, ProviderRef>();
  for (const [provider, candidate] of matches) {
    out.set(provider, {
      provider,
      providerTrackId: candidate.providerTrackId,
    });
  }
  return out;
}

/**
 * The availability of a track.
 *
 * This is the entry point every reader uses. It never throws: a
 * provider that is down simply contributes no match.
 *
 * A cached entry is reused when it already covers every source the
 * caller needs. Otherwise only the *missing* sources are searched, and
 * the result is merged into the entry.
 */
export async function getAvailability(
  canonical: CanonicalTrack,
  options?: {
    signal?: AbortSignal;
    force?: boolean;
    /**
     * The order to search in. It decides *which* sources are asked: a
     * source outside the chain is not asked at all. The ranking,
     * though, always follows the chain the app is currently set to —
     * see `rankAvailability`.
     */
    priority?: ProviderId[];
  },
): Promise<ProviderRef[]> {
  const priority = options?.priority ?? getProviderOrder();
  const key = availabilityKey(canonical);
  const wanted = searchableFor(canonical, priority);

  if (!options?.force) {
    const entry = cache.get(key);
    if (entry) {
      const missing = wanted.filter((p) => !entry.searched.has(p));
      if (missing.length === 0) {
        // Everything the caller needs is already known. Only the
        // ranking changes when the priority does.
        return rankAvailability(entry.matches, canonical, priority);
      }
      const found = await searchSources(canonical, missing, options?.signal);
      for (const [provider, ref] of found) {
        entry.matches.set(provider, ref);
        entry.searched.add(provider);
      }
      return rankAvailability(entry.matches, canonical, priority);
    }

    const pending = inFlight.get(key);
    if (pending) {
      const entry = await pending;
      return rankAvailability(entry.matches, canonical, priority);
    }
  }

  const promise = (async (): Promise<CacheEntry> => {
    const matches = await searchSources(canonical, wanted, options?.signal);
    const entry: CacheEntry = {
      matches,
      searched: new Set(wanted),
    };
    cache.set(key, entry);
    return entry;
  })();
  inFlight.set(key, promise);
  try {
    const entry = await promise;
    return rankAvailability(entry.matches, canonical, priority);
  } finally {
    inFlight.delete(key);
  }
}

/**
 * The availability of a track, from the cache only.
 *
 * Returns `null` when nothing has been cached yet. The source-switcher
 * panel uses this to render instantly while a fetch is in flight.
 */
export function peekAvailability(
  canonical: CanonicalTrack,
): ProviderRef[] | null {
  const entry = cache.get(availabilityKey(canonical));
  if (!entry) return null;
  return rankAvailability(entry.matches, canonical, getProviderOrder());
}

/**
 * Forget the cached availabilities.
 *
 * Used when the source set changes under the app — a provider the app
 * gained, or a NetEase sign-in that changes what NetEase will serve.
 */
export function clearAvailability(): void {
  cache.clear();
  inFlight.clear();
}
