import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { safeIdbStorage } from "./idb-storage";
import type { ProviderId } from "@/lib/providers/types";

/**
 * Which NetEase song a YouTube video came from.
 *
 * ## The problem this solves
 *
 * YouTube Music stores a playlist entry as a YouTube `videoId` and
 * nothing else. There is no field on the server for "this video is the
 * NetEase record 186016" — so a NetEase daily pick that the user
 * hearts ends up in the YouTube liked list, and days later it comes
 * back as an ordinary YouTube row with no memory of where it came
 * from.
 *
 * That memory matters because of the app's own rule: the lyrics come
 * from the platform the audio comes from. NetEase's lyrics are keyed on
 * NetEase's own song id, so the pick has exactly the right words
 * waiting for it there — and they are lost the moment the song leaves
 * the daily-recommendation page.
 *
 * ## What is remembered
 *
 * One correspondence, indexed both ways: a YouTube `videoId` → the
 * NetEase song id of the recording it holds, and back.
 *
 * The forward direction is what the lyrics lookup needs (a YouTube row
 * asking "what is this song on NetEase?"); the reverse is what the
 * heart flow needs (a NetEase pick asking "which YouTube video does it
 * live as?").
 *
 * The mapping is only written when it is *known*, never guessed:
 *
 *   - the daily pick resolved to a YouTube video (both ids known);
 *   - a track was switched from one platform to another (both known);
 *   - a NetEase pick was hearted on YouTube (both known).
 *
 * A track that merely happens to exist on both platforms without the
 * app having seen the correspondence is left alone — the ordinary
 * cross-provider matcher handles that case, and a wrong mapping here
 * would put the wrong song's words under a track.
 */
export type NetEaseIdState = {
  /** YouTube video id → NetEase song id. */
  byVideoId: Record<string, string>;
  /** NetEase song id → YouTube video id. The same correspondence, read
   *  the other way round. */
  bySongId: Record<string, string>;
  /** Remember that a YouTube video holds a given NetEase recording. */
  remember: (videoId: string, songId: string) => void;
  /** Forget a video's mapping — used when the track is no longer known
   *  to be that recording. */
  forget: (videoId: string) => void;
};

/**
 * Soft cap on the number of remembered mappings.
 *
 * The registry only grows when the user moves songs between platforms,
 * so it stays small in practice; the cap is here so a long-lived
 * install cannot grow it without bound. Oldest insertions are evicted
 * first.
 */
const MAX_ENTRIES = 5000;

export const useNetEaseIdStore = create<NetEaseIdState>()(
  persist(
    (set, get) => ({
      byVideoId: {},
      bySongId: {},
      remember: (videoId, songId) => {
        if (!videoId || !songId) return;
        const existing = get().byVideoId[videoId];
        if (existing === songId) return;
        set((s) => {
          const byVideoId = { ...s.byVideoId, [videoId]: songId };
          const bySongId = { ...s.bySongId, [songId]: videoId };
          const keys = Object.keys(byVideoId);
          if (keys.length > MAX_ENTRIES) {
            for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) {
              const dropped = byVideoId[k];
              delete byVideoId[k];
              if (dropped) delete bySongId[dropped];
            }
          }
          return { byVideoId, bySongId };
        });
      },
      forget: (videoId) => {
        set((s) => {
          const songId = s.byVideoId[videoId];
          if (!songId) return s;
          const byVideoId = { ...s.byVideoId };
          const bySongId = { ...s.bySongId };
          delete byVideoId[videoId];
          delete bySongId[songId];
          return { byVideoId, bySongId };
        });
      },
    }),
    {
      name: "adrify-netease-ids",
      storage: createJSONStorage(() => safeIdbStorage),
    },
  ),
);

/**
 * Remember that a YouTube video holds a given NetEase recording.
 *
 * Safe to call from anywhere: it is a no-op when either id is missing,
 * and it never overwrites a mapping with the same value.
 */
export function rememberNeteaseSong(
  videoId: string | undefined,
  songId: string | undefined,
): void {
  if (!videoId || !songId) return;
  useNetEaseIdStore.getState().remember(videoId, songId);
}

/**
 * The NetEase song id a YouTube video is known to hold.
 *
 * `undefined` means the app has never seen the correspondence — which
 * is the normal answer, and not an error.
 */
export function neteaseSongForVideo(
  videoId: string | undefined,
): string | undefined {
  if (!videoId) return undefined;
  return useNetEaseIdStore.getState().byVideoId[videoId];
}

/**
 * The YouTube video id known to hold a given NetEase recording.
 *
 * The mirror image of {@link neteaseSongForVideo}: it is what the
 * heart flow asks, because a YouTube playlist stores YouTube video ids
 * and the NetEase song id means nothing there.
 */
export function neteaseVideoForSong(
  songId: string | undefined,
): string | undefined {
  if (!songId) return undefined;
  return useNetEaseIdStore.getState().bySongId[songId];
}

/** A track's identity on one platform. */
type PlatformRef = {
  provider?: ProviderId;
  providerTrackId?: string;
  /** The queue's `videoId` — the YouTube id for a YouTube track, and a
   *  synthetic `netease_<id>` string for anything else. */
  videoId?: string;
};

/**
 * The YouTube video id a reference names.
 *
 * The app's convention is that an absent provider *means* YouTube (see
 * `isYouTubeVideoId`), so a reference without a provider is a YouTube
 * one — and its id is the `videoId` field rather than `providerTrackId`.
 */
function videoIdOf(ref: PlatformRef): string | undefined {
  if ((ref.provider ?? "youtube") !== "youtube") return undefined;
  return ref.providerTrackId ?? ref.videoId;
}

/**
 * Record that two platform references are the same recording.
 *
 * This is the one place a correspondence is established, and it only
 * ever runs on a pair the app *knows* to be one recording — the two
 * ids of a track that was moved between platforms, or the two ids of a
 * daily pick that resolved to a YouTube video.
 *
 * Only the NetEase ↔ YouTube pair is remembered: those are the two
 * platforms whose lyrics are keyed on their own track ids, and so the
 * two that need to know each other.
 */
export function rememberPlatformPair(
  a: PlatformRef | undefined,
  b: PlatformRef | undefined,
): void {
  if (!a || !b) return;
  const neteaseSide =
    a.provider === "netease" ? a : b.provider === "netease" ? b : null;
  if (!neteaseSide) return;
  const otherSide = neteaseSide === a ? b : a;
  const songId = neteaseSide.providerTrackId;
  const videoId = videoIdOf(otherSide);
  if (!songId || !videoId) return;
  rememberNeteaseSong(videoId, songId);
}
