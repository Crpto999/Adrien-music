import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { create } from "zustand";
import { createStore, del, get, set } from "idb-keyval";

import { proxyOptions } from "@/lib/proxy";

/**
 * PingFang SC, downloaded on demand.
 *
 * The app ships with two interface typefaces: the system stack and
 * PingFang SC. The second one is *not* bundled — the full family is
 * roughly 37 MB, and most installs never look at it. So it is fetched
 * from jsDelivr the first time the user picks it, and the bytes are
 * kept in IndexedDB from then on.
 *
 * Why the full family and not a subset: a subset has to guess which
 * characters matter, and a track title, an artist name or a lyric line
 * will eventually contain one it dropped. The result is a tofu box in
 * the middle of a song title. These files carry the complete Unicode
 * range for the family, so nothing is missing.
 *
 * Why the browser's `FontFace` API and not a `@font-face` rule with a
 * URL: the bytes are already in memory once they are read back from
 * IndexedDB, and handing them to `FontFace` keeps the font out of the
 * CSP's `font-src` entirely — there is no second URL for the webview
 * to be blocked from fetching.
 */

/** Where the family is fetched from. The version is pinned so a
 *  published change cannot silently alter the typeface. */
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
  { weight: 100, file: "PingFangSC-Ultralight.woff2" },
  { weight: 200, file: "PingFangSC-Thin.woff2" },
  { weight: 300, file: "PingFangSC-Light.woff2" },
  { weight: 400, file: "PingFangSC-Regular.woff2" },
  { weight: 500, file: "PingFangSC-Medium.woff2" },
  { weight: 600, file: "PingFangSC-Semibold.woff2" },
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

/** How big the whole family is, in bytes — for the download prompt. */
export const PINGFANG_TOTAL_BYTES = PINGFANG_WEIGHTS.reduce(
  (sum, w) => sum + PINGFANG_FILE_SIZES[w.file],
  0,
);

/** A generous ceiling for one file: a slow proxy should not abort it. */
const DOWNLOAD_TIMEOUT_MS = 300_000;

/** Where the font bytes live. A database of its own, like the cover
 *  cache: `idb-keyval` opens one object store per database. */
const filesStore =
  typeof window !== "undefined" ? createStore("adrify-fonts", "files") : undefined;

/** The key the manifest is stored under, alongside the font files. */
const MANIFEST_KEY = "__manifest__";

type Manifest = {
  files: string[];
  installedAt: number;
};

/** How the font install is going. */
export type PingfangStatus = "missing" | "downloading" | "ready" | "error";

type PingfangState = {
  /** Whether the family is on disk and active. */
  status: PingfangStatus;
  /** How many files of the family are downloaded so far. */
  loaded: number;
  /** How many files the family has in total. */
  total: number;
  /** Bytes fetched so far. */
  bytes: number;
  /** The last failure, if any. */
  error: string | null;
  setState: (patch: Partial<Omit<PingfangState, "setState">>) => void;
};

/**
 * The state of the on-demand font install.
 *
 * Not persisted: the bytes themselves live in IndexedDB, and this is
 * only the progress readout the settings row shows.
 */
export const usePingfangStore = create<PingfangState>()((set) => ({
  status: "missing",
  loaded: 0,
  total: PINGFANG_WEIGHTS.length,
  bytes: 0,
  error: null,
  setState: (patch) => set(patch),
}));

/** The faces currently registered with the document. */
let activeFaces: FontFace[] = [];

/** Whether every file of the family is already on disk. */
export async function isPingfangInstalled(): Promise<boolean> {
  if (!filesStore) return false;
  try {
    const manifest = await get<Manifest>(MANIFEST_KEY, filesStore);
    if (!manifest) return false;
    const have = new Set(manifest.files);
    return PINGFANG_WEIGHTS.every((w) => have.has(w.file));
  } catch {
    return false;
  }
}

/**
 * Register the family with the document.
 *
 * The bytes are read back from IndexedDB and handed to `FontFace`, so
 * the browser never fetches them over the network and the CSP has
 * nothing to allow. Returns false when the family is not on disk.
 */
