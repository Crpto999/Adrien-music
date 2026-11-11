import { describe, expect, it } from "vitest";

import { resolveTauriArgs } from "./tauri-cli-args.mjs";

/**
 * The dev/release split is the whole reason this wrapper exists, so the
 * argument resolution is pinned here: a `dev` run must get the dev config
 * (and therefore the dev bundle identifier), and nothing else may.
 */
describe("resolveTauriArgs", () => {
  const DEV_CONFIG = "src-tauri/tauri.dev.conf.json";

  it("injects the dev config for the dev subcommand", () => {
    expect(resolveTauriArgs(["dev"], { devConfig: DEV_CONFIG })).toEqual([
      "dev",
      "--config",
      DEV_CONFIG,
    ]);
  });

  it("keeps the dev config ahead of the app passthrough separator", () => {
    // Everything after a bare `--` is forwarded to the application, so
    // our flag has to be spliced in before it.
    expect(
      resolveTauriArgs(["dev", "--", "--app-arg"], { devConfig: DEV_CONFIG }),
    ).toEqual(["dev", "--config", DEV_CONFIG, "--", "--app-arg"]);
  });

  it("keeps other flags", () => {
    expect(
      resolveTauriArgs(["dev", "--no-watch"], { devConfig: DEV_CONFIG }),
    ).toEqual(["dev", "--config", DEV_CONFIG, "--no-watch"]);
  });

  it("leaves non-dev subcommands alone", () => {
    // A release build must keep the release identity, otherwise the
    // published installer would install under the dev identifier.
    expect(resolveTauriArgs(["build"], { devConfig: DEV_CONFIG })).toEqual([
      "build",
    ]);
    expect(resolveTauriArgs(["info"], { devConfig: DEV_CONFIG })).toEqual([
      "info",
    ]);
  });

  it("does not override an explicit config", () => {
    expect(
      resolveTauriArgs(["dev", "--config", "other.json"], {
        devConfig: DEV_CONFIG,
      }),
    ).toEqual(["dev", "--config", "other.json"]);
    expect(
      resolveTauriArgs(["dev", "-c", "other.json"], { devConfig: DEV_CONFIG }),
    ).toEqual(["dev", "-c", "other.json"]);
    expect(
      resolveTauriArgs(["dev", "--config=other.json"], {
        devConfig: DEV_CONFIG,
      }),
    ).toEqual(["dev", "--config=other.json"]);
  });

  it("passes through an argument list with no subcommand", () => {
    expect(resolveTauriArgs(["--version"], { devConfig: DEV_CONFIG })).toEqual([
      "--version",
    ]);
  });
});
