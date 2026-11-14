import { describe, expect, it } from "vitest";

import { nativeNeteaseSongId } from "@/lib/netease/song-id";
import type { QueueTrack } from "@/lib/store/playback";

/**
 * The three ways a track turns into a NetEase song id.
 *
 * The order matters, and the test is about the order:
 *
 *   1. The track's own id — for a track that came from NetEase.
 *   2. The registry — for a track the app already knows about.
 *   3. The matcher — for everything else.
 *
 * The third one is the *guess*, so the test also checks that the
 * resolver can say so: the UI shows the caveat, and a reader of the
 * comments needs to know they might be about a different recording.
 *
 * The matcher itself is not exercised here — it is the app's existing
 * cross-platform matcher, unchanged, and it has its own tests.
 */

function track(overrides: Partial<QueueTrack> = {}): QueueTrack {
  return {
    id: "t1",
    videoId: "yt-abc",
    title: "晴天",
    artists: ["周杰伦"],
    ...overrides,
  } as QueueTrack;
}

describe("nativeNeteaseSongId", () => {
  it("is the provider's own id for a track that plays from NetEase", () => {
    const id = nativeNeteaseSongId(
      track({ provider: "netease", providerTrackId: "186016" }),
    );
    expect(id).toBe("186016");
  });

  it("is the discovered id for a track that was found on NetEase", () => {
    const id = nativeNeteaseSongId(
      track({
        provider: "youtube",
        discoveredOn: "netease",
        discoveredTrackId: "186016",
      }),
    );
    expect(id).toBe("186016");
  });

  it("prefers the provider's own id over the discovered one", () => {
    const id = nativeNeteaseSongId(
      track({
        provider: "netease",
        providerTrackId: "111",
        discoveredOn: "netease",
        discoveredTrackId: "222",
      }),
    );
    expect(id).toBe("111");
  });

  it("is nothing for a plain YouTube track", () => {
    expect(nativeNeteaseSongId(track({ provider: "youtube" }))).toBeUndefined();
    expect(nativeNeteaseSongId(track())).toBeUndefined();
  });

  it("is nothing for a track with no id at all", () => {
    expect(
      nativeNeteaseSongId(track({ provider: "netease", providerTrackId: "" })),
    ).toBeUndefined();
    expect(nativeNeteaseSongId(undefined)).toBeUndefined();
  });

  it("does not treat another platform's discovery as a NetEase one", () => {
    const id = nativeNeteaseSongId(
      track({
        provider: "youtube",
        discoveredOn: "youtube",
        discoveredTrackId: "abc",
      }),
    );
    expect(id).toBeUndefined();
  });
});