export async function activatePingfang(): Promise<boolean> {
  if (!filesStore || typeof document === "undefined") return false;

  // A second call replaces the first one's faces rather than adding
  // duplicates.
  deactivatePingfang();

  const faces: FontFace[] = [];
  try {
    for (const w of PINGFANG_WEIGHTS) {
      const buffer = await get<ArrayBuffer>(w.file, filesStore);
      if (!buffer) {
        for (const f of faces) document.fonts.delete(f);
        return false;
      }
      const face = new FontFace(PINGFANG_FAMILY, buffer, {
        weight: String(w.weight),
        style: "normal",
        display: "swap",
      });
      await face.load();
      document.fonts.add(face);
      faces.push(face);
    }
  } catch {
    // A corrupt file: drop whatever was registered and report failure
    // rather than leaving half a family behind.
    for (const f of faces) document.fonts.delete(f);
    return false;
  }

  activeFaces = faces;
  return true;
}

/** Remove the family from the document. */
export function deactivatePingfang(): void {
  if (typeof document === "undefined") return;
  for (const face of activeFaces) {
    try {
      document.fonts.delete(face);
    } catch {
      /* the face was never added */
    }
  }
  activeFaces = [];
}

/**
 * Download the family and activate it.
 *
 * The files are fetched one at a time — the family is large, and
 * fetching them in parallel would only make the connection slower.
 * Each file is stored as soon as it arrives, so an interrupted
 * download does not throw away the parts that did arrive.
 *
 * Returns whether the family ended up installed and active.
 */
export async function installPingfang(): Promise<boolean> {
  if (!filesStore) throw new Error("no storage");

  if (usePingfangStore.getState().status === "downloading") return false;

  // Already on disk — the user may be clicking "download" in a window
  // that has not noticed the install yet. Activating is enough.
  if (await isPingfangInstalled()) {
    const activated = await activatePingfang();
    usePingfangStore.getState().setState({
      status: activated ? "ready" : "error",
      error: activated ? null : "the stored files could not be loaded",
    });
    return activated;
  }

  usePingfangStore.getState().setState({
    status: "downloading",
    loaded: 0,
    bytes: 0,
    error: null,
  });

  try {
    for (const w of PINGFANG_WEIGHTS) {
      const buffer = await downloadFile(w.file);
      await set(w.file, buffer, filesStore);
      const state = usePingfangStore.getState();
      state.setState({
        loaded: state.loaded + 1,
        bytes: state.bytes + buffer.byteLength,
      });
    }

    await set(
      MANIFEST_KEY,
      {
        files: PINGFANG_WEIGHTS.map((w) => w.file),
        installedAt: Date.now(),
      } satisfies Manifest,
      filesStore,
    );

    const activated = await activatePingfang();
    usePingfangStore.getState().setState({
      status: activated ? "ready" : "missing",
      error: activated ? null : "the downloaded files could not be loaded",
    });
    return activated;
  } catch (e) {
    usePingfangStore.getState().setState({
      status: "error",
      error: String(e),
    });
    throw e;
  }
}

/**
 * Delete the family from disk and from the document.
 *
 * The user is told the family takes about 37 MB before they download
 * it; this is how they get that space back.
 */
export async function uninstallPingfang(): Promise<void> {
  deactivatePingfang();
  if (filesStore) {
    try {
      for (const w of PINGFANG_WEIGHTS) await del(w.file, filesStore);
      await del(MANIFEST_KEY, filesStore);
    } catch {
      /* best-effort */
    }
  }
  usePingfangStore.getState().setState({
    status: "missing",
    loaded: 0,
    bytes: 0,
    error: null,
  });
}

/**
 * Load the family if it is already installed.
 *
 * Called once at startup, so switching to PingFang SC later is instant
 * rather than a round trip to IndexedDB at the moment of the click.
 */
export async function initPingfang(): Promise<void> {
  if (!filesStore) return;
  if (!(await isPingfangInstalled())) return;
  const activated = await activatePingfang();
  usePingfangStore.getState().setState({
    status: activated ? "ready" : "missing",
  });
}

/** Fetch one file of the family. */
async function downloadFile(file: string): Promise<ArrayBuffer> {
  const res = await tauriFetch(`${PINGFANG_CDN_BASE}${file}`, {
    method: "GET",
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    ...proxyOptions(),
  });
  if (!res.ok) {
    throw new Error(`${file}: HTTP ${res.status}`);
  }
  return res.arrayBuffer();
}
