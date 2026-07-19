#!/usr/bin/env python3
"""Bake Horatio bust into a macOS-style squircle dock icon with depth."""

from __future__ import annotations

import subprocess
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageOps

DESKTOP = Path(__file__).resolve().parents[1]
ROOT = DESKTOP.parent
SRC = ROOT / "horatio-style" / "big-icon.png"
FALLBACK = DESKTOP / "build" / "icon-1024.png"
OUT_DIR = DESKTOP / "build"
STYLE_OUT = ROOT / "horatio-style" / "assets" / "app-icon"
BRAND_OUT = ROOT / "horatio-style" / "assets" / "brand"

CORNER_RATIO = 0.2237  # continuous-corner ≈ Apple Big Sur


def squircle_mask(size: int) -> Image.Image:
    r = max(1, int(size * CORNER_RATIO))
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=r, fill=255)
    return mask.filter(ImageFilter.GaussianBlur(radius=0.5))


def apply_squircle(img: Image.Image) -> Image.Image:
    rgba = img.convert("RGBA")
    mask = squircle_mask(rgba.size[0])
    out = Image.new("RGBA", rgba.size, (0, 0, 0, 0))
    out.paste(rgba, (0, 0), mask)
    return out


def add_depth(face: Image.Image) -> Image.Image:
    """Inset squircle + soft drop shadow + top sheen."""
    size = face.size[0]
    margin = int(size * 0.07)
    live = size - margin * 2
    face_scaled = face.resize((live, live), Image.Resampling.LANCZOS)
    mask = squircle_mask(live)

    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))

    # Drop shadow (within canvas so Dock composites cleanly)
    blur = max(4, int(26 * size / 1024))
    offset_y = max(4, int(16 * size / 1024))
    shadow = Image.new("RGBA", (live, live), (0, 0, 0, 100))
    shadow.putalpha(mask.point(lambda a: int(a * 0.55) if a else 0))
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=blur))
    canvas.alpha_composite(shadow, (margin, margin + offset_y))

    # Face tile
    canvas.alpha_composite(face_scaled, (margin, margin))

    # Top sheen / rim light for bevel
    sheen = Image.new("RGBA", (live, live), (0, 0, 0, 0))
    grad = Image.new("L", (live, live), 0)
    gdraw = ImageDraw.Draw(grad)
    for y in range(live // 2):
        alpha = int(70 * (1 - y / (live / 2)) ** 1.4)
        gdraw.line([(0, y), (live, y)], fill=alpha)
    white = Image.new("RGBA", (live, live), (255, 255, 255, 255))
    white.putalpha(Image.composite(grad, Image.new("L", (live, live), 0), mask))
    # Keep sheen only near the rim: subtract inset mask
    inset = int(live * 0.04)
    inner = Image.new("L", (live, live), 0)
    ir = max(1, int(live * CORNER_RATIO) - inset)
    ImageDraw.Draw(inner).rounded_rectangle(
        (inset, inset, live - 1 - inset, live - 1 - inset), radius=ir, fill=255
    )
    rim_only = Image.composite(
        white.split()[-1],
        Image.new("L", (live, live), 0),
        ImageChops_subtract(mask, inner),
    )
    sheen = Image.new("RGBA", (live, live), (255, 255, 255, 0))
    sheen.putalpha(rim_only)
    canvas.alpha_composite(sheen, (margin, margin))

    return canvas


def ImageChops_subtract(a: Image.Image, b: Image.Image) -> Image.Image:
    from PIL import ImageChops

    return ImageChops.subtract(a, b)


def master_icon() -> Image.Image:
    src_path = SRC if SRC.exists() else FALLBACK
    src = Image.open(src_path).convert("RGBA")
    base = ImageOps.fit(src, (1024, 1024), method=Image.Resampling.LANCZOS)
    return add_depth(apply_squircle(base))


def export_sizes(master: Image.Image) -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    STYLE_OUT.mkdir(parents=True, exist_ok=True)
    BRAND_OUT.mkdir(parents=True, exist_ok=True)

    for px in (16, 32, 64, 128, 256, 512, 1024):
        img = master.resize((px, px), Image.Resampling.LANCZOS)
        img.save(OUT_DIR / f"icon-{px}.png", "PNG")
        img.save(STYLE_OUT / f"icon-{px}.png", "PNG")

    master.save(OUT_DIR / "icon.png", "PNG")
    master.save(STYLE_OUT / "icon.png", "PNG")
    master.save(BRAND_OUT / "bust-icon-dock.png", "PNG")


def build_icns() -> None:
    iconset = OUT_DIR / "icon.iconset"
    if iconset.exists():
        for p in iconset.iterdir():
            p.unlink()
        iconset.rmdir()
    iconset.mkdir()

    pairs = [
        ("icon-16.png", "icon_16x16.png"),
        ("icon-32.png", "icon_16x16@2x.png"),
        ("icon-32.png", "icon_32x32.png"),
        ("icon-64.png", "icon_32x32@2x.png"),
        ("icon-128.png", "icon_128x128.png"),
        ("icon-256.png", "icon_128x128@2x.png"),
        ("icon-256.png", "icon_256x256.png"),
        ("icon-512.png", "icon_256x256@2x.png"),
        ("icon-512.png", "icon_512x512.png"),
        ("icon-1024.png", "icon_512x512@2x.png"),
    ]
    for src, dst in pairs:
        Image.open(OUT_DIR / src).save(iconset / dst, "PNG")

    icns = OUT_DIR / "icon.icns"
    subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(icns)], check=True)
    for p in iconset.iterdir():
        p.unlink()
    iconset.rmdir()
    print(f"wrote {icns}")


def main() -> None:
    master = master_icon()
    export_sizes(master)
    build_icns()
    print("dock squircle icons ready")


if __name__ == "__main__":
    main()
