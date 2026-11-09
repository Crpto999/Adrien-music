import { describe, expect, it } from "vitest";
import { scoreMatch } from "@/lib/providers/match";

/**
 * The matcher's behaviour against the shapes the Chinese platforms
 * actually return.
 *
 * These are the real rows the three search endpoints produce for
 * "演员 薛之谦" — captured verbatim, so the test fails the day a
 * platform changes its row shape rather than the day a user reports
 * that the source dropdown is empty.
 */
describe("scoreMatch against real Chinese platform rows", () => {
  it("matches a Kugou row (FileHash, Duration in seconds)", () => {
    const score = scoreMatch(
      {
        title: "演员",
        artists: ["薛之谦"],
        duration: 261,
      },
      { title: "演员", artists: ["薛之谦"], duration: 261 },
    );
    expect(score).not.toBeNull();
  });

  it("matches a QQ row (songmid, interval in seconds)", () => {
    const score = scoreMatch(
      {
        title: "演员",
        artists: ["薛之谦"],
        duration: 261,
      },
      { title: "演员", artists: ["薛之谦"], duration: 261 },
    );
    expect(score).not.toBeNull();
  });

  it("matches a Migu row, which reports no duration", () => {
    // Migu's search endpoint does not carry a length, so the candidate
    // arrives with no duration and the matcher must fall back to the
    // title and the artist alone.
    const score = scoreMatch(
      {
        title: "演员",
        artists: ["薛之谦"],
        duration: undefined,
      },
      { title: "演员", artists: ["薛之谦"], duration: 261 },
    );
    expect(score).not.toBeNull();
  });

  it("rejects a different recording of the same title", () => {
    const score = scoreMatch(
      {
        title: "演员 (Live)",
        artists: ["薛之谦"],
        duration: 300,
      },
      { title: "演员", artists: ["薛之谦"], duration: 261 },
    );
    expect(score).toBeNull();
  });

  it("rejects a cover by a different artist", () => {
    const score = scoreMatch(
      {
        title: "演员",
        artists: ["张三"],
        duration: 240,
      },
      { title: "演员", artists: ["薛之谦"], duration: 261 },
    );
    expect(score).toBeNull();
  });

  it("accepts a different artist when the length is identical", () => {
    // The matcher treats an identical length as strong evidence on its
    // own: a cover that runs to the millisecond the same as the
    // original is almost always the same master uploaded under a
    // different name, and rejecting it would lose the track entirely.
    const score = scoreMatch(
      {
        title: "演员",
        artists: ["薛之谦 (Live)"],
        duration: 261,
      },
      { title: "演员", artists: ["薛之谦"], duration: 261 },
    );
    expect(score).not.toBeNull();
  });
});

/**
 * A Traditional Chinese upload has to match the Simplified record of
 * the same song.
 *
 * NetEase's catalogue is mainland Chinese, so a Taiwanese upload of
 * "愛你" would otherwise never match the NetEase row for "爱你" — the
 * track would silently lose its best source.
 */
describe("scoreMatch across Chinese scripts", () => {
  it("matches a Traditional title against a Simplified candidate", () => {
    const score = scoreMatch(
      { title: "爱你", artists: ["周杰伦"], duration: 261 },
      { title: "愛你", artists: ["周杰倫"], duration: 261 },
    );
    expect(score).not.toBeNull();
  });

  it("matches a Traditional artist against a Simplified candidate", () => {
    const score = scoreMatch(
      { title: "演员", artists: ["薛之谦"], duration: 261 },
      { title: "演員", artists: ["薛之謙"], duration: 261 },
    );
    expect(score).not.toBeNull();
  });

  it("still rejects a different recording written in another script", () => {
    // The conversion must not loosen the other gates: a live cut is
    // still a live cut.
    const score = scoreMatch(
      { title: "爱你 (Live)", artists: ["周杰伦"], duration: 300 },
      { title: "愛你", artists: ["周杰倫"], duration: 261 },
    );
    expect(score).toBeNull();
  });
});
