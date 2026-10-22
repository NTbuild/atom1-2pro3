#!/usr/bin/env python3
"""Build NomadaToast brand assets for patches P3–P5 from the user-supplied Tino Assets.

Outputs land in patches/build/ (nothing in site/ is touched here):
  wordmark/plus.png, wordmark/toast.png   extracted from "& Toast (1).png" (exterior red keyed out)
  logo/arc-logo.svg, logo/arc-bands.svg, logo/arc-mark.svg   same viewBoxes as the originals
  sleeves/<id>-1200.jpg (1200×1811), sleeves/<id>-640.jpg (640×966)   one per tape slot
  icons/*, og.jpg

Usage: python3 -I patches/build_brand_assets.py   (needs Pillow + Playwright Chromium)
"""
from __future__ import annotations

import base64
import io
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

PROJECT = Path(__file__).resolve().parent.parent
ASSETS = Path("/Volumes/SSD/Tino Assets")
OUT = PROJECT / "patches/build"
RED = (227, 49, 49)  # sampled from "& Toast (1).png"
RED_HEX = "#E33131"

# Slot order matches projects[] in the page payload; ids are the existing sleeve files.
SLEEVES = [
    dict(id="0d2f7998cf79c6182a9aaa65c399492e7c370faa", title=["NOMADA", "TOAST"], year=2026,
         photo="PP Toast.jpg", layout="bottom", pos="50% 30%", ink="#f1ede4", accent=RED_HEX,
         lines=["#f1ede4", RED_HEX]),
    dict(id="0b6a9d47b94e751d049df2b3f31706402e30836b", title=["AI", "STUDIO"], year=2026,
         photo="8.1-invideo-nanobanana_2 2.png", layout="top", pos="54% 50%", ink="#ff5ad9",
         accent="#ff5ad9", filter="contrast(1.08) saturate(1.15)"),
    dict(id="2c6d662d3a03cc811f4c4181f3752181cb1cdb05", title=["GROWTH", "CAMP"], year=2026,
         photo="growth camp.jpg", layout="band", ink="#111111", accent=RED_HEX,
         lines=["#111111", RED_HEX]),
    dict(id="ac9e00d6e5087d500bf2219e149e167bd56ecd75", title=["VIRAL", "LOOP"], year=2025,
         photo="hf_20260627_145124_0ec89523-a7e9-4a15-b3bd-367e2f865593.png", layout="vertical",
         pos="50% 50%", ink="#3fd0bd", accent="#3fd0bd"),
    dict(id="de69761688b9f069680c2424a56b4048d88e613b", title=["X-RAY"], year=2025,
         photo="xray skeleton 2.png", layout="center", pos="40% 50%", ink="#f1ede4",
         accent="#5b7cff", duotone="#5b7cff"),
    dict(id="da5428375cc9fd88bf102e806c3339ce75d3ece5", title=["ROAD", "TEST"], year=2025,
         photo="5b.png", layout="bottom", pos="44% 50%", ink="#ff8a00", accent="#ff8a00"),
    dict(id="5d872c051b87858247858e962bc7fad82874f136", title=["SUPPORTER"], year=2026,
         photo="Suporter.jpg", layout="band", ink="#111111", accent=RED_HEX),
]


def data_uri(img: Image.Image) -> str:
    buf = io.BytesIO()
    img.save(buf, "PNG", optimize=True)
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


def file_uri(path: Path) -> str:
    return path.resolve().as_uri()


# ---------- 1. wordmark extraction ----------

