#!/usr/bin/env python3
"""Assemble the release assets and the updater manifest for a tag.

This replaces the `rename-assets` job that used to live in
`.github/workflows/release.yml`, and it does two things in one pass so
that the release is never half-renamed:

1. Renames every installer to a name that says which OS it is for
   (`adrify_0.13.0_Windows_x64_Setup.exe` instead of
   `adrify_0.13.0_x64-setup.exe`).
2. Builds `latest.json` -- the manifest the in-app updater reads -- from
   the `.sig` files, and uploads it.

Why the manifest is built here and not by tauri-action: the action
generates `latest.json` with a download-merge-upload cycle that is not
atomic, and every matrix leg does the same cycle against the same
shared asset. Two legs that read before either writes either fail with
`already_exists` or silently clobber each other's platform entries, so
the manifest ends up missing a platform. Making one job the only writer
removes the race entirely.

Usage:

    python scripts/build-updater-manifest.py --tag v0.13.0 --repo owner/name

Reads `GITHUB_TOKEN` from the environment when present; without it the
script can still read a public release, but it cannot rename assets or
upload anything. `--dry-run` stops before the first write and prints the
manifest it would upload.
"""

from __future__ import annotations

import argparse
import fnmatch as _fnmatch
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone

API = "https://api.github.com"


# --- GitHub plumbing -------------------------------------------------------


def request(method: str, path: str, token: str | None, raw: bool = False):
    """Call the GitHub REST API. Returns the decoded JSON, or the bytes."""
    url = path if path.startswith("http") else f"{API}{path}"
    req = urllib.request.Request(url, method=method)
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("X-GitHub-Api-Version", "2022-11-28")
    req.add_header("User-Agent", "adrify-release")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    if raw:
        req.add_header("Accept", "application/octet-stream")
    try:
        with urllib.request.urlopen(req) as resp:
            body = resp.read()
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")
        raise SystemExit(f"{method} {url} failed: {e.code}\n{detail}") from e
    if raw:
        return body
    return json.loads(body) if body else None


def find_release(repo: str, tag: str, token: str | None) -> dict:
    """The release for `tag`, drafts included."""
    releases = request("GET", f"/repos/{repo}/releases?per_page=100", token)
    for rel in releases:
        if rel.get("tag_name") == tag:
            return rel
    raise SystemExit(f"No release found for tag {tag} in {repo}")


def list_assets(repo: str, release_id: int, token: str | None) -> list[dict]:
    assets: list[dict] = []
    page = 1
    while True:
        batch = request(
            "GET",
            f"/repos/{repo}/releases/{release_id}/assets?per_page=100&page={page}",
            token,
        )
        if not batch:
            return assets
        assets.extend(batch)
        page += 1


def download_asset(repo: str, asset_id: int, token: str | None) -> bytes:
    return request(
        "GET", f"/repos/{repo}/releases/assets/{asset_id}", token, raw=True
    )


def patch_asset(repo: str, asset_id: int, name: str, token: str | None) -> None:
    """Rename an asset (GitHub has no dedicated endpoint for it)."""
    body = json.dumps({"name": name}).encode()
    req = urllib.request.Request(
        f"{API}/repos/{repo}/releases/assets/{asset_id}",
        data=body,
        method="PATCH",
    )
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("Content-Type", "application/json")
    req.add_header("User-Agent", "adrify-release")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req) as resp:
            resp.read()
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")
        raise SystemExit(f"rename asset {asset_id} failed: {e.code}\n{detail}")


def delete_asset(repo: str, asset_id: int, token: str | None) -> None:
    request("DELETE", f"/repos/{repo}/releases/assets/{asset_id}", token)


def upload_asset(repo: str, release_id: int, name: str, data: bytes, token: str | None) -> None:
    """Upload `data` as a release asset, replacing any asset of that name."""
    url = f"https://uploads.github.com/repos/{repo}/releases/{release_id}/assets?name={name}"
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Content-Type", "application/octet-stream")
    req.add_header("User-Agent", "adrify-release")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req) as resp:
            resp.read()
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")
        raise SystemExit(f"upload {name} failed: {e.code}\n{detail}") from e


# --- Naming and platform mapping -------------------------------------------


def friendly_name(name: str, version: str) -> str:
    """The name an installer should carry in the release.

    The bundler names its output per-packager (`_x64-setup.exe`,
    `_amd64.deb`, `-1.x86_64.rpm`), which doesn't tell a visitor which
    file is for which OS. Anything we don't recognise keeps its name.

    Windows is x64 only: the ARM64 leg of the release matrix was dropped,
    so no `aarch64` Windows installer is ever published. The Linux ARM
    rules stay, because those packages are built outside this workflow
    (AUR and friends) and a stray ARM asset should still get a sensible
    name rather than be published as `Windows_x64`.
    """
    rules = [
        ("*_aarch64-setup.exe", f"adrify_{version}_Windows_arm64_Setup.exe"),
        ("*_arm64-setup.exe", f"adrify_{version}_Windows_arm64_Setup.exe"),
        ("*-setup.exe", f"adrify_{version}_Windows_x64_Setup.exe"),
        ("*.app.tar.gz", f"adrify_{version}_macOS_Universal.app.tar.gz"),
        ("*.dmg", f"adrify_{version}_macOS_Universal.dmg"),
        ("*_aarch64.AppImage", f"adrify_{version}_Linux_arm64.AppImage"),
        ("*.AppImage", f"adrify_{version}_Linux_x86_64.AppImage"),
        ("*_arm64.deb", f"adrify_{version}_Linux_arm64.deb"),
        ("*.deb", f"adrify_{version}_Linux_x86_64.deb"),
        ("*.rpm", f"adrify_{version}_Linux_x86_64.rpm"),
    ]
    for pattern, new in rules:
        if _fnmatch.fnmatch(name, pattern):
            return new
    return name


