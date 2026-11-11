#!/usr/bin/env node
/**
 * A thin wrapper around the Tauri CLI.
 *
 * Why it exists
 * -------------
 * `tauri dev` builds the app with whatever `identifier` the base config
 * carries — `com.github.crpto999.adrify`. That is the SAME identifier the
 * installed release uses, and the identifier decides three things at once:
 *
 *   1. the WebView2 profile directory (`%LOCALAPPDATA%\<identifier>\EBWebView`),
 *      which holds the localStorage the Zustand stores persist into;
 *   2. the app-data directory (`%APPDATA%\<identifier>`), which holds
 *      `accounts.json`, the encrypted cookie jars and the settings file;
 *   3. the single-instance mutex (`<identifier>-sim` on Windows).
 *
 * So a `tauri dev` run started while the installed release was running
 * would hit the same mutex and exit immediately, and — if it did start —
 * it would read and write the release's accounts and cached state. It
 * looks exactly like "the app opened the old cached version".
 *
 * Tauri only auto-merges the *platform* config files
 * (`tauri.windows.conf.json` and friends). `src-tauri/tauri.dev.conf.json`
 * is applied only when it is passed explicitly, so the plain
 * `tauri dev` command silently used the release identity.
 *
 * What this does
 * --------------
 * For the `dev` subcommand only, inject `--config
 * src-tauri/tauri.dev.conf.json`, which switches the identifier to
 * `com.github.crpto999.adrify.dev` and gives the dev run its own
 * WebView2 profile, app-data directory and mutex. Everything else
 * (`build`, `info`, …) is passed through untouched, so releases still
 * build with the release identity and the CI build is unaffected.
 *
 * An explicit `--config` on the command line always wins — we never
 * override a config the caller asked for by name.
 */

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import { resolveTauriArgs } from "./tauri-cli-args.mjs";

const require = createRequire(import.meta.url);

/** True when this module is the entry point, rather than imported. */
function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
}

async function main() {
  const args = resolveTauriArgs(process.argv.slice(2));
  // The local CLI package, not a global one — same resolution the
  // `tauri` binary in node_modules/.bin performs.
  const cli = require("@tauri-apps/cli");
  await cli.run(args, "tauri");
}

if (isMainModule()) {
  main().catch((err) => {
    // Mirrors the CLI's own entry point so failures look the same
    // whether the CLI was invoked directly or through this wrapper.
    const cli = require("@tauri-apps/cli");
    cli.logError(err?.message ?? String(err));
    process.exit(1);
  });
}
