#!/usr/bin/env python3
"""Build the card-table textures and copy the CRT chrome assets for the NomadaToast cards page.

Outputs (under cards/assets/; nothing in site/ is touched):
  table/hi/felt-green-1024.jpg, felt-charcoal-1024.jpg   tileable felt albedo (sRGB), 20 cm per tile
  table/hi/felt-normal-512.jpg                           felt micro-normal (linear), same 20 cm tile
  table/hi/felt-print-2048.png                           print decal, RGBA, 64 x 32 cm plane centred on z = -4
  table/hi/rail-leather-512.jpg, rail-normal-256.jpg     rail leather, 512 x 1024 px = 16.34 cm (around) x 32.68 cm (along)
  table/lo/                                              the same at half resolution (felt 512, normal 256, print 1024, rail 256/128)
  crt/tv-glass.webp, tv-glass-1280.webp, tv-glass-960.avif (copied), tv-glass-960.webp (fallback for no AVIF)
  crt/logo.svg (site/brand/arc-logo.svg), crt/grain.png (256 x 256)
  fonts/NeueBit-Bold.woff2, PPNeueMontrealMono-Medium.woff2
Intermediates and the review sheet go to patches/build/table/.

The print layout constants (plane size and centre, arc, text, lockup, glass ring) must match
CONFIG.table.print in cards/js/config.js: table.js places the plane, this script draws on it.

Usage: python3 patches/build_table.py [--seed 7331]   (needs Pillow, numpy and Playwright Chromium)
"""
from __future__ import annotations

import argparse
import base64
import io
import math
import re
import shutil
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

PROJECT = Path(__file__).resolve().parent.parent
SITE = PROJECT / "site"
OUT = PROJECT / "cards/assets"
WORK = PROJECT / "patches/build/table"
FONT_SRC = SITE / "_next/static/immutable/media"

TILE_CM = 20.0  # felt tile: 120 x 90 cm felt repeated 6 x 4.5

# Albedo means (sRGB) chosen so the lamp-lit render reads #1E5642 / #34383A at the pool centre
# (warm #FFE2B8 key, ACES); calibrated against harness renders.
FELTS = {
    "green": (50, 117, 121),
    "charcoal": (72, 85, 112),
}

# Print plane (cm): x in [-32, 32], z in [-20, 12]; image top = far side (-z).
PRINT_CM = (64.0, 32.0)
PRINT_CENTRE_Z = -4.0
ARC_CENTRE = (0.0, 30.0)  # (x, z) of the fan pivot
ARC_R = 39.0
ARC_SPAN_DEG = 48.0
ARC_WIDTH = 0.35
ARC_TEXT = "NOMADA TOAST · TECH · AI · SOCIAL MEDIA GROWTH — SERVED HOT EVERY WEEK"
ARC_TEXT_SIZE = 0.6  # cm, font size of the mono caps
ARC_TEXT_GAP = 0.5  # cm between the line's inner edge and the cap tops
LOCKUP_W = 12.0
LOCKUP_Z = -14.0
RING = dict(x=-8.5, z=7.0, r=3.2)  # bottom-left on screen, half under the hand and the rail

RED = "#E33131"
BONE = "#E9E2D2"


# ---------- helpers ----------

def srgb_to_lin(c):
    c = np.asarray(c, dtype=np.float64)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def lin_to_srgb(c):
    c = np.clip(c, 0.0, 1.0)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)


def to_u8(a):
    return (np.clip(a, 0, 1) * 255 + 0.5).astype(np.uint8)


def spectral(shape, px_per_cm, rng, lo, hi, slope=0.0):
    """Zero-mean unit-std periodic noise with energy between lo and hi cycles per cm."""
    h, w = shape
    fy = np.fft.fftfreq(h, d=1 / px_per_cm)[:, None]
    fx = np.fft.fftfreq(w, d=1 / px_per_cm)[None, :]
    f = np.hypot(fx, fy)
    band = ((f >= lo) & (f <= hi)) * np.where(f > 0, f, 1.0) ** (-slope)
    n = np.real(np.fft.ifft2(np.fft.fft2(rng.standard_normal(shape)) * band))
    return (n - n.mean()) / (n.std() + 1e-12)