def platform_keys(original: str) -> list[str]:
    """The updater platform keys an installer's signature covers.

    The updater looks up an entry by `{os}-{arch}` and, for the newer
    format, `{os}-{arch}-{installer}`. Windows publishes both; macOS
    publishes the native keys plus the `-app` variants; Linux publishes
    the bare key for the AppImage plus one entry per package format.

    The architecture comes out of the asset name, which the bundler
    builds as `{name}_{version}_{arch}-setup.exe` and friends.
    """
    if original.endswith("-setup.exe"):
        arch = "aarch64" if "_aarch64-setup.exe" in original else "x86_64"
        return [f"windows-{arch}", f"windows-{arch}-nsis"]
    if original.endswith(".app.tar.gz"):
        # A universal macOS build covers both architectures.
        return [
            "darwin-aarch64",
            "darwin-x86_64",
            "darwin-aarch64-app",
            "darwin-x86_64-app",
        ]
    if original.endswith(".AppImage"):
        arch = "aarch64" if "_aarch64.AppImage" in original else "x86_64"
        return [f"linux-{arch}", f"linux-{arch}-appimage"]
    if original.endswith(".deb"):
        arch = "arm64" if "_arm64.deb" in original else "x86_64"
        return [f"linux-{arch}-deb"]
    if original.endswith(".rpm"):
        arch = "aarch64" if ".aarch64.rpm" in original else "x86_64"
        return [f"linux-{arch}-rpm"]
    return []


# --- Main ------------------------------------------------------------------


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tag", required=True, help="release tag, e.g. v0.13.0")
    parser.add_argument("--repo", required=True, help="owner/name")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="report what would happen without changing anything",
    )
    args = parser.parse_args()

    token = os.environ.get("GITHUB_TOKEN") or None
    version = args.tag.lstrip("v")
    release = find_release(args.repo, args.tag, token)
    release_id = release["id"]
    assets = list_assets(args.repo, release_id, token)

    # 1. Pull the signatures down first. They're deleted at the end --
    #    the updater reads them out of latest.json, so loose copies only
    #    clutter the asset list.
    signatures: dict[str, str] = {}
    sig_assets: list[dict] = []
    for asset in assets:
        if asset["name"].endswith(".sig"):
            raw = download_asset(args.repo, asset["id"], token)
            signatures[asset["name"][: -len(".sig")]] = raw.decode("utf-8").strip()
            sig_assets.append(asset)

    # 2. Rename the installers.
    renames: dict[str, str] = {}  # original name -> final name
    installers: list[dict] = []
    for asset in assets:
        if asset["name"].endswith(".sig"):
            continue
        original = asset["name"]
        new_name = friendly_name(original, version)
        installers.append({**asset, "original": original, "final": new_name})
        if new_name != original:
            # The key is the asset's name on the release, not a key of
            # `asset` -- the API's asset objects only carry `name`,
            # `id`, `url` and friends, so reading "original" off one
            # raises a KeyError and takes the whole release down.
            renames[original] = new_name
            if not args.dry_run:
                patch_asset(args.repo, asset["id"], new_name, token)

    # 3. Build the manifest.
    base_url = f"https://github.com/{args.repo}/releases/download/{args.tag}"
    platforms: dict[str, dict] = {}
    for installer in installers:
        signature = signatures.get(installer["original"])
        if signature is None:
            continue  # not an updater artifact (e.g. the .dmg)
        entry = {
            "signature": signature,
            "url": f"{base_url}/{installer['final']}",
        }
        for key in platform_keys(installer["original"]):
            platforms[key] = entry

    if not platforms:
        raise SystemExit(
            "No signatures found for any installer -- is "
            "TAURI_SIGNING_PRIVATE_KEY set on the repository?"
        )

    manifest = {
        "version": version,
        "notes": release.get("body") or "See the assets below to download and install this version.",
        "pub_date": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "platforms": platforms,
    }

    print(f"Release {args.tag} ({len(installers)} installers, {len(platforms)} platform entries)")
    for original, new in sorted(renames.items()):
        print(f"  rename  {original} -> {new}")
    for key in sorted(platforms):
        print(f"  entry   {key} -> {platforms[key]['url'].rsplit('/', 1)[-1]}")

    if args.dry_run:
        print("\n--dry-run: nothing was changed.")
        print(json.dumps(manifest, indent=2))
        return 0

    # 4. Replace any manifest left over from a previous run, then upload.
    for asset in assets:
        if asset["name"] == "latest.json":
            delete_asset(args.repo, asset["id"], token)

    payload = json.dumps(manifest, indent=2).encode()
    upload_asset(args.repo, release_id, "latest.json", payload, token)
    print("\nUploaded latest.json")

    # 5. The loose signatures are redundant now that they ride along in
    #    the manifest.
    for asset in sig_assets:
        delete_asset(args.repo, asset["id"], token)
        print(f"  removed {asset['name']}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
