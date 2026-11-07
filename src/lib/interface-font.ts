import "@/fonts.css";
import { useSettingsStore, type InterfaceFont } from "@/lib/store/settings";

/**
 * The Interface font setting. The faces ship with the app (fontsource
 * variable builds, weight axis only) so the choice works offline and
 * looks the same on every machine; "System default" is the stack the
 * app always used. The chosen stack is written to `--app-font` on the
 * document root, which `index.css` reads for the whole tree. Imported
 * once from main.tsx, so the main and floating windows both apply it,
 * and the floating window follows changes through the settings store's
 * cross-window rehydrate.
 */

export const SYSTEM_FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Open Sans", "Helvetica Neue", sans-serif';

/**
 * CJK fallbacks appended to every stack.
 *
 * The bundled faces (Inter, Roboto, Google Sans, IBM Plex Sans) carry no
 * CJK glyphs, so without these a Chinese UI renders its Chinese text in
 * whatever the OS picks — which on Windows is a mismatched serif-ish
 * fallback and looks nothing like the rest of the app.
 *
 * The order matters: `Microsoft YaHei` and `PingFang SC` are the UI
 * faces on Windows and macOS respectively, and the Noto / Source Han
 * entries cover Linux. The generic `sans-serif` at the end is the
 * platform's last resort.
 */
const CJK_FALLBACKS = [
  '"Microsoft YaHei"',
  '"PingFang SC"',
  '"Hiragino Sans GB"',
  '"Noto Sans CJK SC"',
  '"Source Han Sans SC"',
  '"Noto Sans SC"',
  '"WenQuanYi Micro Hei"',
  '"Heiti SC"',
  "sans-serif",
].join(", ");

/** A stack with the CJK fallbacks appended. */
function withCjk(stack: string): string {
  return `${stack}, ${CJK_FALLBACKS}`;
}

export const INTERFACE_FONTS: {
  id: InterfaceFont;
  label: string;
  stack: string;
}[] = [
  {
    id: "gsans",
    label: "Google Sans",
    stack: withCjk("'Google Sans Flex Variable', system-ui, sans-serif"),
  },
  {
    id: "inter",
    label: "Inter",
    stack: withCjk("'Inter Variable', system-ui, sans-serif"),
  },
  {
    id: "roboto",
    label: "Roboto",
    stack: withCjk("'Roboto Variable', system-ui, sans-serif"),
  },
  {
    id: "plex",
    label: "IBM Plex Sans",
    stack: withCjk("'IBM Plex Sans Variable', system-ui, sans-serif"),
  },
  { id: "system", label: "System default", stack: withCjk(SYSTEM_FONT_STACK) },
];

export function interfaceFontStack(id: InterfaceFont): string {
  return INTERFACE_FONTS.find((f) => f.id === id)?.stack ?? SYSTEM_FONT_STACK;
}

function apply(id: InterfaceFont): void {
  document.documentElement.style.setProperty(
    "--app-font",
    interfaceFontStack(id),
  );
}

if (typeof document !== "undefined") {
  apply(useSettingsStore.getState().interfaceFont);
  useSettingsStore.subscribe((s, prev) => {
    if (s.interfaceFont !== prev.interfaceFont) apply(s.interfaceFont);
  });
}
