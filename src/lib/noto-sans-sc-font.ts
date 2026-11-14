import { createFontDownload } from "@/lib/downloadable-font";

/**
 * Noto Sans SC (Simplified Chinese), downloaded on demand.
 *
 * The third typeface the app offers, alongside the system stack and
 * PingFang SC. Like PingFang it is fetched from jsDelivr the first
 * time the user picks it and then kept in IndexedDB.
 *
 * Two faces are enough for it, unlike PingFang's six:
 *
 *   - **Light 300** answers for everything that is not bold.
 *   - **Semibold 600** answers for everything that is.
 *
 * The faces are registered with weight *ranges* rather than single
 * weights, so "not bold" (300–599) and "bold" (600–900) each get one
 * face without the stylesheet having to rewrite the `font-weight` of
 * every element. The app asks for 400, 500, 600 and 700 in normal
 * places, so without the ranges the browser would have to synthesise
 * a bolder face out of the light one — and synthesised bold on a CJK
 * typeface is noticeably worse than a real one.
 */

/** Where the family is fetched from. The version is pinned so a
 * published change cannot silently alter the typeface. */
export const NOTO_SANS_SC_CDN_BASE =
  "https://cdn.jsdelivr.net/npm/@openfonts/noto-sans-sc_chinese-simplified@1.44.10/files/";

/**
 * The family name the faces are registered under.
 *
 * Deliberately not "Noto Sans SC": the OS may already ship a font
 * under that name (Linux does), and a `FontFace` sharing it with the
 * system font is a coin toss over which one the browser picks. A name
 * of our own has no competition, so the downloaded family always wins.
 */
export const NOTO_SANS_SC_FAMILY = "Adrify Noto Sans SC";

/**
 * The two faces of the family.
 *
 * `weight` is a range, which is what lets one face stand in for a
 * whole band of weights:
 *
 *   - "300 599" — Light. Covers 300 (light), 400 (normal), 500
 *     (medium): everything the app renders as "not bold".
 *   - "600 900" — Semibold. Covers 600 (semibold) and 700 (bold):
 *     everything the app renders as bold.
 */
export const NOTO_SANS_SC_FACES = [
  { weight: "300 599", file: "noto-sans-sc-chinese-simplified-300.woff2" },
  { weight: "600 900", file: "noto-sans-sc-chinese-simplified-600.woff2" },
] as const;

/**
 * The published size of each file.
 *
 * Only used for the size shown in the download prompt; the actual
 * bytes are whatever the server sends.
 */
const NOTO_SANS_SC_FILE_SIZES: Record<string, number> = {
  "noto-sans-sc-chinese-simplified-300.woff2": 1_112_552,
  "noto-sans-sc-chinese-simplified-600.woff2": 1_162_352,
};

const download = createFontDownload({
  family: NOTO_SANS_SC_FAMILY,
  cdnBase: NOTO_SANS_SC_CDN_BASE,
  faces: NOTO_SANS_SC_FACES,
  fileSizes: NOTO_SANS_SC_FILE_SIZES,
  dbName: "adrify-fonts-noto-sans-sc",
});

/** How big the whole family is, in bytes — for the download prompt. */
export const NOTO_SANS_SC_TOTAL_BYTES = download.totalBytes;

/** The state of the on-demand install: the progress readout. */
export const useNotoSansScStore = download.useStore;

export const isNotoSansScInstalled = download.isInstalled;
export const activateNotoSansSc = download.activate;
export const deactivateNotoSansSc = download.deactivate;
export const installNotoSansSc = download.install;
export const uninstallNotoSansSc = download.uninstall;
export const initNotoSansSc = download.init;
