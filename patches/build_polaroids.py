#!/usr/bin/env python3
"""Build the 80s instant-film polaroids for cards/ from the user's Tino Assets.

Writes, for each card id in cards/data/cards.json:
  cards/assets/cards/{hi,lo}/<id>-front.webp   white polaroid frame, 80s-graded photo, handwritten caption
  cards/assets/cards/{hi,lo}/<id>-wear.png     R = signed distance to the outline, G = whitening, B = height
  cards/assets/cards/{hi,lo}/<id>-gloss.png    glossy photo, matte frame, fingerprints
  cards/assets/cards/{hi,lo}/back.webp         the dark film back
and rewrites the card size and captions in cards/data/cards.json.
A contact sheet goes to patches/build/polaroids/contact.jpg.

Usage: python3 patches/build_polaroids.py   (needs Pillow + numpy from the user site-packages)
"""
from __future__ import annotations

import json
import zlib
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

PROJECT = Path(__file__).resolve().parent.parent
CARDS = PROJECT / "cards"
OUT = CARDS / "assets/cards"
BUILD = PROJECT / "patches/build/polaroids"
TINO = Path("/Volumes/SSD/Tino Assets")
FONTS = Path("/System/Library/Fonts/Supplemental")

# Polaroid 600 proportions, scaled to the deck's 8.89 cm height (real film: 8.8 x 10.7 cm).
CARD_CM = (7.30, 8.89)
SIDE, TOP = 0.373, 0.457          # cm of white frame left/right and above the photo
PHOTO_CM = (CARD_CM[0] - 2 * SIDE, 6.39)
CORNER_CM = 0.10
WEAR_ENCODE = 0.13                # R = 0.5 + d / 0.13 cm (cards/js/config.js render.wearEncode)
SEED = 7331

TIERS = {"hi": 1024, "lo": 640}   # front width in px; wear is half, gloss a quarter

CARD_DATA = {
    # id: title, year, second line, source, focus (x, y), extras
    "a": ("Work in progress", "", "always building", "PP Toast.jpg", (0.5, 0.36), {}),
    "k": ("At home, 2024", "2024", "good ideas late", "8.1-invideo-nanobanana_2 2.png", (0.53, 0.5), {"leak": (1.0, 0.0)}),
    "q": ("Tools I use, 24", "2024", "create, test, repeat", "hf_20260627_145124_0ec89523-a7e9-4a15-b3bd-367e2f865593.png", (0.5, 0.5), {}),
    "j": ("A long story, 2023", "2023", "same me, new chapter", "xray skeleton 2.png", (0.42, 0.5), {}),
    "10": ("Road Trip, somewhere '24", "2024", "good music, better directions", "5b.png", (0.46, 0.45), {"leak": (0.0, 0.7)}),
    "9": ("Night out, 2022", "2022", "dressed for it", "hf_20260626_234900_1840de45-0979-43f2-b199-b44aa70af150.png", (0.5, 0.42), {}),
    "8": ("Good days, 2021", "2021", "keep it simple", "smile PP.jpg", (0.55, 0.4), {}),
    "7": ("Late shift, 2023", "2023", "one more idea", "hf_20260313_152347_4ffc25cd-bad7-4894-9644-4083137d3032.png", (0.5, 0.45), {"leak": (1.0, 0.2)}),
    "6": ("Day off, 2022", "2022", "recharging", "hf_20260722_211353_2d6ffd9b-32b6-477c-ba16-b150e0d0fcf1 2.png", (0.45, 0.5), {}),
}
CAPTION = {cid: data[0] for cid, data in CARD_DATA.items()}
CURL = {"a": (0.11, 0.05, 0.03), "k": (0.08, 0.04, 0.02), "q": (0.06, 0.03, 0.02),
        "j": (0.12, 0.06, 0.04), "10": (0.09, 0.05, 0.03), "9": (0.07, 0.03, 0.02),
        "8": (0.1, 0.04, 0.03), "7": (0.08, 0.05, 0.02), "6": (0.11, 0.04, 0.03)}


def rng(key: str) -> np.random.Generator:
    return np.random.default_rng(zlib.crc32(f"{SEED}:{key}".encode()))


