import { beforeEach, describe, expect, it } from "vitest";
import type { CanonicalTrack } from "@/lib/providers/types";
import type { QueueTrack } from "@/lib/store/playback";

/**
 * The daily pick the user hearts.
 *
 * The scenario this file covers:
 *
 *   1. The NetEase daily recommendation hands the app a *NetEase*
 *      record — it has the platform's own song id, and that id is the
 *      key the platform's own lyrics are filed under.
 *   2. The user hearts it. The heart goes to NetEase (the song belongs
 *      there) *and* to YouTube (the user's YouTube liked list is the
 *      app's own collection). The YouTube side needs a YouTube video
 *      id, so the recording is matched into YouTube's catalogue.
 *   3. From then on the song has two ids — the NetEase song id and the
 *      YouTube video id — and the app must remember that they are one
 *      recording.
 *   4. Playing it from YouTube must give YouTube's lyrics; switching
 *      to NetEase must give NetEase's, and must use the *exact* NetEase
 *      record rather than whatever a catalogue search matched.
 *
 * Step 3 is the part that used to be missing, and step 4 is what it
 * buys.
 */

// The stores read localStorage and IndexedDB; neither exists under the
// node test environment. The playback store decides at import time
// whether to wrap itself in zustand/persist (main window) or stay plain
// (floating mirror) — presenting ourselves as the floating window skips
// that plumbing, and the reducer under test is identical either way.
const mem = new Map<string, string>();
(globalThis as unknown as { window: unknown }).window = {
  location: { search: "?floating-player" },
  localStorage: {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
  },
  // The stores subscribe to the `storage` event so a change made in the
  // other window is picked up. Nothing fires it here, but the
  // subscription has to exist.
  addEventListener: () => {},
  removeEventListener: () => {},
};

const { useNetEaseIdStore, rememberNeteaseSong, neteaseSongForVideo } =
  await import("@/lib/store/netease-ids");
const { usePlaybackStore } = await import("@/lib/store/playback");
const { canonicalFromQueueTrack } = await import("@/lib/providers/queue");
const { dailyQueueTracks } = await import("@/lib/providers/daily");
const { rankAvailability, availabilityKey } = await import(
  "@/lib/providers/availability"
);
const { orderedSourcesForProvider } = await import("@/lib/lyrics/sources");

/** A NetEase song, as the backend reports a daily pick. */
function neteaseSong(id = "186016") {
  return {
    id,
    title: "晴天",
    artists: ["周杰伦"],
    album: "叶惠美",
    aliases: [],
    durationMs: 269_000,
    duration: 269,
    coverUrl: null,
    fee: 8,
    playable: true,
  };
}

describe("the NetEase daily recommendation carries its own song id", () => {
  it("puts the song id on the queue entry, not just the platform name", () => {
    const [entry] = dailyQueueTracks([neteaseSong("186016")]);
    // The origin needs both halves: the platform, and the id the
    // platform's lyrics are filed under.
    expect(entry.discoveredOn).toBe("netease");
    expect(entry.discoveredTrackId).toBe("186016");
  });

  it("keeps the id even when the pick is redirected to another provider", () => {
    // A pick NetEase will not serve is redirected — but the words did
    // not change with the audio source, so the id must not be lost.
    const entry: QueueTrack = {
      ...dailyQueueTracks([neteaseSong("186016")])[0],
      provider: "youtube",
      providerTrackId: "zNhtz0Lygik",
    };
    const canonical = canonicalFromQueueTrack(entry);
    expect(canonical.knownIds?.netease).toBe("186016");
  });

  it("keeps the pick's artwork when it is redirected", () => {
    // The source that wins the redirect is another platform's record,
    // and its cover is not in hand — so the pick's own picture has to
    // survive. Without it the queue entry has no artwork at all, and
    // the player shows an empty square and an empty backdrop.
    const song = { ...neteaseSong("186016"), coverUrl: "https://p1.music.126.net/x.jpg" };
    const entry = dailyQueueTracks([song])[0];
    expect(entry.thumbnails[0]?.url).toBe(song.coverUrl);

    // The same picture survives the redirect, because the redirected
    // entry is rebuilt from the same canonical shape.
    const canonical = canonicalFromQueueTrack(entry);
    expect(canonical.coverUrl).toBe(song.coverUrl);
  });
});

