#!/usr/bin/env python3
"""P6 — tapes play their video (behavioral edit, narrow).

1. `_/index.html`: load /nt/player.css + /nt/player.js (added files in site/nt/) before </body>.
2. `1gvz9m-n0qmop.js`: the carousel's open callback navigated to /work/<slug>, which is
   not mirrored. It now dispatches `nt:play` with the slug for player.js. The settle-time
   prefetch of /work/<slug> (always a local 404) is dropped.
Each target is asserted unique. Run after P1 and P2.
"""
import hashlib
import json
import shutil
from pathlib import Path

PROJECT = Path(__file__).resolve().parent.parent
SITE = PROJECT / "site"
PRISTINE = PROJECT / "patches/pristine"

HOOK = '<link rel="stylesheet" href="/nt/player.css"/><script src="/nt/player.js" defer></script>'
PATCHES = {
    "_/index.html": [
        ("</body>", HOOK + "</body>", 1),
    ],
    "_next/static/immutable/chunks/1gvz9m-n0qmop.js": [
        ("q=(0,s.useCallback)(t=>(0,h.transitionTo)(()=>r.push(`/work/${e[t].slug}`)),[r,e])",
         'q=(0,s.useCallback)(t=>window.dispatchEvent(new CustomEvent("nt:play",{detail:e[t].slug})),[r,e])', 1),
        ("n&&r.prefetch(`/work/${n.slug}`)", "n&&void 0", 1),
    ],
}


def sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def main() -> None:
    report = []
    for rel, swaps in PATCHES.items():
        target, pristine = SITE / rel, PRISTINE / rel
        if not pristine.exists():
            pristine.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(target, pristine)
        pre = sha(target)
        text = target.read_text(encoding="utf-8")
        for old, new, count in swaps:
            if new in text:
                continue  # already applied
            found = text.count(old)
            if found != count:
                raise SystemExit(f"{rel}: expected {count}× {old[:60]!r}, found {found}")
            text = text.replace(old, new)
        target.write_text(text, encoding="utf-8")
        report.append({"patch": "P6", "file": f"site/{rel}", "pre_sha256": pre, "post_sha256": sha(target)})
    print(json.dumps(report, indent=1))


if __name__ == "__main__":
    main()
