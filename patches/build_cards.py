#!/usr/bin/env python3
"""Build the NomadaToast stage-1 playing-card art (reports/cards-build-spec.md §4 and §10).

Per card: graded photo crops (numpy) -> the clean print, drawn as SVG and rendered by Playwright
Chromium at the 1500 x 2100 master (~600 dpi) -> ink-on-stock composite -> seeded wear
(silhouette SDF, ink loss, height, gloss and the ageing baked into the albedo) -> tiered outputs.

Outputs are staged in patches/build/cards/out/ and copied into cards/ by --install:
  assets/cards/{hi,lo}/<id>-front.webp, <id>-wear.png, <id>-gloss.png, back.webp
  assets/cards/dimple-normal-256.png, assets/cards/clip-9.mp4, data/cards.json
Intermediates (marks, photo crops, print renders, masters, contact.jpg) stay in patches/build/cards/.

Usage: python3 patches/build_cards.py [--only a,k] [--seed 7331] [--sheet] [--install]
  Run with plain python3 (not -I): Pillow, numpy and Playwright live in the user site-packages.
  --only rebuilds just the named cards; the back, dimple and clip are built on full runs only.

Conventions shared with the shader (cards/js/render/cardMesh.js):
  * Every texture is stored upright (row 0 = top of the card) and is decoded with flipY.
  * wear R = 0.5 + d / 0.13 cm, d = signed distance to the frayed silhouette, positive inside.
    The silhouette's nominal edge sits SILHOUETTE_INSET_CM inside the quad, so the zero
    crossing (and its anti-aliasing ramp) always lies inside the UV square.
  * video9.windowUV is [u0, v0, u1, v1] in three.js UV space (origin bottom-left, v up) and
    covers exactly the photo area inside the window's red keyline; the clip has its aspect.
  * The dimple tile holds DIMPLE_CELLS x DIMPLE_CELLS dimples; one tile spans dimpleTileCm.
  * dogEar: the hinge is the line where the distances to the corner's two quad edges sum to sizeCm.
"""
from __future__ import annotations

import argparse
import io
import json
import shutil
import subprocess
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

PROJECT = Path(__file__).resolve().parent.parent
ASSETS = Path("/Volumes/SSD/Tino Assets")
MESHY = ASSETS / "Vids/Meshy 2.mp4"
WORDMARK_SRC = ASSETS / "& Toast (1).png"
TOAST_PNG = PROJECT / "patches/build/wordmark/toast.png"
MONO_FONT = PROJECT / "site/_next/static/immutable/media/PPNeueMontrealMono_Medium-s.p.1gnh4ljroxkv0.woff2"
BUILD = PROJECT / "patches/build/cards"
STAGE = BUILD / "out"
WEB = PROJECT / "cards"

DEFAULT_SEED = 7331
CARD_CM = (6.35, 8.89)
CARD_MM = (63.5, 88.9)
W_PX, H_PX = 1500, 2100                    # master, 1 mm = 23.6 px
PX_MM = W_PX / CARD_MM[0]
CM_PX = 0.1 / PX_MM                        # cm per master pixel
TIERS = {
    "hi": dict(front=(1024, 1434), wear=(512, 717), gloss=(256, 358)),
    "lo": dict(front=(640, 896), wear=(256, 358), gloss=(128, 179)),
}
BASE_CORNER_CM = 0.32
SILHOUETTE_INSET_CM = 0.035
SILHOUETTE_MIN_GAP_CM = 0.02
SDF_RANGE_CM = 0.13
DIMPLE_CELLS = 16
DIMPLE_PERIOD_CM = 0.05

CAP = 0.714                                # cap height per em of Helvetica Neue (measured in Chromium)
PAPER = "#F2EDE3"
PAPER_EDGE = "#E6DCC8"
PAPER_BACK = "#EFE8DA"
PAPER_WORN = "#F4F0E8"                     # what the shader lightens toward where wear G is high
RUBBED = "#F4F0E6"
GRIME = "#6B5D4A"
YELLOWED = "#E9DCC2"
COFFEE = "#8A5A2B"
PRINT_RED = "#D42F2F"
BRAND_RED = "#E33131"
KEY = "#151515"

# window rectangles in mm (x0, y0, x1, y1) and their construction
WINDOWS = {"court": (9.0, 6.0, 54.5, 66.5), "pip": (17.0, 6.0, 46.5, 66.5)}
WIN_RADIUS = 1.4
FRAME_W = 0.3
KEYLINE_IN = 0.9                           # keyline sits 0.6 mm inside the frame's inner edge
KEYLINE_W = 0.13
PHOTO_IN = KEYLINE_IN + KEYLINE_W
COURT_BAR = 0.7

CLIP = dict(start=15.5, end=18.2, poster=16.55, fps=30, max_kb=600)

# Ring order (deal order, left to right).
CARDS = [
    dict(id="9", rank="9", title="3D Lab", sub="NINE OF TOAST", accent="#F2B31B", layout="pip",
         pips=(5, 4), wear=0.50),
    dict(id="10", rank="10", title="Road Test", sub="TEN OF TOAST", accent="#FF8A00", layout="pip",
         pips=(5, 5), wear=0.65, src="5b.png", focus=(0.40, 0.5), zoom=1.0, treat="film"),
    dict(id="j", rank="J", title="X-Ray", sub="JACK OF TOAST", accent="#5B7CFF", layout="court",
         wear=0.85, src="xray skeleton 2.png", focus=(0.42, 0.40), zoom=0.86, treat="xray"),
    dict(id="q", rank="Q", title="Viral Loop", sub="QUEEN OF TOAST", accent="#3FD0BD", layout="court",
         wear=0.45, src="hf_20260627_145124_0ec89523-a7e9-4a15-b3bd-367e2f865593.png",
         focus=(0.5, 0.5), zoom=0.8),
    dict(id="k", rank="K", title="AI Studio", sub="KING OF TOAST", accent="#FF5AD9", layout="court",
         wear=0.70, src="8.1-invideo-nanobanana_2 2.png", focus=(0.54, 0.55), zoom=0.86),
    dict(id="a", rank="A", title="Nomada Toast", sub="ACE OF TOAST", accent="#E33131", layout="ace",
         wear=0.85, src="PP Toast.jpg", focus=(0.5, 0.3), zoom=0.74, treat="mono_red"),
]

# Per-card personality (§4.4). Coordinates in cm from the card's top-left, y down.
# Crease control points are a quadratic Bezier; ends on a card edge stay open (no fade).
GENERIC_THUMBS = [dict(c=(1.30, 7.45), r=(0.75, 0.95), ang=-30, grease=0.35),
                  dict(c=(5.05, 1.45), r=(0.70, 0.90), ang=150, grease=0.20)]
TRAITS = {
    "a": dict(whitening=1.3, dog_ear=dict(corner="tr", sizeCm=1.1, liftDeg=7),
              creases=[dict(ctrl=[(0.0, 7.05), (0.55, 7.4), (1.05, 8.89)], s=0.5)],
              thumbs=[dict(c=(4.85, 5.95), r=(0.80, 1.00), ang=-25, grease=1.0)]),
    "k": dict(creases=[dict(ctrl=[(0.0, 6.35), (3.1, 5.95), (6.35, 6.2)], s=0.8, soft=2.6)],
              thumbs=[dict(c=(6.0, 4.5), r=(0.75, 0.95), ang=12, grease=0.7)]),
    "q": dict(rings=dict(c=(3.3, 4.6), r=(1.1, 3.3), n=14), nicks=[dict(side="r", at=5.4)],
              creases=[dict(ctrl=[(0.0, 7.75), (0.45, 8.2), (0.8, 8.89)], s=0.35)]),
    "j": dict(sun=0.18, creases=[dict(ctrl=[(0.0, 1.55), (2.9, 4.3), (6.35, 8.25)], s=1.0)],
              chips=[dict(side="t", at=3.7, r=0.08)]),
    "10": dict(coffee=dict(c=(4.3, 2.7), r=1.2, span=(210, 260)), fray_corner="br",
               creases=[dict(ctrl=[(5.1, 8.89), (5.65, 8.25), (6.35, 7.85)], s=0.45)]),
    "9": dict(fleck=True, creases=[dict(ctrl=[(4.0, 8.89), (5.15, 7.7), (6.35, 6.55)], s=0.7)]),
}


# ---------- small numeric helpers ----------

def cyrb53(text: str, seed: int = 0) -> int:
    """Port of the JS cyrb53 used by cards/js/rng.js (32-bit Math.imul semantics)."""
    m = 0xFFFFFFFF
    h1, h2 = (0xDEADBEEF ^ seed) & m, (0x41C6CE57 ^ seed) & m
    for ch in text:
        c = ord(ch)
        h1 = ((h1 ^ c) * 2654435761) & m
        h2 = ((h2 ^ c) * 1597334677) & m
    h1 = ((h1 ^ (h1 >> 16)) * 2246822507) & m
    h1 ^= ((h2 ^ (h2 >> 13)) * 3266489909) & m
    h2 = ((h2 ^ (h2 >> 16)) * 2246822507) & m
    h2 ^= ((h1 ^ (h1 >> 13)) * 3266489909) & m
    return 4294967296 * (2097151 & h2) + h1


def stream(base: int, name: str) -> np.random.Generator:
    """An independent generator per feature, so tuning one feature never reshuffles another."""
    return np.random.default_rng([base & 0xFFFFFFFF, base >> 32, cyrb53(name)])


def hex01(h: str) -> np.ndarray:
    return np.array([int(h[i:i + 2], 16) for i in (1, 3, 5)], np.float32) / 255


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def mix(a, b, t):
    t = np.asarray(t, np.float32)
    if t.ndim == 2:
        t = t[..., None]
    return a + (b - a) * t


