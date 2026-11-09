import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";

/**
 * The song ids in the NetEase account's own "我喜欢的音乐" collection.
 *
 * `null` means nobody is signed in — there is no collection to read, so
 * nothing on the NetEase side can be hearted or un-hearted, and the
 * heart falls back to the app's own list.
 *
 * The whole collection comes back in one call. That matters because the
 * heart appears on every row of a track list: asking the platform once
 * per row would be a request per row, and the per-song `starred` flag
 * on the song-detail endpoint cannot be trusted (it answers `false`
 * even for songs that *are* in the collection).
 */
export function useNeteaseLikedIds(enabled: boolean) {
  return useQuery({
    queryKey: ["netease-liked-ids"],
    queryFn: () => invoke<string[] | null>("netease_liked_ids"),
    staleTime: 5 * 60 * 1000,
    retry: false,
    enabled,
  });
}

/**
 * Whether a NetEase song is in the account's collection.
 *
 * `false` when nobody is signed in, so the caller can fall back to the
 * app's own liked list.
 */
export function neteaseLikedSet(
  ids: string[] | null | undefined,
): Set<string> | null {
  if (!ids) return null;
  return new Set(ids);
}
