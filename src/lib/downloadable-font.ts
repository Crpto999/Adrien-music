import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { create } from "zustand";
import { createStore, del, get, set } from "idb-keyval";

import { proxyOptions } from "@/lib/proxy";

/**
 * The machinery behind a downloadable type family.
 *
 * The app ships with the system typeface plus two downloaded ones
 * (PingFang SC and Noto Sans SC). Neither of those is bundled — a
 * complete Chinese family is tens of megabytes, and most installs
 * never look at it. So the family is fetched from jsDelivr the first
 * time the user picks it, and the bytes are kept in IndexedDB from
 * then on.
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

/** How the install is going. */
export type FontStatus = "missing" | "downloading" | "ready" | "error";

/** The progress readout the settings row shows. */
export type FontDownloadState = {
  /** Whether the family is on disk and active. */
  status: FontStatus;
  /** How many files of the family are downloaded so far. */
  loaded: number;
  /** How many files the family has in total. */
  total: number;
  /** Bytes fetched so far. */
  bytes: number;
  /** The last failure, if any. */
  error: string | null;
  setState: (patch: Partial<Omit<FontDownloadState, "setState">>) => void;
};

/**
 * One face of a family.
 */
export interface FontFaceSpec {
  /**
   * The weights the face answers for.
   *
   * A range — "300 599" — makes the face answer for every weight
   * inside it. That is how a family that publishes only a light and a
   * semibold face can still cover "not bold" and "bold" without the
   * stylesheet having to rewrite every `font-weight` it uses.
   */
  weight: string;
  /** The file name inside the CDN directory. */
  file: string;
}

/** Everything that distinguishes one downloadable family from another. */
export interface DownloadableFont {
  /**
   * The family name the faces are registered under.
   *
   * Deliberately not the face's own published name: a system may
   * already ship a font under that name, and a `FontFace` sharing it
   * with the system font is a coin toss over which one the browser
   * picks. A name of our own has no competition, so the downloaded
   * family always wins.
   */
  family: string;
  /** Where the files live. */
  cdnBase: string;
  /** One entry per face. */
  faces: readonly FontFaceSpec[];
  /** The published size of each file, for the download prompt. */
  fileSizes: Record<string, number>;
  /**
   * The IndexedDB database the files live in.
   *
   * One database per family, not one database with a store per family:
   * `idb-keyval`'s `createStore` only creates its object store during
   * the database's *first* upgrade, so two families sharing a
   * database would each break the other — whichever opened the
   * database first would lock the other one out of its store.
   */
  dbName: string;
}

/**
 * A generous ceiling for one file: a slow proxy should not abort it.
 */
const DOWNLOAD_TIMEOUT_MS = 300_000;

/** Where the font bytes live. A database of its own, like the cover
 * cache: `idb-keyval` opens one object store per database. */
const stores = new Map<string, ReturnType<typeof createStore>>();

/**
 * The store for one family's files.
 *
 * One database *per family*, not one database with a store per family:
 * `idb-keyval`'s `createStore` only creates its object store during the
 * database's *first* upgrade, so two families sharing a database would
 * each break the other — whichever opened the database first would
 * lock the other one out of its store.
 */
function filesStore(dbName: string) {
  if (typeof window === "undefined") return undefined;
  let store = stores.get(dbName);
  if (!store) {
    store = createStore(dbName, "files");
    stores.set(dbName, store);
  }
  return store;
}

/** The key the manifest is stored under, alongside the font files. */
const MANIFEST_KEY = "__manifest__";

type Manifest = {
  files: string[];
  installedAt: number;
};

/**
 * Everything a downloadable family needs, in one place.
 *
 * The returned `useStore` is a zustand hook the settings row reads
 * for the progress readout; the rest is the install machinery.
 */
