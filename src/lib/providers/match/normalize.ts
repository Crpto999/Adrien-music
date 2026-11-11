/**
 * Text normalisation for cross-provider matching.
 *
 * ## Why this exists
 *
 * Two platforms file the same recording under different strings. The
 * YouTube upload says "Best Part (feat. Daniel Caesar, Lauren
 * Jauregui) [Official Music Video]", NetEase says "Best Part", and a
 * mainland release says "爱情公寓" where a Taiwanese upload says
 * "愛情公寓". None of those differences are *about* the recording —
 * they are upload furniture, script differences and credit formatting.
 *
 * So both sides are reduced to a canonical form before they are
 * compared: the same folding, the same noise words dropped, the same
 * way of pulling a featuring credit out of a title.
 *
 * The design is specified in `docs/YouTube歌曲匹配算法.md` §4.
 *
 * ## The three things this module does that the naive version does not
 *
 *   - **Traditional → Simplified.** The doc assumes both sides are
 *     already Simplified. They are not: a Taiwanese upload carries
 *     Traditional characters, and NetEase's catalogue is mainland
 *     Simplified. Comparing them raw would treat two characters that
 *     mean the same thing as different words, so the conversion runs
 *     *before* the punctuation is stripped.
 *
 *   - **Version markers are split out, not dropped.** The doc's noise
 *     list includes "live", "remix" and "cover", and its §8 then
 *     compares "候选标题仍含 live/remix 而源没有" — which only makes
 *     sense if those words survived the normalisation. Dropping them
 *     would make "Live While We're Young" into "while were young" and
 *     make a live cut's title *identical* to the original's. So the
 *     version markers are removed from the title and kept alongside
 *     it, and the comparison uses them separately.
 *
 *   - **A title has several legitimate forms.** "残酷な天使のテーゼ -
 *     Zankoku na Tenshi no Thesis" is the same song as "残酷な天使のテーゼ",
 *     and "紳士 - Gentleman" as "紳士". Comparing the whole string only
 *     works if you try *every* form of both sides and take the best
 *     pair — which is what {@link titleVariants} is for.
 *
 * The result is a form where two platforms that mean the same song
 * produce the same string, and two platforms that mean *different*
 * songs do not.
 */

import { toSimplified } from "@/lib/chinese";

/**
 * Words that describe the *upload* rather than the recording.
 *
 * The doc's list, minus the version markers (see
 * {@link VERSION_WORDS}), plus the ones YouTube Music actually puts in
 * titles (measured: a "- Topic" channel suffix, "Official Video",
 * "Lyrics", "Audio") and the ones the Chinese platforms put on their
 * search results ("高音质", "无损", "完整版").
 *
 * These are removed as *whole words*, so "Live" goes but "Living"
 * stays.
 */
const NOISE_WORDS = [
  // The doc's list, less the version markers.
  "remaster",
  "remastered",
  "翻唱",
  "现场",
  "官方版",
  "完整版",
  "原版",
  "伴奏",
  "instrumental",
  "karaoke",
  "纯音乐",
  "official",
  "audio",
  "video",
  "mv",
  "歌词版",
  // YouTube Music's own furniture.
  "topic",
  "visualizer",
  "visualiser",
  "lyrics",
  "lyric",
  "music",
  "hd",
  "hq",
  "4k",
  "explicit",
  "clean",
  "version",
  // The Chinese platforms' prefixes on search results.
  "高音质",
  "超清",
  "无损",
  "官方",
  "高品",
  "超品",
  "臻品",
  "全景声",
  "母带",
  "试听",
  "纯享",
  "消音",
  "demo",
  "dj版",
];