describe("the registry of YouTube video → NetEase song", () => {
  beforeEach(() => {
    useNetEaseIdStore.setState({ byVideoId: {}, bySongId: {} });
  });

  it("remembers a correspondence in both directions", () => {
    rememberNeteaseSong("zNhtz0Lygik", "186016");
    expect(neteaseSongForVideo("zNhtz0Lygik")).toBe("186016");
    expect(
      useNetEaseIdStore.getState().bySongId["186016"],
    ).toBe("zNhtz0Lygik");
  });

  it("has no answer for a video it has never seen", () => {
    expect(neteaseSongForVideo("unknownVideo")).toBeUndefined();
  });

  it("survives the queue entry being rebuilt", () => {
    // The correspondence outlives the queue: the pick was hearted days
    // ago and the queue has been rebuilt since, so the id cannot live
    // on the queue entry alone.
    rememberNeteaseSong("zNhtz0Lygik", "186016");

    const fromLikedList: QueueTrack = {
      videoId: "zNhtz0Lygik",
      title: "晴天",
      artists: [{ id: undefined, name: "周杰伦" }],
      thumbnails: [],
      duration: 269,
      // An ordinary YouTube row — the NetEase origin is gone.
      provider: "youtube",
      providerTrackId: "zNhtz0Lygik",
    };

    const canonical = canonicalFromQueueTrack(fromLikedList);
    expect(canonical.knownIds?.netease).toBe("186016");
  });
});

describe("the NetEase option is the exact record, not a search result", () => {
  beforeEach(() => {
    useNetEaseIdStore.setState({ byVideoId: {}, bySongId: {} });
  });

  it("uses the known id rather than the matched one", () => {
    // The search turned up a *cover* of the song — a different
    // recording that happens to share the title. The known id is the
    // pick's own record, and it has to win.
    const canonical: CanonicalTrack = {
      title: "晴天",
      artists: ["周杰伦"],
      duration: 269,
      origin: "youtube",
      originId: "zNhtz0Lygik",
      knownIds: { netease: "186016" },
    };

    const ranked = rankAvailability(
      new Map([["netease", { provider: "netease" as const, providerTrackId: "999999" }]]),
      canonical,
      ["youtube", "netease"],
    );

    expect(ranked).toEqual([
      { provider: "youtube", providerTrackId: "zNhtz0Lygik" },
      { provider: "netease", providerTrackId: "186016" },
    ]);
  });

  it("does not search a platform whose id is already known", () => {
    // Asking again could only turn up a worse answer — a cover of the
    // same song filed under a different id.
    const canonical: CanonicalTrack = {
      title: "晴天",
      artists: ["周杰伦"],
      duration: 269,
      origin: "youtube",
      originId: "zNhtz0Lygik",
      knownIds: { netease: "186016" },
    };

    // The key differs from the same track without the known id, so the
    // two cannot share a cache entry.
    const withoutKnown: CanonicalTrack = { ...canonical, knownIds: undefined };
    expect(availabilityKey(canonical)).not.toBe(availabilityKey(withoutKnown));
  });
});

describe("a YouTube row the app knows is a NetEase recording", () => {
  beforeEach(() => {
    useNetEaseIdStore.setState({ byVideoId: {}, bySongId: {} });
  });

  it("declares its NetEase origin when it comes back out of the liked list", () => {
    // The pick was hearted on YouTube, so it lives in the YouTube
    // liked list under a YouTube video id. When it comes back, the
    // registry is the only thing that remembers where it came from.
    rememberNeteaseSong("zNhtz0Lygik", "186016");

    const store = usePlaybackStore.getState();
    store.playShelfItems(
      [
        {
          id: "zNhtz0Lygik",
          kind: "song",
          title: "晴天",
          artists: [{ id: undefined, name: "周杰伦" }],
          thumbnails: [],
          duration: 269,
        } as never,
      ],
      0,
    );

    const [entry] = usePlaybackStore.getState().queue;
    expect(entry.discoveredOn).toBe("netease");
    expect(entry.discoveredTrackId).toBe("186016");
  });

  it("leaves an unknown YouTube row alone", () => {
    const store = usePlaybackStore.getState();
    store.playShelfItems(
      [
        {
          id: "notAKnownVideo",
          kind: "song",
          title: "晴天",
          artists: [{ id: undefined, name: "周杰伦" }],
          thumbnails: [],
          duration: 269,
        } as never,
      ],
      0,
    );

    const [entry] = usePlaybackStore.getState().queue;
    expect(entry.discoveredOn).toBeUndefined();
  });
});

describe("the lyrics follow the audio source", () => {
  it("asks YouTube first for a track playing from YouTube", () => {
    const order = orderedSourcesForProvider("youtube");
    expect(order[0]).toBe("ytmusic");
    // NetEase is still in the chain — as the fallback that has the
    // exact words when the YouTube ones are missing.
    expect(order).toContain("netease");
  });

  it("asks NetEase first for a track playing from NetEase", () => {
    const order = orderedSourcesForProvider("netease");
    expect(order[0]).toBe("netease");
  });
});
