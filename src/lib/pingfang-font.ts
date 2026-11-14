import { createFontDownload } from "@/lib/downloadable-font";

/**
 * PingFang SC, downloaded on demand.
 *
 * The app ships with the system typeface plus two downloaded ones (this
 * and Noto Sans SC). Neither is bundled — the full family is roughly
 * 37 MB, and most installs never look at it. So it is fetched from
 * jsDelivr the first time the user picks it, and the bytes are kept in
 * IndexedDB from then on.
 *
 * The download machinery lives in `lib/downloadable-font.ts`; this
 * module only says *what* the family is.
 */

/** Where the family is fetched from. The version is pinned so a
 * published change cannot silently alter the typeface. */
export const PINGFANG_CDN_BASE =
  "https://cdn.jsdelivr.net/npm/font-pingfang-sc@1.0.5/";

/**
 * The family name the faces are registered under.
 *
 * Deliberately not "PingFang SC": macOS ships a system face under that
 * name, and a `FontFace` sharing it with the system font is a coin
 * toss over which one the browser picks. A name of our own has no
 * competition, so the downloaded family always wins.
 */
export const PINGFANG_FAMILY = "Adrify PingFang SC";

/**
 * The family, one file per weight.
 *
 * The package publishes static faces rather than a variable font, so
 * each weight is its own download. The UI only ever asks for 400, 500
 * and 600 — but the rest are cheap to carry and a user-defined
 * stylesheet may ask for any of them, so the whole family is kept.
 */
export const PINGFANG_WEIGHTS = [
  { weight: "100", file: "PingFangSC-Ultralight.woff2" },
  { weight: "200", file: "PingFangSC-Thin.woff2" },
  { weight: "300", file: "PingFangSC-Light.woff2" },
  { weight: "400", file: "PingFangSC-Regular.woff2" },
  { weight: "500", file: "PingFangSC-Medium.woff2" },
  { weight: "600", file: "PingFangSC-Semibold.woff2" },
] as const;

/**
 * The published size of each file.
 *
 * Only used for the size shown in the download prompt; the actual
 * bytes are whatever the server sends.
 */
const PINGFANG_FILE_SIZES: Record<string, number> = {
  "PingFangSC-Ultralight.woff2": 6_036_452,
  "PingFangSC-Thin.woff2": 6_125_148,
  "PingFangSC-Light.woff2": 6_164_324,
  "PingFangSC-Regular.woff2": 6_218_304,
  "PingFangSC-Medium.woff2": 6_300_592,
  "PingFangSC-Semibold.woff2": 6_089_456,
};

const download = createFontDownload({
  family: PINGFANG_FAMILY,
  cdnBase: PINGFANG_CDN_BASE,
  faces: PINGFANG_WEIGHTS,
  fileSizes: PINGFANG_FILE_SIZES,
  // The database this family has always used. Renaming it would make
  // every existing install download the whole family again.
  dbName: "adrify-fonts",
});

/** How big the whole family is, in bytes — for the download prompt. */
export const PINGFANG_TOTAL_BYTES = download.totalBytes;

/** The state of the on-demand install: the progress readout. */
export const usePingfangStore = download.useStore;

export const isPingfangInstalled = download.isInstalled;
export const activatePingfang = download.activate;
export const deactivatePingfang = download.deactivate;
export const installPingfang = download.install;
export const uninstallPingfang = download.uninstall;
export const initPingfang = download.init;
