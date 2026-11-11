import type { QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  dislikeTrack,
  likeTrack,
  removeRating,
} from "@/lib/innertube/mutations";
import type { ShelfItem } from "@/lib/innertube/types";
import { syncLastfmLove } from "@/lib/lastfm/love";
import type { LastfmTrackMeta } from "@/lib/lastfm/track";
import {
  findYouTubeVideoId,
  subjectOf,
  syncNeteaseLike,
  syncYouTubeLike,
} from "@/lib/providers/netease-like";
import { isYouTubeVideoId } from "@/lib/providers/queue";
import { useDislikesStore } from "@/lib/store/dislikes";
import { rememberPlatformPair } from "@/lib/store/netease-ids";
import { translate } from "@/lib/i18n";
import type { QueueTrack } from "@/lib/store/playback";

// Patch the cached liked-songs list optimistically. The server is the
// source of truth, but `["liked-songs"]` is `enabled: false` in the
// components that only *read* it, so an `invalidateQueries` call would
// NOT refetch — meaning the heart wouldn't fill until the user visited
// Settings or the Liked Songs page. Mutating the cache directly keeps
// every observer (player bar, track rows, context menus, settings cache
// list) in sync without a round-trip.
function makeLikedPlaceholder(videoId: string): ShelfItem {
  return { id: videoId, kind: "song", title: "", thumbnails: [] };
}

/**
 * Whether the track's `videoId` is a real YouTube video id.
 *
 * A track from another provider carries a synthetic `netease_<id>`
 * string in that field — namespaced so it can never collide with a
 * YouTube id (which is 11 characters), and so nothing that expects a
 * YouTube id will be handed one by accident. This is the check that
 * keeps the heart from being sent to the wrong platform.
 */
export function isNativeYouTubeId(
  videoId: string,
  track?: LastfmTrackMeta | QueueTrack,
): boolean {
  // An explicit provider wins: a YouTube track keeps its YouTube id
  // even when it was discovered on another platform.
  const provider = (track as Partial<QueueTrack> | undefined)?.provider;
  return isYouTubeVideoId(videoId, provider);
}

/**
 * The provider a track belongs to, when it says so.
 *
 * `undefined` means YouTube — the app's own catalogue is YouTube's, and
 * every row that did not come from somewhere else is a YouTube row.
 */
function providerOf(
  track: LastfmTrackMeta | QueueTrack | undefined,
): QueueTrack["provider"] {
  return (track as Partial<QueueTrack> | undefined)?.provider;
}

/**
 * The track's id on the platform that owns it.
 *
 * A NetEase track carries its own song id, so there is nothing to look
 * up: the heart can be submitted straight to NetEase.
 *
 * The *discovery* origin counts too: a NetEase daily pick that was
 * redirected to YouTube still knows the NetEase record it came from,
 * and that record is the authoritative one — a fresh catalogue search
 * could land on a cover of the same song.
 */
function providerTrackIdOf(
  track: LastfmTrackMeta | QueueTrack | undefined,
): string | undefined {
  const candidate = track as Partial<QueueTrack> | undefined;
  if (!candidate) return undefined;
  if (candidate.provider === "netease") return candidate.providerTrackId;
  if (candidate.discoveredOn === "netease") return candidate.discoveredTrackId;
  return undefined;
}

/**
 * Patch the cached NetEase collection after a heart.
 *
 * The collection belongs to the account, so its cache is what has to
 * change — not the app's YouTube liked list, which knows nothing about
 * a NetEase song id.
 */
function patchNeteaseLikedIds(
  queryClient: QueryClient,
  songId: string,
  liked: boolean,
): void {
  queryClient.setQueryData<string[] | null>(["netease-liked-ids"], (old) => {
    if (!old) return old;
    const has = old.includes(songId);
    if (liked) return has ? old : [...old, songId];
    return has ? old.filter((id) => id !== songId) : old;
  });
}

/**
 * Mark the heavy, account-scoped liked lists stale.
 *
 * The Library → Songs list and the Liked Songs (LM) playlist page are
 * infinite queries, so invalidating them only refetches if mounted.
 */
async function invalidateLikedLists(queryClient: QueryClient): Promise<void> {
  await queryClient.invalidateQueries({
    queryKey: ["library", "liked-songs-pages"],
  });
  await queryClient.invalidateQueries({
    predicate: (q) =>
      q.queryKey[0] === "playlist-pages" &&
      typeof q.queryKey[1] === "string" &&
      (q.queryKey[1] as string).includes("LM"),
  });
}

