"""Tests for the release manifest script.

The script decides two things that a broken updater depends on: the
name an installer is published under, and the platform keys it claims
in `latest.json`. A wrong key means the updater can't find the build
for that machine, so the mapping is pinned here.

The `main()` walk itself is pinned too. It is the part that actually
runs in CI, and it used to raise `KeyError: 'original'` on the very
first asset it renamed -- which is why every release since the script
was written failed at the manifest step. The mapping tests above
cannot catch that: they call the helpers directly and never go near
the loop.

Run with: python -m unittest discover -s scripts
"""

import importlib.util
import json
import os
import sys
import unittest
from unittest import mock

SCRIPT = os.path.join(os.path.dirname(__file__), "build-updater-manifest.py")

spec = importlib.util.spec_from_file_location("build_updater_manifest", SCRIPT)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


class FriendlyNameTest(unittest.TestCase):
    """The name an installer is published under."""

    def test_windows_installers(self):
        self.assertEqual(
            mod.friendly_name("adrify_0.13.0_x64-setup.exe", "0.13.0"),
            "adrify_0.13.0_Windows_x64_Setup.exe",
        )
        # Windows is x64 only -- the ARM64 release leg was dropped, but
        # the naming rule stays so a stray asset is still labelled
        # correctly instead of being published as `Windows_x64`.
        self.assertEqual(
            mod.friendly_name("adrify_0.13.0_aarch64-setup.exe", "0.13.0"),
            "adrify_0.13.0_Windows_arm64_Setup.exe",
        )

    def test_linux_packages(self):
        self.assertEqual(
            mod.friendly_name("adrify_0.13.0_amd64.AppImage", "0.13.0"),
            "adrify_0.13.0_Linux_x86_64.AppImage",
        )
        self.assertEqual(
            mod.friendly_name("adrify_0.13.0_amd64.deb", "0.13.0"),
            "adrify_0.13.0_Linux_x86_64.deb",
        )
        self.assertEqual(
            mod.friendly_name("adrify-0.13.0-1.x86_64.rpm", "0.13.0"),
            "adrify_0.13.0_Linux_x86_64.rpm",
        )

    def test_macos_bundles(self):
        self.assertEqual(
            mod.friendly_name("adrify_universal.app.tar.gz", "0.13.0"),
            "adrify_0.13.0_macOS_Universal.app.tar.gz",
        )
        self.assertEqual(
            mod.friendly_name("adrify_0.13.0_universal.dmg", "0.13.0"),
            "adrify_0.13.0_macOS_Universal.dmg",
        )

    def test_unknown_asset_keeps_its_name(self):
        self.assertEqual(mod.friendly_name("latest.json", "0.13.0"), "latest.json")


class PlatformKeysTest(unittest.TestCase):
    """The platform keys an installer claims in the manifest."""

    def test_windows_publishes_both_key_formats(self):
        self.assertEqual(
            mod.platform_keys("adrify_0.13.0_x64-setup.exe"),
            ["windows-x86_64", "windows-x86_64-nsis"],
        )

    def test_universal_macos_covers_both_architectures(self):
        self.assertEqual(
            mod.platform_keys("adrify_universal.app.tar.gz"),
            [
                "darwin-aarch64",
                "darwin-x86_64",
                "darwin-aarch64-app",
                "darwin-x86_64-app",
            ],
        )

    def test_linux_publishes_one_entry_per_format(self):
        self.assertEqual(
            mod.platform_keys("adrify_0.13.0_amd64.AppImage"),
            ["linux-x86_64", "linux-x86_64-appimage"],
        )
        self.assertEqual(
            mod.platform_keys("adrify_0.13.0_amd64.deb"),
            ["linux-x86_64-deb"],
        )
        self.assertEqual(
            mod.platform_keys("adrify-0.13.0-1.x86_64.rpm"),
            ["linux-x86_64-rpm"],
        )

    def test_dmg_is_not_an_updater_artifact(self):
        # The .dmg is a download for humans; the updater installs the
        # .app.tar.gz.
        self.assertEqual(mod.platform_keys("adrify_0.13.0_universal.dmg"), [])

    def test_key_set_matches_a_real_release(self):
        """The keys the script produces must cover exactly the set the
        updater looks up -- the same set the published v0.13.0
        manifest carried.

        Windows is x64 only: the ARM64 release leg was dropped, so no
        `windows-aarch64` entry is published and the updater never looks
        for one."""
        names = [
            "adrify_0.13.0_x64-setup.exe",
            "adrify_0.13.0_amd64.AppImage",
            "adrify_0.13.0_amd64.deb",
            "adrify-0.13.0-1.x86_64.rpm",
            "adrify_universal.app.tar.gz",
        ]
        keys = set()
        for name in names:
            keys |= set(mod.platform_keys(name))

        self.assertEqual(
            keys,
            {
                "windows-x86_64",
                "windows-x86_64-nsis",
                "linux-x86_64",
                "linux-x86_64-appimage",
                "linux-x86_64-deb",
                "linux-x86_64-rpm",
                "darwin-aarch64",
                "darwin-x86_64",
                "darwin-aarch64-app",
                "darwin-x86_64-app",
            },
        )


