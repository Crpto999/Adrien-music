import { useCallback } from "react";
import { en } from "./dictionaries/en";
import { zhCN } from "./dictionaries/zh-CN";
import type { Locale } from "./locales";
import { useLocaleStore } from "@/lib/store/locale";
import type { TranslateParams, TranslationTree } from "./types";

/**
 * A lightweight, dependency-free i18n layer.
 *
 * The app avoids a third-party i18n library on purpose: the upstream
 * project stripped heavyweight dependencies to keep the bundle small and
 * cold start instant, and this app needs nothing more than a dictionary,
 * a lookup and a hook.
 */

/** Flatten a nested dictionary into a dotted-key map, once per locale. */
function flatten(tree: TranslationTree, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") {
      out[path] = value;
    } else {
      Object.assign(out, flatten(value, path));
    }
  }
  return out;
}

const DICTIONARIES: Record<Locale, Record<string, string>> = {
  en: flatten(en),
  "zh-CN": flatten(zhCN),
};

/**
 * Replace `{name}` placeholders with the matching parameter.
 *
 * Unknown placeholders are left in place rather than blanked, so a
 * missing parameter is visible instead of silently producing a hole in
 * the sentence.
 */
function interpolate(template: string, params?: TranslateParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

/**
 * Translate a dotted key.
 *
 * Falls back to English when the active locale lacks the key, and to
 * the key itself when neither has it — a missing translation should
 * read as "nav.home", not as an empty string.
 *
 * `locale` can be passed explicitly for code outside React (the
 * InnerTube layer, format helpers); React components should use
 * `useT()` so they re-render on a language change.
 */
export function translate(
  key: string,
  params?: TranslateParams,
  locale?: Locale,
): string {
  const active = locale ?? useLocaleStore.getState().locale;
  const dict = DICTIONARIES[active] ?? DICTIONARIES.en;
  const template = dict[key] ?? DICTIONARIES.en[key];
  if (template === undefined) return key;
  return interpolate(template, params);
}

/**
 * The translation function bound to the current locale.
 *
 * Reads the locale from the store, so it is only reactive when used
 * through `useT()`; calling `translate()` directly inside a component
 * works but won't re-render on a language change.
 */
export function useT(): (key: string, params?: TranslateParams) => string {
  const locale = useLocaleStore((s) => s.locale);
  return useCallback(
    (key: string, params?: TranslateParams) => translate(key, params, locale),
    [locale],
  );
}

/** The active locale, reactive. */
export function useLocale(): Locale {
  return useLocaleStore((s) => s.locale);
}

/**
 * Pick the right plural/measure form.
 *
 * Chinese has no grammatical plural, so it uses the singular branch; the
 * helper exists so call sites stay readable and so a future locale with
 * real plurals can slot in without touching them.
 */
export function plural(
  count: number,
  forms: { one: string; other: string },
): string {
  return count === 1 ? forms.one : forms.other;
}
