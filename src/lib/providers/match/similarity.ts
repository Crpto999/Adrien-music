/**
 * The agreement measures for cross-provider matching.
 *
 * Each measure answers a *different question*, and each answers it
 * with a **tier** rather than a continuous similarity, because the
 * evidence is discrete: the title either carries the featuring credit
 * or it does not; the album either matches the upload's album or it
 * does not; the length either matches within a second or it does not.
 *
 * The tiers are compared *lexicographically*, in the cascade order
 * (`docs/YouTube歌曲匹配算法.md` §6), not summed. That is the central difference
 * from the old weighted-sum design, and the reason a weighted sum let
 * the platform's own ranking cancel out the featuring-credit
 * evidence.
 *
 * The questions, in the order they are asked:
 *
 *   - **Title** — is this the same song? The most reliable signal.
 *   - **Credit** — the same *release*? "We Don't Talk Anymore (feat.
 *     Selena Gomez)" and "We Don't Talk Anymore" are the same song but
 *     different releases; the credit says which one.
 *   - **Artist** — the same performer? Third, because the platforms
 *     file the same act under different names in different scripts
 *     ("Yoko Takahashi" / "高橋洋子"), so it is reliable but not
 *     infallible.
 *   - **Version** — the same *cut*? "Beaté (Piano)" is a different cut,
 *     but the platform's only recording of a song is sometimes that
 *     cut, so this is a tie-breaker, never a veto.
 *   - **Duration** — the same recording? The exact length separates
 *     two releases that the rounded playlist label does not.
 *   - **Album** — which release? The YouTube album comes from the same
 *     distributor metadata as the title, so it identifies the release.
 */

import {
  decompose,
  normalizeText,
  titleVariants,
  type NormalizedSong,
  type TitleForm,
} from "@/lib/providers/match/normalize";

/**
 * Jaro-Winkler similarity.
 *
 * The doc suggests `rapidfuzz.fuzz.WRatio` or
 * `jellyfish.jaro_winkler_similarity`. Neither is available here —
 * the app ships no string-similarity dependency — so this is the
 * standard algorithm, implemented directly. It is a handful of
 * comparisons over short strings, so the cost is irrelevant next to
 * the network round trip it decides.
 *
 * The prefix bonus is capped at 4 characters, as Winkler's original
 * paper prescribes: the bonus rewards a shared *beginning*, and
 * letting it run further would make two titles that merely start
 * alike look similar however much they diverge afterwards.
 */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;

  const jaro = jaroSimilarity(a, b);
  if (jaro === 0) return 0;

  // The shared prefix, up to four characters.
  let prefix = 0;
  const maxPrefix = Math.min(4, a.length, b.length);
  while (prefix < maxPrefix && a[prefix] === b[prefix]) prefix++;

  // Winkler's scaling factor.
  const P = 0.1;
  return jaro + prefix * P * (1 - jaro);
}

/**
 * The Jaro similarity itself.
 *
 * Named differently from the exported function so the two do not
 * shadow each other.
 */
