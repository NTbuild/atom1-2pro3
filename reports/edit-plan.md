# Edit Plan: NomadaToast rebrand of the hero

## Request

- User request: "Do change branding around NomadaToast, tech, ai, social media growth etc" and "you can use tino assets in the ssd" (`/Volumes/SSD/Tino Assets`).
- In-scope routes / sections: `/` hero only: header logo, metadata, the 7 VHS tapes (sleeve art + caption data), footer clock label and contact email, icons and OG image.
- Explicitly out of scope: `/profile`, `/news-watch`, `/work/*` (not mirrored), layout, motion, WebGL behavior, CRT styling, the site's UI fonts.

## Project identification

- Project path: `Project 3/site/` (working copy)
- Authorization confirmed: yes. User-stated permission for the source site; NomadaToast brand assets supplied by the user (Tino Assets).
- Completed usable local mirror confirmed: yes. `Project 3/mirror/` validated baseline (see `reports/validation-report.md`, tier: Partial static mirror; the hero passes every exercised state).
- Known working local serve path: `python3 site/serve-local.py --port 8038` (launch config `nomadatoast-hero`)
- Evidence path: `NT Site Mirror handoff`
- Project type: `Static Mirror`: `mirror-manifest.json`, serve contract, minified Next/Turbopack chunks.
- Project type/source of truth ambiguous: no
- Eligibility result: `eligible`
- NT handoff artifacts consumed: manifest (read-only), discovery/validation/asset reports, serve contract, viewport evidence.
- Source of truth: `runtime-effective captured artifacts`
- `mirror-manifest.json`: `site/mirror-manifest.json` inspected read-only (route_map for sleeve paths/content types). Never modified by the Editor.
- Ledger ownership confirmed: yes. `reports/patch-log.md` is the post-delivery ledger.

## Restore point (required)

- Method: `folder duplicate`
- Restore-point path: `Project 3/mirror/` (validated baseline, never written by the Editor). The working copy `Project 3/site/` was duplicated from it with `rsync -a --exclude '._*' mirror/ site/` before any write.
- Rollback scope: whole-project (re-copy `mirror/` to `site/`), plus per-file pristine copies in `patches/pristine/` taken by each patch script.

## Baseline

- Serve command: `python3 site/serve-local.py --port 8038` · Route: `/` · Declared viewports: desktop (1440×900 @2x) and mobile (validator presets)
- Baseline screenshots: yes, `audit/shots/before/`
- Console/network baseline: yes, `audit/shots/before/viewport-results.json`. Pre-existing issues (not charged to edits): 404s for `/?_rsc=…`, `/profile?_rsc=…`, `/news-watch?_rsc=…` (out-of-scope route prefetches) and the 2 Vercel telemetry scripts.
- Pre-edit hashes: recorded per file in `reports/patch-log.md`. The working copy was byte-identical to `mirror/` at the start.

## Edits

| # | Edit class | Target (what the user sees) | Traced source — file(s) + anchor | Trace evidence | Confidence | Decision | Rationale |
| --- | --- | --- | --- | --- | --- | --- | --- |
| P1 | Content swap | Tape titles, descriptions, disciplines, years, slugs, alts; page title/description/OG | `_/index.html`: RSC row `b:` (`projects[]`), SSR caption `<section class="vhs-caption">`, `<head>` metadata, RSC row `12:` | Same content in SSR + RSC flight (hydration), both runtime-effective; `/` loads `_/index.html` | verified | Patch | data payload layer; no bundle change needed for tape data |
| P2 | Content swap | Logo alt, CONTACT/EMAIL target, footer clock zone `SAST` / `Africa/Johannesburg` | `_/index.html` SSR header/footer; `1gvz9m-n0qmop.js` (`alt:"Arc — home"`, `let s="hello@arcmarumo.com"`, `timeZone:"Africa/Johannesburg"`, `" SAST"`, 1 occurrence each); `3i898asfgc_9u.js` (`let o="hello@arcmarumo.com"`, 1) | Both chunks fetched on `/` (performance entries). The header/footer re-render client-side from `1gvz9m` | verified | Patch (narrow bundle strings) | no SRI attributes, no service worker; chunk names unchanged |
| P3 | Asset swap | Header logo (desktop + phone) and the sleeve-generator mark | `brand/arc-logo.svg` (115×30), `brand/arc-bands.svg` (67×30, `<source media=(max-width:700px)>`), `about/arc-mark.svg` | Referenced by SSR `<picture>` + bundle; same path kept | verified | Patch (same path) | runtime sizes the img box to 115×30 / 67×30, so the viewBox stays the same |
| P4 | Asset swap | The 7 VHS sleeve textures | `_external/cdn.sanity.io/…/<id>-762x1150__q_09b6…webp` (1200×1811 JPEG) and `__q_0703…webp` (640×966 JPEG) via route_map | route_map content_type `image/jpeg`; WebGL texture loader | verified | Patch (same path, same dimensions + JPEG format) | the runtime draws wear on top and no in-bundle change is needed |
| P5 | Asset swap | Favicons, touch icon, OG image | `favicon__q_…ico` (16/32/48), `icon__q_…svg`, `icon1__q_…png` (192), `apple-icon__q_…png` (180, RGB), `og.jpg` (1200×630) | `<link rel=icon>` / meta in `<head>` | verified | Patch (same path, same sizes) | — |