/**
 * Words that mark a *different recording*.
 *
 * These are removed from the title but remembered, because the
 * comparison has to be able to ask "does the candidate announce a
 * version the source does not?" — which is the doc's §8 penalty, and
 * the reason these words must survive normalisation somewhere.
 *
 * A candidate carrying one of these when the source does not is a
 * different cut of the song. The same marker on *both* sides is the
 * same cut — a live cut matched against a live cut is right.
 *
 * ## The Chinese markers
 *
 * The Chinese platforms mark a cut the way the Western ones do, and
 * the marker is often the *only* thing that tells two rows apart:
 * "Gentleman" and "Gentleman (演奏曲)" have the same title core, the
 * same length and the same performers. Without 演奏曲 in this list the
 * two are literally indistinguishable, and the matcher picks the
 * instrumental.
 *
 * So the list carries the Chinese cut markers as well. Measured: adding
 * them moved the ground-truth success rate on that case from wrong to
 * right, with no effect on any other case.
 */
const VERSION_WORDS = [
  "live",
  "remix",
  "cover",
  "翻唱",
  "现场",
  "钢琴",
  "加速",
  "减速",
  "音效",
  "影视",
  "抖音",
  "卡点",
  "sped",
  "slowed",
  "reverb",
  "nightcore",
  "acoustic",
  "8d",
  "mashup",
  "reprise",
  "edit",
  "piano",
  "demo",
  "acapella",
  "vip",
  "extended",
  "phonk",
  "guitar",
  "orchestra",
  "orchestral",
  "symphony",
  "版本",
  "铃声",
  "片头",
  "片尾",
  "广播",
  "dj",
  // The Chinese platforms' cut markers.
  "演奏曲",
  "演奏版",
  "演奏",
  "伴奏版",
  "伴唱",
  "纯伴奏",
  "现场版",
  "剧场版",
  "电视剧版",
  "电影版",
  "游戏版",
  "纯音乐版",
  "音效版",
  "铃声版",
  "钢琴伴奏",
];

/**
 * The vocabulary the Chinese platforms use to annotate a title with
 * the song's *context*.
 *
 * "无名的人 (电影《雄狮少年》主题曲/片尾曲)" — the parenthetical
 * describes where the song comes from, not what it is called, and the
 * platforms are inconsistent about which release carries it. So it has
 * to come off before the titles are compared.
 */
const ANNOTATION_WORDS = [
  "主题曲",
  "片尾曲",
  "插曲",
  "片头曲",
  "推广曲",
  "ost",
  "电视剧",
  "电影",
  "动画",
  "动漫",
  "游戏",
  "综艺",
  "纪录片",
  "宣传曲",
  "原声带",
  "soundtrack",
  "interlude",
  "钢琴版",
];

/**
 * Artist names that are placeholders.
 *
 * They say nothing about who performed the recording, so they can
 * neither confirm nor veto a match — "ツナ覚醒 / Various Artists" is a
 * real soundtrack track whose performer the source simply does not
 * name.
 */
const GENERIC_ARTISTS = [
  "various artists",
  "various",
  "unknown artist",
  "unknown",
  "未知艺术家",
  "群星",
];

/** The noise words, as a set for a fast lookup. */
const NOISE = new Set(NOISE_WORDS);

/** The version markers, as a set for a fast lookup. */
const VERSION = new Set(VERSION_WORDS);

/** The annotation vocabulary, as a set for a fast lookup. */
const ANNOTATION = new Set(ANNOTATION_WORDS);

/** The placeholder artist names, as a set for a fast lookup. */
const GENERIC = new Set(GENERIC_ARTISTS);

/**
 * The credit forms that introduce a featuring artist.
 *
 * `splitFeat` pulls these out of a title and moves them into the
 * artist list, because the platform that filed the recording under
 * the album credit ("Best Part (feat. H.E.R.)") and the platform that
 * filed it under the single credit ("Best Part (feat. Daniel Caesar,
 * Lauren Jauregui)") disagree about the *title* but agree about the
 * *artists*. Moving the credit to the artist side is what makes the
 * two comparable.
 */
const FEAT = /^(?:feat|ft|featuring|prod)\b[.\s]/i;

