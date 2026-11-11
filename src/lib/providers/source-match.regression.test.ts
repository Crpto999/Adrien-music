import { describe, expect, it } from "vitest";
import { canonicalFromQueueTrack } from "@/lib/providers/queue";
import {
  scoreCandidate,
  decideConfidence,
  scoreMatch,
  compareKeys,
  CREDIT_EXACT,
  TITLE_EXACT_CREDIT,
} from "@/lib/providers/match";
import { NETEASE_SEARCH_LIMIT } from "@/lib/providers/adapters/netease";
import type { QueueTrack } from "@/lib/store/playback";

/**
 * Regression tests for the two faults that left a song the platform
 * clearly has with no NetEase option in the source switcher.
 *
 * Both were measured against the live API rather than reasoned about;
 * the numbers in the comments are what the measurements returned.
 */

/**
 * The single release of "Best Part" is titled on YouTube Music
 *
 *   "Best Part (feat. Daniel Caesar, Lauren Jauregui)"
 *
 * and on NetEase the same recording is filed under the *album* credit
 *
 *   "Best Part (feat. H.E.R.)"   [Daniel Caesar, H.E.R.]   210 s
 *
 * The single-release record itself (id 3230978) is not in NetEase's
 * search page for that title at all — the platform files it under the
 * album credit, and a search for the single-release title returns only
 * covers.
 *
 * So the match has to survive the credit difference, and it did not:
 * the matcher's title-coverage gate needs 75% of the original's words,
 * and "daniel", "caesar", "lauren" and "jauregui" are all missing from
 * the candidate's title — coverage 0.33.
 */
describe("a feat-credit difference between platforms", () => {
  const ytTitle = "Best Part (feat. Daniel Caesar, Lauren Jauregui)";

  const track: QueueTrack = {
    videoId: "zNhtz0Lygik",
    title: ytTitle,
    artists: [{ id: undefined, name: "Daniel Caesar" }],
    thumbnails: [],
    duration: 210,
  };

  it("keeps the featured credit in the canonical title", () => {
    // The credit is *evidence*: it is what separates the two releases
    // of "We Don't Talk Anymore" — the one whose title carries
    // "(feat. Selena Gomez)" and the plain one — and the credit tier
    // is a whole level of the matcher's cascade.
    //
    // Dropping it at the source made that tier inert: the source
    // never named a performer, so every candidate looked equally
    // (un)credited, and the plain release won by default. Measured
    // against NetEase: with the credit dropped the app picked
    // `401249910` ("We Don't Talk Anymore"); with it kept, the app
    // picks `2166151146` ("We Don't Talk Anymore (feat. Selena
    // Gomez)") — the record the user confirmed by hand.
    const canonical = canonicalFromQueueTrack(track);
    expect(canonical.title).toBe("Best Part (feat. Daniel Caesar, Lauren Jauregui)");
  });

  it("picks the credited release over the plain one", () => {
    // Two NetEase records for the same song, the same length and the
    // same performers — the only difference is the credit in the
    // title:
    //
    //   2166151146  "We Don't Talk Anymore (feat. Selena Gomez)"  217.706s
    //   401249910   "We Don't Talk Anymore"                      217.756s
    //
    // The credit is the only thing that separates them, so the source
    // has to keep its own credit for the tier to do any work.
    const credited = canonicalFromQueueTrack({
      videoId: "x",
      title: "We Don't Talk Anymore (feat. Selena Gomez)",
      artists: [{ id: undefined, name: "Charlie Puth" }],
      thumbnails: [],
      duration: 218,
    });
    expect(credited.title).toContain("(feat. Selena Gomez)");

    const candidates: Parameters<typeof scoreCandidate>[0][] = [
      {
        title: "We Don't Talk Anymore",
        artists: ["Charlie Puth", "Selena Gomez"],
        duration: 217.756,
        rank: 0,
      },
      {
        title: "We Don't Talk Anymore (feat. Selena Gomez)",
        artists: ["Charlie Puth", "Selena Gomez"],
        duration: 217.706,
        rank: 5,
      },
    ];

    // The credited release wins, even though the platform ranks the
    // plain one higher.
    const scored = candidates.map((c) => scoreCandidate(c, credited));
    const best = scored.sort((a, b) => compareKeys(b.key, a.key))[0];
    expect(best.components.credit).toBe(CREDIT_EXACT);
    expect(best.components.title).toBe(TITLE_EXACT_CREDIT);
  });

  it("matches the album-credit record NetEase actually has", () => {
    const canonical = canonicalFromQueueTrack(track);
    const score = scoreMatch(
      {
        title: "Best Part (feat. H.E.R.)",
        artists: ["Daniel Caesar", "H.E.R."],
        duration: 210,
      },
      {
        title: canonical.title,
        artists: canonical.artists,
        duration: canonical.duration,
      },
    );
    expect(score).not.toBeNull();
  });

  it("finds the record even from the raw title, thanks to the credit split", () => {
    // The old canonical title was the raw one, and the old matcher
    // rejected the candidate outright — the coverage gate needed 75%
    // of the original's words, and "daniel", "caesar", "lauren" and
    // "jauregui" were all missing from the candidate.
    //
    // The new matcher splits the featuring credit out of the title
    // before comparing, so the *performer* lists are compared on
    // their own: "Daniel Caesar" against "Daniel Caesar, H.E.R.",
    // which the artist measure reads as the same performer carrying an
    // extra credit rather than as a disagreement.
    const source = {
      title: ytTitle,
      artists: ["Daniel Caesar"],
      duration: 210,
    };
    const candidate = {
      title: "Best Part (feat. H.E.R.)",
      artists: ["Daniel Caesar", "H.E.R."],
      duration: 210,
    };

    const raw = scoreCandidate(candidate, source);
    expect(decideConfidence(raw, null)).toBe("high");

    // And the canonical title — which now *keeps* the credit — scores
    // the same way.
    const canonical = canonicalFromQueueTrack(track);
    const fromCanonical = scoreCandidate(candidate, {
      title: canonical.title,
      artists: canonical.artists,
      duration: 210,
    });
    expect(decideConfidence(fromCanonical, null)).toBe("high");
  });
});

/**
 * NetEase's search is a relevance ranking, not a lookup. For a popular
 * song the page fills with covers and remixes, and the authoritative
 * recording sits much further down.
 *
 * Measured against the live API on a 100-row page:
 *
 *   晴天 / 周杰伦              -> rank 65
 *   草蜢 - 嗲噢! / 草蜢        -> rank 67
 *
 * The adapter used to ask for 20 rows, so those records were cut off
 * before the matcher ever saw them, and the song got no NetEase option
 * even though the platform had it.
 */
describe("the NetEase search page depth", () => {
  it("asks for a full page rather than the first twenty rows", () => {
    expect(NETEASE_SEARCH_LIMIT).toBe(100);
  });
});
