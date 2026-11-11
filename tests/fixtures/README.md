# Test fixtures

Data for the tests — not code, and not part of the app.

They live outside `src/` on purpose. Two reasons:

- **`src/` is the production tree.** It should hold the app and nothing
  else. A fixture that only a test reads has no business in the bundle's
  source directory.
- **A JSON import under `src/` is compiled.** `tsc` pulls it into the
  program and infers a literal type from it. For a 337 KB file that is
  real work for no benefit — moving these out took the typecheck from
  ~5.7 s to ~5.0 s and dropped the JSON lines in the program from 15 438
  to 0.

The test reads them with `fs` rather than importing them, so nothing in
the production bundle can reach them even by accident.

## `ground-truth.json`

22 tracks from the user's own YouTube Music playlist, each paired with
the NetEase record that holds the same recording. The ids were confirmed
by hand, after the assistant flagged the six it disagreed with — the
reasons are in `docs/YouTube歌曲匹配算法.md` §14.4.

A 23rd track, "Nana", is present but has `neteaseId: null` and
`uncatalogued: true`: NetEase does not carry it at all, so it is
excluded from the denominator.

## `ground-truth-search.json`

The *actual* NetEase eapi search responses for the queries the app
sends, captured during the validation run and trimmed to the fields the
matcher reads (`id`, `title`, `artists`, `album`, `duration`,
`aliases`). Keyed by the query string.

This is what makes the ground truth **offline**: the test replays the
whole set against the platform's real answer, in milliseconds, with no
network and no flakiness.

## Why a snapshot and not a live call

The test asserts *which id* the matcher picks, not a score. A score
threshold would let a regression hide behind a re-tuning; the id is the
thing the user cares about — it is the record that will actually play.

Replaying against a captured answer is what makes that assertion
trustworthy. The snapshot locks the **algorithm's** behaviour, not
NetEase's live ranking, which shifts on its own.

## Refreshing the snapshot

The snapshot goes stale on its own — NetEase re-orders results and its
catalogue changes. When a case stops matching, first decide whether the
algorithm regressed or the snapshot drifted.

To re-capture, call the eapi search endpoint (`/api/search/get`, see
`docs/YouTube歌曲匹配算法.md` §11) for each query in
`ground-truth.json` and rewrite the rows, keeping the same field set.
`src/lib/providers/live-netease.test.ts` already contains the eapi
encryption and the request shape to copy.
