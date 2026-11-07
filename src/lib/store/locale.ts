import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  DEFAULT_LOCALE,
  INTL_LOCALE,
  LOCALE_REGIONS,
  isLocale,
  type Locale,
} from "@/lib/i18n/locales";

type State = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
};

/**
 * The user's language choice.
 *
 * Kept in its own store (rather than folded into `settings.ts`) because
 * the InnerTube layer reads it to build request headers, and the fonts /
 * `document.lang` follow it too. It is persisted under its own key so a
 * locale change never has to rehydrate the whole settings blob.
 *
 * The main and floating-player windows are separate JS contexts sharing
 * localStorage, so the `storage` listener below re-hydrates on a change
 * made in the other window — same pattern as `store/settings.ts`.
 */
export const useLocaleStore = create<State>()(
  persist(
    (set) => ({
      locale: DEFAULT_LOCALE,
      setLocale: (locale) => set({ locale }),
    }),
    { name: "ytm-locale" },
  ),
);

if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === "ytm-locale") {
      void useLocaleStore.persist.rehydrate();
    }
  });
}

/**
 * Apply the locale to the document: the `lang` attribute (screen
 * readers, and the browser's own hyphenation/font fallback), and the
 * `dir` attribute (RTL locales would need it; the app ships LTR ones
 * today but the hook keeps the wiring in place).
 */
function applyDocumentLocale(locale: Locale): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.lang = INTL_LOCALE[locale];
  root.dir = "ltr";
}

if (typeof document !== "undefined") {
  applyDocumentLocale(useLocaleStore.getState().locale);
  useLocaleStore.subscribe((s, prev) => {
    if (s.locale !== prev.locale) applyDocumentLocale(s.locale);
  });
}

/**
 * The InnerTube `hl` (response language) for the current locale.
 *
 * Read at request time rather than captured, so a language change takes
 * effect on the next fetch without a restart.
 */
export function currentInnertubeLocale(): { hl: string; gl: string } {
  const { locale } = useLocaleStore.getState();
  return { hl: locale, gl: LOCALE_REGIONS[locale] };
}

/** Guard for values arriving from storage (which can be stale or corrupt). */
export function normalizeLocale(value: unknown): Locale {
  return isLocale(value) ? value : DEFAULT_LOCALE;
}
