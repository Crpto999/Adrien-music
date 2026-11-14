import { describe, expect, it } from "vitest";
import { knownYouTubeVideoId } from "./youtube-id";
import type { LikeStatusTrack } from "./youtube-id";

/**
 * The heart asks YouTube about a track by its YouTube video id, so
 * every track — whatever platform it came from — has to be translated
 * into one before the question can be asked.
 *
 * The translation has three answers, in order of how exact they are:
 *
 *   1. the track's own YouTube id (a YouTube row);
 *   2. the correspondence registry, which remembers a pairing the app
 *      established for certain (a daily pick, a platform switch);
 *   3. a catalogue search — a guess, and so the last resort.
 *
 * Only the first two are settled without a request, which is what this
 * test pins: the *known* answer must be exact, and the registry must
 * win over a blind guess.
 */

/** A YouTube row: no provider, its own id in `videoId`. */
const youtubeRow = {
  id: "dQw4w9WgXcQ",
  videoId: "dQw4w9WgXcQ",
  title: "A Song",
  artists: [{ name: "An Artist" }],
} as unknown as LikeStatusTrack;

/** A NetEase row: a synthetic id, and its own song id. */
const neteaseRow = {
  id: "netease_186016",
  videoId: "netease_186016",
  title: "另一首歌",
  artists: [{ name: "另一个歌手" }],
  provider: "netease",
  providerTrackId: "186016",
} as unknown as LikeStatusTrack;

/** A NetEase pick that the app redirected to YouTube. */
const redirectedPick = {
  id: "dQw4w9WgXcQ",
  videoId: "dQw4w9WgXcQ",
  title: "A Song",
  artists: [{ name: "An Artist" }],
  provider: "youtube",
  providerTrackId: "dQw4w9WgXcQ",
  discoveredOn: "netease",
  discoveredTrackId: "186016",
} as unknown as LikeStatusTrack;

describe("knownYouTubeVideoId", () => {
  it("answers a YouTube row with its own id", () => {
    expect(knownYouTubeVideoId(youtubeRow)).toBe("dQw4w9WgXcQ");
  });

  it("answers a redirected pick with the YouTube id it plays from", () => {
    expect(knownYouTubeVideoId(redirectedPick)).toBe("dQw4w9WgXcQ");
  });

  it("does not mistake a NetEase song id for a YouTube id", () => {
    // The synthetic `netease_<id>` id is not a YouTube id, so there is
    // no answer yet — the caller has to look one up.
    expect(knownYouTubeVideoId(neteaseRow)).toBeNull();
  });

  it("has no answer for a missing track", () => {
    expect(knownYouTubeVideoId(undefined)).toBeNull();
  });
});
