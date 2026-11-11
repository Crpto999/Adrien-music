import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { canonicalFromQueueTrack } from "@/lib/providers/queue";
import {
  AVAILABILITY_GC_TIME,
  AVAILABILITY_STALE_TIME,
  availabilityKey,
  getAvailability,
  peekAvailability,
} from "@/lib/providers/availability";
import { canPlayFrom } from "@/lib/providers/probe";
import { getProviderOrder } from "@/lib/providers/order";
import { useNetEaseIdStore } from "@/lib/store/netease-ids";
import type { QueueTrack } from "@/lib/store/playback";
import type {
  CanonicalTrack,
  ProviderRef,
} from "@/lib/providers/types";

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
 *
 * ## One search, two readers
 *
 * The fetch itself goes through `./availability`, which is the *same*
 * search the player used to choose the track's source. So the panel
 * can never offer a source the player never considered, and opening
 * the panel never costs a second round of five requests — the answer
 * is already cached from the moment the track started playing.
 */

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
  return getAvailability(canonical, {
    signal,
    priority: getProviderOrder(),
  });
}

/**
 * The alternative sources for a track.
 *
 * The query is enabled only when there is a track with a searchable
 * identity, so an empty player does not fire a pointless search.
 */
export function useAlternativeSources(track: QueueTrack | undefined) {
  // The canonical form depends on the registry — a NetEase pick the
  // user hearted is a YouTube row that is also a known NetEase
  // recording, and the switcher must offer that *exact* record. The
  // registry is read through a subscription so a mapping written
  // moments ago (the heart flow) still reaches the panel.
  const registryVersion = useNetEaseIdStore((s) =>
    track?.videoId ? s.byVideoId[track.videoId] : undefined,
  );
  // The canonical form is recomputed when the registry changes, because
  // the known ids are part of it.
  const canonical = useMemo(
    () => canonicalFor(track),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [track, registryVersion],
  );
  const [cached, setCached] = useState<ProviderRef[] | null>(null);

  // The key is the track's identity. The canonical object itself is a
  // fresh object on every render, so keying the effect on it would
  // re-run the effect on every render — and each run sets new state,
  // which renders again.
  const key = canonical ? availabilityKey(canonical) : null;

  // Show whatever the availability search already knows, before the
  // query has even started. The search that chose the track's source
  // is the same search, so its answer is usually already there.
  useEffect(() => {
    setCached(canonical ? peekAvailability(canonical) : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const query = useQuery({
    queryKey: canonical
      ? [availabilityKey(canonical)]
      : ["availability:none"],
    queryFn: ({ signal }) =>
      canonical
        ? fetchAlternatives(canonical, signal)
        : Promise.resolve([]),
    enabled: canonical !== null,
    staleTime: AVAILABILITY_STALE_TIME,
    gcTime: AVAILABILITY_GC_TIME,
    retry: false,
  });

  return {
    /** The known alternatives. Empty until the first fetch lands. */
    alternatives: query.data ?? cached ?? [],
    /** True while the very first fetch is in flight. */
    isLoading: query.isLoading && canonical !== null && !cached,
    /** True while a background refresh is running over an existing list. */
    isRefreshing: query.isFetching && !query.isLoading,
  };
}

/**
 * Whether each of a track's sources can actually play it.
 *
 * A source that *has* a track is not the same as a source that will
 * *serve* it — NetEase without a membership will not hand over its VIP
 * tracks, and the same goes for the paid tiers on the Chinese
 * platforms. The panel shows the difference, so the user can see what
 * the switch would actually give them.
 *
 * The answers are cached (see `./probe`), so opening the panel does not
 * fire a round of resolution requests.
 */
export function usePlayability(
  refs: ProviderRef[],
): Map<string, boolean> {
  const [status, setStatus] = useState<Map<string, boolean>>(new Map());

  // The identity of the set of sources being asked about. The array is
  // a fresh object on every render, so the sources are keyed by their
  // own identity instead.
  const identity = refs
    .map((r) => `${r.provider}:${r.providerTrackId}`)
    .join("|");

  useEffect(() => {
    let cancelled = false;

    // The answers for the *previous* set of sources are dropped: they
    // say nothing about this track.
    setStatus(new Map());

    for (const ref of refs) {
      const key = `${ref.provider}:${ref.providerTrackId}`;
      void canPlayFrom(ref)
        .then((ok) => {
          if (cancelled) return;
          setStatus((prev) => new Map(prev).set(key, ok));
        })
        .catch(() => {
          if (cancelled) return;
          setStatus((prev) => new Map(prev).set(key, false));
        });
    }

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity]);

  return status;
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
  const key = canonical ? availabilityKey(canonical) : null;

  useEffect(() => {
    if (!canonical || !key) return;
    void queryClient.prefetchQuery({
      queryKey: [key],
      queryFn: ({ signal }) => fetchAlternatives(canonical, signal),
      staleTime: AVAILABILITY_STALE_TIME,
      gcTime: AVAILABILITY_GC_TIME,
    });
    // `key` is the track's identity: re-running on the same track would
    // re-fetch the same list, and the canonical object is a fresh
    // object on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, queryClient]);
}