class MainWalkTest(unittest.TestCase):
    """The `main()` walk over a real release's asset list.

    Regression: the rename loop read `asset["original"]`, a key that
    only ever existed on the *copy* the loop had just built. The API's
    asset objects carry `name`, `id`, `url` and friends, so every
    release that had an installer to rename died with
    `KeyError: 'original'` before it could publish a manifest.

    The tests above cannot catch that -- they call the helpers
    directly and never go near the loop -- so the loop itself is
    exercised here against an asset list shaped like the API's.
    """

    #: The asset list a release of this project actually carries: one
    #: installer and its signature per platform, plus the macOS .dmg
    #: (which is for humans, not for the updater).
    #:
    #: The names are the ones tauri-action uploads, which are not
    #: always the ones the bundler wrote them under: the macOS app
    #: archive is `adrify.app.tar.gz` on disk but is published as
    #: `adrify_universal.app.tar.gz`, and the RPM carries the release
    #: number the bundler put in it (`-1.`).
    ASSETS = [
        {"id": 1, "name": "adrify_0.14.0_x64-setup.exe"},
        {"id": 2, "name": "adrify_0.14.0_x64-setup.exe.sig"},
        {"id": 3, "name": "adrify_0.14.0_amd64.AppImage"},
        {"id": 4, "name": "adrify_0.14.0_amd64.AppImage.sig"},
        {"id": 5, "name": "adrify_0.14.0_amd64.deb"},
        {"id": 6, "name": "adrify_0.14.0_amd64.deb.sig"},
        {"id": 7, "name": "adrify-0.14.0-1.x86_64.rpm"},
        {"id": 8, "name": "adrify-0.14.0-1.x86_64.rpm.sig"},
        {"id": 9, "name": "adrify_universal.app.tar.gz"},
        {"id": 10, "name": "adrify_universal.app.tar.gz.sig"},
        {"id": 11, "name": "adrify_0.14.0_universal.dmg"},
    ]

    def run_main(self, assets):
        """Run `main()` against a fake release, returning what it did."""
        renames = []

        def fake_patch(repo, asset_id, name, token):
            renames.append((asset_id, name))

        def fake_download(repo, asset_id, token):
            # A .sig file's contents, base64 of a minisign signature.
            return b"c2lnbmF0dXJl"

        with mock.patch.object(mod, "find_release", return_value={"id": 7, "body": ""}), \
             mock.patch.object(mod, "list_assets", return_value=assets), \
             mock.patch.object(mod, "download_asset", side_effect=fake_download), \
             mock.patch.object(mod, "patch_asset", side_effect=fake_patch), \
             mock.patch.object(mod, "delete_asset"), \
             mock.patch.object(mod, "upload_asset") as upload, \
             mock.patch.object(sys, "argv", ["build-updater-manifest.py", "--tag", "v0.14.0", "--repo", "o/n"]):
            rc = mod.main()

        payload = None
        if upload.call_args_list:
            payload = upload.call_args_list[0].args[3]
        return rc, renames, payload

    def test_it_renames_every_installer_without_raising(self):
        rc, renames, _ = self.run_main(self.ASSETS)
        self.assertEqual(rc, 0)
        renamed = {asset_id: name for asset_id, name in renames}
        self.assertEqual(renamed[1], "adrify_0.14.0_Windows_x64_Setup.exe")
        self.assertEqual(renamed[3], "adrify_0.14.0_Linux_x86_64.AppImage")
        self.assertEqual(renamed[5], "adrify_0.14.0_Linux_x86_64.deb")
        self.assertEqual(renamed[7], "adrify_0.14.0_Linux_x86_64.rpm")
        self.assertEqual(renamed[9], "adrify_0.14.0_macOS_Universal.app.tar.gz")
        # The .dmg is renamed for consistency, but it is a download for
        # humans -- it carries no signature, so it gets no platform entry.
        self.assertEqual(renamed[11], "adrify_0.14.0_macOS_Universal.dmg")

    def test_the_dmg_gets_no_updater_entry(self):
        _, _, payload = self.run_main(self.ASSETS)
        manifest = json.loads(payload)
        for entry in manifest["platforms"].values():
            self.assertNotIn(".dmg", entry["url"])

    def test_the_manifest_urls_point_at_the_renamed_assets(self):
        _, _, payload = self.run_main(self.ASSETS)
        manifest = json.loads(payload)
        entry = manifest["platforms"]["windows-x86_64"]
        self.assertTrue(
            entry["url"].endswith("/adrify_0.14.0_Windows_x64_Setup.exe"),
            entry["url"],
        )
        self.assertEqual(manifest["version"], "0.14.0")

    def test_every_platform_the_updater_looks_up_is_present(self):
        _, _, payload = self.run_main(self.ASSETS)
        manifest = json.loads(payload)
        self.assertEqual(
            set(manifest["platforms"]),
            {
                "windows-x86_64",
                "windows-x86_64-nsis",
                "linux-x86_64",
                "linux-x86_64-appimage",
                "linux-x86_64-deb",
                "linux-x86_64-rpm",
                "darwin-aarch64",
                "darwin-x86_64",
                "darwin-aarch64-app",
                "darwin-x86_64-app",
            },
        )


if __name__ == "__main__":
    unittest.main()