function jaroSimilarity(a: string, b: string): number {
  const matchWindow = Math.max(
    0,
    Math.floor(Math.max(a.length, b.length) / 2) - 1,
  );

  const aMatched = new Array<boolean>(a.length).fill(false);
  const bMatched = new Array<boolean>(b.length).fill(false);

  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const start = Math.max(0, i - matchWindow);
    const end = Math.min(i + matchWindow + 1, b.length);
    for (let j = start; j < end; j++) {
      if (bMatched[j]) continue;
      if (a[i] !== b[j]) continue;
      aMatched[i] = true;
      bMatched[j] = true;
      matches++;
      break;
    }
  }

  // Nothing matched: not similar at all.
  if (matches === 0) return 0;

  // The transpositions: count the positions where the matched
  // characters of one string appear in the other, out of order.
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aMatched[i]) continue;
    while (!bMatched[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  const halfTranspositions = transpositions / 2;

  return (
    (matches / a.length +
      matches / b.length +
      (matches - halfTranspositions) / matches) /
    3
  );
}

// --------------------------------------------------------------------------
// The title
// --------------------------------------------------------------------------

/**
 * The tiers of title agreement.
 *
 * A title that carries a featuring credit is a *stronger* match than
 * one that does not, because the credit is evidence, not noise. (The
 * old design had this backwards: it *discounted* a candidate for
 * carrying the credit.)
 *
 * The tier is about the *song*; the credit tier is about the
 * *release*. So a candidate whose title carries the same credit as
 * the source's outranks one that merely shares the core, while a
 * candidate that shares the core but carries a different credit still
 * scores a title match — the credit tier is what tells the two apart.
 */
export const TITLE_EXACT_CREDIT = 5.0;
export const TITLE_EXACT = 4.0;
export const TITLE_FUZZY_STRONG = 2.0;
export const TITLE_NONE = 0.0;

/**
 * The tier of one pair of title forms, or `null` if they are not
 * comparable (their cores differ).
 */
function pairTier(a: TitleForm, b: TitleForm): number | null {
  if (!a.core || !b.core) return null;
  if (a.core !== b.core) return null;

  // The same title *with the same credit* is the strongest evidence
  // there is: both sides name the same release.
  if (
    a.feats.length > 0 &&
    b.feats.length > 0 &&
    sameSet(a.feats, b.feats)
  ) {
    return TITLE_EXACT_CREDIT;
  }
  // The same song. The cores agree; whether the *credits* agree is
  // the credit tier's question.
  return TITLE_EXACT;
}

/**
 * The best title tier between the source and a candidate.
 *
 * Every legitimate form of both sides is tried, and so is each of the
 * candidate's *aliases* — NetEase files a song under an alias that may
 * be the name it is known by on the platform the user came from
 * ("Zankoku na Tenshi no Thesis" for "残酷な天使のテｰゼ").
 */
export function titleAgreement(
  src: NormalizedSong,
  cand: NormalizedSong,
  candAliases: string[] = [],
): number {
  const srcForms = src.forms.length > 0 ? src.forms : [fallbackForm(src)];
  const candForms = cand.forms.length > 0 ? cand.forms : [fallbackForm(cand)];

  let best = TITLE_NONE;

  for (const sv of srcForms) {
    if (!sv.core) continue;
    for (const cv of candForms) {
      if (!cv.core) continue;
      const tier = pairTier(sv, cv);
      if (tier !== null && tier > best) best = tier;
    }
  }
  if (best >= TITLE_EXACT) return best;

  for (const alias of candAliases) {
    if (!alias) continue;
    for (const sv of srcForms) {
      if (!sv.core) continue;
      const tier = pairTier(sv, aliasForm(alias));
      if (tier !== null && tier > best) best = tier;
    }
  }
  if (best >= TITLE_EXACT) return best;

  // Nothing matched exactly. Fall back to the fuzzy comparison.
  let fuzzy = 0;
  for (const sv of srcForms) {
    if (!sv.core) continue;
    for (const cv of candForms) {
      if (!cv.core) continue;
      const value =
        jaroWinkler(sv.core, cv.core) * containmentFactor(sv.core, cv.core);
      if (value > fuzzy) fuzzy = value;
    }
  }
  for (const alias of candAliases) {
    if (!alias) continue;
    for (const sv of srcForms) {
      if (!sv.core) continue;
      const value = jaroWinkler(sv.core, alias);
      if (value > fuzzy) fuzzy = value;
    }
  }

  return fuzzy >= 0.92 ? TITLE_FUZZY_STRONG : TITLE_NONE;
}

/** A song with no forms of its own, reduced to a single one. */
function fallbackForm(song: NormalizedSong): TitleForm {
  return { core: song.coreTitle, feats: song.featArtists };
}

/**
 * An alias, as a form.
 *
 * An alias is a plain string — the platform's other name for the
 * recording — so it has no credit of its own.
 */
function aliasForm(alias: string): TitleForm {
  const parts = decompose(alias);
  return { core: parts.core, feats: parts.feats };
}

/**
 * How much a title that is wholly inside the other is discounted.
 *
 * Jaro-Winkler is generous with a short title that happens to be a
 * prefix of a longer one: "告白" against "告白气球" scores 0.888,
 * because the four-character window around the match lines up. That
 * is the wrong answer — "告白" is not a song called "告白气球", and
 * accepting it would let a *different song* into the user's library.
 *
 * The floor keeps a contained title from scoring zero: a title that
 * is genuinely the same song with a different credit ("Best Part"
 * inside "Best Part (feat. H.E.R.)") should still count for
 * something.
 */
function containmentFactor(srcTitle: string, candTitle: string): number {
  if (!srcTitle || !candTitle || srcTitle === candTitle) return 1;
  const shorter = srcTitle.length <= candTitle.length ? srcTitle : candTitle;
  const longer = srcTitle.length <= candTitle.length ? candTitle : srcTitle;
  if (!longer.includes(shorter)) return 1;

  const coverage = shorter.length / longer.length;
  if (longer.startsWith(shorter)) return 0.55 + 0.45 * coverage;
  return 0.7 + 0.3 * coverage;
}

// --------------------------------------------------------------------------
// The credit
// --------------------------------------------------------------------------

/** The two sides name the same featured performers. */
export const CREDIT_EXACT = 4.0;
/** The two sides name featured performers, and the lists overlap. */
export const CREDIT_PARTIAL = 3.0;
/** Neither side names a featured performer. */
export const CREDIT_NEITHER = 3.0;
/**
 * Only the candidate names a featured performer.
 *
 * Equal to {@link CREDIT_NEITHER} on purpose: when the *source* does
 * not name one, the credit cannot discriminate between the
 * candidates, and the artist and the length have to decide. Scoring
 * it lower would rank the less specific candidate above the more
 * specific one, which is backwards.
 */
export const CREDIT_CAND_ONLY = 3.0;
/** Only the source names a featured performer. */
export const CREDIT_SOURCE_ONLY = 1.0;

/**
 * How well the featuring credits agree.
 *
 * A source that names a featured performer ("We Don't Talk Anymore
 * (feat. Selena Gomez)") is looking for the release that *carries*
 * that credit; one that does not is looking for the plain release.
 *
 * ## The credit is evidence, not noise
 *
 * The credit tier answers "is this the same *release*?", and it is
 * compared *before* the artist and the length — so a candidate that
 * carries the right credit must not be outranked by one that carries
 * no credit at all.
 *
 * That was not true before, and it cost a real match. The tier was
 * `CREDIT_CAND_ONLY` (2.0) when only the candidate named a
 * performer, against `CREDIT_NEITHER` (3.0) when neither did — so a
 * candidate *with* the credit scored *below* one without it. A source
 * whose own credit could not be read (the Chinese platforms' "合作音乐人:"
 * marker) lost its credit entirely, and the correct candidate — which
 * carries "(feat. Nicki Minaj)" — was ranked below every same-titled
 * cover, and the track matched nothing at all.
 *
 * So: a candidate that names a performer is *more* specific than one
 * that names none, and that is what the tier has to say.
 */
export function creditAgreement(
  srcFeats: string[],
  candFeats: string[],
): number {
  const srcHas = srcFeats.length > 0;
  const candHas = candFeats.length > 0;
  if (!srcHas && !candHas) return CREDIT_NEITHER;
  if (srcHas && candHas) {
    if (sameSet(srcFeats, candFeats)) return CREDIT_EXACT;
    const overlap = srcFeats.filter((f) => candFeats.includes(f)).length;
    return overlap > 0 ? CREDIT_PARTIAL : 0.5;
  }
  // Only the candidate names a performer: it is the *more specific*
  // release. It cannot be worse than a candidate that names nobody.
  if (candHas) return CREDIT_CAND_ONLY;
  return CREDIT_SOURCE_ONLY;
}

// --------------------------------------------------------------------------
// The artist
// --------------------------------------------------------------------------

/**
 * The script a name is written in.
 *
 * The cross-script case is the reason the artist measure has to report
 * whether it could *verify* anything: NetEase files the same act under
 * a different writing system, and its artist objects carry no alias to
 * bridge the two.
 */
export type Script = "cjk" | "latin" | "mixed" | "other";

/** The code ranges that count as CJK-ish. */
const CJK_RANGES: Array<[number, number]> = [
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xf900, 0xfaff],
  [0x3040, 0x30ff], // kana
  [0xac00, 0xd7af], // hangul
];

