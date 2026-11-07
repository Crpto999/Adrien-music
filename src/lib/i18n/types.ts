/**
 * Types for the lightweight in-house i18n layer.
 *
 * The app deliberately avoids a third-party i18n library: the upstream
 * project removed heavyweight dependencies to keep the bundle small and
 * startup instant, and a dictionary + a hook is all this app needs.
 */

/** A nested dictionary. Leaves are plain strings. */
export interface TranslationTree {
  [key: string]: string | TranslationTree;
}

/**
 * Flatten a nested dictionary into dotted keys.
 *
 * `"a": { "b": "x" }` becomes `"a.b"`.
 */
export type Flatten<T> = T extends string
  ? never
  : {
      [K in keyof T & string]: T[K] extends string
        ? K
        : `${K}.${Flatten<T[K]>}`;
    }[keyof T & string];

/** Values accepted by a `t()` parameter placeholder. */
export type TranslateParams = Record<string, string | number>;