def periodic_blur(a, sigma_px):
    """Gaussian blur with wrap-around, so tiles stay seamless."""
    h, w = a.shape
    fy = np.fft.fftfreq(h)[:, None]
    fx = np.fft.fftfreq(w)[None, :]
    g = np.exp(-2 * (math.pi * sigma_px) ** 2 * (fx ** 2 + fy ** 2))
    return np.real(np.fft.ifft2(np.fft.fft2(a) * g))


def strands(size, rng, count, length_px, wiggle, value_range, pad=64):
    """Short curved 1 px fibres, drawn on a padded canvas then folded back so the tile wraps."""
    big = size + 2 * pad
    img = Image.new("L", (big, big), 0)
    draw = ImageDraw.Draw(img)
    for _ in range(count):
        x, y = rng.uniform(pad, pad + size, 2)
        ang = rng.uniform(0, 2 * math.pi)
        seg = rng.uniform(*length_px) / 4
        pts = [(x, y)]
        for _ in range(4):
            ang += rng.normal(0, wiggle)
            x, y = x + seg * math.cos(ang), y + seg * math.sin(ang)
            pts.append((x, y))
        draw.line(pts, fill=int(rng.uniform(*value_range)), width=1)
    a = np.asarray(img, dtype=np.float64) / 255
    tile = a[pad:pad + size, pad:pad + size].copy()
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            if dx or dy:
                src = a[pad + dy * size:pad + dy * size + size, pad + dx * size:pad + dx * size + size]
                if src.shape == tile.shape:
                    tile = np.maximum(tile, src)
    return tile


