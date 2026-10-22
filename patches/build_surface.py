#!/usr/bin/env python3
"""Build the table for cards/: a near-black, worn surface (mottling, fine grain, scratches, dust).

Writes cards/assets/table/{hi,lo}/surface-*.jpg. The tile size in cm is CONFIG.table.surfaceTileCm.
Usage: python3 patches/build_surface.py   (needs Pillow + numpy from the user site-packages)
"""
import zlib
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

PROJECT = Path(__file__).resolve().parent.parent
OUT = PROJECT / "cards/assets/table"
BASE = (15, 15, 16)


def rng(key):
    return np.random.default_rng(zlib.crc32(key.encode()))


def tile_noise(n, rnd, cells):
    """Tileable value noise: a random grid wrapped and upsampled."""
    g = rnd.random((cells, cells)).astype(np.float32)
    g = np.pad(g, ((0, 1), (0, 1)), mode="wrap")
    big = Image.fromarray((g * 255).astype(np.uint8)).resize((n + n // cells, n + n // cells), Image.BICUBIC)
    return np.asarray(big, np.float32)[:n, :n] / 255


def surface(n):
    rnd = rng("surface")
    mottle = sum(tile_noise(n, rnd, c) * a for c, a in ((4, 0.5), (12, 0.3), (40, 0.2)))
    grain = rnd.normal(0, 1, (n, n)).astype(np.float32)
    v = np.array(BASE, np.float32)[None, None, :] / 255 * (0.75 + 0.6 * mottle[..., None]) + 0.006 * grain[..., None]
    img = Image.fromarray((np.clip(v, 0, 1) * 255).astype(np.uint8))
    # Scratches and dust: faint light marks, drawn wrapped so the tile repeats cleanly.
    marks = Image.new("L", (n, n), 0)
    d = ImageDraw.Draw(marks)
    for _ in range(60):
        x, y = rnd.uniform(0, n, 2)
        ang, ln = rnd.uniform(0, np.pi), rnd.uniform(0.02, 0.18) * n
        for ox in (-n, 0, n):
            for oy in (-n, 0, n):
                d.line((x + ox, y + oy, x + ox + np.cos(ang) * ln, y + oy + np.sin(ang) * ln), fill=int(rnd.uniform(10, 34)), width=1)
    for _ in range(140):
        x, y = rnd.uniform(0, n, 2)
        r = rnd.uniform(0.4, 1.6)
        d.ellipse((x - r, y - r, x + r, y + r), fill=int(rnd.uniform(12, 50)))
    marks = marks.filter(ImageFilter.GaussianBlur(0.6))
    out = np.asarray(img, np.float32) + np.asarray(marks, np.float32)[..., None] * 0.9
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8))


def main():
    for tier, s_px in {"hi": 1024, "lo": 512}.items():
        d = OUT / tier
        d.mkdir(parents=True, exist_ok=True)
        surface(s_px).save(d / f"surface-{s_px}.jpg", quality=90)
        print("table", tier)


if __name__ == "__main__":
    main()
