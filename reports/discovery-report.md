# Discovery Report

## Task

- Source URL / evidence: https://www.arcmarumo.com/ (live site, captured 2026-10-22 12:50 UTC; in-app browser screenshots; Playwright capture graph)
- Requested baseline: the homepage hero — the CRT "TV" frame with the 3D VHS cassette carousel, header, caption block and footer bar.
- Method: `Static Mirror`
- Why this method is suitable: the hero is a Next.js (Turbopack) + React Three Fiber runtime. Preserving the deployed bundle keeps the procedural cassette geometry, carousel physics, CRT line canvas and grain exactly; a recreation could not match them.
- Permission context (user-stated): "with permission that i have, mirror this site". cdn.sanity.io project `ngr7c3v4` is the site's own CMS image store and is treated as covered by that statement (`--allow-host cdn.sanity.io`).
- Scope Classification: `Hero Only`
- Declared route, viewport, and interaction coverage: route `/`; viewports desktop (1440×900 @2x), tablet, mobile (validator presets); interactions: loader to usable state, ArrowLeft/Right, wheel, B&W toggle, caption swap. Clicking or pressing Enter on a tape opens `/work/<slug>`, which is out of scope.

## Observed runtime

- Framework / build evidence: `x-powered-by: Next.js`, `x-nextjs-prerender: 1`, Turbopack chunks under `/_next/static/immutable/chunks/`, RSC flight data in `self.__next_f`.
- Styling evidence: one CSS chunk (`24l721ux8dkx7.css`); local woff2 fonts (NeueBit Bold, PP Neue Montreal Mono Medium, Neue Montreal Regular, Advercase Regular).
- Animation system(s): three.js r185 (`window.__THREE__`) through React Three Fiber on a WebGL2 canvas; 2D canvas `vhs-crt-lines`; CSS grain, roll and reveal (`.rv`, `.swap`) transitions.
- Observed routing behavior: Next App Router; Link prefetches fire `?_rsc=` requests for `/`, `/profile`, `/news-watch`, `/work/*`.
- Asset pipeline / CDN: Vercel for site assets; Sanity CDN for sleeve and cover images (`?w=1200&auto=format`; `sized()` drops to `w=640` at ≤700px).
- Service worker / cache behavior observed: none registered.
- Supplied or authorized source repo evidence, if any: none.

## Module Trigger Scan

| Trigger | Detected? (Yes / Suspected / No) | Module activated |
| --- | --- | --- |
| WebGL / canvas / 3D | Yes: three.js r185, R3F, WebGL2 canvas, procedural tape geometry | `modules/webgl.md` |
| Audio | No (no `<audio>`, no AudioContext observed) | — |
| Video | No (`video: null` on every project) | — |
| Multiple routes | Links exist; out of scope for Hero Only | — |
| Runtime-loaded assets | Yes: lazy R3F chunks, decal SVGs loaded through `new Image()` | `modules/runtime-assets.md` (handled through bundle scan and 404 loop) |

## Link & Route Inventory

| Link / route | Status | Structured content on target? | Evidence / reason |
| --- | --- | --- | --- |
| `/` (logo, HOME) | Captured local | — | `mirror/_/index.html` |
| `/profile` | Out of scope | Yes | Hero Only scope |
| `/news-watch` | Out of scope | Yes | Hero Only scope |
| `/work/<slug>` ×7 (tape click / Enter / caption title) | Out of scope | Yes | Hero Only scope |
| `mailto:hello@arcmarumo.com` (CONTACT, EMAIL) | Intentional live external | — | mail client |

## Visible Module Inventory (source order)

