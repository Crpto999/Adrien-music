"""Tests for the release manifest script.

The script decides two things that a broken updater depends on: the
name an installer is published under, and the platform keys it claims
in `latest.json`. A wrong key means the updater can't find the build
for that machine, so the mapping is pinned here.

Run with: python -m unittest discover -s scripts
"""

import importlib.util
import os
import unittest

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
        self.assertEqual(
            mod.platform_keys("adrify_0.13.0_aarch64-setup.exe"),
            ["windows-aarch64", "windows-aarch64-nsis"],
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
        manifest carried."""
        names = [
            "adrify_0.13.0_x64-setup.exe",
            "adrify_0.13.0_aarch64-setup.exe",
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
                "windows-aarch64",
                "windows-aarch64-nsis",
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
