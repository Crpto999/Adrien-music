import { describe, expect, it } from "vitest";
import {
  scoreCandidate,
  decideConfidence,
  artistsAgree,
} from "@/lib/providers/match";

/**
 * The NetEase like sync's threshold.
 *
 * The bar a candidate has to clear before the heart is written to the
 * user's NetEase library. Lighting the heart on the wrong song in the
 * user's own collection is worse than not mirroring at all, so the bar
 * is the doc's `high` or `medium` stage — the two the doc says to
 * "采用并缓存" (adopt and cache).
 *
 * The `low` stage is deliberately not enough. The doc marks it "采用
 * 但标记需确认" (adopt, but flag for confirmation), and a heart in the
 * user's own library has no way to ask for confirmation.
 */
const qualifies = (
  candidate: { title: string; artists: string[]; duration: number },
  hint: { title: string; artists: string[]; duration: number },
): boolean => {
  const scored = scoreCandidate(candidate, hint);
  const confidence = decideConfidence(scored, null);
  if (confidence !== "high" && confidence !== "medium") return false;
  // The artist has to agree as well: the scorer is lenient about the
  // artist when the lengths match — a cover is a fine substitute for
  // *playback* — but it is not fine for a *library*.
  return artistsAgree(candidate, hint);
};

describe("the NetEase like-sync threshold", () => {
  it("accepts a candidate that agrees on title, artist and length", () => {
    expect(
      qualifies(
        { title: "告白气球", artists: ["周杰伦"], duration: 209 },
        { title: "告白气球", artists: ["周杰伦"], duration: 209 },
      ),
    ).toBe(true);
  });

  it("accepts a traditional-Chinese upload of a simplified record", () => {
    // The whole point of the conversion: a Taiwanese upload must find
    // the mainland catalogue's Simplified record.
    expect(
      qualifies(
        { title: "愛你", artists: ["周杰倫"], duration: 200 },
        { title: "爱你", artists: ["周杰伦"], duration: 200 },
      ),
    ).toBe(true);
  });

  it("rejects a different song entirely", () => {
    expect(
      qualifies(
        { title: "稻香", artists: ["周杰伦"], duration: 223 },
        { title: "七里香", artists: ["周杰伦"], duration: 223 },
      ),
    ).toBe(false);
  });

  it("rejects a cover by another artist", () => {
    // Same words, same running time, different performer. The length
    // alone cannot tell the two apart, so the artist has to.
    expect(
      qualifies(
        { title: "告白气球", artists: ["林俊杰"], duration: 209 },
        { title: "告白气球", artists: ["周杰伦"], duration: 209 },
      ),
    ).toBe(false);
  });

  it("rejects a live cut of the same song", () => {
    expect(
      qualifies(
        { title: "告白气球 (Live)", artists: ["周杰伦"], duration: 240 },
        { title: "告白气球", artists: ["周杰伦"], duration: 209 },
      ),
    ).toBe(false);
  });

  it("rejects a candidate whose title only partly agrees", () => {
    expect(
      qualifies(
        { title: "告白", artists: ["周杰伦"], duration: 209 },
        { title: "告白气球", artists: ["周杰伦"], duration: 209 },
      ),
    ).toBe(false);
  });
});