| # | Module | Type | Visibility conditions | Evidence status |
| --- | --- | --- | --- | --- |
| 1 | CRT frame: `.tv`, `.tv-glass` image (960 avif / 1280 webp / full webp by width), CRT line canvas, grain, roll | Chrome | always | Observed |
| 2 | Loader ("Loading" + count + tick bar) | Experience gate | first load | Observed reaching terminal state |
| 3 | Header: Arc logo (bands-only at ≤700px), YEAR, timecode counter, HOME, PROFILE, NEWS WATCH (wide only), CONTACT | Nav | always | Observed |
| 4 | VHS carousel: 7 procedural tapes with Sanity sleeves on an arc | WebGL | always | Observed + interaction-tested |
| 5 | Caption: title link, description, discipline (swaps per centred tape) | Text | always | Observed |
| 6 | Footer: local clock + TZ, B&W switch, "Source: <device>", EMAIL | Text / control | always | Observed + interaction-tested |
| 7 | Cursor caption | Hover | pointer over tapes | Not exercised |

## Asset Graph (Static Mirror Mode)

- `capture_assets.py` output file: `reports/home.asset-graph.json`
- Capture graph schema / result: 1.3 / `ok`
- Initial status / final status / final URL / redirect evidence: 200 / 200 / https://www.arcmarumo.com/ / none
- Automatically eligible static GET/HEAD count / excluded: 43 eligible; excluded 5 `data_api` RSC fetches + 2 `personalized_data` RSC fetches; 2 Vercel telemetry scripts failed acquisition (brotli-only), classified telemetry
- Metadata references by state: 6, Observed + Probed (favicons, icons, og image)
- Scroll coverage mechanism: `wheel_virtual_scroll` (html/body `overflow:hidden`, wheel drives the carousel)
- Service-worker registrations: none
- Same-origin assets: 36 requests; notable: tv-glass images, brand SVGs, 4 fonts
- External providers detected: cdn.sanity.io (site CMS images)
- Blocked / unresolved: none blocked; RSC prefetches for out-of-scope routes not acquired

## Static Mirror discovery evidence

- Repo / source link found: no
- Probe URLs checked: none needed. No named source-map/repo risk signal, and the route scope is a single page.
- Sitemap / routes found: anchors → `/`, `/profile`, `/news-watch`, `/work/remyshoots`
- Manifest files found: none probed
- Source maps found: none referenced
- Bundle scan findings: 7 lazy chunks not in the first-load graph (`0350u0vmirmw-`, `0c0hxoamwjsbw` nomodule polyfill, `0qxtffwpvg0u2` R3F loader, `0zc-na89g39-k`, `16a9xs3qtz5ns`, `1gh2i6gkorm5q` R3F canvas, `37n3r0zuw47_4` R3F core), 2 extra fonts (Advercase, Neue Montreal Regular), sleeve decal SVGs `/about/{arc-mark,vhs-logo,mpa}.svg` loaded by `new Image()`, `/brand/arrow-next.svg`. No WASM, workers, GLB/GLTF, Draco, HDR or audio.
- Runtime interaction capture performed: desktop + mobile load and scroll passes; local loop of load, arrows, wheel and B&W.
- Missing assets found from local server 404 logs: the 3 R3F chunks (first boot showed Next's "This page couldn't load") and the 3 decal SVGs. All acquired through `reports/extra-urls.jsonl`.
- Blocked or unexercised discovery paths: tape click / Enter (navigates out of scope), cursor-caption hover.

## Findings

### Facts
- The cassettes are procedural three.js geometry (`CASE`, `TAPE`, `SCREWS`, `CARD` constants). Sleeve artwork is a 762×1150 image per project, taken from RSC `projects[].sleeve.src`.
- Project titles, descriptions, disciplines and years live in the RSC payload in `index.html` (`b:["$","$L15",null,{"projects":[…]}]`).
- cdn.sanity.io sends no `Access-Control-Allow-Origin` for `http://localhost:8037`, so cross-origin sleeve textures fail locally.
- Sanity served JPEG bytes to the non-browser downloader (`auto=format` with no webp Accept), stored under `.webp` names. Browsers decode them by sniffing.

### Assumptions
- Sanity `ngr7c3v4` belongs to the site owner and is covered by the user's stated permission.

### Unknowns
- Exact easing constants of the carousel spring (they live in the minified bundle and were not extracted).
