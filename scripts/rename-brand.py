#!/usr/bin/env python3
"""One-off: rewrite the old brand name to `adrify` across the tree.

Run from the repo root:

    python scripts/rename-brand.py

Kept in the tree as the record of what the rename touched: the order of
the replacements matters (the machine-facing identifiers have to go
before the plain brand-name swap, so a `adrify://` URL is not turned
into `adrify://` by accident), and the storage keys are deliberately
left alone — they are per-install data, and renaming them would throw
away the user's session and settings.

The script is idempotent: running it twice changes nothing.
"""

from __future__ import annotations

import os
import sys

# Machine-facing identifiers first, then the plain brand name.
SUBS = [
    ("com.github.crpto999.adrify", "com.github.crpto999.adrify"),
    ("adrify_lib", "adrify_lib"),
    ("org.mpris.MediaPlayer2.adrify", "org.mpris.MediaPlayer2.adrify"),
    ("org/adrify/track", "org/adrify/track"),
    ("adrify://", "adrify://"),
    ("adrify-ytdlp-", "adrify-ytdlp-"),
    ("adrify.log", "adrify.log"),
    ("adrify-write-test", "adrify-write-test"),
    ("Entry::new(\"adrify\"", "Entry::new(\"adrify\""),
    ("ADRIFY_DISCORD_APP_ID", "ADRIFY_DISCORD_APP_ID"),
    ("dbus_name: \"adrify\"", "dbus_name: \"adrify\""),
    ("adrify", "adrify"),
    ("adrify", "adrify"),
]

# Roots to walk. The Rust `target/` directory and the build outputs are
# skipped — they are regenerated, and touching them would only slow the
# next build down.
SKIP_DIRS = {
    "node_modules",
    "target",
    "dist",
    ".git",
    ".tmpwork",
    "repo",
}

TEXT_SUFFIXES = {
    ".ts",
    ".tsx",
    ".js",
    ".mjs",
    ".json",
    ".rs",
    ".toml",
    ".yml",
    ".yaml",
    ".md",
    ".html",
    ".py",
    ".css",
    ".txt",
    ".svg",
}


def rewrite(path: str) -> bool:
    with open(path, "r", encoding="utf-8", newline="") as fh:
        original = fh.read()
    updated = original
    for old, new in SUBS:
        updated = updated.replace(old, new)
    if updated == original:
        return False
    with open(path, "w", encoding="utf-8", newline="") as fh:
        fh.write(updated)
    return True


def main() -> int:
    roots = sys.argv[1:] or ["."]
    changed = []
    for root in roots:
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
            for name in filenames:
                if os.path.splitext(name)[1].lower() not in TEXT_SUFFIXES:
                    continue
                path = os.path.join(dirpath, name)
                if rewrite(path):
                    changed.append(path)
    for path in changed:
        print("updated", path)
    print(f"\n{len(changed)} files changed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