def normal_from_height(h, strength):
    """Tangent-space normal map (OpenGL, +Y up) from a periodic height field; image row 0 is the top."""
    dx = (np.roll(h, -1, 1) - np.roll(h, 1, 1)) * 0.5
    dy = (np.roll(h, 1, 0) - np.roll(h, -1, 0)) * 0.5  # +v points up the image
    n = np.stack([-dx * strength, -dy * strength, np.ones_like(h)], -1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    return to_u8(n * 0.5 + 0.5)


def save_jpg(arr, path, quality):
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(arr).save(path, "JPEG", quality=quality, subsampling=0)


def hex_rgb(h: str):
    return np.array([int(h[i:i + 2], 16) for i in (1, 3, 5)]) / 255


def data_uri_png(img: Image.Image) -> str:
    buf = io.BytesIO()
    img.save(buf, "PNG", optimize=True)
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


# ---------- felt ----------

def felt_fields(size, seed):
    """Luminance, hue and height fields shared by both felt colours (one seed, same fibres)."""
    rng = np.random.default_rng(seed)
    ppcm = size / TILE_CM
    fuzz = periodic_blur(rng.standard_normal((size, size)), 0.7 * size / 1024)
    fuzz /= fuzz.std()
    pill = spectral((size, size), ppcm, rng, 1.2, 6.0)
    cloud = spectral((size, size), ppcm, rng, 0.08, 0.35)
    hue = spectral((size, size), ppcm, rng, 0.15, 2.5)
    scale = size / 1024
    light = strands(size, rng, int(16000 * scale ** 2), (8 * scale, 30 * scale), 0.35, (90, 255))
    dark = strands(size, rng, int(11000 * scale ** 2), (8 * scale, 26 * scale), 0.35, (90, 255))
    lint = strands(size, rng, 6, (30 * scale, 70 * scale), 0.22, (150, 230))
    specks = np.zeros((size, size))
    for _ in range(18):
        y, x = rng.integers(0, size, 2)
        specks[y, x] = rng.uniform(0.5, 1.0)
    light, dark = periodic_blur(light, 0.45 * scale), periodic_blur(dark, 0.45 * scale)
    lint, specks = periodic_blur(lint, 0.6 * scale), periodic_blur(specks, 0.8 * scale) * 3
    lum = 1 + 0.085 * fuzz + 0.035 * pill + 0.03 * cloud + 0.22 * light - 0.20 * dark - 0.5 * specks
    height = 0.35 * periodic_blur(fuzz, 1.2 * scale) + 0.8 * light + 0.4 * dark + 0.3 * pill + 1.2 * lint
    return lum, hue, lint, height


def build_felt(size, seed):
    lum, hue, lint, height = felt_fields(size, seed)
    out = {}
    for name, base in FELTS.items():
        lin = srgb_to_lin(np.array(base) / 255.0)
        # Fibres of two dye lots: a yellower and a bluer cast, about +/-4 %.
        tint = np.stack([1 + 0.03 * hue, 1 + 0.01 * hue, 1 - 0.04 * hue], -1)
        col = lin[None, None, :] * lum[..., None] * tint
        lint_col = srgb_to_lin(np.array([214, 206, 188]) / 255.0)
        col = col * (1 - 0.45 * lint[..., None]) + lint_col * 0.45 * lint[..., None] * 0.5
        out[name] = to_u8(lin_to_srgb(col))
    return out, height


# ---------- print decal ----------

PRINT_HTML = """<!doctype html><html><head><style>
@font-face{font-family:mono;src:url(%(mono)s) format("woff2");font-weight:500}
html,body{margin:0;background:transparent}
svg{display:block}
</style></head><body>
<svg xmlns="http://www.w3.org/2000/svg" width="%(w)d" height="%(h)d" viewBox="0 0 %(w)d %(h)d">
  <defs><path id="textArc" d="%(text_arc)s"/></defs>
  <path d="%(line_arc)s" fill="none" stroke="%(red)s" stroke-opacity="0.7" stroke-width="%(line_w).2f"/>
  <text font-family="mono" font-weight="500" font-size="%(font_px).2f" letter-spacing="%(track).2f"
        fill="%(bone)s" fill-opacity="0.12" text-anchor="middle">
    <textPath href="#textArc" startOffset="50%%">%(text)s</textPath>
  </text>
  <image href="%(lockup)s" x="%(lx).1f" y="%(ly).1f" width="%(lw).1f" height="%(lh).1f" opacity="0.08"/>
</svg></body></html>"""


def arc_path(cx, cy, r, span_deg):
    a = math.radians(span_deg)
    x0, y0 = cx - r * math.sin(a), cy - r * math.cos(a)
    x1, y1 = cx + r * math.sin(a), cy - r * math.cos(a)
    return f"M {x0:.2f} {y0:.2f} A {r:.2f} {r:.2f} 0 0 1 {x1:.2f} {y1:.2f}"


def lockup_ink():
    """The site lockup (+ nomada / toast) as two flat inks: red stays red, the rest prints bone."""
    svg = (SITE / "brand/arc-logo.svg").read_text()
    png = base64.b64decode(re.search(r'href="data:image/png;base64,([^"]+)"', svg).group(1))
    src = np.asarray(Image.open(io.BytesIO(png)).convert("RGBA"), dtype=np.float64) / 255
    r, g, b, a = src[..., 0], src[..., 1], src[..., 2], src[..., 3]
    red = (r > 0.55) & (g < 0.45) & (b < 0.45)
    lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
    rgb = np.where(red[..., None], hex_rgb(RED), hex_rgb(BONE))
    alpha = np.where(red, a, a * np.clip(lum * 1.15, 0, 1))
    img = Image.fromarray(to_u8(np.dstack([rgb, alpha])), "RGBA")
    bbox = img.getbbox()
    return img.crop(bbox)


def glass_ring(w, h, ppcm):
    """A faint residue ring left by a wet glass: uneven rim, one heavier arc, a break."""
    x0 = (RING["x"] + PRINT_CM[0] / 2) * ppcm
    y0 = (RING["z"] - (PRINT_CENTRE_Z - PRINT_CM[1] / 2)) * ppcm
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float64)
    d = np.hypot(xx - x0, yy - y0) / ppcm
    ang = np.arctan2(yy - y0, xx - x0)
    wob = 0.05 * np.sin(3 * ang + 1.3) + 0.03 * np.sin(7 * ang + 0.4)
    rim = np.exp(-0.5 * ((d - RING["r"] - wob) / 0.06) ** 2)
    heavy = 0.55 + 0.45 * np.cos(ang - 2.4) ** 2
    gap = 1 - 0.85 * np.exp(-0.5 * ((ang - 0.6) / 0.25) ** 2)
    haze = 0.25 * np.exp(-0.5 * ((d - RING["r"] + 0.25) / 0.2) ** 2)
    return np.clip((rim * heavy + haze) * gap * 0.11, 0, 1)