def luma(a: np.ndarray) -> np.ndarray:
    return a @ np.array([0.2126, 0.7152, 0.0722], np.float32)


def noise(rs: np.random.Generator, cell_cm: float, octaves: int = 1, gain: float = 0.5,
          shape: tuple[int, int] = (H_PX, W_PX), cm_px: float = CM_PX) -> np.ndarray:
    """Zero-mean, unit-variance smooth value noise; cell_cm is the feature size of octave one."""
    h, w = shape
    out = np.zeros(shape, np.float32)
    amp, cell = 1.0, cell_cm / cm_px
    for _ in range(octaves):
        c = max(cell, 1.0)
        gh, gw = int(h / c) + 4, int(w / c) + 4
        grid = rs.standard_normal((gh, gw)).astype(np.float32)
        up = np.asarray(Image.fromarray(grid, "F").resize((round(gw * c), round(gh * c)), Image.BICUBIC))
        oy, ox = rs.integers(0, int(c) + 1, 2)
        out += amp * up[oy:oy + h, ox:ox + w]
        amp *= gain
        cell /= 2
    out -= out.mean()
    return out / (out.std() + 1e-6)


def blur(a: np.ndarray, sigma_px: float) -> np.ndarray:
    """Separable Gaussian for small radii (edge-replicated)."""
    r = max(1, int(3 * sigma_px + 0.5))
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma_px) ** 2)
    k /= k.sum()
    p = np.pad(a, [(r, r), (0, 0)] + [(0, 0)] * (a.ndim - 2), mode="edge")
    a = sum(kv * p[i:i + a.shape[0]] for i, kv in enumerate(k))
    p = np.pad(a, [(0, 0), (r, r)] + [(0, 0)] * (a.ndim - 2), mode="edge")
    return sum(kv * p[:, i:i + a.shape[1]] for i, kv in enumerate(k)).astype(np.float32)


def down(a: np.ndarray, size: tuple[int, int]) -> np.ndarray:
    """Area-average a float field (H, W) or (H, W, C) to size = (w, h)."""
    if a.ndim == 3:
        return np.stack([down(a[..., i], size) for i in range(a.shape[2])], -1)
    return np.asarray(Image.fromarray(a.astype(np.float32), "F").resize(size, Image.BOX))


def to8(a: np.ndarray) -> np.ndarray:
    return np.clip(np.round(a * 255), 0, 255).astype(np.uint8)


def load01(path: Path) -> np.ndarray:
    return np.asarray(Image.open(path).convert("RGB"), np.float32) / 255


def save01(a: np.ndarray, path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(to8(a)).save(path)
    return path


def longest_run(flags: np.ndarray) -> np.ndarray:
    """Indices of the longest run of True values."""
    idx = np.nonzero(flags)[0]
    runs = np.split(idx, np.nonzero(np.diff(idx) > 1)[0] + 1)
    return max(runs, key=len)


GRID_X = ((np.arange(W_PX, dtype=np.float32) + 0.5) * CM_PX)[None, :]
GRID_Y = ((np.arange(H_PX, dtype=np.float32) + 0.5) * CM_PX)[:, None]


def window(cx: float, cy: float, rad: float):
    """Pixel slices around (cx, cy) +/- rad cm, with the matching local cm coordinates."""
    x0, x1 = max(0, int((cx - rad) / CM_PX)), min(W_PX, int((cx + rad) / CM_PX) + 1)
    y0, y1 = max(0, int((cy - rad) / CM_PX)), min(H_PX, int((cy + rad) / CM_PX) + 1)
    return (slice(y0, y1), slice(x0, x1)), GRID_X[:, x0:x1], GRID_Y[y0:y1, :]


def bezier(ctrl, n: int = 40) -> np.ndarray:
    (ax, ay), (bx, by), (cx, cy) = ctrl
    t = np.linspace(0, 1, n)[:, None]
    return (1 - t) ** 2 * np.array([ax, ay]) + 2 * (1 - t) * t * np.array([bx, by]) + t ** 2 * np.array([cx, cy])


def curve_field(pts: np.ndarray, reach: float):
    """Signed distance (cm) to a polyline within `reach`, plus the arc-length fraction of the
    nearest point. Pixels farther than `reach` from every segment get +inf."""
    sd = np.full((H_PX, W_PX), np.inf, np.float32)
    dist = np.full((H_PX, W_PX), np.inf, np.float32)
    along = np.zeros((H_PX, W_PX), np.float32)
    seg = np.hypot(*np.diff(pts, axis=0).T)
    cum = np.concatenate([[0], np.cumsum(seg)])
    for i in range(len(pts) - 1):
        (ax, ay), (bx, by) = pts[i], pts[i + 1]
        sl, xs, ys = window((ax + bx) / 2, (ay + by) / 2, seg[i] / 2 + reach)
        ex, ey = bx - ax, by - ay
        t = np.clip(((xs - ax) * ex + (ys - ay) * ey) / (ex * ex + ey * ey), 0, 1)
        d = np.hypot(xs - ax - ex * t, ys - ay - ey * t)
        side = np.sign(ex * (ys - ay) - ey * (xs - ax))
        closer = d < dist[sl]
        dist[sl] = np.where(closer, d, dist[sl])
        sd[sl] = np.where(closer, d * np.where(side == 0, 1, side), sd[sl])
        along[sl] = np.where(closer, (cum[i] + t * seg[i]) / cum[-1], along[sl])
    return sd, along


def sd_triangle(px, py, a, b, c):
    """Signed distance to a triangle, negative inside (after Inigo Quilez)."""
    def dot(ux, uy, vx, vy):
        return ux * vx + uy * vy

    def edge(v, e):
        t = np.clip(dot(*v, *e) / dot(*e, *e), 0, 1)
        return v[0] - e[0] * t, v[1] - e[1] * t

    e0, e1, e2 = (b[0] - a[0], b[1] - a[1]), (c[0] - b[0], c[1] - b[1]), (a[0] - c[0], a[1] - c[1])
    v0, v1, v2 = (px - a[0], py - a[1]), (px - b[0], py - b[1]), (px - c[0], py - c[1])
    s = np.sign(e0[0] * e2[1] - e0[1] * e2[0])
    q = [(edge(v, e), v, e) for v, e in ((v0, e0), (v1, e1), (v2, e2))]
    dd = np.minimum.reduce([dot(*pq, *pq) for pq, _, _ in q])
    ss = np.minimum.reduce([s * (v[0] * e[1] - v[1] * e[0]) for _, v, e in q])
    return -np.sqrt(dd) * np.sign(ss)


# ---------- brand marks ----------

def brush_plus_alpha() -> np.ndarray:
    """The brand's brush "+" at the full resolution of the source lockup (white on red there);
    patches/build/wordmark/plus.png is the same mark at half size."""
    src = np.asarray(Image.open(WORDMARK_SRC).convert("RGB").crop((455, 1501, 1300, 2666)), np.float32)
    alpha = np.clip((src[..., 1] - 49) / 206, 0, 1)
    inked = alpha.max(0) > 0.02
    x0 = int(np.argmax(inked))
    x1 = x0 + int(np.argmin(inked[x0:]))      # the first column gap ends the "+"
    a = alpha[:, x0:x1]
    rows = np.nonzero(a.max(1) > 0.02)[0]
    return a[rows[0]:rows[-1] + 1]


class Marks:
    """Brand marks resampled to the exact pixel size each placement needs (crisp, no browser scaling)."""

    def __init__(self, root: Path):
        self.root = root / "marks"
        self.root.mkdir(parents=True, exist_ok=True)
        self.plus = brush_plus_alpha()
        cols, rows = self.plus.sum(0), self.plus.sum(1)
        # stroke crossing (strokes are the dense column / row bands), as fractions of the bbox
        self.cross = (float(np.argmax(np.convolve(cols, np.ones(25), "same"))) / self.plus.shape[1],
                      float(np.argmax(np.convolve(rows, np.ones(25), "same"))) / self.plus.shape[0])
        self.plus_aspect = self.plus.shape[0] / self.plus.shape[1]
        toast = Image.open(TOAST_PNG).convert("RGBA")
        self.toast_white = toast
        self.toast_red = self._recolour_letters(toast, PRINT_RED)
        self.toast_aspect = toast.height / toast.width
        self._cache: dict = {}

    @staticmethod
    def _recolour_letters(img: Image.Image, colour: str) -> Image.Image:
        """Recolour the white letters, keeping the photo (with the red face) inside the "o"."""
        a = np.asarray(img, np.float32) / 255
        photo = (a[..., :3].min(2) < 0.985) & (a[..., 3] > 0.98)
        cols = longest_run(photo.sum(0) > 60)
        rows = longest_run(photo[:, cols[0]:cols[-1] + 1].sum(1) > 20)
        cx, cy = (cols[0] + cols[-1]) / 2, (rows[0] + rows[-1]) / 2
        r = max(cols[-1] - cols[0], rows[-1] - rows[0]) / 2
        yy, xx = np.mgrid[0:a.shape[0], 0:a.shape[1]]
        disc = 1 - smoothstep(r - 1.0, r + 1.0, np.hypot(xx - cx, yy - cy))
        rgb = mix(np.broadcast_to(hex01(colour), a[..., :3].shape), a[..., :3], disc)
        return Image.fromarray(to8(np.dstack([rgb, a[..., 3]])), "RGBA")

    def plus_png(self, width_mm: float, colour: str) -> tuple[str, float]:
        """file URI of a coloured brush "+" exactly width_mm wide at master resolution, and its height in mm."""
        key = ("plus", round(width_mm, 3), colour)
        if key not in self._cache:
            w = max(4, round(width_mm * PX_MM))
            h = round(w * self.plus_aspect)
            a = np.asarray(Image.fromarray(self.plus, "F").resize((w, h), Image.LANCZOS))
            if w > self.plus.shape[1] * 1.2:      # re-crisp the edge of an upscaled brush
                a = smoothstep(0.3, 0.7, a)
            rgba = np.dstack([np.broadcast_to(hex01(colour), (h, w, 3)), np.clip(a, 0, 1)])
            path = self.root / f"plus-{colour[1:]}-{w}.png"
            Image.fromarray(to8(rgba), "RGBA").save(path)
            self._cache[key] = (path.as_uri(), h / PX_MM)
        return self._cache[key]

    def toast_png(self, width_mm: float, red: bool) -> tuple[str, float]:
        key = ("toast", round(width_mm, 3), red)
        if key not in self._cache:
            w = round(width_mm * PX_MM)
            h = round(w * self.toast_aspect)
            img = (self.toast_red if red else self.toast_white).resize((w, h), Image.LANCZOS)
            path = self.root / f"toast-{'red' if red else 'white'}-{w}.png"
            img.save(path)
            self._cache[key] = (path.as_uri(), h / PX_MM)
        return self._cache[key]


# ---------- photos ----------

def window_rects(layout: str):
    """(frame rect, photo rect) in mm for a windowed layout."""
    x0, y0, x1, y1 = WINDOWS[layout]
    return (x0, y0, x1, y1), (x0 + PHOTO_IN, y0 + PHOTO_IN, x1 - PHOTO_IN, y1 - PHOTO_IN)


def photo_px(rect) -> tuple[int, int]:
    return round((rect[2] - rect[0]) * PX_MM), round((rect[3] - rect[1]) * PX_MM)


def cover(img: Image.Image, size: tuple[int, int], focus=(0.5, 0.5), zoom=1.0) -> np.ndarray:
    """object-fit: cover with object-position = focus; zoom < 1 crops tighter."""
    w, h = img.size
    aspect = size[0] / size[1]
    cw, ch = (h * aspect, h) if w / h > aspect else (w, w / aspect)
    cw, ch = cw * zoom, ch * zoom
    x0, y0 = (w - cw) * focus[0], (h - ch) * focus[1]
    return np.asarray(img.convert("RGB").resize(size, Image.LANCZOS, box=(x0, y0, x0 + cw, y0 + ch)),
                      np.float32) / 255


def treat(a: np.ndarray, kind: str | None) -> np.ndarray:
    """Per-source treatment before the shared faded-ink grade."""
    if kind == "mono_red":           # B&W, contrast 1.1, the red "+" kept
        red = smoothstep(0.12, 0.3, a[..., 0] - a[..., 1:].max(2))
        g = np.clip(0.5 + (luma(a) - 0.5) * 1.1, 0, 1)[..., None]
        return mix(np.repeat(g, 3, 2), a, red)
    if kind == "xray":               # greyscale with a #5B7CFF duotone in the shadows
        g = np.clip(0.5 + (luma(a) - 0.5) * 1.15, 0, 1)
        stops = np.array([0, 0.35, 0.7, 1])
        cols = np.array([hex01("#0C1026"), hex01("#3A4FA8") * 0.9, hex01("#BAC3DE"), hex01("#F5F3EE")])
        return np.stack([np.interp(g, stops, cols[:, i]) for i in range(3)], -1).astype(np.float32)
    if kind == "film":               # warm film: soft toe, warm highlights, cool-cut blues
        a = 0.035 + 0.94 * a ** 0.96
        hi = smoothstep(0.35, 1.0, luma(a))[..., None]
        return np.clip(a * (1 + hi * np.array([0.04, 0.0, -0.08], np.float32)), 0, 1)
    return a


def faded_ink(a: np.ndarray) -> np.ndarray:
    """§4.2 photo grade: contrast 0.9, saturation 0.86, blacks lifted to #1B1917, warm multiply 10%."""
    a = 0.5 + (a - 0.5) * 0.9
    l = luma(a)[..., None]
    a = l + (a - l) * 0.86
    lift = hex01("#1B1917")
    a = lift + a * (1 - lift)
    a = a * (0.9 + 0.1 * hex01("#F6EBD3"))
    return np.clip(a, 0, 1).astype(np.float32)


def video_still(out: Path) -> Path:
    """The source frame the browser shows at clip time posterOffset (frame index, not a nearby one)."""
    frame = int(CLIP["poster"] * CLIP["fps"] + 1e-6)
    t = (frame - 0.25) / CLIP["fps"]
    path = out / "meshy-still.png"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{t:.4f}", "-i", str(MESHY),
                    "-frames:v", "1", str(path)], check=True)
    return path