/**
 * The Chinese platforms' own credit marker.
 *
 * The Chinese catalogues file a collaboration as
 *
 *     True Colors(合作音乐人:Nicki Minaj)
 *
 * — the same construct as "(feat. Nicki Minaj)", written the way the
 * platform writes it. The marker is followed by a colon rather than a
 * dot, so `FEAT` does not recognise it.
 *
 * That is not a cosmetic gap. A source whose credit is *not* read
 * loses its credit entirely, and the credit tier then inverts: the
 * candidate that carries the right credit scores *below* the ones
 * that carry none, and the cascade picks a different recording.
 * Measured: "True Colors(合作音乐人:Nicki Minaj)" picked no NetEase
 * record at all, while the same title with the marker recognised
 * picks 28935275 — the recording the user confirmed.
 *
 * The markers seen in the wild, all followed by a colon:
 *
 *   - 合作音乐人:  "collaborating artist" — the common one
 *   - 合作歌手:    "collaborating singer"
 *   - 合唱:        "chorus with"
 *   - 与...合作:   "in collaboration with" (the name comes *after*)
 */
const FEAT_CN =
  /^(?:合作音乐人|合作歌手|合作|合唱|Featured\s*Artists?|Collaborating\s*Artists?)\s*[:：]/i;

/**
 * The marker that comes *after* the name: "与X合作".
 *
 * The name is before the marker, so the extraction is different — it
 * has to take what comes before the marker rather than what comes
 * after it.
 */
const FEAT_CN_PREFIX = /与([^与与，,、]{1,40}?)合作\s*[:：]?/;

/** A trailing parenthetical, in any of the bracket families. */
const TRAILING_BRACKET = /[(（[【]([^)）\]】]*)[)）\]】]\s*$/;

/**
 * Split a title into its main part and any featured artists.
 *
 * The credit lives in a bracket: "(feat. X)", "[feat. X]", "（feat.
 * X）". The Chinese platforms write the same construct as
 * "(合作音乐人:X)".
 *
 * Every bracket in the title is scanned, not just the first one: a
 * title may carry a context annotation *and* a credit, in either
 * order ("Song (电影主题曲) (feat. X)"), and the credit is the one
 * that has to be found.
 *
 * The trailing " - Topic" form is handled by the caller that strips
 * it, since it is a channel name rather than a credit.
 *
 * Returns the main title and the names from the credit, split on
 * commas and the Chinese separator "、".
 */
export function splitFeat(title: string): {
  coreTitle: string;
  featArtists: string[];
} {
  const text = title ?? "";

  // Scan the brackets for one that carries a credit.
  for (const bracket of bracketBodies(text)) {
    const trimmed = bracket.inner.trim();
    const isLatin = FEAT.test(trimmed);
    const isChinese = FEAT_CN.test(trimmed);
    if (!isLatin && !isChinese) continue;

    // The credit names, minus the marker itself.
    const names = (isChinese
      ? trimmed.replace(FEAT_CN, "")
      : trimmed.replace(/^\s*(?:feat|ft|featuring|prod)\b[.\s]*/i, "")
    )
      .split(/[,，、&]/)
      .map((s) => s.trim())
      .filter(Boolean);

    const coreTitle = (text.slice(0, bracket.open) + text.slice(bracket.close + 1)).trim();
    return {
      coreTitle: coreTitle.length > 0 ? coreTitle : text,
      featArtists: names,
    };
  }

  // The "与X合作" form names the performer *before* the marker, and it
  // is not in a bracket of its own.
  const prefix = FEAT_CN_PREFIX.exec(text);
  if (prefix) {
    const names = prefix[1]
      .split(/[,，、&]/)
      .map((s) => s.trim())
      .filter(Boolean);
    const coreTitle = (
      text.slice(0, prefix.index) + text.slice(prefix.index + prefix[0].length)
    ).trim();
    return {
      coreTitle: coreTitle.length > 0 ? coreTitle : text,
      featArtists: names,
    };
  }

  return { coreTitle: text, featArtists: [] };
}

/**
 * Every bracket group in a title, in order.
 *
 * The scan is a hand-rolled one rather than a regex, because the
 * bracket families nest ("（feat. X）" inside "[...]") and a regex
 * that pairs them by shape gets the nesting wrong.
 */
