import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildQueries, rankCandidates } from "@/lib/providers/resolve";
import { canonicalFromQueueTrack } from "@/lib/providers/queue";
import type { CanonicalTrack, ProviderCandidate } from "@/lib/providers/types";

/**
 * The ground truth, replayed against the real search results.
 *
 * ## What this is
 *
 * `tests/fixtures/ground-truth.json` holds 22 tracks from the user's
 * own YouTube Music playlist, each paired with the NetEase record that
 * holds the same recording — the ids the user confirmed by hand, after
 * the assistant flagged the six it disagreed with. The reasons for
 * those corrections are in `docs/YouTube歌曲匹配算法.md` §14.4.
 *
 * `tests/fixtures/ground-truth-search.json` holds the *actual* NetEase
 * eapi search responses for the queries the app sends, captured during
 * the validation run and trimmed to the fields the matcher reads. So
 * this test replays the whole ground truth against the platform's real
 * answer, offline and in milliseconds.
 *
 * ## Why the ids are the assertion
 *
 * The test asserts the *picked id*, not a score. A score threshold
 * would let a regression hide behind a re-tuning of the weights; the
 * id is the thing the user cares about — it is the record that will
 * actually play.
 *
 * ## The success rate
 *
 * The measured rate against this ground truth is **100%** (22/22 the
 * catalogued tracks; the one track NetEase does not carry at all is
 * excluded, because no algorithm can match what is not in the
 * catalogue). The target the user set was > 90%.
 */

/**
 * The fixtures live in `tests/fixtures/`, outside `src/`.
 *
 * They are data, not code: a 337 KB snapshot of what NetEase actually
 * returned. Keeping them out of `src/` means the production tree holds
 * nothing but the app, and it keeps `tsc` from parsing them — a JSON
 * import under `src/` is pulled into the program and given an inferred
 * literal type, which for a file this size is real work for no benefit.
 *
 * They are read with `fs` rather than imported, so nothing in the
 * production bundle can reach them even by accident.
 */
const FIXTURES = fileURLToPath(new URL("../../../../tests/fixtures/", import.meta.url));

const groundTruth = JSON.parse(
  readFileSync(`${FIXTURES}ground-truth.json`, "utf8"),
) as { cases: unknown[] };

const searchRows = JSON.parse(
  readFileSync(`${FIXTURES}ground-truth-search.json`, "utf8"),
) as Record<string, unknown[]>;

type GroundTruthCase = {
  youtubeTitle: string;
  youtubeArtists: string[];
  youtubeAlbum: string | null;
  durationSeconds: number;
  durationExact: number;
  neteaseId: string | null;
  alsoAccept?: string[];
  supersededIds?: string[];
  uncatalogued?: boolean;
  note?: string;
};

const cases = groundTruth.cases as GroundTruthCase[];
const rows = searchRows as Record<
  string,
  Array<{
    id: string;
    title: string;
    artists: string[];
    album: string | null;
    duration: number;
    aliases: string[];
  }>
>;
/**
 * The canonical track, exactly as the app builds it.
 *
 * This is `canonicalFromQueueTrack` — the *real* one, not a copy of
 * it. The canonical form is what the matcher scores and what the
 * query is built from, so the ground truth has to go through it: a
 * test that scored the raw title would be measuring something the app
 * never does.
 *
 * It matters. The canonical title keeps the **featuring credit**
 * (the credit is evidence — it is a whole level of the cascade), and
 * the query translates it into the platforms' own spelling
 * ("(feat. X)"), because the Chinese platforms' own marker
 * ("合作音乐人:X") is not something they can match.
 */
function canonicalFor(track: GroundTruthCase): CanonicalTrack {
  return canonicalFromQueueTrack({
    videoId: `gt-${track.youtubeTitle}`,
    title: track.youtubeTitle,
    artists: track.youtubeArtists.map((name) => ({ id: undefined, name })),
    thumbnails: [],
    duration: track.durationSeconds,
    album: track.youtubeAlbum ?? undefined,
  });
}

/**
 * The query the app sends for a track.
 *
 * This is `buildQueries` from the resolver — the *real* one, not a copy
 * of it. The query has to be the one the app actually sends, because
 * the platform's answer depends on it: the title and the *first*
 * artist, in Simplified Chinese, with the title in the spelling the
 * platforms write it in.
 *
 * The old resolver sent the title and *every* artist, and it cost a
 * ground-truth case: "紳士 - Gentleman Victor Lau Princess Ai" returns
 * exactly one result and it is the wrong one, while "紳士 - Gentleman"
 * puts the right recording at rank 0.
 */
function queryFor(track: GroundTruthCase): string {
  return buildQueries(canonicalFor(track))[0];
}

/** The platform's rows, in the shape the resolver takes them in. */
function candidatesFor(query: string): ProviderCandidate[] {
  const rowsForQuery = rows[query] ?? [];
  return rowsForQuery.map((row, index) => ({
    provider: "netease" as const,
    providerTrackId: row.id,
    title: row.title,
    artists: row.artists,
    album: row.album ?? undefined,
    duration: row.duration,
    aliases: row.aliases.length > 0 ? row.aliases : undefined,
    // The platform's own ordering, which the cascade uses as its
    // last tie-breaker.
    rank: index,
  }));
}