def clip_crop(aspect: float) -> tuple[int, int]:
    """(width, x offset) of the centred crop of the 1080 x 1920 source with the window's aspect."""
    w = int(round(1920 * aspect / 2)) * 2
    return w, (1080 - w) // 2


def prepare_photos(card: dict, still: Path | None, out: Path) -> dict:
    """Graded, exactly-sized photo files for a card's SVG print."""
    out.mkdir(parents=True, exist_ok=True)
    lay = card["layout"]
    if lay == "ace":
        size = (round(24 * PX_MM),) * 2
        a = cover(Image.open(ASSETS / card["src"]), size, card["focus"], card["zoom"])
        return {"medallion": save01(faded_ink(treat(a, card.get("treat"))), out / f"{card['id']}-medallion.png").as_uri()}
    _, prect = window_rects(lay)
    w, h = photo_px(prect)
    if card["id"] == "9":
        cw, cx = clip_crop(w / h)
        img = Image.open(still).crop((cx, 0, cx + cw, 1920))
        a = cover(img, (w, h))
    elif lay == "court":
        half = cover(Image.open(ASSETS / card["src"]), (w, h // 2), card["focus"], card["zoom"])
        a = np.concatenate([half, half[::-1, ::-1]], 0)
        a = np.asarray(Image.fromarray(to8(a)).resize((w, h), Image.LANCZOS), np.float32) / 255
    else:
        a = cover(Image.open(ASSETS / card["src"]), (w, h), card["focus"], card["zoom"])
    return {"photo": save01(faded_ink(treat(a, card.get("treat"))), out / f"{card['id']}-photo.png").as_uri()}


# ---------- the clean print (SVG rendered by Chromium) ----------

PAGE = """<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{{font-family:CB;src:local("HelveticaNeue-CondensedBlack")}}
@font-face{{font-family:NB;src:local("HelveticaNeue-Bold")}}
@font-face{{font-family:MO;src:url("{mono}")}}
html,body{{margin:0;background:#fff}}
svg{{display:block}}
</style></head><body>
<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {vw} {vh}">
<rect width="{vw}" height="{vh}" fill="#fff"/>
{body}
</svg>
<script>
// Condense any line that would run past its measure (data-fit, in mm).
document.fonts.ready.then(() => {{
  for (const t of document.querySelectorAll('text[data-fit]')) {{
    const fit = parseFloat(t.dataset.fit);
    if (t.getComputedTextLength() > fit) {{
      t.setAttribute('textLength', fit);
      t.setAttribute('lengthAdjust', 'spacingAndGlyphs');
    }}
  }}
  document.body.dataset.done = '1';
}});
</script></body></html>"""

CX, CY = CARD_MM[0] / 2, CARD_MM[1] / 2


def svg_text(x, y, s, font, size, fill, anchor="start", spacing=None, fit=None):
    style = f' style="letter-spacing:{spacing}"' if spacing else ""
    fit_attr = f' data-fit="{fit}"' if fit else ""
    return (f'<text x="{x:.3f}" y="{y:.3f}" font-family="{font}" font-size="{size:.3f}" fill="{fill}" '
            f'text-anchor="{anchor}"{style}{fit_attr}>{s}</text>')


def svg_plus(marks: Marks, cx, cy, width, colour, rot=0.0, centre_on_cross=False):
    uri, h = marks.plus_png(width, colour)
    fx, fy = marks.cross if centre_on_cross else (0.5, 0.5)
    x, y = cx - width * fx, cy - h * fy
    tr = f' transform="rotate({rot:.2f} {cx:.3f} {cy:.3f})"' if rot else ""
    return f'<image href="{uri}" x="{x:.3f}" y="{y:.3f}" width="{width:.3f}" height="{h:.3f}" preserveAspectRatio="none"{tr}/>'


def svg_rect(r, inset, **attrs):
    x0, y0, x1, y1 = r
    a = " ".join(f'{k.replace("_", "-")}="{v}"' for k, v in attrs.items())
    return (f'<rect x="{x0 + inset:.3f}" y="{y0 + inset:.3f}" width="{x1 - x0 - 2 * inset:.3f}" '
            f'height="{y1 - y0 - 2 * inset:.3f}" {a}/>')


def index_group(card, marks: Marks) -> str:
    """Rank over a brush "+", top-left; the caller rotates a copy for the bottom-right."""
    col_x = 6.0 if card["rank"] == "10" else 5.4
    size, base = 7.5 / CAP, 3.0 + 7.5
    fit = 8.6 if card["rank"] == "10" else None
    ghost = 2 / PX_MM                       # misregistered key plate, ~1 px at the hi tier
    return "".join([
        f'<g transform="translate({ghost:.4f} {ghost:.4f})" opacity="0.35">',
        svg_text(col_x, base, card["rank"], "CB", size, KEY, "middle", fit=fit), "</g>",
        svg_text(col_x, base, card["rank"], "CB", size, PRINT_RED, "middle", fit=fit),
        svg_plus(marks, col_x, 12.0 + 5.2 * marks.plus_aspect / 2, 5.2, BRAND_RED),
    ])


def window_svg(card, marks: Marks, photos: dict) -> str:
    lay = card["layout"]
    frame, ph = window_rects(lay)
    out = [f'<clipPath id="ph">{svg_rect(ph, 0, rx=f"{WIN_RADIUS - PHOTO_IN:.3f}")}</clipPath>',
           f'<image href="{photos["photo"]}" x="{ph[0]:.3f}" y="{ph[1]:.3f}" width="{ph[2] - ph[0]:.3f}" '
           f'height="{ph[3] - ph[1]:.3f}" preserveAspectRatio="none" clip-path="url(#ph)"/>']
    if lay == "court":
        ym = (ph[1] + ph[3]) / 2
        out += [svg_rect((ph[0], ym - COURT_BAR / 2, ph[2], ym + COURT_BAR / 2), 0, fill=KEY),
                f'<circle cx="{CX}" cy="{ym:.3f}" r="1.55" fill="#fff" stroke="{KEY}" stroke-width="0.25"/>',
                svg_plus(marks, CX, ym, 2.1, BRAND_RED, centre_on_cross=True)]
    out += [svg_rect(frame, KEYLINE_IN + KEYLINE_W / 2, fill="none", stroke=BRAND_RED,
                     stroke_width=KEYLINE_W, rx=f"{WIN_RADIUS - KEYLINE_IN - KEYLINE_W / 2:.3f}"),
            svg_rect(frame, FRAME_W / 2, fill="none", stroke=KEY, stroke_width=FRAME_W,
                     rx=f"{WIN_RADIUS - FRAME_W / 2:.3f}")]
    if lay == "court":                      # flourishes on the two corners the indices leave free
        for x, y in ((frame[2], frame[1]), (frame[0], frame[3])):
            out += [f'<circle cx="{x}" cy="{y}" r="1.5" fill="#fff"/>',
                    svg_plus(marks, x, y, 2.3, BRAND_RED, centre_on_cross=True)]
    else:
        ys = np.linspace(10.0, 62.5, 5)    # a 4-pip column sits on the gaps of a 5-pip one
        for x, count in zip((12.75, CARD_MM[0] - 12.75), card["pips"]):
            for y in (ys if count == 5 else (ys[:-1] + ys[1:]) / 2):
                out.append(svg_plus(marks, x, y, 2.2, BRAND_RED, rot=180 if y > CY + 1 else 0))
    return "".join(out)


def ace_svg(card, marks: Marks, photos: dict) -> str:
    my = 36.5
    out = [svg_plus(marks, CX, my, 38.0, BRAND_RED, centre_on_cross=True),
           f'<clipPath id="med"><circle cx="{CX}" cy="{my}" r="12"/></clipPath>',
           f'<image href="{photos["medallion"]}" x="{CX - 12}" y="{my - 12}" width="24" height="24" '
           f'preserveAspectRatio="none" clip-path="url(#med)"/>',
           f'<circle cx="{CX}" cy="{my}" r="12.3" fill="none" stroke="#fff" stroke-width="0.6"/>',
           f'<circle cx="{CX}" cy="{my}" r="12.75" fill="none" stroke="{KEY}" stroke-width="0.3"/>']
    # inverted title band: red "nomada" over the paper-white toast wordmark
    uri, th = marks.toast_png(22.0, red=False)
    out += [f'<rect x="3.2" y="69" width="49.6" height="13" rx="1.1" fill="{KEY}"/>',
            f'<image href="{uri}" x="6.0" y="{80.4 - th:.3f}" width="22" height="{th:.3f}" preserveAspectRatio="none"/>',
            svg_text(28.0, 80.4 - th - 0.45, "nomada", "NB", 3.4, BRAND_RED, "end", spacing="-0.01em"),
            f'<rect x="31.5" y="72.6" width="15" height="0.8" fill="{card["accent"]}"/>',
            svg_text(31.5, 76.5, f"N°{card['rank']} · {card['sub']}", "MO", 1.6, "#fff", spacing="0.18em", fit=19.5),
            svg_text(31.5, 79.0, "NOMADA TOAST", "MO", 1.6, "#fff", spacing="0.18em", fit=19.5)]
    return "".join(out)


def front_svg(card, marks: Marks, photos: dict) -> str:
    body = [ace_svg(card, marks, photos) if card["layout"] == "ace" else window_svg(card, marks, photos)]
    if card["layout"] != "ace":
        body += [svg_text(9.0, 77.0, card["title"].upper(), "CB", 7.0 / CAP, KEY, fit=43),
                 f'<rect x="9" y="78.35" width="15" height="0.8" fill="{card["accent"]}"/>',
                 svg_text(9.0, 81.35, f"N°{card['rank']} · {card['title'].upper()} · NOMADA TOAST",
                          "MO", 1.6, KEY, spacing="0.18em", fit=43)]
    idx = index_group(card, marks)
    body += [idx, f'<g transform="rotate(180 {CX} {CY})">{idx}</g>']
    return "".join(body)


def back_svg(marks: Marks) -> str:
    field = (3.0, 3.0, CARD_MM[0] - 3.0, CARD_MM[1] - 3.0)
    out = [svg_rect(field, 0, fill=PRINT_RED, rx=2)]
    d = 4.2 / np.sqrt(2)                     # 45-degree lattice, 4.2 mm between neighbouring marks
    for m in range(-11, 12):
        for n in range(-15, 16):
            x, y = CX + m * d, CY + n * d
            plus = (m + n) % 2 == 0
            margin = 2.3 + (1.2 if plus else 0.25)   # whole marks only, clear of the hairlines
            if not (field[0] + margin <= x <= field[2] - margin and field[1] + margin <= y <= field[3] - margin):
                continue
            if ((x - CX) / 16.5) ** 2 + ((y - CY) / 22.5) ** 2 < 1:
                continue                     # under the medallion's red clearance
            if plus:
                out.append(svg_plus(marks, x, y, 2.4, "#FFFFFF", rot=8 if m % 2 == 0 else -8,
                                    centre_on_cross=True))
            else:
                out.append(f'<circle cx="{x:.3f}" cy="{y:.3f}" r="0.25" fill="#fff"/>')
    for inset, w in ((1.2, 0.18), (1.62, 0.1)):  # bone double hairline inside the field
        out.append(svg_rect(field, inset, fill="none", stroke="#fff", stroke_width=w, rx=f"{2 - inset:.2f}"))
    # centre medallion
    out += [f'<ellipse cx="{CX}" cy="{CY}" rx="15.6" ry="21.6" fill="{PRINT_RED}"/>',
            f'<ellipse cx="{CX}" cy="{CY}" rx="15.0" ry="21.0" fill="none" stroke="#fff" stroke-width="0.16"/>',
            f'<ellipse cx="{CX}" cy="{CY}" rx="14" ry="20" fill="#fff"/>',
            f'<ellipse cx="{CX}" cy="{CY}" rx="13.3" ry="19.3" fill="none" stroke="{PRINT_RED}" stroke-width="0.22"/>',
            f'<ellipse cx="{CX}" cy="{CY}" rx="9.9" ry="15.9" fill="none" stroke="{PRINT_RED}" stroke-width="0.22"/>']
    rx, ry = 10.75, 16.75
    out.append(f'<path id="ring" fill="none" d="M {CX - rx} {CY} A {rx} {ry} 0 0 1 {CX + rx} {CY}"/>')
    ring = (f'<text font-family="NB" font-size="2.7" fill="{PRINT_RED}" style="letter-spacing:0.08em">'
            f'<textPath href="#ring" startOffset="50%" text-anchor="middle">nomada toast</textPath></text>')
    out += [ring, f'<g transform="rotate(180 {CX} {CY})">{ring}</g>']
    for sx in (-1, 1):
        out.append(svg_plus(marks, CX + sx * 11.6, CY, 1.8, PRINT_RED, centre_on_cross=True))
    out.append(svg_plus(marks, CX, CY, 11.0, BRAND_RED, centre_on_cross=True))
    uri, th = marks.toast_png(11.5, red=True)
    wm = f'<image href="{uri}" x="{CX - 5.75:.3f}" y="{CY - 9.9 - th / 2:.3f}" width="11.5" height="{th:.3f}" preserveAspectRatio="none"/>'
    out += [wm, f'<g transform="rotate(180 {CX} {CY})">{wm}</g>']
    micro = svg_text(CX, 2.15, "NOMADA TOAST PLAYING CARDS · No.26 · CASINO FINISH", "MO", 1.0, PRINT_RED,
                     "middle", spacing="0.22em", fit=52)
    out += [micro, f'<g transform="rotate(180 {CX} {CY})">{micro}</g>']
    return "".join(out)


def render_prints(jobs: dict[str, str], out: Path) -> dict[str, Path]:
    """Render each SVG body at the master size; returns name -> PNG path."""
    from playwright.sync_api import sync_playwright

    out.mkdir(parents=True, exist_ok=True)
    paths = {}
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page(viewport={"width": W_PX, "height": H_PX}, device_scale_factor=1)
        for name, body in jobs.items():
            html = out / f"{name}.html"
            html.write_text(PAGE.format(mono=MONO_FONT.as_uri(), w=W_PX, h=H_PX, vw=CARD_MM[0],
                                        vh=CARD_MM[1], body=body), encoding="utf-8")
            page.goto(html.as_uri())
            page.wait_for_load_state("load")
            page.wait_for_selector("body[data-done]", state="attached")
            png = page.screenshot(clip={"x": 0, "y": 0, "width": W_PX, "height": H_PX})
            paths[name] = out / f"{name}.png"
            Image.open(io.BytesIO(png)).convert("RGB").save(paths[name])
        browser.close()
    return paths


# ---------- stock, ink and wear ----------

def rounded_rect_sd(radii: dict[str, float]) -> np.ndarray:
    """Signed distance (cm, inside positive) to the nominal card outline with per-corner radii."""
    hw = CARD_CM[0] / 2 - SILHOUETTE_INSET_CM
    hh = CARD_CM[1] / 2 - SILHOUETTE_INSET_CM
    px, py = GRID_X - CARD_CM[0] / 2, GRID_Y - CARD_CM[1] / 2
    r = np.where(py < 0, np.where(px < 0, radii["tl"], radii["tr"]),
                 np.where(px < 0, radii["bl"], radii["br"])).astype(np.float32)
    qx, qy = np.abs(px) - hw + r, np.abs(py) - hh + r
    outside = np.minimum(np.maximum(qx, qy), 0) + np.hypot(np.maximum(qx, 0), np.maximum(qy, 0)) - r
    return -outside


def corner_weight(which: str | None = None, reach: float = 0.9) -> np.ndarray:
    """1 at a corner of the nominal outline (or at one named corner), falling to 0 by `reach` cm."""
    hw = CARD_CM[0] / 2 - SILHOUETTE_INSET_CM
    hh = CARD_CM[1] / 2 - SILHOUETTE_INSET_CM
    px, py = GRID_X - CARD_CM[0] / 2, GRID_Y - CARD_CM[1] / 2
    if which is None:
        dist = np.hypot(np.abs(px) - hw, np.abs(py) - hh)
    else:
        sx = 1 if which[1] == "r" else -1
        sy = 1 if which[0] == "b" else -1
        dist = np.hypot(px - sx * hw, py - sy * hh)
    return 1 - smoothstep(0.1, reach, dist)


def corner_point(corner: str, a: float, b: float) -> tuple[float, float]:
    """Card coordinates of the point `a` cm from the corner's vertical quad edge and `b` cm from
    its horizontal one (corner is 'tl', 'tr', 'br' or 'bl')."""
    return (a if corner[1] == "l" else CARD_CM[0] - a, b if corner[0] == "t" else CARD_CM[1] - b)


def corner_sum(corner: str) -> np.ndarray:
    """Per pixel, the sum of the distances to a corner's two quad edges (the dog-ear hinge metric)."""
    dx = GRID_X if corner[1] == "l" else CARD_CM[0] - GRID_X
    dy = GRID_Y if corner[0] == "t" else CARD_CM[1] - GRID_Y
    return dx + dy


def edge_point(rs: np.random.Generator, side: str | None = None, at: float | None = None):
    """A point on the nominal outline: (point, outward normal, tangent). Biased toward corners."""
    w, h, i = CARD_CM[0], CARD_CM[1], SILHOUETTE_INSET_CM
    if side is None:
        side = rs.choice(["t", "r", "b", "l"], p=np.array([w, h, w, h]) / (2 * (w + h)))
    length = w if side in "tb" else h
    if at is None:
        at = (rs.uniform(0.45, 1.3) if rs.random() < 0.5 else rs.uniform(1.3, length / 2))
        at = at if rs.random() < 0.5 else length - at
    return {"t": ((at, i), (0, -1), (1, 0)), "b": ((at, h - i), (0, 1), (1, 0)),
            "l": ((i, at), (-1, 0), (0, 1)), "r": ((w - i, at), (1, 0), (0, 1))}[side]


def silhouette(rs: np.random.Generator, card: dict, traits: dict):
    """Signed distance to the frayed, chipped and nicked outline (cm), and the corner weight."""
    wear = card["wear"]
    radii = {c: float(np.clip(rs.uniform(BASE_CORNER_CM, BASE_CORNER_CM + 0.27 * wear), 0.32, 0.55))
             for c in ("tl", "tr", "br", "bl")}
    if traits.get("fray_corner"):
        radii[traits["fray_corner"]] = 0.52
    d = rounded_rect_sd(radii)
    corner = corner_weight()
    amp = 0.012 + 0.023 * corner_weight(reach=0.45)
    if traits.get("fray_corner"):
        amp = amp + 0.02 * corner_weight(traits["fray_corner"], 0.8)
    fray = np.clip(noise(rs, 0.06, octaves=2) * 0.45, -1, 1)
    fuzz = np.clip(noise(rs, 0.012) * 0.45, -1, 1)
    wave = np.clip(noise(rs, 0.7) * 0.45, -1, 1)
    d = d + amp * fray + 0.003 * fuzz + 0.006 * wave
    # keep the zero crossing (and its AA ramp) inside the quad, whatever the fray did
    quad = np.minimum(np.minimum(GRID_X, CARD_CM[0] - GRID_X), np.minimum(GRID_Y, CARD_CM[1] - GRID_Y))
    d = np.minimum(d, quad - SILHOUETTE_MIN_GAP_CM)

    def bite(c, r):
        sl, xs, ys = window(c[0], c[1], r + 0.02)
        d[sl] = np.minimum(d[sl], np.hypot(xs - c[0], ys - c[1]) - r)

    chips = [(edge_point(rs), rs.uniform(0.03, 0.08)) for _ in range(3 + round(5 * wear))]
    chips += [(edge_point(rs, c["side"], c["at"]), c["r"]) for c in traits.get("chips", [])]
    if traits.get("fray_corner"):
        side = "b" if traits["fray_corner"][0] == "b" else "t"
        chips += [(edge_point(rs, side, CARD_CM[0] - rs.uniform(0.35, 0.6)), rs.uniform(0.03, 0.05))
                  for _ in range(2)]
    for (p, n, _), r in chips:
        off = rs.uniform(0.25, 0.7) * r
        bite((p[0] + n[0] * off, p[1] + n[1] * off), r)

    nicks = [edge_point(rs) for _ in range(rs.integers(1, 3))]
    nicks += [edge_point(rs, k["side"], k["at"]) for k in traits.get("nicks", [])]
    for p, n, t in nicks:
        depth, half = rs.uniform(0.05, 0.11), rs.uniform(0.035, 0.065)
        apex = (p[0] - n[0] * depth, p[1] - n[1] * depth)
        b1 = (p[0] + t[0] * half + n[0] * 0.06, p[1] + t[1] * half + n[1] * 0.06)
        b2 = (p[0] - t[0] * half + n[0] * 0.06, p[1] - t[1] * half + n[1] * 0.06)
        sl, xs, ys = window(p[0], p[1], depth + half + 0.08)
        d[sl] = np.minimum(d[sl], sd_triangle(xs, ys, apex, b1, b2))
    return d.astype(np.float32), corner


def crease_list(rs: np.random.Generator, traits: dict) -> list[dict]:
    """Seed-jittered creases (plus the dog-ear hinge), each with its signed-distance field."""
    w, h = CARD_CM
    out = []
    specs = [dict(c) for c in traits.get("creases", [])]
    if traits.get("dog_ear"):
        corner, s = traits["dog_ear"]["corner"], traits["dog_ear"]["sizeCm"]
        specs.append(dict(ctrl=[corner_point(corner, a, b) for a, b in ((s, 0.0), (s / 2, s / 2), (0.0, s))],
                          s=1.0, hinge=True))
    for spec in specs:
        pts = []
        for x, y in spec["ctrl"]:
            on_edge = (x <= 0.0, x >= w, y <= 0.0, y >= h)
            j = 0.0 if spec.get("hinge") else 0.12
            jx, jy = rs.uniform(-j, j, 2)
            x = x if on_edge[0] or on_edge[1] else x + jx
            y = y if on_edge[2] or on_edge[3] else y + jy
            pts.append((x, y))
        line = bezier(pts)
        soft = spec.get("soft", 1.0)
        sd, along = curve_field(line, reach=0.35 * soft + 0.25)

        def inside(p):
            return 0.1 < p[0] < w - 0.1 and 0.1 < p[1] < h - 0.1

        prof = np.ones_like(along)
        if inside(pts[0]):
            prof *= smoothstep(0.0, 0.15, along)
        if inside(pts[-1]):
            prof *= smoothstep(1.0, 0.85, along)
        s = spec["s"] * prof * (0.75 + 0.25 * np.clip(noise(rs, 0.4) * 0.5, -1, 1))
        out.append(dict(sd=sd, s=np.where(np.isfinite(sd), s, 0).astype(np.float32), soft=soft,
                        hinge=spec.get("hinge", False)))
    return out


def thumb_zones(traits: dict, wear: float):
    """Soft thumb blobs (0..1) and fingerprint whorl ridges (0..1, weighted by grease)."""
    zone = np.zeros((H_PX, W_PX), np.float32)
    grease = np.zeros((H_PX, W_PX), np.float32)
    for t in GENERIC_THUMBS + traits.get("thumbs", []):
        (cx, cy), (ax, ay), ang = t["c"], t["r"], np.radians(t["ang"])
        sl, xs, ys = window(cx, cy, max(ax, ay) * 1.1)
        dx, dy = xs - cx, ys - cy
        u = (dx * np.cos(ang) + dy * np.sin(ang))
        v = (-dx * np.sin(ang) + dy * np.cos(ang))
        r = np.hypot(u / ax, v / ay)
        blob = 1 - smoothstep(0.45, 1.0, r)
        theta = np.arctan2(v, u)
        phase = 2 * np.pi * np.hypot(u, v * ax / ay) / 0.07 + 1.4 * np.sin(theta + t["ang"]) + 0.6 * np.sin(2 * theta)
        ridges = 0.5 + 0.5 * np.cos(phase)
        k = (0.45 + 0.55 * wear) if t in GENERIC_THUMBS else 1.0
        zone[sl] = np.maximum(zone[sl], blob * k)
        grease[sl] = np.maximum(grease[sl], ridges * blob * t["grease"])
    return zone, grease


def scuff_strokes(rs: np.random.Generator, traits: dict, wear: float) -> np.ndarray:
    """30-60 scuffs (coverage 0..1, value encodes each stroke's alpha relative to 14%)."""
    canvas = Image.new("F", (W_PX, H_PX), 0.0)
    draw = ImageDraw.Draw(canvas)
    w, h = CARD_CM
    thumbs = GENERIC_THUMBS + traits.get("thumbs", [])
    strokes = []
    for _ in range(30 + round(30 * wear)):
        if rs.random() < 0.45:               # thumb scuffs: short, tight arcs
            t = thumbs[rs.integers(len(thumbs))]
            p = np.array(t["c"]) + rs.normal(0, 0.55, 2)
            a = rs.uniform(0, 2 * np.pi)
            pivot = p + rs.uniform(0.8, 3.0) * np.array([np.cos(a), np.sin(a)])
            length = rs.uniform(0.3, 1.2)
        else:                                # shuffle arcs: long sweeps about a pivot off the card
            p = np.array([rs.uniform(0.2, w - 0.2), rs.uniform(0.2, h - 0.2)])
            pivot = np.array([rs.uniform(-3.5, -1.0), rs.uniform(h + 0.5, h + 3.5)])
            if rs.random() < 0.35:
                pivot = np.array([w, h]) - pivot
            length = rs.uniform(1.2, 4.0)
        strokes.append((p, pivot, length, rs.uniform(0.008, 0.03), rs.uniform(0.06, 0.14)))
    if traits.get("rings"):                  # shuffle-ring scuffs: concentric arcs
        rg = traits["rings"]
        for _ in range(rg["n"]):
            a, rad = rs.uniform(0, 2 * np.pi), rs.uniform(*rg["r"])
            c = np.array(rg["c"])
            strokes.append((c + rad * np.array([np.cos(a), np.sin(a)]), c, rs.uniform(1.0, 3.0),
                            rs.uniform(0.008, 0.02), rs.uniform(0.07, 0.14)))
    for p, pivot, length, width, alpha in strokes:
        rad = float(np.hypot(*(p - pivot)))
        a0 = np.arctan2(p[1] - pivot[1], p[0] - pivot[0])
        span = length / rad
        ts = np.linspace(-0.5, 0.5, max(8, int(length / 0.05)))
        pts = [(pivot + rad * np.array([np.cos(a0 + t * span), np.sin(a0 + t * span)])) / CM_PX for t in ts]
        for i in range(len(pts) - 1):
            taper = np.sin(np.pi * (i + 0.5) / (len(pts) - 1)) ** 0.6
            draw.line([tuple(pts[i]), tuple(pts[i + 1])], fill=float(alpha / 0.14),
                      width=max(1, round(width / CM_PX * taper)))
    return np.clip(blur(np.asarray(canvas), 0.8), 0, 1)


def coffee_ring(rs: np.random.Generator, spec: dict):
    """Partial dried coffee ring with a drip: (rim alpha, interior wash) fields. The ring's gap
    faces left, over the photo, so the dried rim crosses the bare stock where it reads."""
    cx, cy, rr = *spec["c"], spec["r"]
    span = rs.uniform(*spec["span"])
    start = (rs.uniform(-20, 20) - span / 2) % 360
    sl, xs, ys = window(cx, cy, rr + 0.6)
    r = np.hypot(xs - cx, ys - cy)
    th = np.degrees(np.arctan2(ys - cy, xs - cx)) % 360
    rel = (th - start) % 360
    arc = smoothstep(0, 30, rel) * smoothstep(span, span - 30, rel)
    wob = rr + 0.025 * noise(rs, 0.3, shape=r.shape)
    rim = 1.2 * np.exp(-((r - wob) / 0.022) ** 2) + 0.45 * np.exp(-((r - wob + 0.07) / 0.06) ** 2)
    rim *= arc * (0.65 + 0.35 * np.clip(0.5 + 0.4 * noise(rs, 0.25, shape=r.shape), 0, 1))
    interior = (1 - smoothstep(wob - 0.15, wob, r)) * (0.75 + 0.25 * arc)
    a = np.radians(rs.uniform(10, 35))       # the drip landed outside the rim, toward the right edge
    dx, dy = cx + (rr + 0.25) * np.cos(a), cy + (rr + 0.25) * np.sin(a)
    rd = np.hypot(xs - dx, ys - dy) * (1 + 0.18 * noise(rs, 0.15, shape=r.shape))
    drip = 1 - smoothstep(0.12, 0.15, rd)
    drip_rim = np.exp(-((rd - 0.14) / 0.012) ** 2)
    rim_full = np.zeros((H_PX, W_PX), np.float32)
    wash = np.zeros((H_PX, W_PX), np.float32)
    rim_full[sl] = np.maximum(rim, drip_rim * 0.9)
    wash[sl] = np.maximum(interior, drip)
    return rim_full, wash


def ink_fleck(rs: np.random.Generator) -> np.ndarray:
    """One small irregular spot of lost ink, inside the photo window."""
    _, ph = window_rects("pip")
    cx, cy = rs.uniform(ph[0] / 10 + 0.4, ph[2] / 10 - 0.4), rs.uniform(ph[1] / 10 + 0.5, ph[3] / 10 - 1.5)
    out = np.zeros((H_PX, W_PX), np.float32)
    sl, xs, ys = window(cx, cy, 0.1)
    r = np.hypot(xs - cx, ys - cy) * (1 + 0.3 * noise(rs, 0.012, shape=(ys.shape[0], xs.shape[1])))
    out[sl] = 1 - smoothstep(0.022, 0.03, r)
    return out


def flecks(rs: np.random.Generator, d: np.ndarray, corner: np.ndarray, wear: float, k: float) -> np.ndarray:
    """Ink-loss specks: dense near the edges (most at corners), sparse dust over the face."""
    out = np.zeros((H_PX, W_PX), np.float32)
    for cell, base, edge, reach in ((0.016, 0.002, 0.08, 0.3), (0.04, 0.0004, 0.016, 0.4)):
        n = noise(rs, cell, octaves=2, gain=0.4)
        dens = (base * wear + edge * wear * k * np.exp(-np.maximum(d, 0) / (reach * (1 + 1.2 * corner)))
                * (0.5 + 1.5 * corner))
        dens = np.clip(dens, 0, 0.35)
        levels = np.linspace(0, 1, 257)
        q = np.quantile(n[::5, ::5], levels)
        thr = np.interp(1 - dens, levels, q)
        out = np.maximum(out, smoothstep(thr - 0.1, thr + 0.1, n) * (0.75 + 0.25 * np.clip(noise(rs, 0.3), -1, 1)))
    return np.clip(out, 0, 1)


def wear_card(card: dict, seed: int) -> dict:
    """All wear fields of one card at master resolution."""
    traits = TRAITS[card["id"]]
    wear, base = card["wear"], cyrb53(f"{seed}{card['rank']}")
    d, corner = silhouette(stream(base, "silhouette"), card, traits)
    creases = crease_list(stream(base, "creases"), traits)
    zone, grease = thumb_zones(traits, wear)
    scuff = scuff_strokes(stream(base, "scuffs"), traits, wear)
    rs = stream(base, "fields")
    k = traits.get("whitening", 1.0)

    # G: ink loss / whitening
    n1, n2 = noise(rs, 0.25, octaves=3, gain=0.6), noise(rs, 0.05)
    thr = 0.08 * (1 + 0.6 * corner) * (0.55 + 0.5 * wear) * k * np.clip(0.75 + 0.35 * n1, 0.2, 1.4)
    if traits.get("fray_corner"):
        thr = thr * (1 + 0.6 * corner_weight(traits["fray_corner"], 1.1))
    edge = (1 - smoothstep(0.35 * thr, thr, d)) * np.clip(0.8 + 0.2 * n2, 0.5, 1)
    rub = corner_weight(reach=0.75) ** 1.5 * np.clip(0.55 + 0.45 * noise(rs, 0.08, octaves=2), 0, 1)
    g = np.maximum(edge, 0.35 * wear * k * rub)
    g = np.maximum(g, 0.05 * wear * np.clip(noise(rs, 1.2, octaves=2) * 0.6, 0, 1))
    g = np.maximum(g, flecks(rs, d, corner, wear, k))
    g = np.maximum(g, 0.15 * scuff)
    g = np.maximum(g, 0.05 * wear * zone)
    crack = smoothstep(-0.3, 0.6, noise(rs, 0.03, octaves=2))
    for c in creases:
        g = np.maximum(g, 0.7 * c["s"] * np.exp(-(c["sd"] / (0.01 * c["soft"])) ** 2) * crack)
    if traits.get("fleck"):
        g = np.maximum(g, 0.95 * ink_fleck(rs))

    # B: height, 0.5 neutral
    b = np.full((H_PX, W_PX), 0.5, np.float32) - 0.02 * scuff
    for c in creases:
        depth = 0.12 if c["soft"] == 1.0 else 0.08
        b -= depth * c["s"] * np.clip(1 - np.abs(c["sd"]) / (0.02 * c["soft"]), 0, 1)

    # gloss
    gloss = 0.62 + 0.12 * np.clip(noise(rs, 1.5, octaves=2) * 0.45, -1, 1)
    gloss += -0.25 * zone + 0.10 * grease - 0.30 * scuff - 0.35 * (1 - smoothstep(0.0, 0.15, d))
    for c in creases:
        gloss -= 0.30 * c["s"] * np.exp(-(c["sd"] / (0.02 * c["soft"])) ** 2)
    stain = None
    if traits.get("coffee"):
        stain = coffee_ring(rs, traits["coffee"])
        gloss -= 0.20 * stain[1]

    return dict(d=d, corner=corner, g=np.clip(g, 0, 1), b=np.clip(b, 0, 1), gloss=np.clip(gloss, 0, 1),
                creases=creases, zone=zone, scuff=scuff, stain=stain, sun=traits.get("sun", 0.0),
                dog_ear=traits.get("dog_ear"), fields_rs=rs)


def stock(rs: np.random.Generator, d: np.ndarray, base: str, edge: str) -> np.ndarray:
    """Plastic-coated board: slight mottle, yellowing toward the edges."""
    t = (1 - smoothstep(0.0, 0.6, d)) * np.clip(0.75 + 0.25 * noise(rs, 1.5), 0.4, 1)
    col = mix(np.broadcast_to(hex01(base), (H_PX, W_PX, 3)), hex01(edge), 0.8 * t)
    grain = 1 + 0.006 * noise(rs, 0.8) + 0.004 * noise(rs, 0.004)
    return col * grain[..., None]


def print_on(paper: np.ndarray, ink: np.ndarray, rs: np.random.Generator, paper_ref: str,
             fade: float) -> np.ndarray:
    """Multiply the rendered ink onto the stock. Ink density carries a slight offset-litho mottle
    and a low-frequency fade of +/- `fade`."""
    trans = np.clip(blur(ink, 0.5) / hex01(paper_ref), 0, 1)
    vary = (fade * np.clip(noise(rs, 2.5, octaves=2) * 0.45, -1, 1)
            + 0.022 * noise(rs, 0.25) + 0.02 * noise(rs, 0.025))
    dens = (1 - trans) * (1 + vary[..., None])
    return paper * np.clip(1 - dens, 0, 1)


def age_front(col: np.ndarray, card: dict, w: dict) -> np.ndarray:
    """§4.4(a): wear baked into the front albedo."""
    rs, d, wear = w["fields_rs"], w["d"], card["wear"]
    s = 0.08 + 0.07 * wear + w["sun"]
    l = luma(col)[..., None]
    col = l + (col - l) * (1 - s)
    lift = 0.02 + 0.025 * wear
    col = lift * hex01("#2A2621") + col * (1 - lift)
    yb = (1 - smoothstep(0.0, 0.45, d)) * np.clip(0.7 + 0.3 * noise(rs, 1.2), 0.3, 1)
    col = mix(col, hex01(YELLOWED), 0.25 * yb * (0.5 + 0.5 * wear))
    col = mix(col, hex01(GRIME), 0.06 * wear * w["zone"])
    for c in w["creases"]:
        sd, st, hw = c["sd"], c["s"], 0.011 * c["soft"]
        hl = np.exp(-((sd - hw) / hw) ** 2)
        sh = np.exp(-((sd + hw) / hw) ** 2)
        bend = np.tanh(sd / (0.06 * c["soft"])) * np.exp(-(sd / (0.25 * c["soft"])) ** 2)
        col = col * (1 + st * (0.18 * hl - 0.22 * sh + 0.05 * bend))[..., None]
    col = mix(col, hex01("#F8F6F0"), 0.14 * w["scuff"])
    if w["stain"] is not None:
        rim, wash = w["stain"]
        col = mix(col, hex01(COFFEE), np.clip(0.18 * rim + 0.035 * wash, 0, 0.26))
    if w["dog_ear"]:                         # the folded tip gets handled most
        tip = smoothstep(1.2, 0.2, corner_sum(w["dog_ear"]["corner"]))
        col = mix(col, hex01(GRIME), 0.06 * tip)
    band_w = 0.02 + 0.10 * np.clip(0.45 + 0.35 * noise(rs, 1.0, octaves=2, gain=0.4) + 0.25 * w["corner"], 0, 1)
    band = 1 - smoothstep(0.6 * band_w, band_w, d)
    col = mix(col, hex01(RUBBED), 0.75 * band)
    grime = np.exp(-((d - band_w - 0.03) / 0.035) ** 2) * np.clip(0.65 + 0.4 * noise(rs, 0.2, octaves=2), 0.1, 1.3)
    col = mix(col, hex01(GRIME), 0.10 * grime * (0.6 + 0.4 * wear))
    haze = (1 - smoothstep(0.0, 0.4, d)) * (0.35 + 0.65 * w["corner"])
    col = mix(col, hex01(GRIME), 0.05 * wear * haze)
    return fill_outside(np.clip(col, 0, 1), d)


def fill_outside(col: np.ndarray, d: np.ndarray) -> np.ndarray:
    """Outside the silhouette, repeat the rim colour so bilinear sampling never pulls in a seam."""
    rim = (d > 0) & (d < 0.02)
    return np.where((d <= 0)[..., None], np.median(col[rim], axis=0), col)


def age_back(col: np.ndarray) -> np.ndarray:
    """The shared back carries only generic age; per-card wear comes from the wear map in the shader."""
    l = luma(col)[..., None]
    return np.clip(l + (col - l) * 0.94, 0, 1)


# ---------- outputs ----------

def encode_wear(w: dict, size: tuple[int, int]) -> Image.Image:
    r = 0.5 + down(w["d"], size) / SDF_RANGE_CM
    return Image.fromarray(np.dstack([to8(np.clip(r, 0, 1)), to8(down(w["g"], size)), to8(down(w["b"], size))]), "RGB")


def card_params(card: dict, seed: int) -> dict:
    rs = stream(cyrb53(f"{seed}{card['rank']}"), "geometry")
    wear = card["wear"]
    traits = TRAITS[card["id"]]
    return dict(
        wear=wear,
        backFade=round(0.02 + 0.07 * wear, 3),
        curl=dict(long=round(float(np.clip(0.08 + 0.14 * wear * rs.uniform(0.85, 1.15), 0.08, 0.22)), 3),
                  lat=round(float(np.clip(0.02 + 0.04 * wear * rs.uniform(0.7, 1.2), 0.02, 0.06)), 3),
                  twist=round(float(np.clip(0.09 * wear * rs.uniform(0.25, 1.0), 0.0, 0.09)), 3)),
        dogEar=traits.get("dog_ear"),
    )


def build_card(card: dict, seed: int, print_png: Path) -> None:
    w = wear_card(card, seed)
    rs = stream(cyrb53(f"{seed}{card['rank']}"), "stock")
    col = print_on(stock(rs, w["d"], PAPER, PAPER_EDGE), load01(print_png), rs, PAPER, fade=0.05)
    col = age_front(col, card, w)
    master = BUILD / "master"
    save01(col, master / f"{card['id']}-front.png")
    np.savez_compressed(master / f"{card['id']}-wear.npz", d=w["d"], g=w["g"], b=w["b"])
    img = Image.fromarray(to8(col))
    for tier, sz in TIERS.items():
        out = STAGE / "assets/cards" / tier
        out.mkdir(parents=True, exist_ok=True)
        img.resize(sz["front"], Image.LANCZOS).save(out / f"{card['id']}-front.webp", "WEBP", quality=88, method=6)
        encode_wear(w, sz["wear"]).save(out / f"{card['id']}-wear.png", optimize=True)
        Image.fromarray(to8(down(w["gloss"], sz["gloss"])), "L").save(out / f"{card['id']}-gloss.png", optimize=True)


def build_back(seed: int, print_png: Path) -> None:
    rs = stream(cyrb53(f"{seed}back"), "stock")
    d = rounded_rect_sd({c: BASE_CORNER_CM for c in ("tl", "tr", "br", "bl")})
    col = print_on(stock(rs, d, PAPER_BACK, PAPER_EDGE), load01(print_png), rs, PAPER_BACK, fade=0.03)
    col = fill_outside(age_back(col), d)
    save01(col, BUILD / "master/back.png")
    img = Image.fromarray(to8(col))
    for tier, sz in TIERS.items():
        out = STAGE / "assets/cards" / tier
        out.mkdir(parents=True, exist_ok=True)
        img.resize(sz["front"], Image.LANCZOS).save(out / "back.webp", "WEBP", quality=88, method=6)


def build_dimple(seed: int) -> None:
    """Tiling air-cushion emboss: a jittered grid of shallow round dimples, as a tangent-space normal map."""
    rs = stream(cyrb53(f"{seed}dimple"), "dimple")
    n, cell = 256, 256 // DIMPLE_CELLS
    yy, xx = np.mgrid[0:n, 0:n].astype(np.float32)
    h = np.zeros((n, n), np.float32)
    jitter = rs.uniform(-0.12, 0.12, (DIMPLE_CELLS, DIMPLE_CELLS, 2)) * cell
    depth = rs.uniform(0.8, 1.0, (DIMPLE_CELLS, DIMPLE_CELLS))
    for i in range(DIMPLE_CELLS):
        for j in range(DIMPLE_CELLS):
            cx, cy = (j + 0.5) * cell + jitter[i, j, 0], (i + 0.5) * cell + jitter[i, j, 1]
            dx = (xx - cx + n / 2) % n - n / 2      # wrapped, so the tile repeats seamlessly
            dy = (yy - cy + n / 2) % n - n / 2
            h -= depth[i, j] * np.exp(-(dx * dx + dy * dy) / (2 * (0.3 * cell) ** 2))
    gx = (np.roll(h, -1, 1) - np.roll(h, 1, 1)) / 2
    gy = (np.roll(h, -1, 0) - np.roll(h, 1, 0)) / 2
    k = 1.6
    # v runs up the texture (flipY), so dh/dv = -dh/dy_image
    nx, ny, nz = -k * gx, k * gy, np.ones_like(h)
    norm = np.sqrt(nx * nx + ny * ny + nz * nz)
    rgb = np.dstack([nx / norm, ny / norm, nz / norm]) * 0.5 + 0.5
    out = STAGE / "assets/cards"
    out.mkdir(parents=True, exist_ok=True)
    Image.fromarray(to8(rgb), "RGB").save(out / "dimple-normal-256.png", optimize=True)


def build_clip(aspect: float) -> None:
    """§4.6: the 9's window loop, re-encoded at rising CRF until it fits the size budget."""
    cw, cx = clip_crop(aspect)
    out = STAGE / "assets/cards/clip-9.mp4"
    for crf in (26, 28, 30, 32):
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", str(CLIP["start"]), "-to", str(CLIP["end"]),
                        "-i", str(MESHY), "-an", "-vf", f"crop={cw}:1920:{cx}:0,scale=360:-2",
                        "-c:v", "libx264", "-profile:v", "main", "-pix_fmt", "yuv420p", "-crf", str(crf),
                        "-movflags", "+faststart", str(out)], check=True)
        if out.stat().st_size <= CLIP["max_kb"] * 1024:
            return
    raise SystemExit(f"clip-9.mp4 is still over {CLIP['max_kb']} KB at CRF 32")


