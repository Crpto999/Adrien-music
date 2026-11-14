import type { ShelfItem, Thumbnail } from "@/lib/innertube/types";
import type { QueueTrack } from "@/lib/store/playback";
import {
  neteaseSongForVideo,
  neteaseVideoForSong,
} from "@/lib/store/netease-ids";
import { cleanTrackTitle } from "@/lib/track-meta";
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
 * Whether an id in the queue's `videoId` field is a real YouTube video id.
 *
 * A track from another provider carries a synthetic `netease_186016`
 * string there — namespaced so it can never collide with a YouTube id
 * (which is 11 characters), and so nothing that expects a YouTube id
 * will be handed one by accident.
 *
 * An explicit provider wins: a track that was discovered on NetEase but
 * plays from YouTube keeps its YouTube id, and its id is a YouTube id.
 * Without provider metadata, the id's own shape decides.
 */
export function isYouTubeVideoId(
  videoId: string,
  provider?: ProviderId,
): boolean {
  if (provider) return provider === "youtube";
  return !/^[a-z]+_/.test(videoId);
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
 *
 * ## The known ids
 *
 * A track can carry the ids it is *known* by on the platforms other
 * than the one it plays from — the NetEase daily pick the user hearted
 * is one recording under two ids, and the app remembers both. Those
 * ids are authoritative and travel into the canonical form, so the
 * matcher is not asked to rediscover what the app already knows.
 *
 * The lookup goes through the registry rather than the queue alone,
 * because the correspondence outlives the queue entry: the pick was
 * hearted days ago and the queue was rebuilt since.
 *
 * ## Why the title is cleaned
 *
 * The title is YouTube Music's *display* string, and a display string
 * carries credits that the other platforms write differently. The
 * clearest measured case: the single release of "Best Part" is titled
 * on YouTube Music
 *
 *     Best Part (feat. Daniel Caesar, Lauren Jauregui)
 *
 * and on NetEase the same recording is filed under the *album* credit
 *
 *     Best Part (feat. H.E.R.)
 *
 The matcher used to require 75% of the original's title words to be
 * present in the candidate's ("daniel", "caesar", "lauren", "jauregui"
 * are missing — coverage 0.33), so the row NetEase actually has was
 * rejected, and the song got no NetEase option at all.
 *
 * ## Why the credit is **kept**
 *
 * The upload furniture is dropped, but the **featuring credit is
 * kept**. The credit is evidence: it is what separates the two
 * releases of "We Don't Talk Anymore" — the one whose title carries
 * "(feat. Selena Gomez)" and the plain one — and the credit tier is a
 * whole level of the matcher's cascade.
 *
 * Dropping it at the source made that tier **inert**: the source
 * never named a performer, so every candidate looked equally
 * (un)credited, and the plain release won by default. Measured
 * against NetEase: with the credit dropped the app picked `401249910`
 * ("We Don't Talk Anymore"); with it kept the app picks `2166151146`
 * ("We Don't Talk Anymore (feat. Selena Gomez)") — the record the
 * user confirmed by hand.
 *
 * The *query* still drops it, because a query carrying the whole
 * credit finds fewer rows — `searchTitle()` translates the credit
 * into the platforms' own spelling instead of keeping it verbatim.
 */
export function canonicalFromQueueTrack(track: QueueTrack): CanonicalTrack {
  const provider = track.provider ?? "youtube";
  return {
    title: cleanTrackTitle(track.title, { keepCredit: true }),
    artists: (track.artists ?? []).map((a) => a.name),
    album: track.album,
    duration: track.duration,
    // The artwork the queue entry already carries, so a track that is
    // re-resolved to another provider keeps its picture.
    coverUrl: track.thumbnails?.[0]?.url,
    origin: provider,
    originId: track.providerTrackId ?? track.videoId,
    knownIds: knownIdsFor(track),
  };
}

/**
 * The ids a track is known by on the platforms it is not playing from.
 *
 * Two sources of truth, in order of authority:
 *
 *   1. The queue entry's own `discoveredOn` / `discoveredTrackId` — the
 *      origin the track was found on, recorded when it was moved to
 *      another provider.
 *   2. The registry — the persistent correspondence between a YouTube
 *      video and the NetEase recording it holds.
 *
 * The registry is the one that survives: a pick the user hearted on
 * YouTube has no `discoveredOn` left (the queue entry is a plain
 * YouTube row by then), but the registry still knows the video holds
 * NetEase record 186016.
 */
function knownIdsFor(track: QueueTrack): Partial<Record<ProviderId, string>> {
  const out: Partial<Record<ProviderId, string>> = {};

  // The origin the track was found on, when it is not where it plays.
  if (
    track.discoveredOn &&
    track.discoveredOn !== (track.provider ?? "youtube") &&
    track.discoveredTrackId
  ) {
    out[track.discoveredOn] = track.discoveredTrackId;
  }

  // The registry's correspondence, when the track is on YouTube.
  const provider = track.provider ?? "youtube";
  if (provider === "youtube") {
    const songId = neteaseSongForVideo(track.videoId);
    if (songId) out.netease = songId;
  } else if (provider === "netease" && track.providerTrackId) {
    // A NetEase track's own id is authoritative for NetEase; a YouTube
    // counterpart the app has seen is authoritative for YouTube.
    out.netease = track.providerTrackId;
    const videoId = neteaseVideoForSong(track.providerTrackId);
    if (videoId) out.youtube = videoId;
  }

  return out;
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
    coverUrl: candidate.coverUrl,
    origin: candidate.provider,
    originId: candidate.providerTrackId,
  };
}

/** A short label for the provider serving a track. */
export function providerLabel(provider: ProviderId | undefined): string {
  return PROVIDER_LABELS[provider ?? "youtube"];
}