- Static Mirror: every runtime-effective copy needed to prevent hydration overwrite is listed: yes (SSR + RSC for P1/P2, and the chunk for P2).
- Inert hits left unpatched (not loaded on `/`, out of scope): `39ylgc66xe1xs.js` (VHS back-cover credits), `2-5-dyx-8dsia.js`, `27fkz_hesr-qz.js` (other route page chunks).

## Asset sources (user-supplied, `/Volumes/SSD/Tino Assets`)

| Use | File |
| --- | --- |
| Wordmark `+toast` (white on red, face in the "o") | `& Toast (1).png` |
| Lockup reference "+ nomada / toast" | `Banner 1.jpg` (also the OG image crop) |
| Sleeve 0 Nomada Toast | `PP Toast.jpg` |
| Sleeve 1 AI Studio | `8.1-invideo-nanobanana_2 2.png` |
| Sleeve 2 Growth Camp | `growth camp.jpg` |
| Sleeve 3 Viral Loop | `hf_20260627_145124_….png` |
| Sleeve 4 X-Ray | `xray skeleton 2.png` |
| Sleeve 5 Road Test | `5b.png` |
| Sleeve 6 Supporter | `Suporter.jpg` |

Brand red `#E33131` was sampled from `& Toast (1).png`. "nomada" is set in Helvetica Neue Bold (system font) to match the banner lockup. Sleeve titles use Helvetica Neue Condensed Black (system font).

## Validation plan

- Command + route + viewport: `python3 site/serve-local.py --port 8038`, `/`, desktop + mobile through `viewports.py` into `audit/shots/after-pN/`, plus in-app browser interaction checks.
- Interactions: loader → usable, ArrowRight/Left caption swap, wheel, B&W toggle, EMAIL click (clipboard only; no external write).
- Hard gates: Boot ☑ · Offline/local asset ☑ (no new 404s / external requests versus before) · Experience ☑ · No-side-effects ☑ (mailto/clipboard only, never sent) · 3D/WebGL ☑ (texture swap only: instrumented check that each sleeve URL serves the new bytes, plus a visual check on the carousel; no model swap, so the orientation gate is n/a).
- Cache protocol: `serve.py` sends `Cache-Control: no-store`; `viewports.py` uses fresh contexts.
- Service worker present: no.
- Forms/API/external writes affected: no.

## Risks and approvals

- Contact email: no NomadaToast address was supplied, so a non-routable placeholder `hello@example.com` is used (RFC 2606) until the user provides one.
- Clock zone: set to `America/Sao_Paulo` / `BRT`, taken from this Mac's system timezone (`/etc/localtime`). This is an assumption about the brand's home zone.
- UI fonts (NeueBit, PP Neue Montreal Mono, Neue Montreal, Advercase) are the source site's self-hosted fonts. Licensing for reuse is the user's responsibility before any public deploy.
- The 3D engine, layout and motion are the source site's deployed code. This is a local rebrand study, not clean source.

## Addendum: second request

- User request: "can we maybe have the tapes play the video it's referencing and remove the 'growth camp' one"; "this is just for showcasing, no need for actual contact paths".
- Trace: the carousel's open callback `q` in `1gvz9m-n0qmop.js` (unique) did ``transitionTo(()=>router.push(`/work/${slug}`))``. The `.vhs-open` (focus/Enter) and `.vhs-title-link` (caption) anchors go through the layout's document-capture link handler in `3zb5vxwecmax-.js` (`transitionTo` + push). `transitionTo` holds a view transition until the next page arrives (or 3 s), so it is not reused. Tape data lives in RSC row `b:`.
- Decisions:
  - P1 re-run (Content swap, Patch): `TAPES` now names the payload slot it keeps; slot 2 dropped.
  - P6 (Behavioral edit, narrow Patch + added section): `q` dispatches `nt:play`. A window-capture listener in the added `site/nt/player.js` catches `/work/` link clicks before the layout handler. The player itself is a new section (the source has no in-place playback).
- Video pairing: no tape image appears frame-for-frame in the videos, so tapes are paired by theme (see Patch Log). Single edit point: `patches/encode_videos.py` → `TAPE_VIDEOS`, mirrored in `site/nt/tapes.json`.
- Validation plan: click / Enter-on-link / caption link → plays; pause/seek/eject/auto-eject; carousel inert while playing; before vs after failure sets at 3 viewports.