describe("the matcher against the confirmed ground truth", () => {
  it("has a fixture for every catalogued case", () => {
    const missing = cases
      .filter((c) => !c.uncatalogued)
      .filter((c) => !rows[queryFor(c)])
      .map((c) => c.youtubeTitle);
    expect(missing).toEqual([]);
  });

  it("picks the confirmed NetEase record for every case", () => {
    const misses: string[] = [];
    let total = 0;
    let success = 0;

    for (const track of cases) {
      // A track the platform does not carry cannot be matched by any
      // algorithm, so it is not counted.
      if (track.uncatalogued || !track.neteaseId) continue;
      total++;

      const query = queryFor(track);
      const candidates = candidatesFor(query);
      const ranked = rankCandidates(candidates, canonicalFor(track));

      const picked = ranked[0]?.candidate.providerTrackId ?? null;
      const accepted = [track.neteaseId, ...(track.alsoAccept ?? [])];
      if (picked !== null && accepted.includes(picked)) {
        success++;
      } else {
        misses.push(
          `${track.youtubeTitle}: got ${picked ?? "nothing"}, want ${accepted.join("/")}`,
        );
      }
    }

    expect(misses).toEqual([]);
    // The rate the user asked for was > 90%; the measured one is 100%.
    expect(success / total).toBe(1);
  });

  it("is not sensitive to the duration being rounded", () => {
    // The playlist's accessibility label rounds to the nearest second,
    // and the app only has that number. The video's own
    // `lengthSeconds` is exact, and the tiers have to absorb the
    // difference — the exact length separates two releases of the same
    // song ("Soft Spot" at 204.2s and "Soft Spot (Acoustic)" at 208.0s).
    const misses: string[] = [];

    for (const track of cases) {
      if (track.uncatalogued || !track.neteaseId) continue;
      const query = queryFor(track);
      const candidates = candidatesFor(query);
      const canonical = canonicalFor(track);
      const ranked = rankCandidates(candidates, {
        ...canonical,
        duration: track.durationExact,
      });
      const picked = ranked[0]?.candidate.providerTrackId ?? null;
      const accepted = [track.neteaseId, ...(track.alsoAccept ?? [])];
      if (picked === null || !accepted.includes(picked)) {
        misses.push(`${track.youtubeTitle}: got ${picked ?? "nothing"}`);
      }
    }

    expect(misses).toEqual([]);
  });

  it("does not pick the same track when the album is withheld", () => {
    // Some uploads carry no album at all. The album identifies the
    // *release*, so without it the matcher has to fall back on the
    // title, the length and the rank — and the answer may differ. This
    // is not a failure, it is the measurement of what the album is
    // worth: the test pins the behaviour down so it cannot change
    // silently.
    const withoutAlbum = cases.filter((c) => !c.uncatalogued && c.neteaseId);
    const misses: string[] = [];

    for (const track of withoutAlbum) {
      const query = queryFor(track);
      const candidates = candidatesFor(query);
      const canonical = canonicalFor(track);
      const ranked = rankCandidates(candidates, {
        ...canonical,
        album: undefined,
      });
      const picked = ranked[0]?.candidate.providerTrackId ?? null;
      const accepted = [track.neteaseId, ...(track.alsoAccept ?? [])];
      if (picked === null || !accepted.includes(picked)) {
        misses.push(`${track.youtubeTitle}: got ${picked ?? "nothing"}`);
      }
    }

    // The album is worth a great deal, but not everything: the title,
    // the credit and the length carry most of the load on their own.
    expect(misses.length).toBeLessThanOrEqual(2);
  });

  it("picks the original album track, not a compilation", () => {
    // "Ayo" is the case that measures what the album tier is worth.
    //
    // The upload says the album is "Fan of A Fan The Album (Expanded
    // Edition)" and its own length is 225s. NetEase carries the
    // recording on the original album (30512923, 225.28s), on a
    // compilation (31526544, 226.52s) and as the single (29809963,
    // 226.25s). The compilation and the single are both further from
    // the upload's exact length, and neither is on the album the
    // upload names.
    //
    // The user originally accepted the compilation or the single; this
    // is the case where the matcher found the better answer, and the
    // ground truth was updated to it. See the note in
    // `tests/fixtures/ground-truth.json`.
    const track = cases.find((c) => c.youtubeTitle === "Ayo");
    expect(track).toBeDefined();
    expect(track!.neteaseId).toBe("30512923");
    expect(track!.supersededIds).toContain("31526544");

    const ranked = rankCandidates(candidatesFor(queryFor(track!)), {
      ...canonicalFor(track!),
      duration: track!.durationExact,
    });
    expect(ranked[0]?.candidate.providerTrackId).toBe("30512923");
  });
});
