#!/usr/bin/env python3
"""Check that a published release's updater artifacts really verify.

`build-updater-manifest.py` assembles `latest.json` from the `.sig`
files the bundler produced. That only proves the manifest was written;
it does not prove the signatures are *valid* for the public key the
app ships with. If the two ever disagree -- a key mismatch, a truncated
upload, a corrupted asset -- every client would be told the update is
corrupt and nobody could install it.

This script closes that gap: it downloads the published `latest.json`,
picks the entry for the current platform, downloads that artifact and
checks its signature exactly the way `tauri-plugin-updater` will.

It runs in CI after the manifest is published, so a broken release
fails the workflow instead of reaching users.

Usage:

    python scripts/verify-published-updater.py --tag v0.13.0 --repo owner/name

Reads `GITHUB_TOKEN` from the environment when present; without it the
public assets can still be fetched, but a draft release cannot.
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import importlib.util

_SCRIPTS = os.path.dirname(os.path.abspath(__file__))


def _load(name: str, filename: str):
    """Load a sibling script by path -- they have dashes in their names,
    so they can't be imported as modules directly."""
    spec = importlib.util.spec_from_file_location(
        name, os.path.join(_SCRIPTS, filename)
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


verifier = _load("verify_updater_signature", "verify-updater-signature.py")
manifest_builder = _load("build_updater_manifest", "build-updater-manifest.py")

download_asset = manifest_builder.download_asset
find_release = manifest_builder.find_release
list_assets = manifest_builder.list_assets

# The platform keys the updater looks up, in the order it tries them.
# `tauri-plugin-updater` derives these from the OS and architecture it
# is running on; the list below mirrors that derivation for the
# platforms this project publishes.
RUST_TARGET_TO_PLATFORM = {
    "x86_64-pc-windows-msvc": ("windows-x86_64", "windows-x86_64-nsis"),
    "aarch64-pc-windows-msvc": ("windows-aarch64", "windows-aarch64-nsis"),
    "x86_64-apple-darwin": ("darwin-x86_64", "darwin-x86_64-app"),
    "aarch64-apple-darwin": ("darwin-aarch64", "darwin-aarch64-app"),
    "x86_64-unknown-linux-gnu": ("linux-x86_64", "linux-x86_64-appimage"),
    "aarch64-unknown-linux-gnu": ("linux-aarch64", "linux-aarch64-appimage"),
}


def candidate_keys():
    """The platform keys to check, for the machine this runs on."""
    system = platform.system().lower()
    machine = platform.machine().lower()

    if system == "windows":
        arch = "aarch64" if machine in ("arm64", "aarch64") else "x86_64"
        return [f"windows-{arch}", f"windows-{arch}-nsis"]
    if system == "darwin":
        arch = "aarch64" if machine in ("arm64", "aarch64") else "x86_64"
        return [f"darwin-{arch}", f"darwin-{arch}-app"]
    if system == "linux":
        arch = "aarch64" if machine in ("arm64", "aarch64") else "x86_64"
        return [f"linux-{arch}", f"linux-{arch}-appimage"]
    return []


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tag", required=True, help="release tag, e.g. v0.13.0")
    parser.add_argument("--repo", required=True, help="owner/name")
    parser.add_argument(
        "--all-platforms",
        action="store_true",
        help="check every platform entry, not just this machine's",
    )
    parser.add_argument(
        "--pubkey",
        help="override the public key (defaults to tauri.conf.json's)",
    )
    args = parser.parse_args()

    token = os.environ.get("GITHUB_TOKEN") or None
    release = find_release(args.repo, args.tag, token)
    assets = list_assets(args.repo, release["id"], token)

    manifest_asset = next((a for a in assets if a["name"] == "latest.json"), None)
    if manifest_asset is None:
        print("FAILED: the release has no latest.json", file=sys.stderr)
        return 1

    raw = download_asset(args.repo, manifest_asset["id"], token)
    manifest = json.loads(raw.decode("utf-8"))
    platforms = manifest.get("platforms", {})
    if not platforms:
        print("FAILED: latest.json has no platforms", file=sys.stderr)
        return 1

    if args.pubkey:
        # `--pubkey` may be a path to a minisign .pub file or the key
        # itself; a path is read, anything else is used as given.
        if os.path.isfile(args.pubkey):
            with open(args.pubkey, encoding="utf-8") as fh:
                args.pubkey = fh.read()
        pubkey_text = verifier.load_pubkey(args.pubkey)
    else:
        with open("src-tauri/tauri.conf.json", encoding="utf-8") as fh:
            pubkey_text = verifier.load_pubkey(
                json.load(fh)["plugins"]["updater"]["pubkey"]
            )

    keys = sorted(platforms) if args.all_platforms else candidate_keys()
    if not keys:
        print(
            f"FAILED: no platform key for {platform.system()}/{platform.machine()}",
            file=sys.stderr,
        )
        return 1

    failures: list[str] = []
    checked = 0
    for key in keys:
        entry = platforms.get(key)
        if entry is None:
            failures.append(f"{key}: not present in latest.json")
            continue

        url = entry["url"]
        name = url.rsplit("/", 1)[-1]
        asset = next((a for a in assets if a["name"] == name), None)
        if asset is None:
            failures.append(f"{key}: {name} is not published")
            continue

        payload = download_asset(args.repo, asset["id"], token)
        signature_text = verifier.decode_text_field(entry["signature"])

        with tempfile.NamedTemporaryFile(delete=False) as fh:
            fh.write(payload)
            path = fh.name
        try:
            verifier.verify(payload, pubkey_text, signature_text)
        except ValueError as exc:
            failures.append(f"{key}: {exc}")
            continue
        finally:
            os.unlink(path)

        checked += 1
        print(f"  ok  {key}  {name}  ({len(payload)} bytes)")

    if failures:
        print("\nFAILED:", file=sys.stderr)
        for failure in failures:
            print(f"  {failure}", file=sys.stderr)
        return 1

    print(f"\nAll {checked} platform entries verify against the configured public key")
    return 0


if __name__ == "__main__":
    sys.exit(main())
