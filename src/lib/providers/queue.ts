import type { ShelfItem, Thumbnail } from "@/lib/innertube/types";
import type { QueueTrack } from "@/lib/store/playback";
import {
  PROVIDER_LABELS,
  type CanonicalTrack,
  type ProviderCandidate,
  type ProviderId,
} from "@/lib/providers/types";

/**
 * Turning a provider's result into something the queue can hold.
 *
 * The queue's shape is YouTube's — `videoId`, `thumbnails`, `artists`
 * with ids — because everything downstream (liked songs, the storage
 * tab, the radio chain, the media session) was written against it.
 * Rather than migrate all of that, a provider track carries its own
 * id alongside, and the queue keeps both.
 *
 * The consequence is deliberate: a NetEase track's `videoId` is a
 * synthetic id that no YouTube endpoint will ever answer to, and its
 * `provider`/`providerTrackId` pair is what the stream server uses.
 * That keeps "this is a YouTube id" true everywhere it is assumed,
 * without pretending NetEase ids are YouTube ids.
 */

/**
 * The synthetic id a non-YouTube track carries in the queue.
 *
 * It is namespaced so it can never collide with a YouTube video id
 * (which is 11 characters of base64-ish alphabet), and so the storage
 * tab can tell at a glance which provider a cached file came from.
 */
export function syntheticQueueId(
  provider: ProviderId,
  providerTrackId: string,
): string {
  return `${provider}_${providerTrackId}`;
}

/**
 * The id a shelf row carries in the queue's `videoId` shape.
 *
 * A row from another provider (the NetEase daily picks) has no
 * YouTube id at all, so the queue gives it the synthetic
 * `provider_id` form — the same one `toQueueTrack` uses. The row and
 * the queue entry therefore agree on the id, which is what lets the
 * "jump to the playing row" machinery find it.
 */
export function shelfItemQueueId(item: ShelfItem): string {
  if (item.provider && item.provider !== "youtube") {
    return syntheticQueueId(item.provider, item.providerTrackId ?? item.id);
  }
  return item.id;
}

/** A thumbnail built from a cover URL, in the queue's shape. */
function coverThumbnail(url: string | undefined): Thumbnail[] {
  if (!url) return [];
  return [{ url, width: 544, height: 544 }];
}

/**
 * A queue track for a provider candidate.
 *
 * `videoId` is the synthetic id for non-YouTube providers, and the
 * provider's own id for YouTube.
 */
export function toQueueTrack(candidate: ProviderCandidate): QueueTrack {
  const isYouTube = candidate.provider === "youtube";
  const videoId = isYouTube
    ? candidate.providerTrackId
    : syntheticQueueId(candidate.provider, candidate.providerTrackId);

  const artists = candidate.artists.map((name) => ({
    id: undefined,
    name,
  }));

  return {
    videoId,
    title: candidate.title,
    subtitle: candidate.artists.join(", ") || undefined,
    artists,
    album: candidate.album,
    thumbnails: coverThumbnail(candidate.coverUrl),
    duration: candidate.duration,
    provider: candidate.provider,
    providerTrackId: candidate.providerTrackId,
  };
}

/**
 * The canonical form of a queue track, for cross-provider matching.
 *
 * This is the input the matcher needs: the title and the artist, which
 * are the only fields two platforms are guaranteed to agree on.
 */
export function canonicalFromQueueTrack(track: QueueTrack): CanonicalTrack {
  const provider = track.provider ?? "youtube";
  return {
    title: track.title,
    artists: (track.artists ?? []).map((a) => a.name),
    album: track.album,
    duration: track.duration,
    origin: provider,
    originId: track.providerTrackId ?? track.videoId,
  };
}

/**
 * The canonical form of a provider candidate, for cross-provider
 * matching.
 */
export function canonicalFromCandidate(
  candidate: ProviderCandidate,
): CanonicalTrack {
  return {
    title: candidate.title,
    artists: candidate.artists,
    album: candidate.album,
    duration: candidate.duration,
    origin: candidate.provider,
    originId: candidate.providerTrackId,
  };
}

/** A short label for the provider serving a track. */
export function providerLabel(provider: ProviderId | undefined): string {
  return PROVIDER_LABELS[provider ?? "youtube"];
}
