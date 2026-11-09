# Linux graphics: flickering menus and artwork previews

## WebKitGTK 2.54 compositor workaround

adrify selects WebKitGTK's **TextureMapper compositor** on Linux when the loaded
WebKitGTK version is **2.54.x**, unless `WEBKIT_USE_SKIA_FOR_COMPOSITION` is already
set in the environment. This happens at startup, before Tauri creates any
webviews, so the main window and subsequent player/login windows inherit the
same choice. Windows, macOS, and other WebKitGTK release series are unchanged.

WebKitGTK 2.54 switched to Skia composition by default ([release highlights](https://webkitgtk.org/2026/09/16/webkitgtk-2.54-highlights.html)).
On a tested AMD/Mesa + Wayland system running WebKitGTK 2.54.1, the new compositor
briefly exposed underlying page content at the boundaries of menu and artwork
preview animations. Visual A/B testing confirmed that TextureMapper eliminated
flicker when both opening and closing these surfaces. This identifies the
compositor path as the practical workaround, not a specific upstream defect.

Disabling the DMA-BUF renderer was also tested: it removed the opening flicker,
but closing still flickered and performance deteriorated substantially. That
setting is **not** applied by adrify. The selected workaround does not disable
DMA-BUF or GPU acceleration, change image sources/quality, or alter animations,
blur, reduced-motion preferences, modal focus handling, or drag behavior.

This is a version-scoped compatibility workaround, not a claim that every
2.54 system is affected. Reevaluate it against upstream fixes; newer release
series deliberately retain their own default compositor.

## Override / compare

To test WebKitGTK's Skia compositor on an affected version:

```sh
WEBKIT_USE_SKIA_FOR_COMPOSITION=1 pnpm tauri:dev
```

To explicitly select TextureMapper:

```sh
WEBKIT_USE_SKIA_FOR_COMPOSITION=0 pnpm tauri:dev
```

For an installed build, use the same environment variable before its executable
instead of `pnpm tauri:dev`. Quit the running instance before comparing: opening
a second instance only focuses the first and does not change its renderer.
Any explicitly present value is respected; unset the variable to use adrify's
version-scoped default. The fallback logs a `[linux-graphics]` message at startup.

For troubleshooting, remove `WEBKIT_DISABLE_DMABUF_RENDERER` or
`WEBKIT_DISABLE_COMPOSITING_MODE` from the launch environment if they were added
during testing. adrify never sets or removes these user-provided variables.