export function createFontDownload(font: DownloadableFont) {
  const store = filesStore(font.dbName);

  /** The total size of the family, for the download prompt. */
  const totalBytes = font.faces.reduce(
    (sum, f) => sum + (font.fileSizes[f.file] ?? 0),
    0,
  );

  /**
   * The state of the on-demand font install.
   *
   * Not persisted: the bytes themselves live in IndexedDB, and this is
   * only the progress readout the settings row shows.
   */
  const useStore = create<FontDownloadState>()((set) => ({
    status: "missing",
    loaded: 0,
    total: font.faces.length,
    bytes: 0,
    error: null,
    setState: (patch) => set(patch),
  }));

  /** The faces currently registered with the document. */
  let activeFaces: FontFace[] = [];

  /** Whether every file of the family is already on disk. */
  async function isInstalled(): Promise<boolean> {
    if (!store) return false;
    try {
      const manifest = await get<Manifest>(MANIFEST_KEY, store);
      if (!manifest) return false;
      const have = new Set(manifest.files);
      return font.faces.every((f) => have.has(f.file));
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
  async function activate(): Promise<boolean> {
    if (!store || typeof document === "undefined") return false;

    // A second call replaces the first one's faces rather than adding
    // duplicates.
    deactivate();

    const faces: FontFace[] = [];
    try {
      for (const f of font.faces) {
        const buffer = await get<ArrayBuffer>(f.file, store);
        if (!buffer) {
          for (const face of faces) document.fonts.delete(face);
          return false;
        }
        const face = new FontFace(font.family, buffer, {
          weight: f.weight,
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
      for (const face of faces) document.fonts.delete(face);
      return false;
    }

    activeFaces = faces;
    return true;
  }

  /** Remove the family from the document. */
  function deactivate(): void {
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
  async function install(): Promise<boolean> {
    if (!store) throw new Error("no storage");

    if (useStore.getState().status === "downloading") return false;

    // Already on disk — the user may be clicking "download" in a window
    // that has not noticed the install yet. Activating is enough.
    if (await isInstalled()) {
      const activated = await activate();
      useStore.getState().setState({
        status: activated ? "ready" : "error",
        error: activated ? null : "the stored files could not be loaded",
      });
      return activated;
    }

    useStore.getState().setState({
      status: "downloading",
      loaded: 0,
      bytes: 0,
      error: null,
    });

    try {
      for (const f of font.faces) {
        const buffer = await downloadFile(f.file);
        await set(f.file, buffer, store);
        const state = useStore.getState();
        state.setState({
          loaded: state.loaded + 1,
          bytes: state.bytes + buffer.byteLength,
        });
      }

      await set(
        MANIFEST_KEY,
        {
          files: font.faces.map((f) => f.file),
          installedAt: Date.now(),
        } satisfies Manifest,
        store,
      );

      const activated = await activate();
      useStore.getState().setState({
        status: activated ? "ready" : "missing",
        error: activated ? null : "the downloaded files could not be loaded",
      });
      return activated;
    } catch (e) {
      useStore.getState().setState({
        status: "error",
        error: String(e),
      });
      throw e;
    }
  }

  /**
   * Delete the family from disk and from the document.
   *
   * The user is told how big the family is before they download it;
   * this is how they get that space back.
   */
  async function uninstall(): Promise<void> {
    deactivate();
    if (store) {
      try {
        for (const f of font.faces) await del(f.file, store);
        await del(MANIFEST_KEY, store);
      } catch {
        /* best-effort */
      }
    }
    useStore.getState().setState({
      status: "missing",
      loaded: 0,
      bytes: 0,
      error: null,
    });
  }

  /**
   * Load the family if it is already installed.
   *
   * Called once at startup, so switching to the family later is
   * instant rather than a round trip to IndexedDB at the moment of
   * the click.
   */
  async function init(): Promise<void> {
    if (!store) return;
    if (!(await isInstalled())) return;
    const activated = await activate();
    useStore.getState().setState({
      status: activated ? "ready" : "missing",
    });
  }

  /** Fetch one file of the family. */
  async function downloadFile(file: string): Promise<ArrayBuffer> {
    const res = await tauriFetch(`${font.cdnBase}${file}`, {
      method: "GET",
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      ...proxyOptions(),
    });
    if (!res.ok) {
      throw new Error(`${file}: HTTP ${res.status}`);
    }
    return res.arrayBuffer();
  }

  return {
    useStore,
    totalBytes,
    isInstalled,
    activate,
    deactivate,
    install,
    uninstall,
    init,
  };
}

/** The shape `createFontDownload` returns. */
export type FontDownload = ReturnType<typeof createFontDownload>;