/** The dominant script of a name. */
export function scriptOf(name: string): Script {
  if (!name) return "other";
  let cjk = 0;
  let latin = 0;
  for (const ch of name) {
    const code = ch.codePointAt(0) ?? 0;
    if (!/\p{L}/u.test(ch)) continue;
    if (CJK_RANGES.some(([lo, hi]) => code >= lo && code <= hi)) cjk++;
    else if (code < 0x0250) latin++;
  }
  if (cjk && latin) return "mixed";
  if (cjk) return "cjk";
  if (latin) return "latin";
  return "other";
}

/**
 * The artist agreement.
 *
 * Returns the tier and whether the comparison could be *verified* at
 * all. `verified` is false when the parties could not be compared —
 * the cross-script case, where the names are in different writing
 * systems and the platform carries no alias to bridge them.
 */
export function artistAgreement(
  srcArtists: string[],
  candArtists: string[],
): { score: number; verified: boolean } {
  if (srcArtists.length === 0 || candArtists.length === 0) {
    return { score: 0, verified: false };
  }

  // A placeholder artist says nothing: it cannot veto, but it cannot
  // confirm either.
  if (srcArtists.some((a) => a === "various artists" || a === "群星" || a === "未知艺术家")) {
    return { score: 0.6, verified: false };
  }

  const srcSet = new Set(srcArtists);
  const candSet = new Set(candArtists);

  // A candidate that names *every* artist of the source, plus the
  // orchestra and the conductor, is the same recording described more
  // fully. The extra names are session musicians, not a contradiction.
  if ([...srcSet].every((a) => candSet.has(a))) {
    return { score: 1, verified: true };
  }

  const intersection = [...srcSet].filter((a) => candSet.has(a)).length;
  if (intersection > 0) {
    const unionSize = Math.max(srcSet.size, candSet.size);
    return { score: intersection / unionSize, verified: true };
  }

  // No exact overlap. Try containment: "刘伟德" inside "victor 刘伟德"
  // is the same person with a Western given name attached.
  let best = 0;
  for (const s of srcSet) {
    for (const c of candSet) {
      if (!c.includes(s) && !s.includes(c)) continue;
      const shorter = c.length <= s.length ? c : s;
      const longer = c.length <= s.length ? s : c;
      best = Math.max(best, containmentScore(shorter.length / longer.length));
    }
  }
  if (best > 0) return { score: Math.min(best, 0.9), verified: true };

  // No overlap at all. If the two are in different scripts the
  // mismatch is *unverifiable*, not proven — the same performer is
  // routinely credited in two writing systems.
  const srcScripts = new Set(srcArtists.map(scriptOf));
  const candScripts = new Set(candArtists.map(scriptOf));
  if (
    (srcScripts.has("cjk") && candScripts.has("latin")) ||
    (srcScripts.has("latin") && candScripts.has("cjk"))
  ) {
    return { score: 0.6, verified: false };
  }

  return { score: 0, verified: true };
}

