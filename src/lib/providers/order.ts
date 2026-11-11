import {
  PROVIDER_PRIORITY,
  playableProviders,
  type ProviderId,
} from "@/lib/providers/types";

/**
 * The provider priority chain.
 *
 * The order is the user's standing preference about *where audio comes
 * from*, and it decides two separate things:
 *
 *   1. Which source serves a track when more than one of them has it.
 *   2. The order the sources are listed in, both here and in the
 *      source-switcher panel.
 *
 * It is persisted: losing it on every restart would make the setting a
 * chore rather than a preference.
 *
 * ## Why this lives in its own module
 *
 * The chain is read by the playback resolver, by the availability
 * search, by the daily-picks resolver and by the audio engine — and the
 * audio engine sits below all of them. Keeping the order here means
 * none of those readers has to import another reader, and the cycle
 * that a single "playback" module would create (engine → resolver →
 * engine) simply does not exist.
 */

/** Where the persisted order lives. */
const ORDER_STORAGE_KEY = "adrify-provider-order";

let providerOrder: ProviderId[] = loadProviderOrder();
const providerOrderListeners = new Set<() => void>();

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

/**
 * The current provider priority.
 *
 * Falls back to the built-in default when nothing has been stored — a
 * first run, or a private-mode session where the write did not stick.
 */
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
