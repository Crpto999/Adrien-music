import { describe, expect, it } from "vitest";
import { rankAvailability } from "@/lib/providers/availability";
import { effectiveOrder } from "@/lib/providers/source-resolution";
import type {
  CanonicalTrack,
  ProviderId,
  ProviderRef,
} from "@/lib/providers/types";

/**
 * The ranking of a track's available sources.
 *
 * This is where the priority setting becomes real: the sources a track
 * exists on are gathered, and the *order* the user set is what decides
 * which of them serves it. The bug this covers was that the order was
 * never consulted at all — every ordinary song played from YouTube
 * whatever the setting said.
 */

/** A track found on YouTube. */
const ytTrack: CanonicalTrack = {
  title: "起风了",
  artists: ["买辣椒也用券"],
  duration: 325,
  origin: "youtube",
  originId: "yt123",
};

/** The matches a cross-provider search came back with. */
function matches(
  entries: Array<[ProviderId, string]>,
): Map<ProviderId, ProviderRef> {
  const out = new Map<ProviderId, ProviderRef>();
  for (const [provider, providerTrackId] of entries) {
    out.set(provider, { provider, providerTrackId });
  }
  return out;
}

describe("ranking the available sources", () => {
  it("puts the sources in the user's priority order", () => {
    const ranked = rankAvailability(
      matches([
        ["youtube", "yt123"],
        ["netease", "185709"],
        ["migu", "600929"],
      ]),
      ytTrack,
      ["netease", "youtube", "migu"],
    );

    expect(ranked.map((r) => r.provider)).toEqual([
      "netease",
      "youtube",
      "migu",
    ]);
  });

  it("uses the origin's own id, not the matched one", () => {
    // The user picked the track on YouTube, so YouTube's own id is the
    // authoritative one — a *match* for YouTube would be a different
    // recording.
    const ranked = rankAvailability(
      matches([["youtube", "some-other-id"]]),
      ytTrack,
      ["youtube", "netease"],
    );

    expect(ranked[0]).toEqual({
      provider: "youtube",
      providerTrackId: "yt123",
    });
  });

  it("does not put the origin first just because it is the origin", () => {
    // The regression this whole change is about: the origin used to
    // win unconditionally, which meant the priority order had no
    // effect on ordinary songs.
    const ranked = rankAvailability(
      matches([
        ["youtube", "yt123"],
        ["netease", "185709"],
      ]),
      ytTrack,
      ["netease", "youtube"],
    );

    expect(ranked[0].provider).toBe("netease");
    expect(ranked[1].provider).toBe("youtube");
  });

  it("leaves out a source that does not have the track", () => {
    const ranked = rankAvailability(
      matches([["youtube", "yt123"]]),
      ytTrack,
      ["netease", "youtube", "migu"],
    );

    expect(ranked.map((r) => r.provider)).toEqual(["youtube"]);
  });

  it("leaves out a source that is not in the chain", () => {
    // A source the user has deprioritised out of the chain entirely
    // is not consulted — the chain *is* the set of sources.
    const ranked = rankAvailability(
      matches([
        ["youtube", "yt123"],
        ["migu", "600929"],
      ]),
      ytTrack,
      ["youtube"],
    );

    expect(ranked.map((r) => r.provider)).toEqual(["youtube"]);
  });

  it("never lists a metadata-only source", () => {
    // Spotify and Apple Music gate their audio behind DRM; they can
    // never serve a stream, so they are not playable sources at all.
    const ranked = rankAvailability(
      matches([["spotify", "sp1"]]),
      ytTrack,
      ["spotify", "youtube"],
    );

    expect(ranked.map((r) => r.provider)).toEqual(["youtube"]);
  });

  it("puts a NetEase pick ahead of the other sources", () => {
    // The daily picks are NetEase records, so NetEase comes first even
    // when the order says otherwise — but only as far as NetEase, and
    // the rest of the order keeps its shape.
    const pick: CanonicalTrack = {
      title: "起风了",
      artists: ["买辣椒也用券"],
      duration: 325,
      origin: "netease",
      originId: "185709",
    };
    const order = effectiveOrder(["youtube", "migu", "netease"], ["netease"]);

    const ranked = rankAvailability(
      matches([
        ["netease", "185709"],
        ["youtube", "yt123"],
        ["migu", "600929"],
      ]),
      pick,
      order,
    );

    expect(ranked.map((r) => r.provider)).toEqual([
      "netease",
      "youtube",
      "migu",
    ]);
  });
});

/**
 * The daily picks prefer NetEase.
 *
 * The picks are NetEase records, so they play from NetEase when NetEase
 * will serve them. The preference moves NetEase to the front of the
 * order without reshuffling the rest of it.
 */
describe("the daily picks' preference", () => {
  it("moves the preferred source to the front", () => {
    expect(
      effectiveOrder(["youtube", "netease", "migu"], ["netease"]),
    ).toEqual(["netease", "youtube", "migu"]);
  });

  it("leaves the order alone when there is no preference", () => {
    const order: ProviderId[] = ["youtube", "netease", "migu"];
    expect(effectiveOrder(order, [])).toEqual(order);
    expect(effectiveOrder(order)).toEqual(order);
  });

  it("does not disturb the order of the other sources", () => {
    // The preference moves *one* source ahead of the others. It does
    // not reverse them.
    expect(
      effectiveOrder(["youtube", "migu", "kugou", "qq"], ["kugou"]),
    ).toEqual(["kugou", "youtube", "migu", "qq"]);
  });

  it("ignores a preferred source that is not in the chain", () => {
    expect(effectiveOrder(["youtube", "migu"], ["netease"])).toEqual([
      "youtube",
      "migu",
    ]);
  });
});