def build_print(seed):
    from playwright.sync_api import sync_playwright

    w, h = 2048, 1024
    ppcm = w / PRINT_CM[0]
    z_top = PRINT_CENTRE_Z - PRINT_CM[1] / 2

    def px(x, z):
        return (x + PRINT_CM[0] / 2) * ppcm, (z - z_top) * ppcm

    cx, cy = px(*ARC_CENTRE)
    text_r = ARC_R - ARC_WIDTH / 2 - ARC_TEXT_GAP - 0.72 * ARC_TEXT_SIZE
    lock = lockup_ink()
    lw = LOCKUP_W * ppcm
    lh = lw * lock.height / lock.width
    lx, ly = px(0, LOCKUP_Z)
    mono = (FONT_SRC / "PPNeueMontrealMono_Medium-s.p.1gnh4ljroxkv0.woff2").read_bytes()
    html = PRINT_HTML % dict(
        w=w, h=h, red=RED, bone=BONE,
        line_arc=arc_path(cx, cy, ARC_R * ppcm, ARC_SPAN_DEG),
        text_arc=arc_path(cx, cy, text_r * ppcm, 70), line_w=ARC_WIDTH * ppcm,
        font_px=ARC_TEXT_SIZE * ppcm, track=0.1 * ARC_TEXT_SIZE * ppcm, text=ARC_TEXT,
        mono="data:font/woff2;base64," + base64.b64encode(mono).decode(),
        lockup=data_uri_png(lock), lx=lx - lw / 2, ly=ly - lh / 2, lw=lw, lh=lh)
    WORK.mkdir(parents=True, exist_ok=True)
    page_file = WORK / "print.html"
    page_file.write_text(html, encoding="utf-8")
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page(viewport={"width": w, "height": h}, device_scale_factor=1)
        page.goto(page_file.resolve().as_uri())
        page.evaluate("document.fonts.ready")
        page.wait_for_timeout(150)
        png = page.screenshot(omit_background=True, clip={"x": 0, "y": 0, "width": w, "height": h})
        browser.close()
    rgba = np.asarray(Image.open(io.BytesIO(png)).convert("RGBA"), dtype=np.float64) / 255
    rgb, alpha = rgba[..., :3], rgba[..., 3]

    ring = glass_ring(w, h, ppcm)
    rng = np.random.default_rng(seed + 11)
    bone = hex_rgb(BONE)
    rgb = (rgb * alpha[..., None] + bone * ring[..., None] * (1 - alpha[..., None]))
    alpha = alpha + ring * (1 - alpha)
    rgb = np.where(alpha[..., None] > 1e-6, rgb / np.maximum(alpha[..., None], 1e-6), bone)

    # Dye soaked into felt: bleed the edges a little, then break the coverage up with fibres.
    alpha = np.asarray(Image.fromarray(to_u8(alpha)).filter(ImageFilter.GaussianBlur(0.7)), dtype=np.float64) / 255
    fib = periodic_blur(rng.standard_normal((h, w)), 0.8)
    fib /= fib.std()
    blot = spectral((h, w), ppcm, rng, 0.15, 1.5)
    alpha *= np.clip(0.72 + 0.2 * fib + 0.12 * blot, 0, 1)

    # Transparent texels take the nearby ink colour so mipmaps do not fringe dark.
    weight = alpha[..., None]
    spread = np.dstack([periodic_blur(rgb[..., i] * alpha, 12) for i in range(3)])
    norm = periodic_blur(alpha, 12)[..., None]
    fill = np.where(norm > 1e-4, spread / np.maximum(norm, 1e-4), bone)
    rgb = rgb * np.minimum(weight * 8, 1) + fill * (1 - np.minimum(weight * 8, 1))
    # Quantised alpha keeps the PNG small; the fibre noise hides the steps.
    a8 = (np.round(alpha * 63) / 63)
    return Image.fromarray(to_u8(np.dstack([rgb, a8])), "RGBA")


# ---------- rail leather ----------

RAIL_CIRC_CM = 2 * math.pi * 2.6
STITCH_U = 0.60  # around the cylinder: 0.5 faces the felt, 0.75 is the crest; 0.56-0.64 shows on screen


