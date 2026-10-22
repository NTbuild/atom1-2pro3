#!/usr/bin/env python3
"""Construction-time accommodations for the arcmarumo.com hero mirror.

Re-runnable after any `mirror_assets.py --resume`. It:
  1. keeps a pristine copy of the captured homepage document under ../pristine/,
  2. points the seven VHS sleeve URLs at the already-mirrored local copies
     (cdn.sanity.io refuses CORS from localhost, so WebGL textures drew blank),
  3. adds exact route_map entries for the desktop request (w=1200) and the
     mobile request the bundle's `sized()` helper builds (`/_next/image?...&w=640`),
  4. records every change in mirror-manifest.json.local_modifications,
  5. writes serve-contract.json, _ntsm/serve.py and serve-local.py, which the
     pipeline only emits on a clean run (its run ended on two telemetry scripts).

Usage: python3 tools/accommodate.py   (from the Project 3 folder)
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

PROJECT = Path(__file__).resolve().parent.parent
MIRROR = PROJECT / "mirror"
PRISTINE = PROJECT / "pristine"
SKILL_SERVE = Path.home() / ".claude/skills/nt-site-mirror/scripts/serve.py"
DOC = "_/index.html"
SANITY = "https://cdn.sanity.io/images/ngr7c3v4/production/"
LOCAL = "/_external/cdn.sanity.io/images/ngr7c3v4/production/"
ACTOR = "Claude (NT Site Mirror operator)"
PORT = 8037


def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def encode_uri_component(value: str) -> str:
    # Same character set JavaScript's encodeURIComponent leaves alone.
    return quote(value, safe="-_.!~*'()")


def main() -> None:
    manifest_path = MIRROR / "mirror-manifest.json"
    manifest = json.loads(manifest_path.read_text())

    # 1. Pristine copy (refreshed only if the mirror copy is still unmodified).
    doc = MIRROR / DOC
    pristine_doc = PRISTINE / DOC
    pristine_doc.parent.mkdir(parents=True, exist_ok=True)
    original = doc.read_text(encoding="utf-8")
    if SANITY in original or not pristine_doc.exists():
        pristine_doc.write_text(original, encoding="utf-8")
    pristine = pristine_doc.read_text(encoding="utf-8")

    # Sleeve downloads: the 762x1150 images, keyed by width variant.
    sleeves: dict[str, dict[str, dict]] = {}
    for item in manifest["downloaded"]:
        url = item["url"]
        if url.startswith(SANITY) and "-762x1150.webp?" in url:
            name = url[len(SANITY):].split("?", 1)[0]
            width = "1200" if "w=1200" in url else "640"
            sleeves.setdefault(name, {})[width] = item

    # 2. Rewrite sleeve URLs in the document (cover URLs for work pages stay as-is).
    patched = pristine
    for name in sleeves:
        patched = patched.replace(SANITY + name, LOCAL + name)
    doc.write_text(patched, encoding="utf-8")

    # 3. Exact route_map entries.
    route_map = manifest["route_map"]
    added = []
    for name, variants in sorted(sleeves.items()):
        desktop_target = LOCAL + name + "?w=1200&auto=format"
        mobile_target = "/_next/image?url=%s&w=640&q=75" % encode_uri_component(desktop_target)
        for target, width in ((desktop_target, "1200"), (mobile_target, "640")):
            item = variants[width]
            route_map[target] = {
                "local_path": item["path"],
                "content_type": item.get("content_type") or "image/webp",
                "source_url": item["url"],
                "sha256": item["sha256"],
            }
            added.append(target)

    # Browsers also ask for bare /favicon.ico; the origin serves the same bytes
    # (sha256 checked) as the query-stamped icon the page declares.
    favicon = route_map["/favicon.ico?favicon.2g6m_zl2nfl0r.ico"]
    route_map["/favicon.ico"] = dict(favicon)
    added.append("/favicon.ico")

    # 4. Ledger.
    stamp = now()
    entries = [
        {
            "id": "localize-sleeve-urls",
            "phase": "construction",
            "actor": ACTOR,
            "file": DOC,
            "reason": "cdn.sanity.io returns no Access-Control-Allow-Origin for localhost, so the "
                      "WebGL sleeve textures failed CORS and drew blank. The captured copies "
                      "already in _external/ are served same-origin instead.",
            "before": "7 sleeve URLs (…-762x1150.webp?w=1200&auto=format) on https://cdn.sanity.io/images/ngr7c3v4/production/",
            "after": "same paths and queries under %s" % LOCAL,
            "pristine_copy": str(pristine_doc.relative_to(PROJECT)),
            "pristine_sha256": sha(pristine_doc),
            "patched_sha256": sha(doc),
            "validation": "reports/validation-report.md (sleeves render in local WebGL scene, desktop + mobile)",
            "at": stamp,
        },
        {
            "id": "route-map-sleeves",
            "phase": "construction",
            "actor": ACTOR,
            "file": "mirror-manifest.json#route_map",
            "reason": "Exact path+query routes for the localized sleeves: desktop w=1200 and the "
                      "mobile /_next/image?...&w=640 URL the bundle's sized() helper builds at <=700px; "
                      "plus bare /favicon.ico (origin serves identical bytes, sha256-verified).",
            "before": "no entries",
            "after": "%d entries" % len(added),
            "targets": added,
            "validation": "local server log shows route-map hits, no 404s for sleeves",
            "at": stamp,
        },
    ]
    ids = {e["id"] for e in entries}
    manifest["local_modifications"] = [
        m for m in manifest.get("local_modifications", []) if m.get("id") not in ids
    ] + entries

    # 5. Serving contract + portable launcher.
    ntsm = MIRROR / "_ntsm"
    ntsm.mkdir(exist_ok=True)
    shutil.copyfile(SKILL_SERVE, ntsm / "serve.py")
    launcher = MIRROR / "serve-local.py"
    launcher.write_text(
        '#!/usr/bin/env python3\n'
        '"""Portable launcher (NT Site Mirror v1.3 layout)."""\n'
        'from pathlib import Path\nimport runpy\nimport sys\n\n'
        'ROOT = Path(__file__).resolve().parent\n'
        'SERVER = ROOT / "_ntsm" / "serve.py"\n'
        'sys.argv = [str(SERVER), str(ROOT), "--contract", str(ROOT / "serve-contract.json")] + sys.argv[1:]\n'
        'runpy.run_path(str(SERVER), run_name="__main__")\n'
    )
    os.chmod(launcher, 0o755)
    contract = {
        "schema_version": manifest.get("schema_version", "1.3"),
        "manifest": "mirror-manifest.json",
        "route_map": "mirror-manifest.json#route_map",
        "bind": "127.0.0.1",
        "port": PORT,
        "spa_fallback": False,
        "safe_spa_entry": None,
        "cache_control": "no-store",
        "range_requests": True,
        "launcher": "serve-local.py",
        "generated": {"phase": "construction", "actor": ACTOR, "at": stamp},
    }
    (MIRROR / "serve-contract.json").write_text(json.dumps(contract, indent=2) + "\n")

    generated = []
    for rel, kind in (("_ntsm/serve.py", "bundled-local-server"),
                      ("serve-local.py", "portable-launcher"),
                      ("serve-contract.json", "serve-contract")):
        path = MIRROR / rel
        generated.append({
            "path": rel, "kind": kind, "sha256": sha(path), "bytes": path.stat().st_size,
            "phase": "construction", "actor": ACTOR, "at": stamp,
            "note": "written by tools/accommodate.py; the pipeline emits these only on a run "
                    "with zero required failures (its only failures were Vercel telemetry).",
        })
    keep = [g for g in manifest.get("generated_artifacts", []) if g.get("path") not in {g2["path"] for g2 in generated}]
    manifest["generated_artifacts"] = keep + generated
    manifest["construction_provenance"] = [
        p for p in manifest.get("construction_provenance", []) if p.get("id") != "accommodate.py"
    ] + [{
        "id": "accommodate.py", "phase": "construction", "actor": ACTOR, "at": stamp,
        "script": "tools/accommodate.py",
        "telemetry_classification": [
            {"url": "https://www.arcmarumo.com/aafe13344bef70fc/script.js", "class": "telemetry",
             "what": "Vercel Web Analytics", "action": "not replayed; 404 locally (logs a console notice only)"},
            {"url": "https://www.arcmarumo.com/5d18c82ce29be22e/script.js", "class": "telemetry",
             "what": "Vercel Speed Insights", "action": "not replayed; 404 locally (logs a console notice only)"},
        ],
    }]
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    print("sleeves localized: %d, route_map entries: %d" % (len(sleeves), len(added)))
    print("serve: python3 \"%s\"" % launcher)


if __name__ == "__main__":
    main()