def manifest(seed: int) -> dict:
    _, ph = window_rects("pip")
    uv = [ph[0] / CARD_MM[0], 1 - ph[3] / CARD_MM[1], ph[2] / CARD_MM[0], 1 - ph[1] / CARD_MM[1]]
    cards = []
    for c in CARDS:
        files = {t: {k: f"assets/cards/{t}/{c['id']}-{k}.{'webp' if k == 'front' else 'png'}"
                     for k in ("front", "wear", "gloss")} for t in TIERS}
        cards.append(dict(id=c["id"], rank=c["rank"], title=c["title"], sub=c["sub"], accent=c["accent"],
                          **card_params(c, seed), files=files))
    return {
        "version": 1, "seed": seed, "cardCm": list(CARD_CM), "cornerCm": BASE_CORNER_CM,
        "ring": [c["id"] for c in CARDS],
        "cards": cards,
        "back": {t: f"assets/cards/{t}/back.webp" for t in TIERS},
        "dimple": "assets/cards/dimple-normal-256.png",
        "dimpleTileCm": DIMPLE_CELLS * DIMPLE_PERIOD_CM,
        "video9": {"file": "assets/cards/clip-9.mp4", "startSec": CLIP["start"], "endSec": CLIP["end"],
                   "posterSec": CLIP["poster"], "posterOffset": round(CLIP["poster"] - CLIP["start"], 3),
                   "windowUV": [round(v, 5) for v in uv]},
    }


