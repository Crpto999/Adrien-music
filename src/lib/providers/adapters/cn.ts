import { invoke } from "@tauri-apps/api/core";
import type { ProviderCandidate, ProviderId } from "@/lib/providers/types";

/**
 * The Chinese music platforms: Migu (咪咕), Kugou (酷狗) and QQ Music.
 *
 * All three share one shape — they are all Chinese catalogues behind
 * the same kind of mobile API — so they share one adapter module. The
 * differences are the endpoints and the id each platform uses, both of
 * which live in Rust (`src-tauri/src/cnproviders.rs`); the frontend
 * only ever sees rows of the same type.
 *
 * The id each platform uses:
 *
 *   - Migu:  a `contentId` (`600929000002646139`)
 *   - Kugou: a `FileHash` (32 hex characters)
 *   - QQ:    a `songmid` (`001Qu4I30eVFYb`)
 */

/** One row as the backend reports it. */
export type CnSong = {
  id: string;
  title: string;
  artists: string[];
  album: string | null;
  /** Seconds. */
  duration: number;
  coverUrl: string | null;
  /** The platform's own fee tier where it reports one: 0 free, 1 VIP. */
  fee: number | null;
};

/** The three platforms this module covers. */
export type CnProviderId = Extract<ProviderId, "migu" | "kugou" | "qq">;

/** The Tauri command that searches each platform. */
const SEARCH_COMMANDS: Record<CnProviderId, string> = {
  migu: "migu_search_cmd",
  kugou: "kugou_search_cmd",
  qq: "qq_search_cmd",
};

/**
 * Search one of the Chinese platforms.
 *
 * A failure returns an empty list rather than throwing: a provider
 * that is down must not break the page that asked it, and the
 * resolver treats "no candidates" and "provider failed" the same way.
 */
export async function cnSearch(
  provider: CnProviderId,
  query: string,
  limit = 20,
): Promise<CnSong[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  try {
    const rows = await invoke<CnSong[]>(SEARCH_COMMANDS[provider], {
      query: trimmed,
      limit,
    });
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

/** Turn a platform row into the provider-neutral candidate shape. */
export function toCnCandidate(
  provider: CnProviderId,
  song: CnSong,
): ProviderCandidate {
  return {
    provider,
    providerTrackId: song.id,
    title: song.title,
    artists: song.artists,
    album: song.album ?? undefined,
    // Migu's search endpoint reports no length at all. A zero here
    // would read as "a zero-length track" everywhere downstream, so
    // it becomes "unknown" instead — which is what it is.
    duration: song.duration > 0 ? song.duration : undefined,
    coverUrl: song.coverUrl ?? undefined,
  };
}

/**
 * Build the adapter the resolver registers.
 *
 * The adapter takes a free-text query rather than a structured hint,
 * because that is what these platforms' search endpoints accept. The
 * *matching* of the results against the track being looked for is the
 * resolver's job (`rankCandidates`), not the adapter's.
 *
 * ## The two-query strategy
 *
 * The doc's §7: search the title with the artist, and if that comes
 * back nearly empty, search the title alone.
 *
 * These platforms return a much narrower page than NetEase does —
 * twenty rows — and their ranking puts the authoritative recording
 * below the covers when the artist name is part of the query. A second
 * query without the artist is what gives a song the first query missed
 * a second chance, and it only runs when the first query came back
 * nearly empty, so the common case costs one request.
 */
export function makeCnAdapter(provider: CnProviderId) {
  return async (
    query: string,
    signal?: AbortSignal,
  ): Promise<ProviderCandidate[]> => {
    if (signal?.aborted) return [];
    let songs = await cnSearch(provider, query);
    if (signal?.aborted) return [];

    // Too few rows: the query was too narrow. Try the title on its own.
    if (songs.length < 3) {
      const bare = query.split(/\s+/).slice(0, 2).join(" ");
      if (bare && bare !== query) {
        const wider = await cnSearch(provider, bare);
        if (signal?.aborted) return [];
        // The wider page is only better if it actually has more in it.
        if (wider.length > songs.length) songs = wider;
      }
    }

    return songs.map((song) => toCnCandidate(provider, song));
  };
}

/** Search Migu Music (咪咕音乐). */
export const searchMigu = makeCnAdapter("migu");

/** Search Kugou Music (酷狗音乐). */
export const searchKugou = makeCnAdapter("kugou");

/** Search QQ Music (QQ音乐). */
export const searchQQ = makeCnAdapter("qq");
