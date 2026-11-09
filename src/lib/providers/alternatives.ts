import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { canonicalFromQueueTrack } from "@/lib/providers/queue";
import { findAlternativeSources } from "@/lib/providers/playback";
import { getProviderOrder } from "@/lib/providers/play";
import type { QueueTrack } from "@/lib/store/playback";
import type { CanonicalTrack, ProviderRef } from "@/lib/providers/types";

/**
 * The alternative sources for a track, cached.
 *
 * ## Why this module exists
 *
 * The source switcher used to search every provider *when the menu
 * opened*. That is one round trip per provider — five of them — on
 * every single click of a button the user might click twenty times in
 * a row. The results never change between clicks: the alternatives for
 * a track are a property of the track, not of the moment.
 *
 * So the search moved here, into the query cache:
 *
 *   - The list is fetched once per track and kept.
 *   - Re-opening the menu reads the cache — instant, no request.
 *   - The cache is keyed by the track's *identity* (title, artists,
 *     duration), not by its queue position, so the same song reached
 *     through a different path reuses the same entry.
 *   - A background refetch still happens when the entry goes stale, so
 *     a provider that was temporarily down recovers on its own.
 */

/**
 * How long a fetched alternative list is considered fresh.
 *
 * A track's availability on other platforms barely changes, but the
 * upstream services do come and go, so the list is refreshed in the
 * background rather than frozen forever.
 */
const STALE_TIME = 10 * 60 * 1000;

/**
 * How long an unused entry is kept around.
 *
 * Long enough that skipping back and forth between two tracks does not
 * re-fetch, short enough that the cache does not grow without bound
 * over a long listening session.
 */
const GC_TIME = 30 * 60 * 1000;

/**
 * A stable key for a track's alternative sources.
 *
 * The provider and the provider's own id are deliberately *not* part
 * of the key: the alternatives are "everywhere else this song lives",
 * which does not depend on where it is currently playing from. The
 * title, the artists and the duration do, because they are what the
 * matcher uses to decide what counts as the same recording.
 */
export function alternativesKey(canonical: CanonicalTrack): string {
  const title = canonical.title.trim().toLowerCase();
  const artists = canonical.artists
    .map((a) => a.trim().toLowerCase())
    .sort()
    .join(",");
  const duration = canonical.duration ? Math.round(canonical.duration) : "";
  return `alternatives:${title}|${artists}|${duration}`;
}

/**
 * The canonical form of a queue track, or `null` when the track has
 * no identity to search with.
 */
export function canonicalFor(
  track: QueueTrack | undefined,
): CanonicalTrack | null {
  if (!track) return null;
  const canonical = canonicalFromQueueTrack(track);
  if (!canonical.title.trim()) return null;
  return canonical;
}

/**
 * Fetch the alternative sources for a track.
 *
 * Exported separately from the hook so the caller can warm the cache
 * ahead of time — the prefetcher in `useAlternativeSourcesPrefetch`
 * does that for the track that is *about* to play.
 */
export async function fetchAlternatives(
  canonical: CanonicalTrack,
  signal?: AbortSignal,
): Promise<ProviderRef[]> {
  return findAlternativeSources(canonical, {
    priority: getProviderOrder(),
    signal,
  });
}

/**
 * The alternative sources for a track.
 *
 * The query is enabled only when there is a track with a searchable
 * identity, so an empty player does not fire a pointless search.
 */
export function useAlternativeSources(track: QueueTrack | undefined) {
  const canonical = canonicalFor(track);

  const query = useQuery({
    queryKey: canonical
      ? [alternativesKey(canonical)]
      : ["alternatives:none"],
    queryFn: ({ signal }) =>
      canonical
        ? fetchAlternatives(canonical, signal)
        : Promise.resolve([]),
    enabled: canonical !== null,
    staleTime: STALE_TIME,
    gcTime: GC_TIME,
    retry: false,
  });

  return {
    /** The known alternatives. Empty until the first fetch lands. */
    alternatives: query.data ?? [],
    /** True while the very first fetch is in flight. */
    isLoading: query.isLoading && canonical !== null,
    /** True while a background refresh is running over an existing list. */
    isRefreshing: query.isFetching && !query.isLoading,
  };
}

/**
 * Warm the alternative-source cache for the track that is about to play.
 *
 * The switcher is usually opened *after* the track has been playing for
 * a moment, by which time the search has long finished. Starting it at
 * the moment the track changes means the menu is ready before the user
 * reaches for it — so the first click on the switcher shows a full list
 * instead of a spinner.
 *
 * Mount this once, next to the player.
 */
export function useAlternativeSourcesPrefetch(track: QueueTrack | undefined) {
  const queryClient = useQueryClient();
  const canonical = canonicalFor(track);
  const key = canonical ? alternativesKey(canonical) : null;

  useEffect(() => {
    if (!canonical || !key) return;
    void queryClient.prefetchQuery({
      queryKey: [key],
      queryFn: ({ signal }) => fetchAlternatives(canonical, signal),
      staleTime: STALE_TIME,
      gcTime: GC_TIME,
    });
    // `key` is the track's identity: re-running on the same track would
    // re-fetch the same list, and the canonical object is a fresh
    // object on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, queryClient]);
}