def fbm(shape, rnd, octaves=4, scale=8.0):
    """Smooth value noise in [0, 1] made of upsampled random grids."""
    h, w = shape
    acc = np.zeros(shape, np.float32)
    amp, total = 1.0, 0.0
    for o in range(octaves):
        gh, gw = max(2, int(scale * 2**o * h / max(h, w))), max(2, int(scale * 2**o * w / max(h, w)))
        grid = Image.fromarray((rnd.random((gh, gw)) * 255).astype(np.uint8))
        acc += amp * np.asarray(grid.resize((w, h), Image.BICUBIC), np.float32) / 255
        total += amp
        amp *= 0.5
    return acc / total


def cover_crop(img: Image.Image, size, focus) -> Image.Image:
    w, h = img.size
    tw, th = size
    s = max(tw / w, th / h)
    img = img.resize((round(w * s), round(h * s)), Image.LANCZOS)
    w, h = img.size
    x = min(max(0, round(focus[0] * w - tw / 2)), w - tw)
    y = min(max(0, round(focus[1] * h - th / 2)), h - th)
    return img.crop((x, y, x + tw, y + th))


def instant_film(img: Image.Image, cid: str, extras: dict) -> Image.Image:
    """80s instant-film look: soft lens, lifted cool blacks, warm creamy highlights, flash hot spot,
    vignette, grain, uneven chemistry at the borders, optional light leak and date stamp."""
    rnd = rng("film:" + cid)
    img = img.filter(ImageFilter.GaussianBlur(img.width / 900))
    a = np.asarray(img.convert("RGB"), np.float32) / 255
    h, w, _ = a.shape
    lum = a @ np.array([0.2126, 0.7152, 0.0722], np.float32)
    # Tone: crush nothing, lift blacks toward teal, fade the whites toward cream.
    lo = np.array([0.10, 0.11, 0.12], np.float32)
    hi = np.array([0.97, 0.93, 0.83], np.float32)
    a = lo + (hi - lo) * np.power(np.clip(a, 0, 1), 1.08)
    a = a + (1 - lum[..., None]) * np.array([-0.025, 0.012, 0.03], np.float32)        # cyan-green shadows
    a = a + lum[..., None] * (1 - lum[..., None]) * np.array([0.06, 0.015, -0.03], np.float32)  # warm mids
    g = (a @ np.array([0.2126, 0.7152, 0.0722], np.float32))[..., None]
    a = g + (a - g) * 0.86
    # On-camera flash: bright centre, falling into dark corners.
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    r2 = ((xx / w - 0.5) / 0.5) ** 2 + ((yy / h - 0.46) / 0.5) ** 2
    a = a * (1 + 0.14 * np.exp(-r2 / 0.35))[..., None]
    a = a * (1 - 0.38 * np.clip(r2 / 2, 0, 1) ** 1.6)[..., None]
    if "leak" in extras:
        lx, ly = extras["leak"]
        d = np.sqrt((xx / w - lx) ** 2 + (yy / h - ly) ** 2)
        leak = np.exp(-(d / 0.45) ** 2)[..., None] * np.array([1.0, 0.42, 0.18], np.float32) * 0.75
        a = 1 - (1 - a) * (1 - leak)                                                    # screen blend
    a = a + (rnd.normal(0, 0.035, (h, w, 1)) + rnd.normal(0, 0.012, (h, w, 3))).astype(np.float32)
    # Chemistry: a ragged darker band hugging the border, heavier along the bottom (the reagent pod).
    edge = np.minimum.reduce([xx, w - 1 - xx, yy, (h - 1 - yy) * 0.6]) / w
    rag = 0.006 + 0.012 * fbm((h, w), rnd, 3, 14)
    band = np.clip(1 - edge / rag, 0, 1)
    a = a * (1 - 0.55 * band)[..., None] + band[..., None] * np.array([0.05, 0.04, 0.03], np.float32) * 0.5
    out = Image.fromarray((np.clip(a, 0, 1) * 255).astype(np.uint8))
    if "stamp" in extras:
        out = date_stamp(out, extras["stamp"])
    return out


