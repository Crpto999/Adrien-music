import { invoke } from "@tauri-apps/api/core";
import type { ProviderCandidate } from "@/lib/providers/types";

/**
 * The NetEase Cloud Music adapter.
 *
 * Everything NetEase needs — the eapi encryption, the search request,
 * the daily recommendation — happens in Rust (`src-tauri/src/netease.rs`).
 * The adapter is a thin translation layer between the backend's row
 * shape and the provider-neutral `ProviderCandidate` the matcher
 * consumes.
 */

/** One NetEase song, as the backend reports it. */
export type NeteaseSong = {
  id: string;
  title: string;
  artists: string[];
  album: string | null;
  durationMs: number;
  duration: number;
  coverUrl: string | null;
  /** The platform's own fee tier: 0 free, 1 VIP, 4 album purchase. */
  fee: number;
  playable: boolean;
};

/**
 * Search NetEase.
 *
 * A failure returns an empty list rather than throwing: a provider
 * that is down must not break the page that asked it, and the
 * resolver treats "no candidates" and "provider failed" the same way.
 */
export async function neteaseSearch(
  query: string,
  limit = 20,
): Promise<NeteaseSong[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  try {
    const rows = await invoke<NeteaseSong[]>("netease_search", {
      query: trimmed,
      limit,
    });
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

/**
 * The account's daily recommendation.
 *
 * `null` means the user is not signed in to NetEase — the platform
 * answers anonymously with an empty list, so the caller can show a
 * "sign in" prompt rather than an error.
 *
 * A *failure* is a different thing and is not swallowed here: the
 * backend reports a rejected credential as an error, and turning that
 * into "not signed in" would show the user a sign-in prompt for an
 * account that is signed in and working.
 */
export async function neteaseDailyRecommend(): Promise<NeteaseSong[] | null> {
  const rows = await invoke<NeteaseSong[] | null>("netease_daily_recommend");
  return Array.isArray(rows) ? rows : null;
}

/** The lyrics for a NetEase song id, as raw LRC text. */
export async function neteaseLyric(songId: string): Promise<string | null> {
  const id = songId.trim();
  if (!id) return null;
  try {
    return await invoke<string | null>("netease_lyric", { songId: id });
  } catch {
    return null;
  }
}

/**
 * What the official player endpoint says about a track.
 *
 * `st === 0` means playable. A paid track the user has no rights to
 * comes back with `st < 0` and a `cannotListenReason`.
 */
export type NeteasePrivileges = {
  st: number;
  fee: number;
  payed: number;
  freeTrialEnd: number | null;
  cannotListenReason: string | null;
  level: string | null;
  br: number | null;
  size: number | null;
  url: string | null;
};

export async function neteasePrivileges(
  songId: string,
): Promise<NeteasePrivileges | null> {
  const id = songId.trim();
  if (!id) return null;
  try {
    return await invoke<NeteasePrivileges>("netease_privileges", {
      songId: id,
    });
  } catch {
    return null;
  }
}

/** Turn a NetEase row into the provider-neutral candidate shape. */
export function toCandidate(song: NeteaseSong): ProviderCandidate {
  return {
    provider: "netease",
    providerTrackId: song.id,
    title: song.title,
    artists: song.artists,
    album: song.album ?? undefined,
    duration: song.duration,
    coverUrl: song.coverUrl ?? undefined,
  };
}

/**
 * The adapter the resolver registers.
 *
 * It takes a free-text query rather than a structured hint, because
 * that is what the platforms' search endpoints actually accept. The
 * *matching* of the results against the track being looked for is the
 * resolver's job (`rankCandidates`), not the adapter's — an adapter
 * that filtered by itself would have to reimplement the matcher.
 */
export async function searchNetEase(
  query: string,
  signal?: AbortSignal,
): Promise<ProviderCandidate[]> {
  if (signal?.aborted) return [];
  const songs = await neteaseSearch(query);
  if (signal?.aborted) return [];
  return songs.map(toCandidate);
}
