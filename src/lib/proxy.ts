import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useProxyStore } from "@/lib/store/proxy";

/**
 * The user's proxy setting, and the plumbing that carries it to every
 * network path.
 *
 * Three paths need the proxy, and each needs a different mechanism:
 *
 *  1. The webview's own requests, which go through
 *     `tauri-plugin-http` (Rust-side `reqwest`). The plugin takes a
 *     `proxy` client option, so [`proxyOptions`] is spread into every
 *     `tauriFetch` call.
 *  2. Our Rust-side clients (media stream server, cover fetch,
 *     session probe) — those read the proxy from the Rust state, which
 *     [`useProxySync`] keeps in sync with this store.
 *  3. The `yt-dlp` child processes — they take a `--proxy` argument,
 *     added on the Rust side.
 *
 * An empty setting disables the proxy everywhere: no `proxy` option is
 * passed to the HTTP plugin, the Rust clients connect directly, and
 * `yt-dlp` gets no `--proxy` flag.
 */

/** Proxy schemes we accept — mirrors `SUPPORTED_SCHEMES` in Rust. */
export const SUPPORTED_PROXY_SCHEMES = [
  "http",
  "https",
  "socks4",
  "socks4a",
  "socks5",
  "socks5h",
] as const;

/**
 * The normalized proxy URL, or `null` when the proxy is disabled.
 *
 * Throws on an unusable value so the settings row can show the problem
 * inline instead of silently connecting directly.
 */
export function normalizeProxyUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // A bare `host:port` is a common way to write an HTTP proxy.
  const candidate = trimmed.includes("://")
    ? trimmed
    : `http://${trimmed}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error("invalid");
  }
  const scheme = url.protocol.replace(/:$/, "").toLowerCase();
  if (!(SUPPORTED_PROXY_SCHEMES as readonly string[]).includes(scheme)) {
    throw new Error("scheme");
  }
  if (!url.hostname) {
    throw new Error("invalid");
  }
  return candidate;
}

/**
 * The `proxy` client option for `tauri-plugin-http`, or `{}` when the
 * proxy is disabled.
 *
 * Spread into every `tauriFetch` call: `...proxyOptions()`.
 */
export function proxyOptions(): { proxy?: { all: string } } {
  const raw = useProxyStore.getState().url;
  try {
    const url = normalizeProxyUrl(raw);
    return url ? { proxy: { all: url } } : {};
  } catch {
    // An invalid URL never reaches the network layer: the settings row
    // rejects it before it can be saved, and the Rust side refuses it
    // too. Fall back to a direct connection rather than throwing inside
    // an unrelated request.
    return {};
  }
}

/**
 * Push the proxy setting into Rust and keep it there.
 *
 * Mounted once in AppShell. Rust needs the value for the paths the
 * webview can't reach — the media stream server's ranged reads from
 * googlevideo, the cover fetch and the `yt-dlp` child processes.
 */
export function useProxySync(): void {
  const url = useProxyStore((s) => s.url);
  useEffect(() => {
    invoke("set_proxy", { url }).catch((e) => {
      // Plain-vite dev without a Tauri backend, or an invalid URL the
      // Rust side rejected. The settings row shows the error; here we
      // only need to know it didn't take.
      console.error("[proxy] set_proxy failed:", e);
    });
  }, [url]);
}
