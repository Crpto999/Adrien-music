import { fetchSearch } from "@/lib/innertube/search";
import type { ProviderCandidate } from "@/lib/providers/types";

/**
 * The YouTube Music adapter.
 *
 * YouTube was the app's native source long before the provider layer
 * existed, so this adapter is a shim: the InnerTube client stays where
 * it is and the provider layer learns to speak to it.
 *
 * The search filter is `songs` rather than `all` — the "all" tab
 * mixes in albums, playlists and artists, which are not tracks and
 * would only add noise to the cross-provider match.
 */

/** Turn a YouTube shelf row into the provider-neutral candidate shape. */
export function toCandidate(item: {
  id: string;
  title: string;
  artists?: { id?: string; name: string }[];
  album?: string;
  duration?: number;
  thumbnails?: { url: string; width?: number; height?: number }[];
}): ProviderCandidate {
  return {
    provider: "youtube",
    providerTrackId: item.id,
    title: item.title,
    artists: (item.artists ?? []).map((a) => a.name),
    album: item.album,
    duration: item.duration,
    coverUrl: item.thumbnails?.[0]?.url,
  };
}

/**
 * Search YouTube Music for tracks.
 *
 * A failure returns an empty list rather than throwing: a provider
 * that is down must not take the whole cross-provider search with it.
 */
export async function searchYouTube(
  query: string,
  signal?: AbortSignal,
): Promise<ProviderCandidate[]> {
  if (signal?.aborted) return [];
  const trimmed = query.trim();
  if (!trimmed) return [];
  try {
    const results = await fetchSearch(trimmed, "songs");
    if (signal?.aborted) return [];
    const items = results.shelves.flatMap((s) => s.items);
    return items
      // The "songs" tab can still surface album/playlist rows when a
      // query matches an entity rather than a track. They are not
      // playable as a single track, so they are dropped here rather
      // than confusing the matcher.
      .filter((i) => i.kind === "song")
      .map(toCandidate);
  } catch {
    return [];
  }
}