/**
 * How much a contained name is trusted.
 *
 * A short contained name ("keshi" inside "keshiy") is ambiguous; a
 * long one ("刘伟德" inside "victor 刘伟德") is not.
 */
function containmentScore(coverage: number): number {
  if (coverage >= 0.5) return 0.55 + 0.45 * coverage;
  return 0.5 * coverage;
}

// --------------------------------------------------------------------------
// The duration
// --------------------------------------------------------------------------

/**
 * The duration tiers.
 *
 * The tiers are tight, because the exact length is what separates two
 * releases of the same song: "Soft Spot" at 204.2 s and "Soft Spot
 * (Acoustic)" at 208.0 s are 3.8 s apart, and the rounded playlist
 * label (205) is not enough to tell them apart.
 */
export const DURATION_EXACT = 5.0;
export const DURATION_CLOSE = 4.0;
export const DURATION_NEAR = 3.0;
export const DURATION_FAR = 2.0;
export const DURATION_FARTHER = 1.0;
export const DURATION_NONE = 0.0;

/**
 * The length agreement.
 *
 * An unknown length on either side scores zero: there is no evidence
 * either way, and a candidate with no length cannot be said to have
 * the same recording.
 */
export function durationAgreement(
  srcSeconds: number | undefined,
  candSeconds: number | undefined,
): number {
  if (!srcSeconds || srcSeconds <= 0 || !candSeconds || candSeconds <= 0) {
    return DURATION_NONE;
  }
  const diff = Math.abs(srcSeconds - candSeconds);
  if (diff <= 1.5) return DURATION_EXACT;
  if (diff <= 3) return DURATION_CLOSE;
  if (diff <= 6) return DURATION_NEAR;
  if (diff <= 10) return DURATION_FAR;
  if (diff <= 20) return DURATION_FARTHER;
  return DURATION_NONE;
}

// --------------------------------------------------------------------------
// The album
// --------------------------------------------------------------------------

export const ALBUM_EXACT = 5.0;
export const ALBUM_CONTAINED = 4.0;
export const ALBUM_CLOSE = 3.0;
export const ALBUM_FAIR = 2.0;
export const ALBUM_DIFFERENT = 1.0;

