# Before / After Validation Result

## Setup (identical before and after)

- Project type: `Static Mirror`. Every affected path is a captured deployed artifact.
- Serve command: `python3 site/serve-local.py --port 8038` · Route: `/` · Declared viewports: desktop (1440×900 @2x), tablet, mobile (`viewports.py` presets)
- Browser state: fresh Playwright context per cell (`viewports.py`); the server sends `Cache-Control: no-store`
- Service worker present: no
- Additional viewports checked: tablet and mobile (the logo has a ≤700px variant, and mobile sleeves come from the 640 route)
- Captured-file integrity: Patch Log rows 1–26 hold pre/post SHA-256. The Mirror manifest is untouched; the working-copy difference from its baseline hashes is expected.

## Comparison

| Region | Before | After | Verdict |
| --- | --- | --- | --- |
| Edited region: header logo | Arc bands + "Arc" (`audit/shots/before/*desktop*`) | "+ nomada / toast" (desktop), "+toast" (mobile) | Intended change. Observed visually + DOM confirmed (115×30 box) |
| Edited region: VHS tapes | 7 Arc client sleeves | 7 NomadaToast sleeves on the same procedural tapes, same arc, wear overlay intact | Intended change. Observed visually + served-bytes check |
| Edited region: caption | RemyShoots / CSSDA copy | NomadaToast tape copy; swaps on ArrowLeft/Right | Intended change. Interaction-tested |
| Edited region: footer | "SAST" clock, Arc email | "BRT" clock (America/Sao_Paulo), placeholder email | Intended change. DOM confirmed |
| Section above (CRT frame, nav, timecode) | — | unchanged | Unchanged. Observed visually |
| Section below (B&W switch, Source label) | — | unchanged; B&W toggles greyscale on/off | Unchanged. Interaction-tested |
| Full page silhouette | CRT frame, carousel arc, caption block | same geometry at all 3 viewports | Unchanged. Observed visually |

## Instrumented evidence

| Claim | Instrument | Result | Evidence path |
| --- | --- | --- | --- |
| Asset replaced (14 sleeve URLs) | HTTP fetch + SHA-256 against installed files | 14/14 match, 200, image/jpeg | `audit/reports/p4-served-bytes.json` |
| Asset replaced (logo) | DOM probe of `.vhs-logo img` | `/brand/arc-logo.svg`, complete, 115×30 | `audit/reports/interaction-probes.json` |
| Hydration keeps the new copy | post-hydration DOM read + console filter for hydration/mismatch | new caption/title/alt present; 0 hydration errors | `audit/reports/interaction-probes.json` |
| Runtime safe | console/network delta (before vs after, per viewport) | no new failed requests, 0 page errors | `audit/shots/before/` vs `audit/shots/after/viewport-results.json` |
| Clock zone | DOM clock vs `Intl.DateTimeFormat('America/Sao_Paulo')` | 10:09 vs 10:10 (15 s update interval) | `audit/reports/interaction-probes.json` |
| Files on disk = ledger | SHA-256 re-check of all 25 changed files | 0 mismatches | `audit/reports/p*-hashes.json` |

## Console / network delta

- New console errors/warnings: none
- New failed/changed network requests: none. The out-of-scope prefetch for the first tape changed name with the slug (`/work/remyshoots?_rsc` → `/work/nomada-toast?_rsc`); it still 404s exactly as before.
- Hydration check: the post-hydration DOM shows the change: yes

## Interaction coverage

- Exercised: loader → usable; ArrowRight / ArrowLeft caption swap; wheel (validator scroll pass); B&W on/off; mailto href inspection.
- Not exercised: drag fling, cursor caption hover, clicking a tape into `/work/*` (out of scope, not mirrored).

## Forms / APIs / external side effects

- Applicable: yes. CONTACT/EMAIL are `mailto:` plus a clipboard copy.
- Validation method: `intercepted` (href inspected; nothing sent)
- Real external writes prevented: yes

## Hard gates

| Gate | Applicable | Result | Evidence path / n/a rationale |
| --- | --- | --- | --- |
| Boot | yes | Pass | `audit/shots/after/viewport-results.json` |
| Offline / local asset | yes | Pass | before/after failure sets identical (pre-existing, classified) |
| Experience / target behavior | yes | Pass | `audit/reports/interaction-probes.json`, `audit/shots/interactions/` |
| No external side effects | yes | Pass | no mail sent |
| 3D/WebGL orientation + instrumented verification | yes (texture swap) | Pass | served-bytes check + rendered carousel at 3 viewports; no geometry change |

## Result

- Verdict: `Pass with acknowledged gaps`
- Acknowledged (optional / out-of-scope): drag fling and cursor caption not exercised; `/profile`, `/news-watch`, `/work/*` not mirrored, so their links 404 locally just as in the baseline.
- Remaining risks: the contact email is a placeholder; the BRT zone is inferred from this Mac; the UI fonts are the source site's; the in-pane loader sometimes takes ~10 s on first paint (seen on the untouched baseline too).

## Second round: P1 re-run + P6 (6 tapes, tapes play video)

- Same setup: `python3 site/serve-local.py --port 8038`, `/`, desktop/tablet/mobile fresh contexts (`audit/shots/after-p6/`), plus in-app browser interaction tests.

| Region | Before | After | Verdict |
| --- | --- | --- | --- |
| Carousel | 7 tapes | 6 tapes, Growth Camp gone; arc layout and spacing still handled by the runtime | Intended change. Observed visually (`audit/shots/interactions/six-tapes.jpg`) |
| Opening a tape | navigated to an unmirrored `/work/<slug>` → 404 page | VCR player on the CRT screen, URL stays `/` | Intended change. Interaction-tested |
| Header, caption, footer, B&W | — | unchanged when no tape is playing | Unchanged. Observed visually |

| Claim | Instrument | Result | Evidence path |
| --- | --- | --- | --- |
| Correct video per tape | DOM probe of `.nt-vcr video` src/size/readyState | nomada-toast 1280×720, ai-studio 720×1280, playing with sound | `audit/reports/interaction-probes.json` |
| Carousel inert while playing | wheel ×5 / arrows during playback, then read caption | caption unchanged | same |
| Runtime safe | before vs after-p6 failure sets per viewport | no new failures, 0 page errors; `/work/*?_rsc` prefetch 404s gone | `audit/shots/after-p6/viewport-results.json` |
| Added files | SHA-256 + sizes | 15 files, 82.7 MB | `audit/reports/p6-added-files.json` |

- Exercised: centre-tape click, focused `.vhs-open` + Enter, caption-title click, Space pause, → seek (FF), Esc, Eject click, end-of-tape auto-eject, wheel isolation.
- Not exercised: M mute, ← rewind, the autoplay-refused fallback (Chrome allowed sound on the user gesture), reduced-motion path, and every tape's video (2 of 6 played in-browser). The other 4 were checked as encodes: ffmpeg exit 0, H.264/AAC, served by the same route.
- Gates: Boot Pass · Offline/local asset Pass · Experience Pass · No-side-effects Pass (no external requests) · 3D/WebGL n/a for P6 (no texture/model change).
- Verdict: `Pass with acknowledged gaps` (only the optional items listed above are unexercised).
