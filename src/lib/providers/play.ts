import { toast } from "sonner";
import { usePlaybackStore, type QueueTrack } from "@/lib/store/playback";
import { canonicalFromCandidate, toQueueTrack } from "@/lib/providers/queue";
import { resolvePlaybackSource, type PlaybackSource } from "@/lib/providers/playback";
import {
  playableProviders,
  PROVIDER_PRIORITY,
  type CanonicalTrack,
  type ProviderCandidate,
  type ProviderId,
} from "@/lib/providers/types";
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
 */

/**
 * The provider priority chain.
 *
 * YouTube is first by default because it has no membership gate — a
 * track it has is playable by anyone. A signed-in NetEase account
 * with a membership can move NetEase to the front, because there the
 * stream is lossless rather than 128 kbps.
 *
 * The order is persisted: it is the user's standing preference about
 * where audio comes from, and losing it on every restart would make
 * the setting a chore.
 */
let providerOrder: ProviderId[] = loadProviderOrder();
const providerOrderListeners = new Set<() => void>();

/** Where the persisted order lives. */
const ORDER_STORAGE_KEY = "adrify-provider-order";

/**
 * Read the persisted order.
 *
 * A stored order that names a provider the app no longer has is
 * dropped rather than honoured, and the rest is kept in the stored
 * order — a provider the user put first stays first.
 */
function loadProviderOrder(): ProviderId[] {
  try {
    const raw = localStorage.getItem(ORDER_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const playable = playableProviders();
    const kept = parsed.filter(
      (p): p is ProviderId =>
        typeof p === "string" && playable.includes(p as ProviderId),
    );
    // Any provider the app gained since the order was written is
    // appended at the end rather than dropped: it is playable, and
    // putting it last means it only ever serves a track nothing else
    // can.
    const missing = playable.filter((p) => !kept.includes(p));
    return [...kept, ...missing];
  } catch {
    return [];
  }
}

/** Persist the order. */
function persistProviderOrder(order: ProviderId[]): void {
  try {
    localStorage.setItem(ORDER_STORAGE_KEY, JSON.stringify(order));
  } catch {
    /* private mode etc — the in-memory order still works */
  }
}

/** Set the provider priority. */
export function setProviderOrder(order: ProviderId[]): void {
  providerOrder = order.filter((p) => playableProviders().includes(p));
  persistProviderOrder(providerOrder);
  providerOrderListeners.forEach((l) => l());
}

/** The current provider priority. */
export function getProviderOrder(): ProviderId[] {
  return providerOrder.length > 0 ? providerOrder : PROVIDER_PRIORITY;
}

/** Subscribe to provider-priority changes. */
export function subscribeProviderOrder(fn: () => void): () => void {
  providerOrderListeners.add(fn);
  return () => {
    providerOrderListeners.delete(fn);
  };
}

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