def date_stamp(img: Image.Image, text: str) -> Image.Image:
    """The orange LED date a 1980s compact burned into the corner of the frame."""
    w, h = img.size
    font = ImageFont.truetype("/System/Library/Fonts/Avenir Next Condensed.ttc", round(w * 0.055), index=5)
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    tw = d.textlength(text, font=font)
    pos = (w - tw - w * 0.07, h - w * 0.12)
    d.text(pos, text, font=font, fill=(255, 140, 40, 235))
    glow = layer.filter(ImageFilter.GaussianBlur(w * 0.006))
    base = img.convert("RGBA")
    base.alpha_composite(glow)
    base.alpha_composite(layer.filter(ImageFilter.GaussianBlur(w * 0.0012)))
    return base.convert("RGB")


def source_image(cid: str, src: str | None) -> Image.Image:
    return Image.open(TINO / src).convert("RGB")


def front(cid: str, W: int) -> Image.Image:
    title, _, line2, src, focus, extras = CARD_DATA[cid]
    px = W / CARD_CM[0]
    H = round(CARD_CM[1] * px)
    rnd = rng("frame:" + cid)
    # Frame: off-white board with paper tooth, yellowing toward the edges, a little handling grime.
    base = np.array([243, 240, 232], np.float32) / 255
    tooth = fbm((H, W), rnd, 5, 40)[..., None]
    frame = base * (0.97 + 0.05 * tooth)
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    edge = np.minimum.reduce([xx, W - 1 - xx, yy, H - 1 - yy]) / px                    # cm from the edge
    yellow = np.clip(1 - edge / 0.7, 0, 1) ** 1.5 * (0.4 + 0.6 * fbm((H, W), rnd, 3, 6))
    frame = frame * (1 - yellow[..., None] * np.array([0.02, 0.07, 0.2], np.float32))
    # Handled border: a broken band of grey grime hugging the edge, darker in the corners.
    rim = np.clip(1 - edge / 0.12, 0, 1) * (0.3 + 0.7 * (fbm((H, W), rnd, 4, 40) > 0.45))
    corner = np.exp(-((np.minimum(xx, W - 1 - xx) / px) ** 2 + (np.minimum(yy, H - 1 - yy) / px) ** 2) / 0.35)
    frame = frame * (1 - (0.22 * rim + 0.18 * corner)[..., None])
    grime = (fbm((H, W), rnd, 4, 10) > 0.68) * fbm((H, W), rnd, 3, 30) * 0.06
    frame = frame * (1 - grime[..., None])
    canvas = Image.fromarray((np.clip(frame, 0, 1) * 255).astype(np.uint8))

    pw, ph = round(PHOTO_CM[0] * px), round(PHOTO_CM[1] * px)
    photo = instant_film(cover_crop(source_image(cid, src), (pw, ph), focus), cid, extras)
    ox, oy = round(SIDE * px), round(TOP * px)
    canvas.paste(photo, (ox, oy))
    # A hairline of shadow where the print sits under the frame's window.
    d = ImageDraw.Draw(canvas, "RGBA")
    d.rectangle((ox - 1, oy - 1, ox + pw, oy + ph), outline=(60, 50, 40, 70), width=max(1, round(px * 0.012)))

    # Handwritten caption in ballpoint, two lines, slightly off level like the reference.
    ink = (32, 34, 52, 235)
    f1 = ImageFont.truetype(str(FONTS / "Bradley Hand Bold.ttf"), round(px * 0.40))
    f2 = ImageFont.truetype(str(FONTS / "Bradley Hand Bold.ttf"), round(px * 0.34))
    text = Image.new("RGBA", (W, round(2.0 * px)), (0, 0, 0, 0))
    td = ImageDraw.Draw(text)
    td.text((W * 0.5, px * 0.55), CAPTION[cid], font=f1, fill=ink, anchor="mm")
    td.text((W * 0.5 + px * 0.25, px * 1.15), line2, font=f2, fill=ink, anchor="mm")
    text = text.rotate(float(rnd.uniform(-2.2, 1.6)), resample=Image.BICUBIC, center=(W / 2, px))
    text = text.filter(ImageFilter.GaussianBlur(px * 0.004))
    out = canvas.convert("RGBA")
    out.alpha_composite(text, (0, oy + ph + round(px * 0.12)))
    return out.convert("RGB")


