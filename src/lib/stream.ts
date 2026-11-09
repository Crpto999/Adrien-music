import { invoke } from "@tauri-apps/api/core";
import type { ProviderId } from "@/lib/providers/types";

/**
 * The Rust side runs a tiny axum server on a random localhost port that
 * streams yt-dlp output progressively. We query the port once and build
 * stream URLs from it.
 *
 * Every played track is cached to disk regardless of account tier — we're
 * downloading the bytes anyway, so keeping them makes replays instant.
 * The persistent cache is bounded by a user-configurable size limit
 * (Settings → Cache), enforced on the Rust side with oldest-first
 * eviction.
 */

let baseUrlPromise: Promise<string> | null = null;

async function fetchBaseUrl(): Promise<string> {
  // Up to ~2s of retries — the server starts asynchronously from Tauri
  // setup() and may not be listening yet when the first track plays.
  for (let i = 0; i < 20; i++) {
    try {
      return await invoke<string>("get_stream_base_url");
    } catch (e) {
      if (i === 19) throw e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error("unreachable");
}

export function getStreamBaseUrl(): Promise<string> {
  if (!baseUrlPromise) {
    baseUrlPromise = fetchBaseUrl().catch((e) => {
      baseUrlPromise = null; // retry next call
      throw e;
    });
  }
  return baseUrlPromise;
}

export async function streamUrlFor(videoId: string): Promise<string> {
  const base = await getStreamBaseUrl();
  return `${base}/stream/${encodeURIComponent(videoId)}`;
}

/**
 * The stream URL for a track on a given provider.
 *
 * YouTube keeps its original route (`/stream/:videoId`) because the
 * yt-dlp path is the app's oldest and most exercised code; the other
 * providers get their own prefix. NetEase resolves its own song id
 * to a CDN URL and serves the bytes through the same progressive
 * machinery, so the `<audio>` element sees the same kind of response
 * whichever provider is behind it.
 */
export async function streamUrlForProvider(
  provider: ProviderId,
  trackId: string,
): Promise<string> {
  const base = await getStreamBaseUrl();
  const id = encodeURIComponent(trackId);
  if (provider === "youtube") return `${base}/stream/${id}`;
  if (provider === "netease") return `${base}/stream/netease/${id}`;
  // The Chinese platforms share one route: Migu, Kugou and QQ Music all
  // resolve to a direct CDN URL that the same progressive machinery
  // serves, so they only differ by the platform segment.
  if (provider === "migu" || provider === "kugou" || provider === "qq") {
    return `${base}/stream/cn/${provider}/${id}`;
  }
  // A provider without its own route yet: fall back to the generic
  // one rather than producing a URL that 404s.
  return `${base}/stream/${id}`;
}

const prefetched = new Set<string>();

/**
 * Warm the disk cache for a videoId in the background. No-ops if we
 * already fired a prefetch for this id in this session. Runs for every
 * user now that caching is universal, so the next track is ready before
 * the user reaches it.
 *
 * The server itself is idempotent on a per-file basis (checks .part /
 * .webm existence), so re-firing is cheap but still skippable.
 */
export async function prefetchStream(videoId: string): Promise<void> {
  await prefetchStreamFor("youtube", videoId);
}

/**
 * Warm the disk cache for a track on a given provider.
 *
 * The memo key is the provider-qualified id: a NetEase song id and a
 * YouTube video id live in different namespaces and would otherwise
 * share a slot.
 */
export async function prefetchStreamFor(
  provider: ProviderId,
  trackId: string,
): Promise<void> {
  const key = `${provider}:${trackId}`;
  if (prefetched.has(key)) return;
  prefetched.add(key);
  try {
    const base = await getStreamBaseUrl();
    // Fire-and-forget — server returns 200/202 immediately and caches
    // bytes in the background. fetch() only rejects on network errors, so an
    // HTTP 4xx/5xx (yt-dlp spawn/extractor failure) resolves normally — drop
    // the warm mark on an error status so the id is retried later.
    const path =
      provider === "netease"
        ? `/prefetch/netease/${encodeURIComponent(trackId)}`
        : provider === "migu" || provider === "kugou" || provider === "qq"
          ? `/prefetch/cn/${provider}/${encodeURIComponent(trackId)}`
          : `/prefetch/${encodeURIComponent(trackId)}`;
    const res = await fetch(`${base}${path}`);
    if (!res.ok) prefetched.delete(key);
  } catch {
    // If it fails we'll just fall through to on-demand fetch later.
    prefetched.delete(key);
  }
}

/**
 * Drop the in-memory "already prefetched" log. Call after the user
 * clears the disk cache via Settings — otherwise we'd never re-prefetch
 * tracks that are gone from disk but still remembered as "warm" here.
 */
export function clearPrefetchMemo(): void {
  prefetched.clear();
}

/**
 * Ported from upstream 148246f for the playback-settings merge, adapted:
 * upstream writes title/artist beside the cache file via Rust
 * `set_cache_meta` (gated on Premium); this fork keeps titles in the
 * IndexedDB track-meta store (which already powers the Storage tab's
 * real-title list) and streams without a Premium gate, so this just
 * forwards to `rememberTrack` — idempotent, safe every play.
 */
export async function saveTrackMeta(
  videoId: string,
  track:
    | {
        title?: string;
        subtitle?: string;
        artists?: { id?: string; name: string }[];
      }
    | undefined,
): Promise<void> {
  if (!track?.title) return;
  const { rememberTrack } = await import("@/lib/store/track-meta");
  rememberTrack({
    videoId,
    title: track.title,
    subtitle: track.subtitle,
    artists: track.artists,
  });
}
