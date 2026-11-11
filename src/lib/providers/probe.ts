import { invoke } from "@tauri-apps/api/core";
import type { ProviderId, ProviderRef } from "@/lib/providers/types";

/**
 * Asking a provider whether it can actually play a specific track.
 *
 * A provider that *has* a track is not the same as a provider that will
 * *serve* it. NetEase in particular carries plenty of tracks it will not
 * hand over without a membership, and the same is true of the paid tiers
 * on the Chinese platforms. Those are exactly the tracks the
 * third-party unblock pool exists for.
 *
 * So "can this be played here?" is a separate question from "does this
 * catalogue have it?", and it needs its own round trip to answer.
 *
 * ## The probe cache
 *
 * The answer is cached per provider-and-track, because the same track
 * gets asked about repeatedly: once by the availability search that
 * fills the source-switcher panel, once by the player when it picks a
 * source, and again by every other reader of the same track's
 * availability. A negative answer is a real answer — "nothing can serve
 * this" — so it is cached too.
 */

/** What the backend says about a resolved NetEase track. */
type NeteaseResolved = {
  url: string;
  source: string;
  quality: string;
  size: number | null;
};

/**
 * Whether a provider can serve a track right now.
 *
 * A provider that cannot answer is not a failure of the app — it is
 * one link in the chain being skipped.
 */
export type PlayabilityProbe = (
  ref: ProviderRef,
  signal?: AbortSignal,
) => Promise<boolean>;

/**
 * Whether the backend could resolve a track on one of the Chinese
 * platforms to a playable URL.
 *
 * `cn_resolve` is the same resolution the stream server performs, so
 * a `true` here means the track will actually play — not merely that
 * the platform lists it.
 */
async function probeCn(
  platform: "migu" | "kugou" | "qq",
  ref: ProviderRef,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) return false;
  try {
    const resolved = await invoke<NeteaseResolved | null>("cn_resolve", {
      platform,
      songId: ref.providerTrackId,
    });
    if (signal?.aborted) return false;
    return !!resolved?.url;
  } catch {
    return false;
  }
}

/**
 * The default probes.
 *
 * YouTube needs no probe: its extractor can answer for essentially
 * every track the catalogue has, and probing it would double the
 * latency of every play for no information. NetEase does need one,
 * because its catalogue contains tracks the platform refuses to serve
 * without a membership — and those are exactly the tracks the
 * third-party unblock pool exists for.
 *
 * The Chinese platforms need one for the same reason: their free tiers
 * are large but their VIP tiers are not served to an anonymous client,
 * and the third-party resolver pool is what covers those.
 */
const PROBES: Partial<Record<ProviderId, PlayabilityProbe>> = {
  netease: async (ref, signal) => {
    if (signal?.aborted) return false;
    try {
      const resolved = await invoke<NeteaseResolved | null>(
        "netease_resolve",
        { songId: ref.providerTrackId },
      );
      if (signal?.aborted) return false;
      return !!resolved?.url;
    } catch {
      return false;
    }
  },
  migu: (ref, signal) => probeCn("migu", ref, signal),
  kugou: (ref, signal) => probeCn("kugou", ref, signal),
  qq: (ref, signal) => probeCn("qq", ref, signal),
};

/** The cached probe answers, keyed by `provider:trackId`. */
const probeCache = new Map<string, boolean>();

/** The probes currently in flight, so two callers don't double up. */
const probeInFlight = new Map<string, Promise<boolean>>();

/**
 * Ask a provider whether it can play a specific track.
 *
 * This is the check the source switcher runs before it moves a track to
 * another provider: the matcher found a candidate there, but a
 * candidate is not a guarantee.
 */
export async function canPlayFrom(
  ref: ProviderRef,
  signal?: AbortSignal,
): Promise<boolean> {
  const probe = PROBES[ref.provider];
  // A provider with no probe is trusted: it either has a playable
  // catalogue or the stream server will say so.
  if (!probe) return true;

  const key = `${ref.provider}:${ref.providerTrackId}`;
  const cached = probeCache.get(key);
  if (cached !== undefined) return cached;

  const pending = probeInFlight.get(key);
  if (pending) return pending;

  const promise = probe(ref, signal)
    .then((ok) => {
      probeCache.set(key, ok);
      return ok;
    })
    .catch(() => false)
    .finally(() => {
      probeInFlight.delete(key);
    });
  probeInFlight.set(key, promise);
  return promise;
}

/**
 * Forget the cached probe answers.
 */
export function clearProbeCache(): void {
  probeCache.clear();
  probeInFlight.clear();
}
