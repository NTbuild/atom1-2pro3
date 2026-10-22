# Editability Map

Project type: `Hybrid`: a patched Static Mirror plus one added section (`site/nt/`, the tape player). Evidence: `site/mirror-manifest.json`, serve contract, minified Next/Turbopack chunks. Source of truth: runtime-effective captured artifacts in `site/`.

- Entries point to runtime-effective captured artifacts loaded on `/`.
- `mirror-manifest.json` is read-only baseline provenance; post-delivery work is recorded only in `reports/patch-log.md`.

## Editability by layer

| Layer | Tier | Confidence | Where / how |
| --- | --- | --- | --- |
| Content / text / copy (tapes) | Safe | verified | `patches/p1_tape_data.py` → `TAPES` list (rewrites RSC row `b:` + SSR caption in `site/_/index.html`) |
| Metadata / SEO | Safe | verified | `patches/p1_tape_data.py` (`TITLE_*`, `DESC_*`, `OG*`); `<head>` HTML-escapes `'` as `&#x27;` |
| Logos / images | Safe | verified | `patches/build_brand_assets.py` → `patches/install_assets.py p3|p4|p5` (same paths, same sizes) |
| Fonts | Moderate risk | probable | `_next/static/immutable/media/*.woff2` (source site's fonts, referenced from CSS chunk) |
| WebGL textures (sleeves) | Safe | verified | `site/_external/cdn.sanity.io/…/<id>-762x1150__q_*.webp`: 1200×1811 + 640×966 JPEG bytes |
| CSS / colors | Moderate risk | probable | `_next/static/immutable/chunks/24l721ux8dkx7.css` (single minified sheet) |
| Layout / structure | Recreate instead | probable | React components inside minified chunks |
| Routing / links | High risk | probable | Next Link hrefs in `1gvz9m-n0qmop.js`; other routes are not mirrored |
| Config / runtime payloads | Safe | verified | RSC flight rows in `site/_/index.html` |
| Header/footer strings (alt, email, clock) | Moderate risk | verified | `patches/p2_identity.py` (unique strings in `1gvz9m-n0qmop.js`, `3i898asfgc_9u.js` + SSR) |
| Runtime behavior / animations | High risk | probable | `09ouw4cybbr0h.js` (`ENTER_SECONDS`, `WHEEL_IDLE_MS`, `FLING_MAX` constants) |
| WebGL / shaders | Recreate instead | probable | R3F chunks `1gh2i6gkorm5q.js`, `37n3r0zuw47_4.js`, `0qxtffwpvg0u2.js` |
| Minified bundle patches | Moderate risk | verified | assert unique occurrence, no SRI present |
| Service worker / cache | Safe | verified | none registered; server sends `no-store` |

## Safe edit points

- Tape → video pairing: `TAPE_VIDEOS` in `patches/encode_videos.py` (re-encode) and `site/nt/tapes.json` (verified).
- Player look and controls: `site/nt/player.css`, `site/nt/player.js`. This is normal hand-written source, not a minified artifact (verified).
- Tape copy, years, slugs: `TAPES` in `patches/p1_tape_data.py`, then re-run p1 → p2 (verified).
- Sleeve art: `SLEEVES` in `patches/build_brand_assets.py` (photo, title, colors, layout), then `install_assets.py p4` (verified).
- Contact email / clock zone: `EMAIL`, `TZ_NAME`, `TZ_LABEL` in `patches/p2_identity.py` (verified).

## Known brittle / risky areas

- The tape opener hook: `nt:play` is dispatched from the patched `q` callback in `1gvz9m-n0qmop.js`, and `/work/` link clicks are caught at window capture in `player.js`. If a re-mirror changes the chunk, re-trace `q` before replaying `p6_player.py`.
- Hydration duplication: tape 0's caption exists in the SSR HTML and the RSC payload; p1 patches both. Editing only one makes React re-render with the RSC values.
- The tape count (7) is fixed by the sleeve files and routes. Adding a tape needs a new sleeve file plus 2 route_map entries, which live in the read-only manifest. Treat that as a structural edit.
- Sleeve files must stay JPEG bytes (route_map content_type `image/jpeg`) at 1200×1811 / 640×966.

## Service worker / cache notes

None registered. Use a fresh browser context when re-validating image swaps.

## Validation command

`python3 site/serve-local.py --port 8038`, then `python3 ~/.claude/skills/nt-site-mirror/scripts/viewports.py http://localhost:8038/ --viewports desktop,tablet,mobile --settle-ms 12000 --out audit/shots/after`. Compare its failure set with `audit/shots/before/`.

## Recommended extraction candidates

1. The VHS carousel scene, if tapes need adding or removing often (it's a structural change in a minified R3F bundle).
2. Header/footer chrome, if the nav needs new routes.

## Source-level editability caveat

Everything under `site/_next/` is opaque deployed output. Edits there are patches, not source changes, and go through `reports/patch-log.md`.

## Final recommendation

`Patch` for copy, metadata and art: the scripts in `patches/` make those safe to change. If NomadaToast needs more tapes, real tape pages, or its own fonts, extract the carousel into a clean editable project rather than patching deeper into the bundle.
