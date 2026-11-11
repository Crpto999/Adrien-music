import { describe, expect, it } from "vitest";
import {
  SOURCE_ORDER,
  lyricsSourceForProvider,
  orderedSourcesForProvider,
} from "@/lib/lyrics/sources";

/**
 * The lyrics source has to follow the audio source.
 *
 * A song is one recording, and the platform that serves the recording
 * is the platform that has the words for it. The platform's own lyrics
 * are keyed on its own track id, so they cannot be the wrong song's
 * words — which is exactly what the text-matching sources sometimes
 * are. So the pairing is not a preference, it is a correctness
 * requirement.
 */
describe("lyricsSourceForProvider", () => {
  it("pairs each provider with the platform that serves the same ids", () => {
    expect(lyricsSourceForProvider("youtube")).toBe("ytmusic");
    expect(lyricsSourceForProvider("netease")).toBe("netease");
    expect(lyricsSourceForProvider("migu")).toBe("migu");
    expect(lyricsSourceForProvider("kugou")).toBe("kugou");
    expect(lyricsSourceForProvider("qq")).toBe("qq");
  });

  it("has no lyrics for the metadata-only providers", () => {
    // Spotify and Apple Music never serve audio, so a track never plays
    // from them and there is nothing for their lyrics to pair with.
    expect(lyricsSourceForProvider("spotify")).toBeNull();
    expect(lyricsSourceForProvider("apple")).toBeNull();
  });

  it("has no lyrics for a track with no provider", () => {
    expect(lyricsSourceForProvider(undefined)).toBeNull();
  });
});

describe("orderedSourcesForProvider", () => {
  it("puts the provider's own source first", () => {
    const order = orderedSourcesForProvider("netease");
    expect(order[0]).toBe("netease");
  });

  it("keeps the provider's own source ahead of the text-matching ones", () => {
    // The whole point: a NetEase track's words come from NetEase, not
    // from whichever fuzzy text search happened to answer first.
    const order = orderedSourcesForProvider("netease");
    const own = order.indexOf("netease");
    for (const s of ["lrclib", "musixmatch", "genius"] as const) {
      expect(order.indexOf(s)).toBeGreaterThan(own);
    }
  });

  it("still lists every source exactly once", () => {
    for (const provider of [
      "youtube",
      "netease",
      "migu",
      "kugou",
      "qq",
    ] as const) {
      const order = orderedSourcesForProvider(provider);
      expect(new Set(order).size).toBe(order.length);
      expect(order.sort()).toEqual([...SOURCE_ORDER].sort());
    }
  });

  it("leaves the order alone for a provider with no lyrics", () => {
    expect(orderedSourcesForProvider("spotify")).toEqual(SOURCE_ORDER);
    expect(orderedSourcesForProvider(undefined)).toEqual(SOURCE_ORDER);
  });
});