def extract_wordmark() -> tuple[Image.Image, Image.Image]:
    src = Image.open(ASSETS / "& Toast (1).png").convert("RGB")
    crop = src.crop((455, 1501, 3713, 2666))  # ink bbox + 40 px
    crop = crop.resize((crop.width // 2, crop.height // 2), Image.LANCZOS)
    w, h = crop.size

    # Key out only the red that touches the border, so the red face inside the "o" stays.
    work = crop.copy()
    ImageDraw.floodfill(work, (0, 0), (0, 255, 0), thresh=90)
    r, g, b = work.split()

    # Enclosed red counters (the "a") go too; the largest enclosed red region is the face
    # in the "o" and stays. Each component is flooded with its own sentinel blue level.
    px = work.load()
    sizes = {}
    level = 1
    for y in range(h):
        for x in range(w):
            pr, pg, pb = px[x, y]
            if (pr, pg) != (0, 255) and abs(pr - RED[0]) + abs(pg - RED[1]) + abs(pb - RED[2]) < 90:
                ImageDraw.floodfill(work, (x, y), (1, 1, level), thresh=90)
                sizes[level] = 0
                level += 1
    for (cr, cg, cb) in work.getdata():
        if cr == 1 and cg == 1 and cb in sizes:
            sizes[cb] += 1
    face = max(sizes, key=sizes.get) if sizes else None
    counters = {k for k, n in sizes.items() if k != face and n > 500}
    r, g, b = work.split()
    ext = ImageChops.multiply(
        ImageChops.multiply(r.point(lambda v: 255 if v == 0 else 0),
                            g.point(lambda v: 255 if v == 255 else 0)),
        b.point(lambda v: 255 if v == 0 else 0))
    holes = ImageChops.multiply(
        ImageChops.multiply(r.point(lambda v: 255 if v == 1 else 0), g.point(lambda v: 255 if v == 1 else 0)),
        b.point(lambda v: 255 if v in counters else 0))
    ext = ImageChops.lighter(ext, holes)
    band = ImageChops.subtract(ext.filter(ImageFilter.MaxFilter(5)), ext)

    # Edge pixels are white blended over red: recover coverage from the green channel.
    _, g0, _ = crop.split()
    edge_alpha = g0.point(lambda v: max(0, min(255, round((v - 49) * 255 / 206))))
    alpha = Image.composite(edge_alpha, Image.new("L", (w, h), 255), band)
    alpha = Image.composite(Image.new("L", (w, h), 0), alpha, ext)
    rgb = Image.composite(Image.new("RGB", (w, h), (255, 255, 255)), crop, band)
    mark = rgb.convert("RGBA")
    mark.putalpha(alpha)

    # Split the "+" from "toast" at the first fully transparent column run.
    cols = [alpha.crop((x, 0, x + 1, h)).getbbox() is not None for x in range(w)]
    x = 0
    while not cols[x]:
        x += 1
    while cols[x]:
        x += 1
    gap_start = x
    while not cols[x]:
        x += 1
    plus = mark.crop((0, 0, gap_start, h))
    plus = plus.crop(plus.getbbox())
    toast = mark.crop((x, 0, w, h))
    toast = toast.crop(toast.getbbox())

    # The banner lockup shows the "+" in brand red.
    pr, pg, pb, pa = plus.split()
    plus = Image.merge("RGBA", (*Image.new("RGB", plus.size, RED).split(), pa))

    (OUT / "wordmark").mkdir(parents=True, exist_ok=True)
    plus.save(OUT / "wordmark/plus.png")
    toast.save(OUT / "wordmark/toast.png")
    return plus, toast


# ---------- 2. HTML renders (Playwright) ----------

LOGO_HTML = """<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:NB;src:local("HelveticaNeue-Bold")}
html,body{margin:0;background:transparent}
.box{width:%(w)dpx;height:%(h)dpx;display:flex;align-items:center;justify-content:center;gap:%(gap)dpx}
.plus{height:%(plus_h)dpx;align-self:%(plus_align)s;margin-top:%(plus_mt)dpx}
.stack{display:flex;flex-direction:column;align-items:flex-end}
.nomada{font:%(nomada_px)dpx/0.8 NB;color:%(red)s;letter-spacing:-0.01em;margin:0 %(nomada_mr)dpx %(nomada_mb)dpx 0}
.toast{height:%(toast_h)dpx;display:block}
</style></head><body><div class="box">
<img class="plus" src="%(plus)s">
<div class="stack">%(nomada)s<img class="toast" src="%(toast)s"></div>
</div></body></html>"""

GRAIN = ("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='300' height='300'>"
         "<filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' "
         "stitchTiles='stitch'/></filter><rect width='100%25' height='100%25' filter='url(%23n)'/></svg>")

SLEEVE_HTML = """<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:TB;src:local("HelveticaNeue-CondensedBlack")}
@font-face{font-family:NM;src:local("HelveticaNeue-Medium")}
@font-face{font-family:NB;src:local("HelveticaNeue-Bold")}
html,body{margin:0}
.s{position:relative;width:1200px;height:1811px;overflow:hidden;background:%(bg)s;color:%(ink)s}
.rule{position:absolute;left:60px;right:60px;height:3px;background:%(rule)s}
.brand{position:absolute;top:84px;left:0;right:0;display:flex;justify-content:center;align-items:center;gap:10px}
.brand .plus{height:40px}.brand .toast{height:52px}
.hv{position:absolute;top:150px;left:0;right:0;text-align:center;font:500 30px NM;letter-spacing:.34em;color:%(rule)s}
.photo{position:absolute;overflow:hidden;background:#000}
.photo img{width:100%%;height:100%%;object-fit:cover;object-position:%(pos)s;filter:%(filter)s;display:block}
.duo{position:absolute;inset:0;background:%(duotone)s;mix-blend-mode:multiply}
.title{position:absolute;left:40px;right:40px;font:310px/0.8 TB;letter-spacing:-0.01em;text-transform:uppercase}
.title span{display:block}
.foot{position:absolute;left:60px;right:60px;bottom:58px;height:110px;display:flex;align-items:center;justify-content:space-between}
.vhs{font:64px/1 TB;letter-spacing:.04em;border:5px solid %(accent)s;color:%(accent)s;padding:6px 14px 2px}
.year{font:500 40px NM;color:%(accent)s;letter-spacing:.08em}
.badge{height:110px}
.grain{position:absolute;inset:0;background:url("%(grain)s");opacity:.10;mix-blend-mode:overlay;pointer-events:none}
.head{position:absolute;left:0;right:0;top:0;height:236px;background:%(head)s}
.fade{position:absolute;inset:0;background:linear-gradient(rgba(12,11,10,0) 52%%,rgba(12,11,10,.9) 92%%)}
%(extra)s
</style></head><body><div class="s">
<div class="head"></div>
<div class="rule" style="top:66px"></div>
<div class="brand"><img class="plus" src="%(plus)s"><img class="toast" src="%(toast)s"></div>
<div class="hv">HOME VIDEO</div>
<div class="rule" style="top:204px"></div>
<div class="photo">%(photo)s</div>
<div class="title">%(title)s</div>
<div class="foot"><span class="vhs">VHS</span><span class="year">%(year)s</span><img class="badge" src="%(plus)s"></div>
<div class="grain"></div>
</div>
<script>
// shrink any title line that would overflow the sleeve
for (const s of document.querySelectorAll('.title span')) {
  const box = s.parentElement.clientWidth;
  let px = parseFloat(getComputedStyle(s).fontSize);
  s.style.whiteSpace = 'nowrap';
  while (s.scrollWidth > s.clientWidth && px > 60) { px -= 4; s.style.fontSize = px + 'px'; }
}
</script></body></html>"""

LAYOUTS = {
    # photo panel + title placement, echoing the varied compositions of the original sleeves
    "bottom": ".photo{left:60px;right:60px;top:236px;height:1080px}.title{top:1150px}",
    "top": ".photo{left:60px;right:60px;top:236px;bottom:200px}.title{top:262px}",
    "center": ".photo{left:60px;right:60px;top:236px;bottom:200px}"
              ".title{top:640px;font-size:420px;text-align:center;mix-blend-mode:difference}",
    "vertical": ".photo{left:330px;right:60px;top:236px;bottom:200px}"
                ".title{left:40px;top:1600px;width:1380px;transform:rotate(-90deg);transform-origin:0 0;font-size:300px;line-height:.8}",
    "band": ".photo{left:0;right:0;top:300px;height:753px;background:transparent}"
            ".photo img{object-fit:contain}.title{top:1100px;text-align:left;font-size:280px}",
}


def render(plus: Image.Image, toast: Image.Image) -> None:
    from playwright.sync_api import sync_playwright

    plus_uri, toast_uri = data_uri(plus), data_uri(toast)
    (OUT / "logo").mkdir(parents=True, exist_ok=True)
    (OUT / "sleeves").mkdir(parents=True, exist_ok=True)

    pa, ta = plus.width / plus.height, toast.width / toast.height

    def logo_html(w, h, stacked, scale):
        if stacked:  # "+ nomada/toast", as on the banner
            toast_h, plus_h, gap = 0.62 * h, 0.6 * h, 0.08 * h
        else:  # "+toast", fitted to the box width
            toast_h = min(0.8 * h, 0.94 * w / (0.8 * pa + 0.1 + ta))
            plus_h, gap = 0.8 * toast_h, 0.1 * toast_h
        return LOGO_HTML % dict(
            w=w, h=h, gap=round(gap), red=RED_HEX, plus=plus_uri, toast=toast_uri,
            plus_h=round(plus_h), toast_h=round(toast_h),
            plus_align="flex-start" if stacked else "center", plus_mt=round(0.06 * h) if stacked else 0,
            nomada='<div class="nomada">nomada</div>' if stacked else "",
            nomada_px=round(0.34 * h), nomada_mr=round(0.03 * h), nomada_mb=round(0.04 * h))

    jobs = {
        # name: (css w, css h, stacked lockup, svg viewBox w, svg viewBox h)
        "arc-logo": (920, 240, True, 115, 30),
        "arc-bands": (536, 240, False, 67, 30),
        "arc-mark": (532, 157, False, 66.4559, 19.6479),
    }
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page(device_scale_factor=1)
        for name, (w, h, stacked, vw, vh) in jobs.items():
            page.set_viewport_size({"width": w, "height": h})
            page.set_content(logo_html(w, h, stacked, w / vw))
            page.wait_for_timeout(150)
            png = page.screenshot(omit_background=True, clip={"x": 0, "y": 0, "width": w, "height": h})
            img = Image.open(io.BytesIO(png))
            img.save(OUT / f"logo/{name}.png")
            svg = (f'<svg width="{vw}" height="{vh}" viewBox="0 0 {vw} {vh}" fill="none" '
                   f'xmlns="http://www.w3.org/2000/svg">\n<!-- NomadaToast lockup ({name}), built by '
                   f'patches/build_brand_assets.py from the Tino Assets wordmark -->\n'
                   f'<image width="{vw}" height="{vh}" preserveAspectRatio="xMidYMid meet" '
                   f'href="{data_uri(img)}"/>\n</svg>\n')
            (OUT / f"logo/{name}.svg").write_text(svg)

        page.set_viewport_size({"width": 1200, "height": 1811})
        for sl in SLEEVES:
            light = sl["layout"] == "band"
            photo = f'<img src="{file_uri(ASSETS / sl["photo"])}">'
            if sl.get("duotone"):
                photo += '<div class="duo"></div>'
            if sl["layout"] == "bottom":
                photo += '<div class="fade"></div>'
            colors = sl.get("lines") or [sl["ink"]] * len(sl["title"])
            title = "".join(f'<span style="color:{c}">{t}</span>' for t, c in zip(sl["title"], colors))
            html = SLEEVE_HTML % dict(
                bg="#d9d8d4" if light else "#0c0b0a", ink=sl["ink"],
                head="#111111" if light else "transparent", rule="rgba(241,237,228,.75)",
                plus=plus_uri, toast=toast_uri,
                pos=sl.get("pos", "50% 50%"),
                filter=sl.get("filter", "grayscale(1) contrast(1.15)" if sl.get("duotone") else "none"),
                duotone=sl.get("duotone", "transparent"), photo=photo, title=title,
                year=sl["year"], accent=sl["accent"], grain=GRAIN, extra=LAYOUTS[sl["layout"]])
            # file:// page so the local photo files may load
            tmp = OUT / "tmp" / f"sleeve-{sl['id'][:4]}.html"
            tmp.parent.mkdir(exist_ok=True)
            tmp.write_text(html, encoding="utf-8")
            page.goto(tmp.resolve().as_uri())
            page.wait_for_load_state("load")
            page.evaluate("document.fonts.ready")
            page.wait_for_timeout(200)
            png = page.screenshot(clip={"x": 0, "y": 0, "width": 1200, "height": 1811})
            img = Image.open(io.BytesIO(png)).convert("RGB")
            img.save(OUT / f"sleeves/{sl['id']}-1200.jpg", "JPEG", quality=88, optimize=True)
            img.resize((640, 966), Image.LANCZOS).save(
                OUT / f"sleeves/{sl['id']}-640.jpg", "JPEG", quality=86, optimize=True)
        browser.close()


# ---------- 3. icons + OG ----------

def icons_and_og(plus: Image.Image) -> None:
    (OUT / "icons").mkdir(parents=True, exist_ok=True)
    size = 512
    tile = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(tile).rounded_rectangle((0, 0, size - 1, size - 1), radius=112, fill=(17, 17, 17, 255))
    p = plus.copy()
    p.thumbnail((int(size * 0.66), int(size * 0.66)), Image.LANCZOS)
    tile.alpha_composite(p, ((size - p.width) // 2, (size - p.height) // 2))
    tile.resize((192, 192), Image.LANCZOS).save(OUT / "icons/icon1.png")
    apple = Image.new("RGB", (180, 180), (17, 17, 17))
    pa = plus.copy()
    pa.thumbnail((112, 112), Image.LANCZOS)
    apple.paste(pa, ((180 - pa.width) // 2, (180 - pa.height) // 2), pa)
    apple.save(OUT / "icons/apple-icon.png")
    tile.save(OUT / "icons/favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])
    (OUT / "icons/icon.svg").write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">\n'
        '  <!-- NomadaToast "+" (Tino Assets wordmark) on the screen\'s dark. -->\n'
        f'  <image width="32" height="32" href="{data_uri(tile.resize((128, 128), Image.LANCZOS))}"/>\n'
        '</svg>\n')

    banner = Image.open(ASSETS / "Banner 1.jpg").convert("RGB")  # 5939×2200, lockup left of centre
    w = round(2200 * 1200 / 630)
    left = 300
    banner.crop((left, 0, left + w, 2200)).resize((1200, 630), Image.LANCZOS).save(
        OUT / "og.jpg", "JPEG", quality=86, optimize=True)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    plus, toast = extract_wordmark()
    render(plus, toast)
    icons_and_og(plus)
    print("built:", sorted(str(p.relative_to(OUT)) for p in OUT.rglob("*") if p.is_file() and not p.name.startswith("._")))


if __name__ == "__main__":
    main()
