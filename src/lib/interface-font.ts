import { useSettingsStore, type InterfaceFont } from "@/lib/store/settings";
import { IS_MAC, IS_WINDOWS } from "@/lib/platform";
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
 * used, and two downloaded typefaces — PingFang SC (macOS only) and
 * Noto Sans SC. Neither downloaded family is bundled — each is fetched
 * the first time the user picks it (see `lib/pingfang-font.ts` and
 * `lib/noto-sans-sc-font.ts`), which is why the setting row asks
 * before it fetches them. Once a family is registered with the
 * document the stack below resolves to it.
 *
 * The stacks are split per platform, the way Fluent / QQ音乐 do it:
 * Windows renders Latin in Segoe UI and CJK in Microsoft YaHei UI,
 * macOS in SF / PingFang, Linux in Noto. A single cross-platform stack
 * mixes hinting models and is the main reason CJK looked blurry on
 * Windows (ClearType vs. gray-scale AA, different x-heights).
 *
 * Imported once from main.tsx, so the main and floating windows both
 * apply it, and the floating window follows changes through the
 * settings store's cross-window rehydrate.
 */

/**
 * @deprecated Kept for tests / external callers; prefer `systemStack()`.
 * The old single cross-platform Latin head.
 */
export const SYSTEM_FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Open Sans", "Helvetica Neue", sans-serif';

/** Latin heads, per platform. */
const LATIN_WINDOWS =
  '"Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif';
const LATIN_MAC =
  '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif';
const LATIN_LINUX =
  'system-ui, "Noto Sans", Roboto, "Helvetica Neue", Arial, sans-serif';

function latinHead(): string {
  if (IS_WINDOWS) return LATIN_WINDOWS;
  if (IS_MAC) return LATIN_MAC;
  return LATIN_LINUX;
}

/**
 * CJK chain, platform head first, universal tail after.
 *
 * The platform head is what actually renders (YaHei UI on Windows,
 * PingFang on macOS, Noto CJK on Linux); the tail only covers a
 * machine missing its own UI face. Every stack keeps "Microsoft YaHei"
 * and "sans-serif" in the tail so old tests and exotic systems stay
 * covered.
 */
function cjkChain(): string {
  const tail = [
    '"Microsoft YaHei"',
    '"PingFang SC"',
    '"Hiragino Sans GB"',
    '"Noto Sans CJK SC"',
    '"Source Han Sans SC"',
    '"WenQuanYi Micro Hei"',
    '"Heiti SC"',
    "sans-serif",
  ].join(", ");
  if (IS_WINDOWS) return `"Microsoft YaHei UI", ${tail}`;
  if (IS_MAC) return `"PingFang SC", "Hiragino Sans GB", ${tail}`;
  return `"Noto Sans CJK SC", "Source Han Sans SC", ${tail}`;
}

/** The system stack for this platform. */
export function systemStack(): string {
  return `${latinHead()}, ${cjkChain()}`;
}

/**
 * The system stack, with the CJK fallbacks appended.
 *
 * The same stack the "System default" entry uses, so the fallback for
 * an unknown id is not a subtly different one.
 */
export const SYSTEM_FONT_STACK_WITH_CJK = systemStack();

export const INTERFACE_FONTS: {
  id: InterfaceFont;
  label: string;
  stack: string;
  /** When false on this platform the row hides the entry. */
  available: boolean;
}[] = [
  {
    id: "pingfang",
    label: "PingFang SC",
    // PingFang has no ClearType hinting — blurry on Windows low-dpi
    // screens — so it stays in the list for macOS and hides on Windows.
    stack: `"${PINGFANG_FAMILY}", ${cjkChain()}`,
    available: !IS_WINDOWS,
  },
  {
    id: "noto-sans-sc",
    label: "Noto Sans SC",
    stack: `"${NOTO_SANS_SC_FAMILY}", ${cjkChain()}`,
    available: true,
  },
  { id: "system", label: "System default", stack: SYSTEM_FONT_STACK_WITH_CJK, available: true },
];

/** The entries the settings row shows on this platform. */
export function visibleInterfaceFonts() {
  return INTERFACE_FONTS.filter((f) => f.available);
}

export function interfaceFontStack(id: InterfaceFont): string {
  // A stored "pingfang" pick from another platform (or an old install)
  // falls back to system rather than rendering in a hint-less face.
  const found = INTERFACE_FONTS.find((f) => f.id === id);
  if (!found || !found.available) return SYSTEM_FONT_STACK_WITH_CJK;
  return found.stack;
}

function apply(id: InterfaceFont): void {
  document.documentElement.style.setProperty(
    "--app-font",
    interfaceFontStack(id),
  );
}

function applyPlatformClass(): void {
  const cls = IS_WINDOWS ? "os-windows" : IS_MAC ? "os-mac" : "os-linux";
  document.documentElement.classList.remove(
    "os-windows",
    "os-mac",
    "os-linux",
  );
  document.documentElement.classList.add(cls);
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
  applyPlatformClass();
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
