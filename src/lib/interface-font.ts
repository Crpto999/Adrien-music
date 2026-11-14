import { useSettingsStore, type InterfaceFont } from "@/lib/store/settings";
import {
  PINGFANG_FAMILY,
  activatePingfang,
  initPingfang,
} from "@/lib/pingfang-font";
import {
  NOTO_SANS_SC_FAMILY,
  activateNotoSansSc,
  initNotoSansSc,
} from "@/lib/noto-sans-sc-font";

/**
 * The Interface font setting.
 *
 * Three choices: the system stack, which is what the app has always
 * used, and two downloaded typefaces — PingFang SC and Noto Sans SC.
 * The chosen stack is written to `--app-font` on the document root,
 * which `index.css` reads for the whole tree.
 *
 * Neither downloaded family is bundled — each is fetched the first time
 * the user picks it (see `lib/pingfang-font.ts` and
 * `lib/noto-sans-sc-font.ts`), which is why the setting row asks
 * before it fetches them. Once a family is registered with the
 * document the stack below resolves to it.
 *
 * Imported once from main.tsx, so the main and floating windows both
 * apply it, and the floating window follows changes through the
 * settings store's cross-window rehydrate.
 */

export const SYSTEM_FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Open Sans", "Helvetica Neue", sans-serif';

/**
 * CJK fallbacks appended to every stack.
 *
 * The system stack has no CJK coverage of its own on every platform, so
 * without these a Chinese UI renders its Chinese text in whatever the
 * OS picks — which on Windows is a mismatched serif-ish fallback and
 * looks nothing like the rest of the app.
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

/**
 * The system stack, with the CJK fallbacks appended.
 *
 * The same stack the "System default" entry uses, so the fallback for
 * an unknown id is not a subtly different one.
 */
export const SYSTEM_FONT_STACK_WITH_CJK = withCjk(SYSTEM_FONT_STACK);

export const INTERFACE_FONTS: {
  id: InterfaceFont;
  label: string;
  stack: string;
}[] = [
  {
    id: "pingfang",
    label: "PingFang SC",
    stack: withCjk(`"${PINGFANG_FAMILY}"`),
  },
  {
    id: "noto-sans-sc",
    label: "Noto Sans SC",
    stack: withCjk(`"${NOTO_SANS_SC_FAMILY}"`),
  },
  { id: "system", label: "System default", stack: SYSTEM_FONT_STACK_WITH_CJK },
];

export function interfaceFontStack(id: InterfaceFont): string {
  return (
    INTERFACE_FONTS.find((f) => f.id === id)?.stack ??
    SYSTEM_FONT_STACK_WITH_CJK
  );
}

function apply(id: InterfaceFont): void {
  document.documentElement.style.setProperty(
    "--app-font",
    interfaceFontStack(id),
  );
}

/**
 * Make the family available to the document, if it is installed.
 *
 * The main window downloads it; the floating window is a separate JS
 * context and has to register the faces itself. Both share the same
 * IndexedDB, so the bytes are already there — this only hands them to
 * the browser.
 */
async function ensureFamily(id: InterfaceFont): Promise<void> {
  if (id === "pingfang") await activatePingfang();
  else if (id === "noto-sans-sc") await activateNotoSansSc();
  else return;
  // The browser re-matches the text against the newly added faces only
  // when the stack is re-applied, so do that here rather than leaving
  // the old metrics in place.
  apply(id);
}

if (typeof document !== "undefined") {
  const current = useSettingsStore.getState().interfaceFont;
  apply(current);
  void ensureFamily(current);

  useSettingsStore.subscribe((s, prev) => {
    if (s.interfaceFont === prev.interfaceFont) return;
    apply(s.interfaceFont);
    void ensureFamily(s.interfaceFont);
  });

  // Register the downloaded families with the document, if they are
  // already installed — so picking one later is instant.
  void initPingfang();
  void initNotoSansSc();
}
