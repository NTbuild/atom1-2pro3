#!/usr/bin/env python3
"""P2 — header/footer identity strings (content swap; SSR HTML + 2 runtime chunks).

The home route chunk re-renders the header and footer after hydration, so the logo
alt, contact email and footer clock zone are patched in the chunk as well as in the
server-rendered HTML. Each target is asserted unique before replacement. Run after P1.
"""
import hashlib
import json
import shutil
from pathlib import Path

PROJECT = Path(__file__).resolve().parent.parent
SITE = PROJECT / "site"
PRISTINE = PROJECT / "patches/pristine"

# No NomadaToast address was supplied: RFC 2606 placeholder that cannot misroute mail.
EMAIL = "hello@example.com"
TZ_NAME, TZ_LABEL = "America/Sao_Paulo", "BRT"  # this Mac's /etc/localtime

PATCHES = {
    "_/index.html": [
        ('alt="Arc — home"', 'alt="NomadaToast — home"', 1),
        ("mailto:hello@arcmarumo.com", f"mailto:{EMAIL}", 2),
        ('<span class="vhs-tz"> SAST</span>', f'<span class="vhs-tz"> {TZ_LABEL}</span>', 1),
    ],
    "_next/static/immutable/chunks/1gvz9m-n0qmop.js": [
        ('alt:"Arc — home"', 'alt:"NomadaToast — home"', 1),
        ('let s="hello@arcmarumo.com"', f'let s="{EMAIL}"', 1),
        ('timeZone:"Africa/Johannesburg"', f'timeZone:"{TZ_NAME}"', 1),
        ('children:" SAST"', f'children:" {TZ_LABEL}"', 1),
    ],
    "_next/static/immutable/chunks/3i898asfgc_9u.js": [
        ('let o="hello@arcmarumo.com"', f'let o="{EMAIL}"', 1),
    ],
}


def sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def main() -> None:
    report = []
    for rel, swaps in PATCHES.items():
        target = SITE / rel
        pristine = PRISTINE / rel
        if not pristine.exists():
            pristine.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(target, pristine)
        pre = sha(target)
        text = target.read_text(encoding="utf-8")
        for old, new, count in swaps:
            if text.count(new) == count and text.count(old) == 0:
                continue  # already applied
            found = text.count(old)
            if found != count:
                raise SystemExit(f"{rel}: expected {count}× {old!r}, found {found}")
            text = text.replace(old, new)
        target.write_text(text, encoding="utf-8")
        report.append({"file": f"site/{rel}", "pre_sha256": pre, "post_sha256": sha(target),
                       "pristine": str(pristine.relative_to(PROJECT))})
    print(json.dumps(report, indent=1))


if __name__ == "__main__":
    main()
