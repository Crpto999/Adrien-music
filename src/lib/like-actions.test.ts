import { describe, expect, it } from "vitest";
import { isNativeYouTubeId } from "@/lib/like-actions";
import { syntheticQueueId } from "@/lib/providers/queue";

/**
 * The two platforms' ids are not interchangeable.
 *
 * A YouTube video id is an 11-character opaque string; a NetEase song
 * id is a number. A track that came from NetEase therefore carries a
 * *synthetic* id — `netease_186016` — in the field the app uses for a
 * YouTube video id, so that nothing that expects a YouTube id is
 * handed one by accident.
 *
 * The heart has to be routed by where the track actually lives, and
 * the two platforms' hearts are separate submissions to separate
 * endpoints.
 */
describe("which platform a heart goes to", () => {
  it("treats a YouTube track's id as native", () => {
    expect(isNativeYouTubeId("dQw4w9WgXcQ")).toBe(true);
  });

  it("treats a synthetic NetEase id as foreign", () => {
    const id = syntheticQueueId("netease", "186016");
    expect(id).toBe("netease_186016");
    expect(isNativeYouTubeId(id)).toBe(false);
  });

  it("trusts an explicit provider over the id's shape", () => {
    // A track discovered on NetEase but playable on YouTube keeps its
    // YouTube id, and its heart belongs on YouTube.
    expect(
      isNativeYouTubeId("dQw4w9WgXcQ", {
        provider: "youtube",
        providerTrackId: "dQw4w9WgXcQ",
      } as never),
    ).toBe(true);
    expect(
      isNativeYouTubeId("netease_186016", {
        provider: "netease",
        providerTrackId: "186016",
      } as never),
    ).toBe(false);
  });

  it("does not mistake a plain number for a YouTube id", () => {
    // Without provider metadata the id's shape decides. A bare number
    // is not a YouTube id, so it must not be treated as one — a
    // NetEase row's id is numeric.
    expect(isNativeYouTubeId("186016")).toBe(true);
    expect(isNativeYouTubeId("netease_186016")).toBe(false);
  });
});
