import { beforeEach, describe, expect, it } from "vitest";
import type { NeteaseSimilarSong } from "@/lib/netease/social";

/**
 * Playing a song out of the encyclopedia's "喜欢这首歌的人也爱听" list.
 *
 * The scenario this file covers:
 *
 *   1. The row carries the platform's own song id, so the queue entry
 *      is a NetEase-origin track — the id needs no lookup at all.
 *   2. The row keeps the id the platform's lyrics are filed under, so
 *      the track that plays has the platform's own words.
 *   3. The row's canonical form is the *origin* form, so the matcher
 *      is not asked to rediscover what the platform already said.
 */

// The stores read localStorage; it does not exist under the node test
// environment. Presenting ourselves as the floating window skips that
// plumbing, and the reducer under test is identical either way.
const mem = new Map<string, string>();
(globalThis as unknown as { window: unknown }).window = {
  location: { search: "?floating-player" },
  localStorage: {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => mem.delete(k),
  },
  addEventListener: () => {},
  removeEventListener: () => {},
};

const { usePlaybackStore } = await import("@/lib/store/playback");
const { canonicalFromQueueTrack, toQueueTrack } = await import(
  "@/lib/providers/queue"
);
const {
  similarSongQueueTrack,
  similarSongCanonical,
} = await import("@/lib/netease/similar-play");

/** A row of the similar-songs list, as the encyclopedia gives it. */
function row(id = "288820"): NeteaseSimilarSong {
  return {
    id,
    title: "结尾·友谊地久天长(Live)",
    artists: ["宋祖英", "郎朗", "多明戈"],
    album: "中国北京鸟巢夏季音乐会",
    pictureUrl: "https://p2.music.126.net/abc.jpg",
    durationMs: 268000,
    aliases: ["Farewell (Live)"],
  };
}

describe("a row of the similar-songs list", () => {
  beforeEach(() => {
    usePlaybackStore.setState({ queue: [], index: -1, playing: false });
  });

  it("becomes a NetEase-origin queue entry", () => {
    const track = similarSongQueueTrack(row());
    // The origin needs both halves: the platform, and the id the
    // platform's lyrics are filed under.
    expect(track.provider).toBe("netease");
    expect(track.providerTrackId).toBe("288820");
    expect(track.discoveredOn).toBe("netease");
    expect(track.discoveredTrackId).toBe("288820");
    // The queue's own id is the synthetic one, so it can never collide
    // with a YouTube id.
    expect(track.videoId).toBe("netease_288820");
  });

  it("carries the length, the album and the cover", () => {
    const track = similarSongQueueTrack(row());
    expect(track.duration).toBe(268);
    expect(track.album).toBe("中国北京鸟巢夏季音乐会");
    expect(track.thumbnails[0]?.url).toBe("https://p2.music.126.net/abc.jpg");
  });

  it("keeps the platform's own id as the origin's id", () => {
    // The matcher is not asked to rediscover what the platform already
    // said: the origin's id is authoritative.
    const canonical = similarSongCanonical(row());
    expect(canonical.origin).toBe("netease");
    expect(canonical.originId).toBe("288820");
    expect(canonical.duration).toBe(268);
  });

  it("is recognised as the same recording by the queue's own canonical form", () => {
    // The queue entry's canonical form has to agree, or the source
    // switcher would offer a *search result* instead of the row's own
    // exact NetEase record.
    const canonical = canonicalFromQueueTrack(similarSongQueueTrack(row()));
    expect(canonical.origin).toBe("netease");
    expect(canonical.originId).toBe("288820");
    expect(canonical.knownIds?.netease).toBe("288820");
  });

  it("keeps the row's artwork when the source is resolved", () => {
    // The source that wins the resolution is another platform's record,
    // and its cover is not in hand — so the row's own picture has to
    // survive the swap. Without it the player shows an empty square and
    // an empty backdrop for a track that plainly has a cover.
    const resolved = toQueueTrack({
      provider: "youtube",
      providerTrackId: "zNhtz0Lygik",
      title: row().title,
      artists: row().artists,
      album: row().album ?? undefined,
      duration: 268,
      coverUrl: row().pictureUrl ?? undefined,
    });
    expect(resolved.thumbnails[0]?.url).toBe(row().pictureUrl);
  });

  it("keeps the artwork on the canonical form the queue is built from", () => {
    // The canonical form is what the resolution reads, and what the
    // queue entry is rebuilt from. If it drops the picture, the track
    // that ends up playing has no artwork — an empty square in the
    // player and an empty backdrop behind it.
    const canonical = similarSongCanonical(row());
    expect(canonical.coverUrl).toBe(row().pictureUrl);
  });

  it("keeps the artwork when the queue entry is rebuilt from it", () => {
    const canonical = similarSongCanonical(row());
    const rebuilt = toQueueTrack({
      provider: "youtube",
      providerTrackId: "zNhtz0Lygik",
      title: canonical.title,
      artists: canonical.artists,
      album: canonical.album,
      duration: canonical.duration,
      coverUrl: canonical.coverUrl,
    });
    expect(rebuilt.thumbnails).toHaveLength(1);
    expect(rebuilt.thumbnails[0]?.url).toBe(row().pictureUrl);
  });
});