/**
 * Like or unlike a track and keep every cached view of the liked list in
 * sync. Shared by the heart button and the track context menu so they
 * can't drift apart. Throws on a failed mutation; the toast is emitted here.
 */
export async function toggleLiked({
  queryClient,
  videoId,
  wasLiked,
  track,
}: {
  queryClient: QueryClient;
  videoId: string;
  wasLiked: boolean;
  /** Metadata for the Last.fm loved-track sync. Without it a like still
   *  works, it just isn't mirrored to Last.fm. */
  track?: LastfmTrackMeta;
}): Promise<void> {
  // Where the heart goes depends on where the track lives.
  //
  // A YouTube track is hearted on YouTube directly — its `videoId` is
  // a real YouTube id. A track from another platform carries a
  // synthetic `netease_<id>` string there, which YouTube's like
  // endpoint will not answer to, so the heart is submitted to that
  // platform instead, and YouTube gets it through a catalogue lookup
  // (see `syncYouTubeLike`).
  const provider = providerOf(track);
  const nativeToYouTube = isNativeYouTubeId(videoId, track);

  if (provider === "netease") {
    // A NetEase track. The heart belongs to the NetEase account, and
    // the track already knows its own song id — so the submission is
    // direct, with no catalogue lookup on this side.
    const songId = providerTrackIdOf(track);
    if (!songId) {
      toast.error(translate("toast.likeFailedNoId"));
      return;
    }
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("netease_set_like", { songId, like: !wasLiked });
    } catch (e) {
      toast.error(translate("toast.neteaseLikeFailed", { detail: String(e) }));
      return;
    }
    if (!wasLiked) {
      useDislikesStore.getState().remove(videoId);
    }
    // The NetEase collection is the platform's, so the app's cache of it
    // is what gets patched — not the YouTube liked list.
    patchNeteaseLikedIds(queryClient, songId, !wasLiked);
    toast.success(
      translate(wasLiked ? "toast.neteaseUnliked" : "toast.neteaseLiked"),
    );
    // And to YouTube, which has to look the song up in its own catalogue
    // first — the two platforms' ids are not interchangeable.
    void syncYouTubeLike(!wasLiked, track);
    await invalidateLikedLists(queryClient);
    syncLastfmLove(track ?? {}, !wasLiked);
    return;
  }

  if (nativeToYouTube) {
    if (wasLiked) {
      await removeRating(videoId);
    } else {
      await likeTrack(videoId);
      // A like replaces a dislike on the server; mirror that locally.
      useDislikesStore.getState().remove(videoId);
    }
    // A track the app knows on NetEase — a daily pick that was
    // redirected to YouTube — keeps the correspondence alive, so the
    // track can still be recognised as the NetEase recording it came
    // from when it comes back out of the liked list.
    rememberPlatformPair(
      {
        provider: "youtube",
        providerTrackId: videoId,
        videoId,
      },
      {
        provider: "netease",
        providerTrackId: providerTrackIdOf(track),
      },
    );
  } else {
    // A track from a platform that has no heart of its own yet (the
    // other Chinese platforms, Spotify, Apple). YouTube is where the
    // heart can live — but its id has to be looked up in YouTube's own
    // catalogue first, because the id the track carries is the other
    // platform's and the two are not interchangeable.
    //
    // The lookup is awaited here rather than left in the background:
    // the heart's own filled state depends on the answer, and a
    // half-applied heart would leave the button out of step with the
    // server.
    const matched = await findYouTubeVideoId(subjectOf(track));
    if (!matched) {
      toast.info(
        translate("toast.youtubeLikeNoMatch", {
          title: track?.title ?? "",
        }),
      );
      return;
    }
    if (wasLiked) {
      await removeRating(matched);
    } else {
      await likeTrack(matched);
      useDislikesStore.getState().remove(videoId);
    }
  }

  // A cold-start membership fetch may have captured the list before this
  // mutation. Cancel it at the cache commit point so its older snapshot cannot
  // overwrite the patch below. If we interrupted one, restart it after the
  // patch to recover the complete membership list rather than leaving a
  // partial placeholder-only cache.
  const likedSongsKey = ["liked-songs"] as const;
  const interruptedFetch =
    queryClient.isFetching({ queryKey: likedSongsKey, exact: true }) > 0;
  await queryClient.cancelQueries({ queryKey: likedSongsKey, exact: true });

  if (wasLiked) {
    queryClient.setQueryData<ShelfItem[]>(["liked-songs"], (old) =>
      (old ?? []).filter((t) => t.id !== videoId),
    );
    toast.success(translate("toast.removedFromLiked"));
  } else {
    queryClient.setQueryData<ShelfItem[]>(["liked-songs"], (old) => {
      const list = old ?? [];
      if (list.some((t) => t.id === videoId)) return list;
      return [makeLikedPlaceholder(videoId), ...list];
    });
    toast.success(translate("toast.addedToLiked"));
  }
  if (interruptedFetch) {
    void queryClient.invalidateQueries({
      queryKey: likedSongsKey,
      exact: true,
      refetchType: "all",
    });
  }
  // Mirror the like/unlike to Last.fm as a loved / unloved track.
  syncLastfmLove(track ?? {}, !wasLiked);
  // And to the other platform, as a heart on the account's own
  // collection there.
  //
  // These are not fire-and-forget in the same way: the lookup they
  // need (which record on the other platform is this song?) is a
  // network round trip, and it has to happen *after* the app's own
  // heart so the user never waits on it. The sync is started here and
  // settles on its own.
  if (nativeToYouTube) {
    // A YouTube track: the heart is already on YouTube; mirror it to
    // NetEase, which has to look the song up in its own catalogue.
    void syncNeteaseLike(!wasLiked, track);
  }
  // The heart-fill cache (["liked-songs"]) is separate from the
  // Library → Songs list (["library","liked-songs-pages"]) and the
  // Liked Songs (LM) playlist page (["playlist-pages", …"LM"…]). Mark
  // those stale so they don't keep showing an outdated list. They're
  // heavy infinite queries, so invalidate only refetches if mounted.
  void invalidateLikedLists(queryClient);
}