def back(W: int) -> Image.Image:
    """The film's black back: matte plastic, the raised reagent-pod strip, small white print (unbranded)."""
    px = W / CARD_CM[0]
    H = round(CARD_CM[1] * px)
    rnd = rng("back")
    tex = fbm((H, W), rnd, 5, 50)
    a = (0.105 + 0.02 * tex)[..., None] * np.array([1.0, 0.98, 0.96], np.float32)
    pod = (np.mgrid[0:H, 0:W][0] > H - 2.0 * px).astype(np.float32)
    a = a * (1 + 0.15 * pod[..., None])
    img = Image.fromarray((np.clip(a, 0, 1) * 255).astype(np.uint8))
    d = ImageDraw.Draw(img)
    small = ImageFont.truetype("/System/Library/Fonts/Avenir Next.ttc", round(px * 0.17), index=5)
    tiny = ImageFont.truetype("/System/Library/Fonts/Avenir Next.ttc", round(px * 0.12), index=0)
    ink = (225, 220, 210)
    d.text((W / 2, px * 0.7), "INSTANT FILM", font=small, fill=ink, anchor="mm")
    d.text((W / 2, px * 1.0), "600 SERIES · KEEP AWAY FROM HEAT · DO NOT CUT", font=tiny, fill=(150, 146, 140), anchor="mm")
    return img


