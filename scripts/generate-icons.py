#!/usr/bin/env python3
"""Generate the Tauri icon set from a single square source PNG.

Tauri needs a multi-resolution icon set: a `.ico` for Windows, an
`.icns` for macOS, and the Square*Logo.png / StoreLogo.png raster
tiles for the Windows Store packaging, plus the plain PNGs the
bundler embeds.

The source is the app's colorful logo (`repo/cyberpunk_app_logo.png`),
which is a square RGBA image with transparent margins. Windows icons
must not be fully transparent, so the artwork is composited onto the
theme's deep-void background (#080A12) before it is written out --
an unpadded transparent .ico renders as an invisible square in the
Start Menu on Windows.

Usage:

    python scripts/generate-icons.py [--source repo/cyberpunk_app_logo.png]
"""

from __future__ import annotations

import argparse
import io
import os
import struct
import sys

from PIL import Image

# The cyberpunk logo's deepest background tone. Used as the matte behind
# the artwork for the raster formats that cannot carry alpha (the .ico
# and the Windows Store tiles).
VOID_BLACK = (0x08, 0x0A, 0x12, 0xFF)

# Every raster the bundler or the platform shells ask for, by the file
# name Tauri expects next to the manifest.
PNG_SIZES = {
    "32x32.png": 32,
    "64x64.png": 64,
    "128x128.png": 128,
    "128x128@2x.png": 256,
    "icon.png": 512,
    "icon-dev.png": 512,
    "Square30x30Logo.png": 30,
    "Square44x44Logo.png": 44,
    "Square71x71Logo.png": 71,
    "Square89x89Logo.png": 89,
    "Square107x107Logo.png": 107,
    "Square142x142Logo.png": 142,
    "Square150x150Logo.png": 150,
    "Square284x284Logo.png": 284,
    "Square310x310Logo.png": 310,
    "StoreLogo.png": 50,
}


def load_source(path: str) -> Image.Image:
    """The source artwork, cropped to its opaque bounds and squared."""
    image = Image.open(path)
    if image.mode != "RGBA":
        image = image.convert("RGBA")
    # Trim the transparent margin so the logo fills the icon the way the
    # app icon does on every platform.
    bbox = image.getbbox()
    if bbox:
        image = image.crop(bbox)
    side = max(image.size)
    square = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    square.paste(
        image,
        ((side - image.width) // 2, (side - image.height) // 2),
        image,
    )
    return square


def resize(image: Image.Image, size: int) -> Image.Image:
    return image.resize((size, size), Image.LANCZOS)


def matte(image: Image.Image) -> Image.Image:
    """Flatten the artwork onto the void-black background."""
    flat = Image.new("RGBA", image.size, VOID_BLACK)
    flat.alpha_composite(image)
    return flat


def write_png(image: Image.Image, path: str) -> None:
    image.save(path, format="PNG", optimize=True)


def write_ico(images: list[Image.Image], path: str) -> None:
    """Write a multi-resolution .ico by hand.

    Pillow's ICO writer only stores PNG-compressed frames from 256px
    down, which Windows Explorer renders fine but older shell surfaces
    mishandle. Writing the container by hand keeps every frame
    BMP-encoded, which is what the platform expects.
    """
    frames = sorted(images, key=lambda im: im.width)
    count = len(frames)
    header = struct.pack("<HHH", 0, 1, count)
    offset = 6 + 16 * count
    entries = []
    blobs = []
    for frame in frames:
        width, height = frame.size
        # A 256px frame is stored as 0 in the directory entry.
        w = 0 if width >= 256 else width
        h = 0 if height >= 256 else height
        rgba = frame.convert("RGBA")
        # The .ico's BMP rows are bottom-up and carry a doubled alpha.
        pixels = rgba.tobytes()
        rows = []
        for y in range(height - 1, -1, -1):
            row = pixels[y * width * 4 : (y + 1) * width * 4]
            bgr = bytearray(row)
            for x in range(width):
                r, g, b, a = row[x * 4 : x * 4 + 4]
                bgr[x * 4 : x * 4 + 4] = bytes((b, g, r, a))
            and_mask = b"\x00" * (4 * width)
            rows.append(bytes(bgr) + and_mask)
        pixels_blob = b"".join(rows)
        mask_header = struct.pack("<IiiHHIIiiII", 40, width, height * 2, 1, 32, 0, len(pixels_blob), 0, 0, 0, 0)
        blob = mask_header + pixels_blob
        entries.append(struct.pack("<BBBBHHII", w, h, 0, 0, 1, 32, len(blob), offset))
        blobs.append(blob)
        offset += len(blob)
    with open(path, "wb") as fh:
        fh.write(header + b"".join(entries) + b"".join(blobs))


def write_icns(image: Image.Image, path: str) -> None:
    """Write a macOS .icns container with the classic icon types."""
    entries = [
        ("icp4", 16),
        ("icp5", 32),
        ("icp6", 64),
        ("ic07", 128),
        ("ic08", 256),
        ("ic09", 512),
    ]
    body = b""
    for tag, size in entries:
        frame = resize(image, size).convert("RGBA")
        buf = io.BytesIO()
        frame.save(buf, format="PNG")
        blob = buf.getvalue()
        body += tag.encode("ascii") + struct.pack(">I", len(blob) + 8) + blob
    with open(path, "wb") as fh:
        fh.write(b"icns" + struct.pack(">I", len(body) + 8) + body)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source",
        default=os.path.join("repo", "cyberpunk_app_logo.png"),
        help="square source artwork",
    )
    parser.add_argument(
        "--out",
        default=os.path.join("src-tauri", "icons"),
        help="destination directory",
    )
    args = parser.parse_args()

    if not os.path.isfile(args.source):
        print(f"source not found: {args.source}", file=sys.stderr)
        return 1

    source = load_source(args.source)
    os.makedirs(args.out, exist_ok=True)

    for name, size in PNG_SIZES.items():
        frame = resize(source, size)
        # The Windows Store tiles are drawn on an opaque background by
        # the shell, so they get the matte; the rest keep their alpha.
        if name.startswith("Square") or name == "StoreLogo.png":
            frame = matte(frame)
        write_png(frame, os.path.join(args.out, name))
        print(f"  {name} ({size}x{size})")

    ico_frames = [matte(resize(source, s)) for s in (16, 32, 48, 64, 128, 256)]
    write_ico(ico_frames, os.path.join(args.out, "icon.ico"))
    print("  icon.ico (16..256)")

    write_icns(source, os.path.join(args.out, "icon.icns"))
    print("  icon.icns (16..512)")

    return 0


if __name__ == "__main__":
    sys.exit(main())
