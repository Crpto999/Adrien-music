import { getAvailability } from "@/lib/providers/availability";
import { canPlayFrom } from "@/lib/providers/probe";
import { getProviderOrder } from "@/lib/providers/order";
import { canonicalFromQueueTrack } from "@/lib/providers/queue";
import {
  type CanonicalTrack,
  type ProviderId,
  type ProviderRef,
} from "@/lib/providers/types";
import { usePlaybackStore, type QueueTrack } from "@/lib/store/playback";

/**
 * Choosing the source that will actually serve a track.
 *
 * ## The rule
 *
 * A track's source is decided by the user's priority order and nothing
 * else. The order in Settings → Sources is a standing instruction
 * about where audio comes from, and it is honoured for ordinary songs:
 * if NetEase is first and NetEase has the song, the song plays from
 * NetEase — even though the user found it on YouTube.
 *
 * The priority order only decides *which* source. It does not decide
 * *whether* a source can play: a provider that has the track in its
 * catalogue but will not serve it (NetEase without a membership for a
 * VIP track, say) is skipped, and the next one in the order is tried.
 *
 * ## The one exception
 *
 * The NetEase daily picks are NetEase records. They play from NetEase
 * when NetEase will serve them, and fall back to the priority order
 * only when it will not — the pick *is* the NetEase recording, so the
 * other platforms are substitutes for the ones NetEase will not serve,
 * not better versions of it.
 *
 * That exception is expressed as a *preference*, not as a special
 * case: the source that is preferred goes to the front of the order,
 * and everything else about the decision is unchanged.
 *
 * ## A track that already has a source keeps it
 *
 * A track the user pointed at another source by hand must stay where
 * the user put it, and the daily picks arrive with NetEase's own id.
 * So a track that already carries a source is never re-decided.
 */

/**
 * The order sources are tried in, with the preferred ones moved to the
 * front.
 *
 * The rest of the chain keeps its order — a preference moves one
 * source ahead of the others, it does not reshuffle them.
 */
export function effectiveOrder(
  priority: ProviderId[],
  prefer?: ProviderId[],
): ProviderId[] {
  if (!prefer || prefer.length === 0) return priority;
  const front = prefer.filter((p) => priority.includes(p));
  const rest = priority.filter((p) => !front.includes(p));
  return [...front, ...rest];
}

/**
 * The source that should serve a track, chosen by the priority order.
 *
 * Returns `null` when no source can play it — the caller reports that
 * rather than substituting something arbitrary.
 *
 * ## Why the search does not always delay playback
 *
 * The order can only be honoured if the sources *ahead* of the track's
 * own source have been asked. When the track's own source is already
 * at the top of the order, nothing has to be waited for: the track
 * plays from it immediately, and the search for the remaining sources
 * runs in the background, feeding the source panel.
 *
 * So the cost of the setting is paid exactly where the setting asks
 * for it, and nowhere else.
 */
export async function chooseSource(
  canonical: CanonicalTrack,
  options?: { prefer?: ProviderId[] },
): Promise<ProviderRef | null> {
  const priority = getProviderOrder();
  const order = effectiveOrder(priority, options?.prefer);
  const origin = canonical.origin;
  const originId = canonical.originId;

  const originRef: ProviderRef | null =
    origin && originId
      ? { provider: origin, providerTrackId: originId }
      : null;

  // Where the track's own source sits in the order. -1 means it is not
  // in the chain at all.
  const originIndex = origin ? order.indexOf(origin) : -1;

  // The sources ahead of the track's own source are unknown until they
  // have been searched, so the answer has to wait for them.
  if (originIndex === 0 && originRef) {
    // The track's own source is first in the order: it wins without a
    // search. The search still runs — in the background — so the source
    // panel has the data and the next play of the track is instant.
    void getAvailability(canonical, { priority }).catch(() => {});
    if (await canPlayFrom(originRef)) return originRef;
    // It would not serve the track — fall through and let the chain
    // find it elsewhere.
  }

  // Every source that has the track, in the order they should be
  // tried. The search is concurrent, so the ranking below is decided
  // by the order and not by which source answered first.
  const availability = await getAvailability(canonical, { priority: order });
  for (const ref of availability) {
    if (await canPlayFrom(ref)) return ref;
  }

  // Nothing would serve it — the track's own source is the last word,
  // so the stream server's own fallback path can still try.
  return originRef;
}