function bracketBodies(text: string): Array<{
  open: number;
  close: number;
  inner: string;
}> {
  const out: Array<{ open: number; close: number; inner: string }> = [];
  const stack: number[] = [];

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(" || ch === "（" || ch === "[" || ch === "【") {
      stack.push(i);
    } else if (ch === ")" || ch === "）" || ch === "]" || ch === "】") {
      const open = stack.pop();
      if (open === undefined) continue;
      out.push({ open, close: i, inner: text.slice(open + 1, i) });
    }
  }

  return out.sort((a, b) => a.open - b.open);
}

/**
 * The base fold, before the noise and version words are removed.
 *
 * Everything here is about making two spellings of the same thing
 * compare equal: case, fullwidth forms, Traditional characters, and
 * punctuation.
 *
 * The order matters: the Traditional → Simplified conversion runs
 * *before* the punctuation is stripped, because it is defined over the
 * original characters. And NFKC runs before the punctuation is
 * stripped too, because it is what folds the halfwidth katakana
 * prolonged sound mark (U+FF70) that NetEase uses where YouTube uses
 * the fullwidth one (U+30FC).
 */
function fold(text: string): string {
  let t = (text ?? "").toLowerCase();
  t = toSimplified(t);
  // NFKC folds the fullwidth latin letters and digits, and the
  // fullwidth brackets, into their ASCII forms.
  t = t.normalize("NFKC");
  // Anything that is not a letter, a digit or a space becomes a space.
  // The Unicode property classes keep Chinese characters — the doc's
  // "只保留中文、英文、数字、空格".
  t = t.replace(/[^\p{L}\p{N}]+/gu, " ");
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

/**
 * Fold a string into the form the matcher compares.
 *
 * The doc's order: lowercase, fullwidth → halfwidth, Traditional →
 * Simplified, punctuation → spaces, collapse spaces, drop the noise
 * words.
 *
 * The version markers are dropped too — the doc's noise list includes
 * "live", "remix" and "cover" — but they are *remembered* separately
 * (see {@link versionTags}), because the comparison has to be able to
 * ask "does the candidate announce a version the source does not?".
 *
 * The result is a space-separated string of the words that actually
 * name the song.
 */
export function normalizeText(text: string | null | undefined): string {
  if (!text) return "";
  const folded = fold(text);
  if (folded.length === 0) return "";

  const kept = folded
    .split(" ")
    .filter((w) => w.length > 0 && !NOISE.has(w) && !VERSION.has(w))
    .join(" ");

  // A title that was *only* noise ("Official Audio") must not become
  // the empty string — that would compare as "matches everything".
  // The original (noise and all) is the better answer in that case.
  return kept.length > 0 ? kept : folded;
}

/**
 * The version markers a title carries.
 *
 * Returned as the words themselves, so the comparison can be
 * asymmetric: a candidate carrying "live" when the source does not is
 * a different cut, while the *same* marker on both sides is the same
 * cut.
 *
 * The words are matched against the *folded* title rather than the
 * normalised one, because the normalised title has had them removed.
 */
export function versionTags(text: string | null | undefined): string[] {
  const folded = fold(text ?? "");
  if (!folded) return [];
  return folded.split(" ").filter((w) => VERSION.has(w));
}

/**
 * Whether an artist name is a placeholder.
 *
 * "Various Artists" says nothing about who performed the recording,
 * so it can neither confirm nor veto a match.
 */
export function isGenericArtist(name: string): boolean {
  return GENERIC.has(normalizeText(name));
}

/**
 * Strip the parenthetical that describes the song's *context*.
 *
 * "无名的人 (电影《雄狮少年》主题曲/片尾曲)" → "无名的人"
 *
 * These annotations describe the song's provenance, not its name, and
 * the platform is inconsistent about which release carries them — so
 * they have to come off before the titles are compared.
 *
 * A parenthetical is treated as an annotation when it contains one of
 * the annotation words, or when it contains one of the punctuation
 * marks that only a descriptive aside carries.
 */
export function stripAnnotation(title: string): string {
  const text = title ?? "";
  let out = text;
  // A title can carry more than one trailing note ("... (Live) (电影
  // 《…》主题曲)"), so this repeats until it stops making progress.
  for (let i = 0; i < 3; i++) {
    const match = TRAILING_BRACKET.exec(out);
    if (!match) break;
    const inner = match[1];
    const isAnnotation =
      inner
        .split(/[\s,，、&]+/)
        .some((w) => ANNOTATION.has(normalizeText(w))) ||
      /[《》〈〉…·\-—:：/]/.test(inner);
    if (!isAnnotation) break;
    const stripped = out.slice(0, match.index).trim();
    if (!stripped) break;
    out = stripped;
  }
  return out || text;
}

/**
 * Every legitimate form of a title.
 *
 * A title may carry a romanisation ("残酷な天使のテーゼ - Zankoku na
 * Tenshi no Thesis"), a translation ("紳士 - Gentleman"), a featuring
 * credit ("We Don't Talk Anymore (feat. Selena Gomez)") or a context
 * annotation ("无名的人 (电影《雄狮少年》主题曲/片尾曲)"). The *song*
 * is the same in every case, so the matcher compares all of them and
 * takes the best pair.
 *
 * Measured: without this, two of the twenty ground-truth tracks
 * cannot be matched at all.
 */
export function titleVariants(title: string): string[] {
  const raw = title ?? "";
  const variants: string[] = [];

  const add = (text: string): void => {
    const t = (text ?? "").replace(/\s+/g, " ").trim();
    if (t && !variants.includes(t)) variants.push(t);
  };

  add(raw);
  // The credit is split off the *raw* title, and the annotation is
  // stripped off what is left. Doing it in this order matters: the
  // annotation stripper removes any bracket carrying a colon, and the
  // Chinese platforms' credit marker ("合作音乐人:Nicki Minaj") carries
  // one — so stripping first would take the credit with it.
  const { coreTitle } = splitFeat(raw);
  add(coreTitle);
  const stripped = stripAnnotation(coreTitle);
  add(stripped);

  for (const piece of [...variants]) {
    if (piece.includes(" - ")) {
      for (const part of piece.split(" - ")) add(part);
    }
    const match = TRAILING_BRACKET.exec(piece);
    if (match) add(piece.slice(0, match.index).trim());
  }

  return variants.filter((v) => normalizeText(v).length > 0);
}

/**
 * The title as it should be **searched for**.
 *
 * The platforms' own catalogues are written in their own way, and a
 * query has to speak theirs. A Chinese credit marker is the worst
 * offender: NetEase files the recording as
 *
 *     True Colors (feat. Nicki Minaj)
 *
 * and searching for "True Colors(合作音乐人:Nicki Minaj)" returns a
 * page of unrelated songs — measured, the correct record (28935275)
 * is not on it at all, while "True Colors Wiz Khalifa" puts it at
 * rank 0.
 *
 * So the credit is translated into the form the platforms write it
 * in, rather than being dropped: dropping it would lose the
 * distinction between the credited release and the plain one, which
 * the credit tier depends on.
 */
export function searchTitle(title: string): string {
  const raw = title ?? "";
  const { coreTitle, featArtists } = splitFeat(raw);
  const stripped = stripAnnotation(coreTitle).trim();
  if (featArtists.length === 0) return stripped || raw;

  // The names, in the form the platforms write them.
  return `${stripped} (feat. ${featArtists.join(", ")})`;
}

/**
 * A title's core, credit and full comparable form.
 *
 * - `core`: the title with the featuring credit removed.
 * - `credited`: the title with the credit *kept*.
 * - `feats`: the credited performers, parsed out of the title.
 *
 * The credit is read from the **raw** title, before the annotation
 * stripper runs. The stripper removes any bracket that carries a
 * colon, and the Chinese platforms' credit marker
 * ("True Colors(合作音乐人:Nicki Minaj)") carries one — so reading the
 * credit afterwards finds nothing, and the source silently loses the
 * credit it named.
 */
export function decompose(title: string): {
  core: string;
  credited: string;
  feats: string[];
} {
  const raw = title ?? "";
  // The credit first, from the raw title.
  const { coreTitle, featArtists } = splitFeat(raw);
  // Then the annotation off what is left.
  const stripped = stripAnnotation(coreTitle);
  return {
    core: normalizeText(stripped),
    credited: normalizeText(coreTitle),
    feats: unique(featArtists.map((a) => normalizeText(a))),
  };
}

/**
 * One legitimate form of a title, split into its parts.
 *
 * The comparison needs the credit *and* the core separately, and it
 * needs them from the *raw* title — the normalised form has lost the
 * brackets, and with them the knowledge that the title names a
 * featured performer.
 *
 * That knowledge is what separates the two releases of "We Don't Talk
 * Anymore": the one whose title carries "(feat. Selena Gomez)" and
 * the plain one. So the forms are built from the raw title, and each
 * one keeps its own credit.
 */
export type TitleForm = {
  /** The title without the credit, normalised. */
  core: string;
  /** The credited performers, normalised. */
  feats: string[];
};

/**
 * Every legitimate form of a title, split into its core and its
 * credit.
 *
 * A title with a credit yields two forms: the credited one and the
 * bare core. A title without one yields just the core. Both are
 * compared, and the best pair wins — which is how the matcher can say
 * "the same song" (the cores agree) while the credit tier says "the
 * same *release*" (the credits agree).
 */
export function titleForms(title: string): TitleForm[] {
  const forms: TitleForm[] = [];
  const seen = new Set<string>();

  for (const variant of titleVariants(title)) {
    const parts = decompose(variant);
    if (!parts.core) continue;
    const key = `${parts.core}|${[...parts.feats].sort().join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    forms.push({ core: parts.core, feats: parts.feats });
  }

  return forms;
}

/**
 * The normalised form of a whole song.
 *
 * The artist list and the *featured* artists are kept apart, and the
 * reason is a measured one.
 *
 * A YouTube upload files a song as "Best Part (feat. Daniel Caesar,
 * Lauren Jauregui)" by "Daniel Caesar", while the platform that
 * filed the same recording under its album credit says "Best Part
 * (feat. H.E.R.)" by "Daniel Caesar, H.E.R.". The two disagree about
 * the *credit*, and the credit is not the same thing as the *performer
 * list* — but merging the two would make the comparison worse:
 *
 *   - The source's performer list is "Daniel Caesar" — one name.
 *   - The candidate's is "Daniel Caesar, H.E.R." — two names.
 *
 * Comparing those two sets gives a ratio of 0.5, which reads as "the
 * performers half agree". Comparing the *performer* lists alone — the
 * source's one name against the candidate's two, where the source's
 * one is contained in the candidate's — gives 0.85, which is what it
 * is: the same performer, with the candidate carrying an extra
 * credit.
 *
 * So the two lists stay separate, and the *credit* is compared on its
 * own — as part of the title, which is where it lives.
 */
export type NormalizedSong = {
  /** The title, without the featuring credit and without the noise. */
  coreTitle: string;
  /** The title with the featuring credit kept. */
  creditedTitle: string;
  /** The normalised artist names, as the platform credits them. */
  artists: string[];
  /** The normalised names from a featuring credit in the title. */
  featArtists: string[];
  /** Every legitimate form of the title, split into core and credit. */
  forms: TitleForm[];
  /** The normalised album, when there is one. */
  album: string | null;
  /** The length, in seconds. */
  duration?: number;
  /** The version markers the title carried. */
  versions: string[];
};

/**
 * The words that name an *edition* of an album rather than the album
 * itself.
 *
 * "Blacc Hollywood" and "Blacc Hollywood (Deluxe)" are the same album
 * with more tracks on the second one. They do not identify different
 * *recordings* — the recording of "True Colors (feat. Nicki Minaj)"
 * on the deluxe edition is the same file as the one on the standard
 * edition, and the platforms give the two the same length to the
 * millisecond.
 *
 * So the edition qualifier has to come off before the albums are
 * compared. Leaving it on made the tier do the opposite of its job:
 * the upload names "Blacc Hollywood", the deluxe record says
 * "Blacc Hollywood (Deluxe)", the two compared as merely *contained*,
 * and the *standard* edition — which the upload did not name — won
 * the tier and took the match away from the record the user wanted.
 *
 * The edition is not a different recording, so it is not a different
 * album for this purpose; what does identify the recording — the
 * title, the credit, the length — is compared on its own.
 */
const ALBUM_EDITION_WORDS = new Set([
  "deluxe",
  "deluxe edition",
  "deluxe version",
  "expanded edition",
  "expanded version",
  "special edition",
  "anniversary edition",
  "standard edition",
  "standard version",
  "ultimate edition",
  "platinum edition",
  "explicit",
  "explicit edition",
  "bonus tracks",
  "bonus track version",
]);

/**
 * An album name with its edition qualifier removed.
 *
 * The qualifier is a trailing parenthetical ("Blacc Hollywood
 * (Deluxe)") or a trailing dash clause ("Blacc Hollywood - Deluxe
 * Edition"). Only a *known* edition word is removed: an unknown
 * parenthetical is part of the name ("Flower Of Scotland: Timeless
 * Classics from the Land of the Brave" is not an edition of
 * anything).
 *
 * This runs on the **raw** name, before the punctuation is folded
 * away — once "(Deluxe)" has become " deluxe " there is no bracket
 * left to recognise.
 */
export function albumBase(album: string | null | undefined): string {
  const raw = (album ?? "").trim();
  if (!raw) return "";

  let out = raw;
  // A trailing parenthetical or bracket, possibly several of them.
  for (let i = 0; i < 3; i++) {
    const match = /\s*[([]\s*([^()[\]]*?)\s*[)\]]\s*$/.exec(out);
    if (!match) break;
    const inner = match[1].toLowerCase().replace(/\s+/g, " ").trim();
    if (!ALBUM_EDITION_WORDS.has(inner)) break;
    const stripped = out.slice(0, match.index).trim();
    if (!stripped) break;
    out = stripped;
  }

  // A trailing dash clause.
  const dash = /\s+[-–—]\s+([^-–—]+)$/.exec(out);
  if (dash) {
    const inner = dash[1].toLowerCase().replace(/\s+/g, " ").trim();
    if (ALBUM_EDITION_WORDS.has(inner)) {
      const stripped = out.slice(0, dash.index).trim();
      if (stripped) out = stripped;
    }
  }

  return out || raw;
}

/**
 * Normalise a song for comparison.
 *
 * The `featArtists` from the title are kept apart from the platform's
 * own artist list — see the type's comment for why.
 *
 * The album is normalised with its *edition qualifier* removed
 * ({@link albumBase}): a deluxe edition is the same album with more
 * tracks, and the platforms list it as a separate record with the
 * same length, so leaving the qualifier on would let the edition
 * decide which recording wins.
 */
export function normalizeSong(song: {
  title: string;
  artists?: string[];
  album?: string | null;
  duration?: number;
}): NormalizedSong {
  const rawTitle = song.title ?? "";
  const parts = decompose(rawTitle);
  const album = song.album;
  const credited = (song.artists ?? []).map((a) => normalizeText(a));
  const fromTitle = parts.feats;

  return {
    coreTitle: parts.core,
    creditedTitle: parts.credited,
    featArtists: unique(fromTitle),
    forms: titleForms(rawTitle),
    artists: unique(credited),
    album: album ? normalizeText(albumBase(album)) || null : null,
    duration: song.duration,
    versions: versionTags(stripAnnotation(rawTitle)),
  };
}

/**
 * The artist names to compare, given both sides.
 *
 * The platform's own credit wins; the title's credit is the fallback
 * for a row that carries no artist field of its own.
 */
export function artistsOf(song: NormalizedSong): string[] {
  if (song.artists.length > 0) return song.artists;
  return song.featArtists;
}

/**
 * De-duplicate a list, keeping the first occurrence.
 */
function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}
