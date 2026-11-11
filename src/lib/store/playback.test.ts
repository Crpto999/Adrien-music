import { beforeEach, describe, expect, it } from "vitest";
import type { PlaybackState, QueueTrack } from "@/lib/store/playback";

// The store decides at import time whether to wrap itself in
// zustand/persist (main window) or stay plain (floating mirror).
// Present ourselves as the floating window so construction skips
// persist + localStorage (which isn't available under the node test
// env). `next()` — the reducer under test — is identical in both
// variants, so this only sidesteps the storage plumbing.
// The Playback settings store (read by prev()) persists through
// localStorage regardless, so give it an in-memory one.
const mem = new Map<string, string>();
(globalThis as unknown as { window: unknown }).window = {
  location: { search: "?floating-player" },
  localStorage: {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
  },
};

const { usePlaybackStore } = await import("@/lib/store/playback");
const { usePlaybackSettings } = await import("@/lib/store/playback-settings");

function track(videoId: string): QueueTrack {
  return { videoId, title: videoId, thumbnails: [] };
}

/** Reset to a known "mid-playback" baseline, then apply the overrides. */
function setup(partial: Partial<PlaybackState>): void {
  usePlaybackStore.setState({
    queue: [],
    index: -1,
    repeat: "off",
    shuffle: false,
    playing: true,
    status: "ready",
    streamUrl: "blob:prev",
    position: 42,
    pendingSeek: undefined,
    ...partial,
  });
}

describe("clearQueue", () => {
  beforeEach(() => setup({}));

  it("keeps the current track playing and drops what's after it", () => {
    setup({ queue: [track("a"), track("b"), track("c")], index: 1 });
    usePlaybackStore.getState().clearQueue();
    const s = usePlaybackStore.getState();
    expect(s.queue.map((t) => t.videoId)).toEqual(["a", "b"]);
    expect(s.index).toBe(1);
    expect(s.playing).toBe(true);
    expect(s.status).toBe("ready");
    expect(s.streamUrl).toBe("blob:prev");
    expect(s.position).toBe(42);
  });

  it("bumps radioEpoch so auto-radio can re-seed from the same track", () => {
    setup({ queue: [track("a"), track("b")], index: 0, radioEpoch: 3 });
    usePlaybackStore.getState().clearQueue();
    expect(usePlaybackStore.getState().radioEpoch).toBe(4);
  });

  it("empties an idle queue", () => {
    setup({ queue: [track("a"), track("b")], index: -1, playing: false });
    usePlaybackStore.getState().clearQueue();
    expect(usePlaybackStore.getState().queue).toEqual([]);
  });

  it("stopPlayback empties everything and stops", () => {
    setup({ queue: [track("a"), track("b")], index: 0 });
    usePlaybackStore.getState().stopPlayback();
    const s = usePlaybackStore.getState();
    expect(s.queue).toEqual([]);
    expect(s.index).toBe(-1);
    expect(s.playing).toBe(false);
    expect(s.status).toBe("idle");
  });
});

describe("playback next()", () => {
  beforeEach(() => setup({}));

  it("replays the current track in place for repeat-one", () => {
    setup({ queue: [track("a"), track("b")], index: 0, repeat: "one" });
    usePlaybackStore.getState().next();
    const s = usePlaybackStore.getState();
    expect(s.index).toBe(0);
    expect(s.pendingSeek).toBe(0);
    expect(s.position).toBe(0);
    expect(s.playing).toBe(true);
  });

  it("replays in place for repeat-all on a single-track queue", () => {
    // Regression: wrapping a length-1 queue lands on the same index, so
    // the "loading" path never restarts the (already-ended) element and
    // playback used to stall on the loader — the "first click does
    // nothing" bug. It must route through pendingSeek like repeat-one.
    setup({
      queue: [track("a")],
      index: 0,
      repeat: "all",
      status: "ready",
      streamUrl: "blob:a",
    });
    usePlaybackStore.getState().next();
    const s = usePlaybackStore.getState();
    expect(s.index).toBe(0);
    expect(s.pendingSeek).toBe(0);
    expect(s.playing).toBe(true);
    // Must NOT take the load path (which would stall on a same-index track).
    expect(s.status).not.toBe("loading");
    expect(s.streamUrl).toBe("blob:a");
  });

  it("wraps a multi-track queue back to the first track for repeat-all", () => {
    setup({ queue: [track("a"), track("b")], index: 1, repeat: "all" });
    usePlaybackStore.getState().next();
    const s = usePlaybackStore.getState();
    expect(s.index).toBe(0);
    expect(s.status).toBe("loading");
    expect(s.streamUrl).toBeUndefined();
    expect(s.pendingSeek).toBeUndefined();
    expect(s.playing).toBe(true);
  });

  it("stops at the end of the queue when repeat is off", () => {
    setup({ queue: [track("a"), track("b")], index: 1, repeat: "off" });
    usePlaybackStore.getState().next();
    const s = usePlaybackStore.getState();
    expect(s.index).toBe(1);
    expect(s.playing).toBe(false);
    expect(s.position).toBe(0);
  });

  it("advances to the next track mid-queue", () => {
    setup({
      queue: [track("a"), track("b"), track("c")],
      index: 0,
      repeat: "off",
    });
    usePlaybackStore.getState().next();
    const s = usePlaybackStore.getState();
    expect(s.index).toBe(1);
    expect(s.status).toBe("loading");
    expect(s.playing).toBe(true);
  });

  it("is a no-op on an empty queue", () => {
    setup({ queue: [], index: -1, repeat: "all", playing: false });
    usePlaybackStore.getState().next();
    expect(usePlaybackStore.getState().index).toBe(-1);
  });
});