/**
 * Dislike a track, or clear the dislike again. The server treats a
 * dislike as replacing any like, so the liked-list cache is patched the
 * same way an unlike is; the dislike itself is remembered in
 * `store/dislikes.ts` (see there for why it's local).
 */
export async function toggleDisliked({
  queryClient,
  videoId,
  wasDisliked,
  wasLiked,
  track,
}: {
  queryClient: QueryClient;
  videoId: string;
  wasDisliked: boolean;
  wasLiked: boolean;
  track?: LastfmTrackMeta;
}): Promise<void> {
  const dislikes = useDislikesStore.getState();
  const provider = providerOf(track);

  if (provider === "netease") {
    // A NetEase track's dislike is not a YouTube rating: the id in
    // `videoId` is a NetEase song id, and YouTube's rating endpoint
    // will not answer to it. What a dislike means here is the same
    // thing it means on YouTube — the track should not be liked — so
    // the NetEase heart comes off, and so does the YouTube one (which
    // has to be looked up, since the two platforms' ids differ).
    if (wasDisliked) {
      dislikes.remove(videoId);
      toast.success(translate("toast.dislikeRemoved"));
      return;
    }
    const songId = providerTrackIdOf(track);
    if (songId) {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("netease_set_like", { songId, like: false });
        patchNeteaseLikedIds(queryClient, songId, false);
      } catch (e) {
        toast.error(
          translate("toast.neteaseLikeFailed", { detail: String(e) }),
        );
        return;
      }
    }
    dislikes.add(videoId);
    toast.success(translate("toast.disliked"));
    return;
  }

  if (wasDisliked) {
    await removeRating(videoId);
    dislikes.remove(videoId);
    toast.success(translate("toast.dislikeRemoved"));
    return;
  }
  await dislikeTrack(videoId);
  dislikes.add(videoId);
  if (wasLiked) {
    await queryClient.cancelQueries({ queryKey: ["liked-songs"], exact: true });
    queryClient.setQueryData<ShelfItem[]>(["liked-songs"], (old) =>
      (old ?? []).filter((t) => t.id !== videoId),
    );
    syncLastfmLove(track ?? {}, false);
    void queryClient.invalidateQueries({
      queryKey: ["library", "liked-songs-pages"],
    });
  }
  toast.success(translate("toast.disliked"));
}