def wear_and_gloss(cid: str, W: int):
    """R: signed distance to the outline (positive inside), G: whitening, B: height, plus the gloss map."""
    px = W / CARD_CM[0]
    H = round(CARD_CM[1] * px)
    rnd = rng("wear:" + cid)
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    x = (xx + 0.5) / px - CARD_CM[0] / 2
    y = (yy + 0.5) / px - CARD_CM[1] / 2
    qx = np.abs(x) - (CARD_CM[0] / 2 - CORNER_CM)
    qy = np.abs(y) - (CARD_CM[1] / 2 - CORNER_CM)
    outside = np.hypot(np.maximum(qx, 0), np.maximum(qy, 0)) + np.minimum(np.maximum(qx, qy), 0) - CORNER_CM
    # Frayed, chipped outline: high-frequency fray plus a few bites out of the edges.
    d = -outside - 0.03 * (fbm((H, W), rnd, 4, 60) - 0.5) - 0.012 * (fbm((H, W), rnd, 2, 160) - 0.5)
    for _ in range(int(rnd.integers(4, 9))):
        along = rnd.uniform(0, 1)
        ex, ey = [(along * CARD_CM[0] - CARD_CM[0] / 2, -CARD_CM[1] / 2), (along * CARD_CM[0] - CARD_CM[0] / 2, CARD_CM[1] / 2),
                  (-CARD_CM[0] / 2, along * CARD_CM[1] - CARD_CM[1] / 2), (CARD_CM[0] / 2, along * CARD_CM[1] - CARD_CM[1] / 2)][int(rnd.integers(0, 4))]
        d = np.minimum(d, np.hypot(x - ex, y - ey) - rnd.uniform(0.03, 0.07))
    R = np.clip(0.5 + d / WEAR_ENCODE, 0, 1)
    # Whitening: rubbed corners and a few fine scratches across the glossy print.
    Gimg = Image.new("L", (W, H), 0)
    gd = ImageDraw.Draw(Gimg)
    for _ in range(int(rnd.integers(3, 7))):
        x0, y0 = rnd.uniform(SIDE, CARD_CM[0] - SIDE) * px, rnd.uniform(TOP, TOP + PHOTO_CM[1]) * px
        ang, ln = rnd.uniform(0, np.pi), rnd.uniform(0.4, 2.2) * px
        gd.line((x0, y0, x0 + np.cos(ang) * ln, y0 + np.sin(ang) * ln), fill=int(rnd.uniform(60, 140)), width=1)
    G = np.asarray(Gimg, np.float32) / 255
    to_corner = np.hypot(np.abs(x) - CARD_CM[0] / 2, np.abs(y) - CARD_CM[1] / 2)
    rub = np.exp(-(to_corner / 0.45) ** 2)
    edge_cm = np.minimum(CARD_CM[0] / 2 - np.abs(x), CARD_CM[1] / 2 - np.abs(y))
    scuff = np.clip(1 - edge_cm / 0.08, 0, 1) * (fbm((H, W), rnd, 4, 50) > 0.5)
    G = np.clip(G + 0.6 * rub * fbm((H, W), rnd, 3, 20) + 0.25 * scuff, 0, 1)
    # Height: the print sits a hair below the frame, so its window edge catches the light.
    inside = ((x > -CARD_CM[0] / 2 + SIDE) & (x < CARD_CM[0] / 2 - SIDE) &
              (y > -CARD_CM[1] / 2 + TOP) & (y < -CARD_CM[1] / 2 + TOP + PHOTO_CM[1])).astype(np.float32)
    inside = np.asarray(Image.fromarray((inside * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(px * 0.02)), np.float32) / 255
    B = 0.5 - 0.035 * inside
    wear = Image.fromarray((np.dstack([R, G, B]) * 255).round().astype(np.uint8))
    # Gloss: satin frame, glossy print, a thumbprint or two on the photo.
    gloss = 0.30 + 0.58 * inside + 0.05 * (fbm((H, W), rnd, 3, 12) - 0.5)
    for _ in range(int(rnd.integers(1, 3))):
        cx, cy = rnd.uniform(SIDE + 0.5, CARD_CM[0] - SIDE - 0.5) * px, rnd.uniform(TOP + 0.5, TOP + PHOTO_CM[1] - 0.5) * px
        rr = ((xx - cx) ** 2 + ((yy - cy) * 0.8) ** 2) / (0.55 * px) ** 2
        ridges = 0.5 + 0.5 * np.sin(np.sqrt(rr) * 38)
        gloss -= np.exp(-rr * 2) * (0.18 + 0.12 * ridges) * inside
    gloss = Image.fromarray((np.clip(gloss, 0, 1) * 255).astype(np.uint8), "L")
    return wear, gloss


def save_tiers(cid: str, make_front):
    for tier, W in TIERS.items():
        d = OUT / tier
        d.mkdir(parents=True, exist_ok=True)
        make_front(W).save(d / f"{cid}-front.webp", quality=88)
        wear, gloss = wear_and_gloss(cid, W // 2)
        wear.save(d / f"{cid}-wear.png")
        gloss.resize((W // 4, round(W // 4 * CARD_CM[1] / CARD_CM[0])), Image.LANCZOS).save(d / f"{cid}-gloss.png")


def update_manifest():
    path = CARDS / "data/cards.json"
    m = json.loads(path.read_text())
    m["cardCm"], m["cornerCm"] = list(CARD_CM), CORNER_CM
    m.pop("video9", None)   # every polaroid is a still for now
    for c in m["cards"]:
        title, year, line2, *_ = CARD_DATA[c["id"]]
        c.update(rank=year, title=title, sub=line2, accent="#E8542A", wear=0.4, backFade=0.0,
                 dogEar=None, curl=dict(zip(("long", "lat", "twist"), CURL[c["id"]])))
    path.write_text(json.dumps(m, indent=1) + "\n")


def contact_sheet():
    BUILD.mkdir(parents=True, exist_ok=True)
    ids = ["9", "10", "j", "q", "k", "a"]
    ims = [Image.open(OUT / "hi" / f"{i}-front.webp") for i in ids] + [Image.open(OUT / "hi/back.webp")]
    tw = 360
    th = round(tw * CARD_CM[1] / CARD_CM[0])
    sheet = Image.new("RGB", (len(ims) * (tw + 20) + 20, th + 40), (246, 233, 223))
    for i, im in enumerate(ims):
        sheet.paste(im.resize((tw, th), Image.LANCZOS), (20 + i * (tw + 20), 20))
    sheet.save(BUILD / "contact.jpg", quality=88)


def main():
    for cid in CARD_DATA:
        save_tiers(cid, lambda W, cid=cid: front(cid, W))
        print("polaroid", cid)
    for tier, W in TIERS.items():
        back(W).save(OUT / tier / "back.webp", quality=88)
    update_manifest()
    contact_sheet()
    print("contact sheet:", BUILD / "contact.jpg")


if __name__ == "__main__":
    main()
