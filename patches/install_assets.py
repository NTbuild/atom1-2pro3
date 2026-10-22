#!/usr/bin/env python3
"""Install built NomadaToast assets into site/ at their existing paths (asset swaps P3–P5).

Usage: python3 -I patches/install_assets.py p3|p4|p5
Keeps a pristine copy of every replaced file under patches/pristine/ and prints
pre/post SHA-256 for the patch log. Same path, same pixel size, same format.
"""
import hashlib
import json
import shutil
import sys
from pathlib import Path

PROJECT = Path(__file__).resolve().parent.parent
SITE = PROJECT / "site"
BUILD = PROJECT / "patches/build"
PRISTINE = PROJECT / "patches/pristine"
SANITY = "_external/cdn.sanity.io/images/ngr7c3v4/production"
SLEEVE_IDS = [
    "0d2f7998cf79c6182a9aaa65c399492e7c370faa", "0b6a9d47b94e751d049df2b3f31706402e30836b",
    "2c6d662d3a03cc811f4c4181f3752181cb1cdb05", "ac9e00d6e5087d500bf2219e149e167bd56ecd75",
    "de69761688b9f069680c2424a56b4048d88e613b", "da5428375cc9fd88bf102e806c3339ce75d3ece5",
    "5d872c051b87858247858e962bc7fad82874f136",
]

PATCHES = {
    "p3": {
        "brand/arc-logo.svg": "logo/arc-logo.svg",
        "brand/arc-bands.svg": "logo/arc-bands.svg",
        "about/arc-mark.svg": "logo/arc-mark.svg",
    },
    "p4": {
        **{f"{SANITY}/{i}-762x1150__q_09b6cb73ffa3ccc7.webp": f"sleeves/{i}-1200.jpg" for i in SLEEVE_IDS},
        **{f"{SANITY}/{i}-762x1150__q_07039c2c44d7cce9.webp": f"sleeves/{i}-640.jpg" for i in SLEEVE_IDS},
    },
    "p5": {
        "favicon__q_6a07e95189b14176.ico": "icons/favicon.ico",
        "icon__q_597e0c2e60754391.svg": "icons/icon.svg",
        "icon1__q_ab8733923c70f0ce.png": "icons/icon1.png",
        "apple-icon__q_1e84c58542855607.png": "icons/apple-icon.png",
        "og.jpg": "og.jpg",
    },
}


def sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def main(name: str) -> None:
    rows = []
    for rel, built in PATCHES[name].items():
        target, source = SITE / rel, BUILD / built
        if not target.exists() or not source.exists():
            raise SystemExit(f"missing {target if not target.exists() else source}")
        pristine = PRISTINE / rel
        if not pristine.exists():
            pristine.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(target, pristine)
        pre = sha(target)
        shutil.copyfile(source, target)
        rows.append({"file": f"site/{rel}", "from": f"patches/build/{built}",
                     "pre_sha256": pre, "post_sha256": sha(target)})
    print(json.dumps(rows, indent=1))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "")