def build_rail(w, seed):
    """Albedo + normal, w px around the rail and 2w along it (16.34 x 32.68 cm)."""
    h = 2 * w
    ppcm = w / RAIL_CIRC_CM
    rng = np.random.default_rng(seed + 23)
    # Image rows run along the rail (v), columns around it (u).
    pebble = spectral((h, w), ppcm, rng, 3.0, 9.0)
    crease = np.abs(spectral((h, w), ppcm, rng, 0.8, 2.5))
    lowf = spectral((h, w), ppcm, rng, 0.05, 0.4)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float64)
    u = (xx + 0.5) / w
    vcm = (yy + 0.5) / ppcm

    # Rubbed-light scuffs around the crest, long along the rail.
    scuff = np.zeros((h, w))
    for _ in range(14):
        c_u = rng.uniform(0.56, 0.68)
        c_v = rng.uniform(0, h / ppcm)
        ln = rng.uniform(1.5, 5.5)
        wd = rng.uniform(0.25, 0.8) / RAIL_CIRC_CM
        dv = np.minimum(np.abs(vcm - c_v), h / ppcm - np.abs(vcm - c_v))
        scuff += rng.uniform(0.4, 1.0) * np.exp(-0.5 * (dv / (ln / 2)) ** 2 - 0.5 * ((u - c_u) / wd) ** 2)
    scuff = np.clip(scuff, 0, 1) * (0.7 + 0.3 * np.clip(pebble, -1, 1))

    base = srgb_to_lin(np.array([0xC2, 0x27, 0x2A]) / 255)
    lum = 1 + 0.05 * pebble - 0.10 * np.clip(crease - 1.2, 0, None) + 0.04 * lowf
    col = base * lum[..., None]
    rubbed = srgb_to_lin(np.array([0xDE, 0x6A, 0x62]) / 255)
    col = col * (1 - 0.32 * scuff[..., None]) + rubbed * 0.32 * scuff[..., None]

    # Cream saddle stitch: 0.32 cm stitches, 0.14 cm gaps, slight slant, sunk in a groove.
    pitch = 0.46
    phase = (vcm % pitch) / pitch
    du_cm = (u - STITCH_U) * RAIL_CIRC_CM
    slant = du_cm - 0.05 * (phase - 0.35)
    on = (phase < 0.7).astype(np.float64)
    thread = on * np.exp(-0.5 * (slant / 0.035) ** 2)
    groove = np.exp(-0.5 * (du_cm / 0.09) ** 2)
    col *= (1 - 0.35 * groove)[..., None]
    cream = srgb_to_lin(np.array([0xE6, 0xDA, 0xBE]) / 255)
    tmask = np.clip(thread * 1.6, 0, 1)[..., None]
    col = col * (1 - tmask) + cream * (0.85 + 0.15 * np.cos(phase * 2 * math.pi))[..., None] * tmask
    albedo = to_u8(lin_to_srgb(col))

    height = 0.35 * periodic_blur(pebble, 0.8) - 0.6 * np.clip(crease - 1.2, 0, None) - 2.2 * groove + 1.6 * thread - 0.3 * scuff
    return albedo, normal_from_height(height, 1.4)


# ---------- CRT grain ----------

def build_grain(rng):
    n = periodic_blur(rng.standard_normal((256, 256)), 0.55)
    n = 0.5 + 0.2 * n / n.std()
    return Image.fromarray(to_u8(n), "L")


# ---------- copies ----------

def copy_assets():
    crt = OUT / "crt"
    fonts = OUT / "fonts"
    crt.mkdir(parents=True, exist_ok=True)
    fonts.mkdir(parents=True, exist_ok=True)
    for name in ("tv-glass.webp", "tv-glass-1280.webp", "tv-glass-960.avif"):
        shutil.copyfile(SITE / "brand" / name, crt / name)
    Image.open(SITE / "brand/tv-glass-1280.webp").resize((960, 540), Image.LANCZOS).save(
        crt / "tv-glass-960.webp", "WEBP", quality=82, method=6)
    shutil.copyfile(SITE / "brand/arc-logo.svg", crt / "logo.svg")
    shutil.copyfile(FONT_SRC / "NeueBit_Bold-s.p.1o0qymtuv0t4o.woff2", fonts / "NeueBit-Bold.woff2")
    shutil.copyfile(FONT_SRC / "PPNeueMontrealMono_Medium-s.p.1gnh4ljroxkv0.woff2",
                    fonts / "PPNeueMontrealMono-Medium.woff2")