/**
 * Resolve the source for a queue slot and make the queue agree.
 *
 * The queue slot is rewritten to carry the source that will serve it,
 * so the player bar names the right platform, the source panel lists
 * the track under the right entry, and the storage tab describes the
 * right file. A track that already has the right source is left alone.
 *
 * The origin is remembered when it differs from the winner, so the
 * player can still say "found on YouTube, playing from NetEase".
 */
export async function resolveSlotSource(
  index: number,
  track: QueueTrack,
  options?: { prefer?: ProviderId[] },
): Promise<ProviderRef | null> {
  // A track that already has a source keeps it — the daily picks
  // arrive with NetEase's own id, and a track the user pointed at
  // another source by hand must stay where the user put it.
  if (track.provider && track.providerTrackId) {
    return {
      provider: track.provider,
      providerTrackId: track.providerTrackId,
    };
  }
  const canonical = canonicalFromQueueTrack(track);
  const ref = await chooseSource(canonical, options);
  if (!ref) return null;

  const store = usePlaybackStore.getState();
  const current = store.queue[index];
  if (!current) return ref;
  // The queue may have changed while the resolution was in flight —
  // the slot may now hold a different track. Only rewrite a slot that
  // still holds the track the answer was computed for.
  if (
    current.videoId !== track.videoId &&
    current.providerTrackId !== track.providerTrackId
  ) {
    return ref;
  }
  if (
    current.provider === ref.provider &&
    current.providerTrackId === ref.providerTrackId
  ) {
    return ref;
  }

  store.setTrackProvider(index, ref, {
    // Where the track was found, when it is not where it will play
    // from. The origin's own id is the authoritative one — it is what
    // the platform's own lyrics are filed under.
    discoveredOn: canonical.origin,
    discoveredTrackId: canonical.originId,
  });
  return ref;
}

/**
 * Re-resolve the queue's tracks when the priority order changes.
 *
 * The order is a standing instruction about where audio comes from,
 * so a change to it has to reach the tracks that are already queued —
 * otherwise the setting would only affect the *next* track, and the
 * user's expectation ("play from NetEase from now on") would be
 * half-met.
 *
 * Two kinds of track are left alone:
 *
 *   - A track whose source the user chose by hand. That choice outranks
 *     the order.
 *   - The track that is *audible* right now. Moving it would re-resolve
 *     its stream mid-song.
 */
export async function reResolveQueueForOrder(): Promise<void> {
  const state = usePlaybackStore.getState();
  const { queue, index, status } = state;

  for (let i = 0; i < queue.length; i++) {
    const track = queue[i];
    if (!track) continue;
    // A locked source is the user's own choice.
    if (track.sourceLocked) continue;
    // The playing track keeps its stream while it is making noise.
    if (i === index && status === "ready") continue;

    // The track's origin is what the matcher searches from, and the
    // source it currently plays from is what the matcher would wrongly
    // treat as authoritative — so the *origin* is what the resolution
    // works from, not the current source.
    const canonical = canonicalFromQueueTrack({
      ...track,
      provider: track.discoveredOn ?? track.provider,
      providerTrackId:
        track.discoveredTrackId ?? track.providerTrackId ?? track.videoId,
    });

    const ref = await chooseSource(canonical);
    if (!ref) continue;
    if (
      track.provider === ref.provider &&
      track.providerTrackId === ref.providerTrackId
    ) {
      continue;
    }

    // Re-read the queue: it may have changed while the resolution was
    // in flight.
    const current = usePlaybackStore.getState();
    const slot = current.queue[i];
    if (!slot || slot.videoId !== track.videoId) continue;
    if (current.index === i && current.status === "ready") continue;
    current.setTrackProvider(i, ref);
  }
}
