import { usePlaybackStore } from "@/lib/store/playback";
import { canPlayFrom } from "@/lib/providers/probe";
import type { ProviderRef } from "@/lib/providers/types";

/**
 * Move the current queue entry to another provider.
 *
 * The queue slot keeps its identity — the title, the artist and the
 * position in the queue are the user's, not the provider's — but the
 * provider and that provider's own id change, which is what the audio
 * engine watches to re-resolve the stream.
 *
 * The switch is verified before it is applied: the alternative is
 * asked whether it can actually serve the track, because a provider
 * that merely has a catalogue entry may still refuse to serve it.
 *
 * Returns `false` when the track cannot be moved — either there is
 * no track, or the target provider will not serve it. The caller
 * reports that to the user rather than silently doing nothing.
 */
export async function switchTrackProvider(ref: ProviderRef): Promise<boolean> {
  const store = usePlaybackStore.getState();
  const index = store.index;
  const track = store.queue[index];
  if (!track) return false;

  const playable = await canPlayFrom(ref);
  if (!playable) return false;

  // `locked`: the user chose this source by hand, so the priority
  // order will not undo the switch the next time the track is
  // re-resolved.
  usePlaybackStore.getState().setTrackProvider(index, ref, undefined, true);
  return true;
}
