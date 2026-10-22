#!/usr/bin/env python3
"""P1 — NomadaToast tape data + page metadata (content swap, `_/index.html`).

Patches every runtime-effective copy: the RSC flight row `b:` (projects[] that the
carousel hydrates from), the server-rendered caption, and the <head> metadata plus
its RSC twin (row `12:`). Each replacement asserts its expected occurrence count.
Re-runnable from the pristine copy in patches/pristine/.
"""
import hashlib
import json
import re
import shutil
from pathlib import Path

PROJECT = Path(__file__).resolve().parent.parent
TARGET = PROJECT / "site/_/index.html"
PRISTINE = PROJECT / "patches/pristine/_/index.html"

# (slot in the captured projects[] whose sleeve file the tape uses, slug, title, discipline,
#  description, year). Slot 2 (Growth Camp) was dropped at the user's request.
TAPES = [
    (0, "nomada-toast", "Nomada Toast", "Tech • AI • Social Growth",
     "Tech, AI and social media growth, served hot every week", 2026),
    (1, "ai-studio", "AI Studio", "AI Tools • Video",
     "Hands-on with the newest AI video, image and voice tools", 2026),
    (3, "viral-loop", "Viral Loop", "Short-form • Strategy",
     "Breaking down the hooks, edits and formats that travel", 2025),
    (4, "x-ray", "X-Ray", "Tech • Deep Dives",
     "Under the hood of the tech everyone is talking about", 2025),
    (5, "road-test", "Road Test", "Gadgets • Apps",
     "New gear and apps, tested in real life before you buy", 2025),
    (6, "supporter", "Supporter", "Community • Membership",
     "The crew that keeps the toaster running", 2026),
]

TITLE_OLD, TITLE_NEW = "Arc ©'26", "NomadaToast ©'26"
DESC_OLD = ("Arc: a multi-disciplinary designer and Awwwards Juror with over 7 years of "
            "experience crafting digital products for agencies, studios and startups.")
DESC_NEW = ("NomadaToast: tech, AI and social media growth, tested by a creator before "
            "it reaches your feed.")
OG_OLD, OG_NEW = "https://www.arcmarumo.com/og.jpg", "/og.jpg"
OGALT_OLD = "The Arc site on an old white CRT monitor: the home page's VHS tapes, RemyShoots in the middle."
OGALT_NEW = "NomadaToast on an old CRT: the home page's VHS tapes, Nomada Toast in the middle."


def sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def swap(text: str, old: str, new: str, count: int) -> str:
    found = text.count(old)
    if found != count:
        raise SystemExit(f"expected {count}× {old[:50]!r}, found {found}")
    return text.replace(old, new)


def main() -> None:
    if not PRISTINE.exists():
        PRISTINE.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(TARGET, PRISTINE)
    pre = sha(TARGET)
    html = PRISTINE.read_text(encoding="utf-8")

    # 1. RSC row b: — rebuild projects[] keeping each slot's sleeve URL (P4 swaps the bytes).
    scripts = list(re.finditer(r'<script>self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)</script>', html))
    hits = [s for s in scripts if '\\"projects\\":' in s.group(1)]
    if len(hits) != 1:
        raise SystemExit(f"expected 1 flight chunk with projects, found {len(hits)}")
    lit = hits[0].group(1)
    payload = json.loads(lit)
    rows = payload.split("\n")
    idx = [i for i, r in enumerate(rows) if r.startswith('b:["$","$L15",null,{"projects":')]
    if len(idx) != 1:
        raise SystemExit("projects row not found exactly once")
    row = json.loads(rows[idx[0]][2:])
    projects = row[3]["projects"]
    if len(projects) != 7:
        raise SystemExit(f"expected the 7 captured projects, found {len(projects)}")
    tapes = []
    for slot, slug, title, discipline, description, year in TAPES:
        proj = dict(projects[slot])
        sleeve = dict(proj["sleeve"], alt=f"{title} VHS cover")
        proj.update(slug=slug, title=title, discipline=discipline, description=description,
                    year=year, sleeve=sleeve,
                    # cover feeds /work pages only (out of scope): point it at the local sleeve
                    cover=dict(sleeve, alt=f"{title} cover"))
        tapes.append(proj)
    row[3]["projects"] = tapes
    rows[idx[0]] = "b:" + json.dumps(row, ensure_ascii=False, separators=(",", ":"))
    new_lit = json.dumps("\n".join(rows), ensure_ascii=False)
    html = html.replace(lit, new_lit, 1)

    # 2. SSR caption for the first tape (hydration expects it to match projects[0]).
    _, slug, title, discipline, description, _ = TAPES[0]
    html = swap(html, 'aria-label="RemyShoots"', f'aria-label="{title}"', 1)
    html = swap(html, 'href="/work/remyshoots"', f'href="/work/{slug}"', 1)
    html = swap(html, ">RemyShoots</span>", f">{title}</span>", 1)
    html = swap(html, ">Built to get the work seen, and recognised with four CSSDA awards</span>",
                f">{description}</span>", 1)
    html = swap(html, ">Web Design • Development</span>", f">{discipline}</span>", 1)

    # 3. Metadata: <head> plus its RSC twin (row 12:).
    # <head> escapes apostrophes as &#x27;; the RSC row keeps them raw.
    def esc(s: str) -> str:
        return s.replace("'", "&#x27;")
    html = swap(html, TITLE_OLD, TITLE_NEW, 6)
    html = swap(html, esc(TITLE_OLD), esc(TITLE_NEW), 6)
    html = swap(html, DESC_OLD, DESC_NEW, 6)
    html = swap(html, OG_OLD, OG_NEW, 4)
    html = swap(html, OGALT_OLD, OGALT_NEW, 2)
    html = swap(html, esc(OGALT_OLD), esc(OGALT_NEW), 2)
    for leftover in ("RemyShoots", "remyshoots", "cdn.sanity.io/images/ngr7c3v4/production/4c0a"):
        if leftover in html:
            raise SystemExit(f"leftover {leftover!r}")

    TARGET.write_text(html, encoding="utf-8")
    print(json.dumps({"file": "site/_/index.html", "pre_sha256": pre, "post_sha256": sha(TARGET),
                      "pristine": str(PRISTINE.relative_to(PROJECT))}, indent=1))


if __name__ == "__main__":
    main()
