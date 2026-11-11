/**
 * Argument resolution for the Tauri CLI wrapper.
 *
 * Kept in its own module — with no shebang — so it can be imported
 * directly by the test suite. Vitest's ESM transform chokes on a
 * `#!` line in an `.mjs` file, and a shebang is only needed by the
 * executable entry point anyway.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

/** The repository root, derived from this file's location. */
export const ROOT = path.resolve(SCRIPT_DIR, "..");

/**
 * The dev-only config. Its `identifier` is what keeps a dev run from
 * sharing state with the installed release.
 *
 * Forward slashes even on Windows: the CLI treats the value as a path
 * and forward slashes are the one form every layer (Node, Cargo, the
 * Tauri config merger) agrees on.
 */
export const DEV_CONFIG = path
  .join(ROOT, "src-tauri", "tauri.dev.conf.json")
  .replace(/\\/g, "/");

/**
 * Work out the arguments to hand to the Tauri CLI.
 *
 * @param {string[]} argv Arguments as passed to the CLI, without the
 *   node executable and the script path.
 * @param {{ devConfig?: string }} [options]
 * @returns {string[]} The arguments to run the CLI with.
 */
export function resolveTauriArgs(argv, options = {}) {
  const devConfig = options.devConfig ?? DEV_CONFIG;
  const args = [...argv];

  // The subcommand is the first argument that is not a flag.
  const subcommandIndex = args.findIndex((a) => !a.startsWith("-"));
  if (subcommandIndex === -1) return args;
  if (args[subcommandIndex] !== "dev") return args;

  // The caller named a config explicitly — leave it alone.
  const hasExplicitConfig = args.some(
    (a) =>
      a === "--config" ||
      a === "-c" ||
      a.startsWith("--config=") ||
      a.startsWith("-c="),
  );
  if (hasExplicitConfig) return args;

  // Insert right after the subcommand rather than at the end: everything
  // after a bare `--` is forwarded to the application, and must not have
  // our flag spliced into it.
  args.splice(subcommandIndex + 1, 0, "--config", devConfig);
  return args;
}
