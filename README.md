<p align="center">
  <img src="assets/branding/adrify-logo.png" alt="adrify" width="96" />
</p>

<h1 align="center">adrify</h1>

<p align="center">
  A fast, responsive YouTube Music desktop client for Windows and Linux.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-GPLv3-blue.svg" alt="License: GPL-3.0" /></a>
</p>

<p align="center">
  <a href="../../releases/latest">
    <img src="https://img.shields.io/badge/%E2%AC%87%20Download-FF0000?style=for-the-badge&logo=youtube&logoColor=white" alt="Download" height="60" />
  </a>
  <a href="https://discord.gg/v7JGAWWWj">
    <img src="https://img.shields.io/badge/Join%20the%20Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Join the adrify Discord" height="60" />
  </a>
</p>

Built as a reaction to the sluggish webview-wrapper experience — adrify talks to YouTube's InnerTube API directly, renders its own UI, and caches aggressively, so navigation and playback feel instant.

![adrify — artist page with the player and synced lyrics](assets/screenshots/artist-page.jpg)

## What this fork adds

This is a fork of [NUber-dev/YTubic](https://github.com/NUber-dev/YTubic), via
[ameenalasady/YTubic](https://github.com/ameenalasady/YTubic). On top of the
original, it adds:

- **No Premium gating** — drops upstream's YouTube Music Premium playback gate; streaming and caching are free for every account (the premium store is kept only for the sidebar's informational tier badge)
- **Linux support** — native build with MPRIS media controls and Secret Service-encrypted cookie storage
- **Discord Rich Presence** — shows what you're listening to on Discord
- **Last.fm integration** — scrobbling, now-playing status, loved-tracks sync, and an account card (needs your own Last.fm API key — see [Last.fm](#lastfm-integration))
- **Playback persistence** — resumes your last track at its saved playhead, and restores scroll position and the last-visited page on launch
- **Persistent track cache** — cached tracks survive restarts, with real titles/artwork and a search box, bounded to a size limit
- **Customizable layout** — resizable sidebar and side panel, home page section reordering, pin/hide playlists from the sidebar
- **Full library sidebar** — automatically lists all your saved/created playlists alongside Liked Songs, not just manually pinned ones
- **Clickable artist/album links** — jump to an artist or album from any card or the player
- **Cover art lightbox** — click any cover to view it full-size
- **Full album release dates** — shows the complete release date when YouTube provides one, not just the year
- **Artist page shuffle** — shuffle an artist's entire catalogue, re-rolled and randomized each time
- **Other quality-of-life fixes** — global lyrics on/off toggle, age-restricted track playback, home page refresh button, and various UI polish and performance improvements

## Features

- **Fast and responsive UI** — instant navigation with prefetch and aggressive caching; no page reloads, no spinners on every click
- **Flexible player layouts** — dock the player at the bottom or as a right-side panel
- **Floating player widget** — pop the player out into a compact always-on-top window
- **Synced lyrics** — line-by-line synced lyrics from multiple providers (LRCLIB, Musixmatch, Genius)
- **Hi-res cover art** — upgrades album covers to high-resolution studio art when available
- **Full library support** — your playlists, likes, albums and artists; search with filters; radio/autoplay queues
- **Desktop integration** — media keys and Now Playing controls (SMTC on Windows, MPRIS on Linux), tray icon, single instance
- **Auto-updates** — the app updates itself from GitHub Releases, and keeps its yt-dlp copy fresh automatically

> **Disclaimer:** adrify is an unofficial client. It is not affiliated with,
> endorsed by, or sponsored by Google or YouTube. "YouTube" and "YouTube Music"
> are trademarks of Google LLC. The app streams audio through
> [yt-dlp](https://github.com/yt-dlp/yt-dlp) and may stop working at any time if
> YouTube changes its internals. Use at your own risk.

## Install

Download the latest installer from the [Releases](../../releases) page and run it.

- **Windows 10/11:** run the `.exe` NSIS installer. Pick the `x64` build, or
  the `arm64` one on a Windows on ARM device.
- **macOS 10.15+ (beta):** open the universal `.dmg`; the same build supports
  Apple Silicon and Intel. Login cookies are encrypted with a Keychain-backed
  key.
- **Linux (beta):** install the `.deb` (Debian/Ubuntu), `.rpm` (Fedora/openSUSE), or
  run the `AppImage` directly. On Arch, install from the
  [AUR](https://aur.archlinux.org/packages/adrify) (`yay -S adrify`).
  Requires WebKitGTK 4.1 + GTK 3, plus the
  GStreamer "good" and "base" plugins (and `gst-libav`) — WebKitGTK decodes
  audio through GStreamer, so without `autoaudiosink` + the WebM/Opus/AAC
  demuxers there is no sound. These are pulled in automatically by the
  `.deb`/`.rpm`/AUR package; for the AppImage install them yourself, e.g. on Arch:
  `sudo pacman -S webkit2gtk-4.1 gst-plugins-base gst-plugins-good gst-libav`.
  Signing in also requires a desktop Secret Service provider
  such as GNOME Keyring or a compatible KWallet setup.
- **Updates:** Windows, macOS and AppImage builds update themselves
  (Settings → General → Automatic Updates). AUR installs update with
  `yay -Syu`; `.deb`/`.rpm` installs re-download the new file from
  [Releases](../../releases) — the in-app updater never touches
  system-owned files.
- On first launch the app downloads its own copy of yt-dlp (~12 MB) into its
  data folder and keeps it updated automatically.
- Signing in is optional: browse and playback work anonymously; sign in to get
  your library, likes, and playlists.

### FAQ

**Windows says "Windows protected your PC" (SmartScreen).**
The installer is not code-signed (certificates are expensive for a free
open-source project). Click "More info" → "Run anyway". The source code is
public — you can audit it or build it yourself.

**My antivirus flags the app / yt-dlp.**
yt-dlp is a widely-used open-source downloader that some AV vendors
false-positive on. The binary is downloaded directly from yt-dlp's official
GitHub releases.

**Will Google ban my account for using this?**
Browsing/search/library requests look identical to the official web app, and
audio streaming is fully anonymous (never tied to your account). There are no
known cases of accounts being banned for third-party players — but no
guarantees; see the disclaimer above.

**Playback suddenly stopped working.**
YouTube periodically changes its streaming internals. yt-dlp usually ships a
fix within days, and the app picks it up automatically (it self-updates its
yt-dlp copy every ~3 days). Restarting the app forces the check.

## Last.fm integration

Scrobbling, now-playing status and loved-tracks sync are **off by default**
and need your own Last.fm API key — the app ships none. Nothing is baked
into the build; the key and secret live only in your local app storage.

To set it up:

1. Create a Last.fm API account at
   [last.fm/api/account/create](https://www.last.fm/api/account/create).
   The callback URL can be anything — the desktop app never uses it.
2. Copy the **API key** and **shared secret** from the account page.
3. In the app: Settings → Integrations → Last.fm, paste both, and press
   Connect. Your browser opens to authorize; the app picks the session up
   within a couple of seconds.

Two switches then become available:

- **Scrobble tracks** — reports what you play to your Last.fm profile. A
  track counts once you have listened to half its length (or four minutes,
  whichever comes first); anything under 30 seconds never counts.
- **Sync loved tracks** — liking a track here also marks it as loved on
  Last.fm, and unliking un-loves it.

Scrobbles that fail because you were offline are queued locally and
retried once the connection is back.

## Stack

- **Shell:** Tauri 2 (Rust backend, system webview — WebView2 on Windows)
- **Frontend:** React 19 + TypeScript
- **Build:** Vite 7
- **Styling:** Tailwind CSS v4
- **Components:** shadcn/ui (new-york style, neutral base, YouTube red accent)
- **Routing:** TanStack Router (file-based, type-safe, prefetch on intent)
- **Data:** TanStack Query
- **Client state:** Zustand
- **Icons:** @tabler/icons-react

## Dev

```bash
pnpm install
pnpm tauri dev
```

Frontend-only dev (no Tauri window): `pnpm dev`.

## Quality checks

```bash
pnpm test         # vitest unit tests (pure parsers/matchers)
pnpm lint         # eslint
pnpm format       # prettier --write
pnpm build        # tsc + vite production build
```

CI (`.github/workflows/ci.yml`) runs typecheck, lint, tests, build and
`cargo check` on every push / PR.

## Releasing

The release workflow (`.github/workflows/release.yml`) builds Windows
(x64 and ARM64), a universal macOS app and Linux packages on every
`v*` tag, then publishes a **draft** release you review and publish by hand.

```bash
# Bump the version first — it lives in three places and they must agree:
#   package.json, src-tauri/Cargo.toml, src-tauri/tauri.conf.json
git tag v0.13.0 && git push origin v0.13.0
```

Two repository secrets have to be set for the in-app updater to work:

- `TAURI_SIGNING_PRIVATE_KEY` — the minisign private key that signs the
  updater artifacts. The matching public key is baked into
  `src-tauri/tauri.conf.json` under `plugins.updater.pubkey`.
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — the passphrase you chose when
  you ran `tauri signer generate`. `tauri signer generate` always asks
  for a password, so this secret has to exist.

The password is passed to the workflow as a secret rather than hardcoded
because the key is encrypted with it. It still has to be *present* in
the environment even if you chose an empty passphrase: the bundler
decides whether to prompt for a password by whether the variable exists,
and a missing variable makes it wait on stdin forever.

Without the private key the bundles still build, but no `latest.json` is
produced and the app cannot install an update.

The workflow builds the manifest itself, in a single job, rather than
letting each platform leg write it — see
`scripts/build-updater-manifest.py` for why that matters.

After publishing, the workflow re-downloads the release and checks every
signature against the public key in `src-tauri/tauri.conf.json`, the same
way the updater will. A mismatch fails the release instead of reaching
users. The same check runs locally:

```bash
pip install cryptography
python scripts/verify-updater-signature.py <installer> <installer>.sig
python scripts/verify-published-updater.py --tag v0.13.0 --repo owner/name
```

## Project layout

```
src/
├── routes/              # TanStack Router file-based routes
├── components/
│   ├── ui/              # shadcn primitives
│   ├── layout/          # AppShell, sidebar, topbar, player bar, floating player, lyrics
│   └── shared/          # Track list/rows, cards, shelves, context menus
├── lib/
│   ├── innertube/        # Raw InnerTube client + parsers
│   ├── lyrics/          # LRCLIB / Musixmatch / Genius sources + LRC parser
│   ├── store/           # Zustand stores
│   ├── audio-engine.ts  # Playback engine
│   ├── stream.ts        # Stream URL resolver (localhost proxy)
│   └── utils.ts         # cn() and friends
└── hooks/
src-tauri/               # Rust backend (axum stream proxy, cookies, tray)
```

## Credits

- [yt-dlp](https://github.com/yt-dlp/yt-dlp) — audio streaming
- [LRCLIB](https://lrclib.net) — synced lyrics
- Musixmatch and Genius — lyrics sources
- [Tauri](https://tauri.app), [shadcn/ui](https://ui.shadcn.com),
  [TanStack](https://tanstack.com), and the rest of the stack above

## License

[GPL-3.0](LICENSE) — free to use, modify, and redistribute; derivative works
must stay open source under the same license.