def review_sheet(felts, normal, print_img, rail, rail_n):
    """One image for a human look: felt tiles 2 x 2, normal, rail strips, print over green felt."""
    sheet = Image.new("RGB", (2048 + 40, 560 + 1024 + 20), (20, 20, 20))
    for i, (name, arr) in enumerate(felts.items()):
        tile = Image.fromarray(arr).resize((512, 512), Image.LANCZOS)
        two = Image.new("RGB", (1024, 1024))
        for oy in (0, 512):
            for ox in (0, 512):
                two.paste(tile, (ox, oy))
        sheet.paste(two.resize((512, 512)), (20 + i * 532, 20))
    sheet.paste(Image.fromarray(normal).resize((512, 512)), (20 + 2 * 532, 20))
    sheet.paste(Image.fromarray(rail).resize((128, 256)), (20 + 3 * 532, 20))
    sheet.paste(Image.fromarray(rail_n).resize((128, 256)), (20 + 3 * 532 + 140, 20))
    green = Image.fromarray(felts["green"])
    under = Image.new("RGBA", (2048, 1024))
    under.paste(green, (0, 0))
    under.paste(green, (1024, 0))
    under.alpha_composite(print_img)
    sheet.paste(under.convert("RGB"), (20, 560))
    return sheet


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--seed", type=int, default=7331)
    args = ap.parse_args()

    hi, lo = OUT / "table/hi", OUT / "table/lo"
    hi.mkdir(parents=True, exist_ok=True)
    lo.mkdir(parents=True, exist_ok=True)
    WORK.mkdir(parents=True, exist_ok=True)

    felts, height = build_felt(1024, args.seed)
    for name, arr in felts.items():
        save_jpg(arr, hi / f"felt-{name}-1024.jpg", 90)
        save_jpg(np.asarray(Image.fromarray(arr).resize((512, 512), Image.LANCZOS)), lo / f"felt-{name}-512.jpg", 88)
    h512 = np.asarray(Image.fromarray(height.astype(np.float32), "F").resize((512, 512), Image.BOX), dtype=np.float64)
    h256 = np.asarray(Image.fromarray(height.astype(np.float32), "F").resize((256, 256), Image.BOX), dtype=np.float64)
    normal = normal_from_height(h512, 1.1)
    save_jpg(normal, hi / "felt-normal-512.jpg", 88)
    save_jpg(normal_from_height(h256, 0.6), lo / "felt-normal-256.jpg", 88)

    print_img = build_print(args.seed)
    print_img.save(hi / "felt-print-2048.png", optimize=True)
    print_img.resize((1024, 512), Image.LANCZOS).save(lo / "felt-print-1024.png", optimize=True)

    rail, rail_n = build_rail(512, args.seed)
    save_jpg(rail, hi / "rail-leather-512.jpg", 88)
    save_jpg(np.asarray(Image.fromarray(rail).resize((256, 512), Image.LANCZOS)), lo / "rail-leather-256.jpg", 86)
    # The rail shows as a sliver at the screen's foot, so its bumps can be coarser than its albedo.
    save_jpg(np.asarray(Image.fromarray(rail_n).resize((256, 512), Image.LANCZOS)), hi / "rail-normal-256.jpg", 85)
    save_jpg(np.asarray(Image.fromarray(rail_n).resize((128, 256), Image.LANCZOS)), lo / "rail-normal-128.jpg", 85)

    copy_assets()
    build_grain(np.random.default_rng(args.seed + 5)).save(OUT / "crt/grain.png", optimize=True)
    review_sheet(felts, normal, print_img, rail, rail_n).save(WORK / "review.jpg", "JPEG", quality=88)

    for p in sorted(q for d in ("table", "crt", "fonts") for q in (OUT / d).rglob("*")
                    if q.is_file() and not q.name.startswith("._")):
        print(f"{p.stat().st_size / 1024:8.1f} kB  {p.relative_to(PROJECT)}")


if __name__ == "__main__":
    main()
