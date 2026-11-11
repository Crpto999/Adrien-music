import { toast } from "sonner";
import { usePlaybackStore, type QueueTrack } from "@/lib/store/playback";
import { canonicalFromCandidate, toQueueTrack } from "@/lib/providers/queue";
import { resolvePlaybackSource, type PlaybackSource } from "@/lib/providers/playback";
import {
  type CanonicalTrack,
  type ProviderCandidate,
} from "@/lib/providers/types";
import { getProviderOrder } from "@/lib/providers/order";
import { translate } from "@/lib/i18n";

/**
 * Playing a track that came from a provider other than YouTube.
 *
 * The two halves of the job:
 *
 *   1. **Choose the source.** A NetEase track may be playable from
 *      NetEase, from YouTube (as the same recording), or from neither.
 *      The provider priority chain decides, and the winner is the
 *      first provider that can actually produce audio — not the first
 *      one that merely has a catalogue entry.
 *
 *   2. **Put it in the queue.** The queue's shape is YouTube's, so the
 *      winning provider's id rides along in `provider` /
 *      `providerTrackId` while `videoId` stays a stable identity for
 *      everything else in the app.
 *
 * The priority chain itself lives in `./order` — it is read by the
 * availability search and by the audio engine too, and none of those
 * should have to come through this module to get at it.
 */
export { getProviderOrder } from "@/lib/providers/order";

/**
 * Play a provider candidate.
 *
 * Returns the source that was chosen, or `null` when nothing can play
 * it (in which case an error toast has already been shown).
 */
export async function playProviderCandidate(
  candidate: ProviderCandidate,
): Promise<PlaybackSource | null> {
  return playCanonical(canonicalFromCandidate(candidate));
}

/**
 * Play a track described only by its canonical form.
 *
 * The origin provider's own id is authoritative, so a NetEase track
 * plays from NetEase without a search round trip when the priority
 * chain prefers it.
 */
export async function playCanonical(
  canonical: CanonicalTrack,
): Promise<PlaybackSource | null> {
  const source = await resolvePlaybackSource(canonical, {
    priority: getProviderOrder(),
  });

  if (!source) {
    toast.error(
      translate("settings.providers.noPlayableSource", {
        title: canonical.title,
      }),
    );
    return null;
  }

  // The winner becomes the queue entry. The title and artists come
  // from the canonical track (which is what the user saw), while the
  // ids come from the source that will serve it.
  const track: QueueTrack = {
    ...toQueueTrack({
      provider: source.provider,
      providerTrackId: source.providerTrackId,
      title: canonical.title,
      artists: canonical.artists,
      album: canonical.album,
      duration: canonical.duration,
    }),
    // Remember where it was discovered, so the player can say "found
    // on NetEase, playing from YouTube".
    discoveredOn: canonical.origin,
  };

  usePlaybackStore.getState().playNow(track);
  return source;
}