# ---------- review sheet ----------

def preview(albedo: np.ndarray, wear_rgb: np.ndarray, paper_mix: str, fade: float = 0.0,
            felt=(0.10, 0.27, 0.21)) -> np.ndarray:
    """Approximate the shader for review: wear G (+ fade) toward paper, crease relief from B,
    SDF cut onto felt."""
    r, g, b = (wear_rgb[..., i] for i in range(3))
    col = mix(albedo, hex01(paper_mix), np.clip(g + fade, 0, 1))
    gy, gx = np.gradient(b * 3.0)
    col = col * (1 + np.clip(-gx - gy, -0.5, 0.5))[..., None]
    alpha = smoothstep(0.47, 0.53, r)[..., None]
    return np.clip(alpha * col + (1 - alpha) * np.array(felt), 0, 1)


def contact_sheet(seed: int) -> Path:
    """Fronts and backs as the shader would wear them, every wear channel, and the 9's clip at 4 fps."""
    font = ImageFont.load_default(22)
    small = ImageFont.load_default(16)
    tier = STAGE / "assets/cards/hi"
    back = load01(tier / "back.webp")
    meta = {c["id"]: c for c in manifest(seed)["cards"]}
    tw, th = 400, 560
    sheet = Image.new("RGB", (6 * (tw + 20) + 20, 2600), (24, 24, 22))
    draw = ImageDraw.Draw(sheet)
    draw.text((20, 12), f"NomadaToast cards, seed {seed}: fronts and backs with wear applied (hi tier)", font=font, fill=(236, 233, 225))
    y0 = 50
    for i, c in enumerate(CARDS):
        x = 20 + i * (tw + 20)
        front = load01(tier / f"{c['id']}-front.webp")
        wear = np.asarray(Image.open(tier / f"{c['id']}-wear.png").convert("RGB"), np.float32) / 255
        wear_full = np.asarray(Image.fromarray(to8(wear)).resize(front.shape[1::-1], Image.BILINEAR), np.float32) / 255
        f = preview(front, wear_full, PAPER_WORN)
        bk = preview(back, wear_full[:, ::-1], PAPER_BACK, meta[c["id"]]["backFade"])
        sheet.paste(Image.fromarray(to8(f)).resize((tw, th), Image.LANCZOS), (x, y0))
        sheet.paste(Image.fromarray(to8(bk)).resize((tw, th), Image.LANCZOS), (x, y0 + th + 16))
        draw.text((x, y0 + 2 * th + 36), f"{c['rank']}  {c['title']}  wear {c['wear']}", font=small, fill=(236, 233, 225))
        gloss = Image.open(tier / f"{c['id']}-gloss.png").convert("L")
        chans = [Image.fromarray(to8(wear[..., k])) for k in range(3)] + [gloss]
        cw = (tw - 6) // 4
        for k, ch in enumerate(chans):
            im = ch.convert("RGB").resize((cw, round(cw * 1.4)), Image.LANCZOS)
            sheet.paste(im, (x + k * (cw + 2), y0 + 2 * th + 62))
        draw.text((x, y0 + 2 * th + 62 + round(cw * 1.4) + 4), "R sdf   G ink   B height   gloss", font=small, fill=(150, 150, 140))
    # 4 fps clip strip
    y = y0 + 2 * th + 62 + round(((tw - 6) // 4) * 1.4) + 40
    draw.text((20, y), "clip-9.mp4 at 4 fps (15.5-18.2 s of Meshy 2.mp4), then the baked still and the dimple tile",
              font=font, fill=(236, 233, 225))
    frames = BUILD / "clip-frames"
    shutil.rmtree(frames, ignore_errors=True)
    frames.mkdir(parents=True)
    subprocess.run(["ffmpeg", "-v", "error", "-i", str(STAGE / "assets/cards/clip-9.mp4"), "-vf", "fps=4",
                    str(frames / "f%02d.png")], check=True)
    fx = 20
    for p in sorted(frames.glob("f*.png")):
        im = Image.open(p).convert("RGB")
        im = im.resize((180, round(180 * im.height / im.width)), Image.LANCZOS)
        sheet.paste(im, (fx, y + 34))
        fx += 186
    still = Image.open(BUILD / "photos/9-photo.png").convert("RGB")
    still = still.resize((180, round(180 * still.height / still.width)), Image.LANCZOS)
    sheet.paste(still, (fx + 20, y + 34))
    dimple = Image.open(STAGE / "assets/cards/dimple-normal-256.png").convert("RGB")
    sheet.paste(dimple, (fx + 220, y + 34))
    bottom = y + 34 + still.height + 20
    sheet = sheet.crop((0, 0, sheet.width, bottom))
    path = BUILD / "contact.jpg"
    sheet.save(path, "JPEG", quality=88)
    return path


def install() -> None:
    for src in STAGE.rglob("*"):
        if src.is_file() and not src.name.startswith("._"):
            dst = WEB / src.relative_to(STAGE)
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(src, dst)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--only", help="comma-separated card ids (9,10,j,q,k,a)")
    ap.add_argument("--seed", type=int, default=DEFAULT_SEED)
    ap.add_argument("--sheet", action="store_true", help="write patches/build/cards/contact.jpg")
    ap.add_argument("--install", action="store_true", help="copy the staged outputs into cards/")
    args = ap.parse_args()
    only = set(args.only.split(",")) if args.only else None
    cards = [c for c in CARDS if only is None or c["id"] in only]
    if only and len(cards) != len(only):
        raise SystemExit(f"unknown card id in --only {args.only}")
    staged = STAGE / "data/cards.json"
    if only and staged.exists() and json.loads(staged.read_text())["seed"] != args.seed:
        raise SystemExit("--only must use the staged seed; run a full build to change seeds")

    marks = Marks(BUILD)
    still = video_still(BUILD) if any(c["id"] == "9" for c in cards) else None
    photos = {c["id"]: prepare_photos(c, still, BUILD / "photos") for c in cards}
    jobs = {c["id"]: front_svg(c, marks, photos[c["id"]]) for c in cards}
    if only is None:
        jobs["back"] = back_svg(marks)
    prints = render_prints(jobs, BUILD / "print")
    for c in cards:
        build_card(c, args.seed, prints[c["id"]])
        print("card", c["id"])
    if only is None:
        build_back(args.seed, prints["back"])
        build_dimple(args.seed)
        _, ph = window_rects("pip")
        w, h = photo_px(ph)
        build_clip(w / h)
    (STAGE / "data").mkdir(parents=True, exist_ok=True)
    (STAGE / "data/cards.json").write_text(json.dumps(manifest(args.seed), indent=1) + "\n")
    if args.sheet:
        print("sheet", contact_sheet(args.seed))
    if args.install:
        install()
        print("installed into", WEB)


if __name__ == "__main__":
    main()