/**
 * The album agreement.
 *
 * The album identifies the *release*: the YouTube album comes from the
 * same distributor metadata as the title, so when a song exists on
 * several platform albums, the album says which release the upload
 * is.
 *
 * The album field sometimes carries a romanisation of the title rather
 * than an album name — the platform files "残酷な天使のテｰゼ" with the
 * alias "Zankoku na Tenshi no Thesis", and the YouTube album field
 * carries that same romanisation. So the source's album is also
 * compared against the candidate's *aliases*.
 *
 * Only the aliases are used for that fallback, never the candidate's
 * own title: the title is compared against the source's *title*, and
 * matching the album against it would let every self-titled single
 * score as a perfect album match.
 *
 * ## The edition qualifier
 *
 * "Blacc Hollywood" and "Blacc Hollywood (Deluxe)" are the same album
 * with more tracks, and the recording on the two is the same file. The
 * platforms list them as separate records with the same length to the
 * millisecond, so the album tier cannot tell them apart — and it must
 * not try to, because a deluxe edition is not a different
 * *recording*. The qualifier is removed when the album is normalised
 * ({@link albumBase}), so by the time it reaches here both sides
 * carry the album's bare name.
 */
export function albumAgreement(
  srcAlbum: string | null | undefined,
  candAlbum: string | null | undefined,
  candAliases: string[] = [],
): number {
  if (!srcAlbum || !candAlbum) return ALBUM_DIFFERENT;

  if (srcAlbum === candAlbum) return ALBUM_EXACT;
  if (srcAlbum.includes(candAlbum) || candAlbum.includes(srcAlbum)) {
    return ALBUM_CONTAINED;
  }

  const direct = jaroWinkler(srcAlbum, candAlbum);
  if (direct >= 0.85) return ALBUM_EXACT;
  if (direct >= 0.7) return ALBUM_CLOSE;
  if (direct >= 0.5) return ALBUM_FAIR;

  for (const alias of candAliases) {
    if (alias && srcAlbum === alias) return ALBUM_EXACT;
  }
  return ALBUM_DIFFERENT;
}

// --------------------------------------------------------------------------
// The version
// --------------------------------------------------------------------------

/** The two sides name the same cut. */
export const VERSION_MATCH = 1.0;
/** The candidate announces a cut the source does not. */
export const VERSION_MISMATCH = 0.85;
/** The source names a cut the candidate does not. */
export const VERSION_MISSING = 0.95;

/**
 * How well the *cut* agrees.
 *
 * A candidate that announces a cut the source does not is demoted, but
 * never eliminated: "Beaté (Piano)" is the platform's *only* recording
 * of "Beaté", and "Got It (PHONK)" is the only one whose length
 * matches.
 */
export function versionAgreement(
  srcVersions: string[],
  candVersions: string[],
): number {
  const extra = candVersions.filter((v) => !srcVersions.includes(v));
  const missing = srcVersions.filter((v) => !candVersions.includes(v));
  if (extra.length > 0) return VERSION_MISMATCH;
  if (missing.length > 0) return VERSION_MISSING;
  return VERSION_MATCH;
}

// --------------------------------------------------------------------------
// The platform's own ranking
// --------------------------------------------------------------------------

/**
 * The platform's own ranking, as a signal.
 *
 * Rank 0 → 1.0, decaying to 0 by the end of the page. The decay is
 * hyperbolic rather than linear, because the difference between rank 0
 * and rank 3 matters far more than between rank 60 and rank 63.
 *
 * Measured: the authoritative recording is at rank 0 in 14 of the 18
 * ground-truth cases where it is on the page at all, and the median
 * rank is 0. So the platform's ordering is a strong prior — but it is
 * the *last* tie-breaker, not a prior that can outvote the title.
 */
export function rankScore(bestRank: number): number {
  if (bestRank < 0) return 0;
  return 1 / (1 + bestRank / 5);
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

/** Whether two lists hold the same members. */
function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((x) => b.includes(x));
}

/**
 * The candidate's other names, normalised.
 *
 * NetEase files a song under an alias as well as its title, and the
 * alias is often the name the recording is known by *elsewhere* — the
 * name the source side carries. So an alias that matches is strong
 * evidence, and it has to be in the alias pool for the title to match
 * at all.
 */
export function normalizeAliases(aliases: string[] | undefined): string[] {
  const out: string[] = [];
  for (const alias of aliases ?? []) {
    for (const variant of titleVariants(alias)) {
      const n = normalizeText(variant);
      if (n && !out.includes(n)) out.push(n);
    }
  }
  return out;
}