// A pending server-side shuffle continuation belongs to the queue it was
// created with — any action that replaces the queue must drop it, or the
// audio engine would append the OLD playlist's shuffle tail onto whatever
// the user played next.
describe("queueContinuation lifecycle", () => {
  beforeEach(() => setup({}));

  it("survives appends but is cleared when the queue is replaced", () => {
    setup({ queue: [track("a")], index: 0, queueContinuation: "tok1" });
    const s = usePlaybackStore.getState();
    s.appendToQueue([track("b")]);
    expect(usePlaybackStore.getState().queueContinuation).toBe("tok1");
    s.setQueue([track("c")], 0);
    expect(usePlaybackStore.getState().queueContinuation).toBeUndefined();
  });

  it("is cleared by playNow", () => {
    setup({ queue: [track("a")], index: 0, queueContinuation: "tok1" });
    usePlaybackStore.getState().playNow(track("b"));
    expect(usePlaybackStore.getState().queueContinuation).toBeUndefined();
  });

  it("is cleared by clearQueue", () => {
    setup({ queue: [track("a")], index: 0, queueContinuation: "tok1" });
    usePlaybackStore.getState().clearQueue();
    expect(usePlaybackStore.getState().queueContinuation).toBeUndefined();
  });

  it("is cleared by stopPlayback", () => {
    setup({ queue: [track("a")], index: 0, queueContinuation: "tok1" });
    usePlaybackStore.getState().stopPlayback();
    expect(usePlaybackStore.getState().queueContinuation).toBeUndefined();
  });

  it("setQueueContinuation sets and clears the token", () => {
    usePlaybackStore.getState().setQueueContinuation("tok2");
    expect(usePlaybackStore.getState().queueContinuation).toBe("tok2");
    usePlaybackStore.getState().setQueueContinuation(undefined);
    expect(usePlaybackStore.getState().queueContinuation).toBeUndefined();
  });
});

// The album menu's "Play next" queues a whole album by calling
// enqueueNext once per track in reverse — each insert lands directly
// after the current track, so reversing is what restores album order.
// If enqueueNext's insertion point ever changes, this breaks loudly
// instead of silently shuffling every album.
describe("album 'Play next' ordering", () => {
  beforeEach(() => setup({}));

  it("keeps album order when enqueued back-to-front", () => {
    setup({ queue: [track("cur"), track("later")], index: 0 });
    for (const t of [track("a1"), track("a2"), track("a3")].reverse()) {
      usePlaybackStore.getState().enqueueNext(t);
    }
    expect(usePlaybackStore.getState().queue.map((t) => t.videoId)).toEqual([
      "cur",
      "a1",
      "a2",
      "a3",
      "later",
    ]);
  });
});

describe("playback prev()", () => {
  const rule = (
    backButton: "previous" | "restart" | "smart",
    smartBackSeconds = 3,
  ) => usePlaybackSettings.setState({ backButton, smartBackSeconds });

  const mid = (position: number, index = 1) =>
    setup({ queue: [track("a"), track("b"), track("c")], index, position });

  it("smart: rewinds once more than the threshold has played", () => {
    rule("smart", 3);
    mid(10);
    usePlaybackStore.getState().prev();
    expect(usePlaybackStore.getState().index).toBe(1);
    expect(usePlaybackStore.getState().pendingSeek).toBe(0);
  });

  it("smart: steps back early in the track", () => {
    rule("smart", 3);
    mid(2);
    usePlaybackStore.getState().prev();
    expect(usePlaybackStore.getState().index).toBe(0);
  });

  it("smart: honours the chosen threshold", () => {
    rule("smart", 5);
    mid(4);
    usePlaybackStore.getState().prev();
    expect(usePlaybackStore.getState().index).toBe(0);
  });

  it("previous: always steps back, however far in", () => {
    rule("previous");
    mid(120);
    usePlaybackStore.getState().prev();
    expect(usePlaybackStore.getState().index).toBe(0);
  });

  it("restart: always rewinds, even at the very start", () => {
    rule("restart");
    mid(0.5);
    usePlaybackStore.getState().prev();
    expect(usePlaybackStore.getState().index).toBe(1);
    expect(usePlaybackStore.getState().pendingSeek).toBe(0);
  });

  it("the first track can only rewind", () => {
    rule("previous");
    mid(1, 0);
    usePlaybackStore.getState().prev();
    expect(usePlaybackStore.getState().index).toBe(0);
    expect(usePlaybackStore.getState().pendingSeek).toBe(0);
  });
});

describe("setTrackProvider", () => {
  beforeEach(() => setup({}));

  it("swaps the provider and the provider's own id", () => {
    setup({
      queue: [
        { ...track("yt123"), provider: "youtube", providerTrackId: "yt123" },
      ],
      index: 0,
    });
    usePlaybackStore
      .getState()
      .setTrackProvider(0, { provider: "netease", providerTrackId: "185709" });

    const t = usePlaybackStore.getState().queue[0];
    expect(t.provider).toBe("netease");
    expect(t.providerTrackId).toBe("185709");
  });

  it("rewrites the videoId to the provider's own namespace", () => {
    // A stale YouTube id would make the storage tab and the media
    // session describe the wrong file.
    setup({
      queue: [
        { ...track("yt123"), provider: "youtube", providerTrackId: "yt123" },
      ],
      index: 0,
    });
    usePlaybackStore
      .getState()
      .setTrackProvider(0, { provider: "netease", providerTrackId: "185709" });

    expect(usePlaybackStore.getState().queue[0].videoId).toBe("netease_185709");
  });

  it("keeps the queue slot's identity — title, artist and position", () => {
    setup({
      queue: [
        {
          ...track("yt123"),
          title: "起风了",
          provider: "youtube",
          providerTrackId: "yt123",
        },
      ],
      index: 0,
    });
    usePlaybackStore
      .getState()
      .setTrackProvider(0, { provider: "netease", providerTrackId: "185709" });

    const s = usePlaybackStore.getState();
    expect(s.index).toBe(0);
    expect(s.queue[0].title).toBe("起风了");
    expect(s.queue.length).toBe(1);
  });

  it("marks the current track as loading so the stream re-resolves", () => {
    setup({
      queue: [
        { ...track("yt123"), provider: "youtube", providerTrackId: "yt123" },
      ],
      index: 0,
      status: "ready",
      streamUrl: "http://127.0.0.1:1234/stream/yt123",
    });
    usePlaybackStore
      .getState()
      .setTrackProvider(0, { provider: "netease", providerTrackId: "185709" });

    const s = usePlaybackStore.getState();
    expect(s.status).toBe("loading");
    expect(s.streamUrl).toBeUndefined();
  });

  it("leaves a track that is not playing alone", () => {
    // A queued-but-not-current track has no stream to re-resolve, so
    // changing its provider must not disturb playback.
    setup({
      queue: [
        { ...track("a"), provider: "youtube", providerTrackId: "a" },
        { ...track("b"), provider: "youtube", providerTrackId: "b" },
      ],
      index: 0,
      status: "ready",
      streamUrl: "http://127.0.0.1:1234/stream/a",
    });
    usePlaybackStore
      .getState()
      .setTrackProvider(1, { provider: "netease", providerTrackId: "185709" });

    const s = usePlaybackStore.getState();
    expect(s.status).toBe("ready");
    expect(s.streamUrl).toBe("http://127.0.0.1:1234/stream/a");
    expect(s.queue[1].provider).toBe("netease");
  });

  it("ignores an out-of-range index", () => {
    setup({ queue: [track("a")], index: 0, status: "ready" });
    usePlaybackStore
      .getState()
      .setTrackProvider(5, { provider: "netease", providerTrackId: "185709" });

    expect(usePlaybackStore.getState().queue[0].provider).toBeUndefined();
    expect(usePlaybackStore.getState().status).toBe("ready");
  });

  it("locks the source when the user chose it by hand", () => {
    // The source switcher marks its choice as locked, so the priority
    // order will not undo it the next time the track is re-resolved.
    setup({
      queue: [
        { ...track("yt123"), provider: "youtube", providerTrackId: "yt123" },
      ],
      index: 0,
    });
    usePlaybackStore
      .getState()
      .setTrackProvider(
        0,
        { provider: "netease", providerTrackId: "185709" },
        undefined,
        true,
      );

    expect(usePlaybackStore.getState().queue[0].sourceLocked).toBe(true);
  });

  it("leaves the lock alone when the source is resolved automatically", () => {
    setup({
      queue: [
        { ...track("yt123"), provider: "youtube", providerTrackId: "yt123" },
      ],
      index: 0,
    });
    usePlaybackStore
      .getState()
      .setTrackProvider(0, { provider: "netease", providerTrackId: "185709" });

    expect(usePlaybackStore.getState().queue[0].sourceLocked).toBeUndefined();
  });

  it("remembers where the track was found when it moves provider", () => {
    // The origin's own id is what the platform's lyrics are filed
    // under, so it has to travel with the track.
    setup({
      queue: [
        { ...track("yt123"), provider: "youtube", providerTrackId: "yt123" },
      ],
      index: 0,
    });
    usePlaybackStore
      .getState()
      .setTrackProvider(
        0,
        { provider: "netease", providerTrackId: "185709" },
        { discoveredOn: "youtube", discoveredTrackId: "yt123" },
      );

    const t = usePlaybackStore.getState().queue[0];
    expect(t.discoveredOn).toBe("youtube");
    expect(t.discoveredTrackId).toBe("yt123");
  });
});
