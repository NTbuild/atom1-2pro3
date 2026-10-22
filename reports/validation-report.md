# Validation Report (baseline mirror)

## Declared validation scope

- Source URL / evidence: https://www.arcmarumo.com/
- Local URL / serving contract: http://localhost:8037/ via `python3 mirror/serve-local.py` (`mirror/serve-contract.json`)
- Method: `Static Mirror`
- Routes: `/`
- Viewports: validator presets desktop, tablet, mobile; in-app browser 800×600 pane for interactions
- Interaction / loading / media states: loader → usable, ArrowRight, wheel, B&W on/off, caption swap
- Source and local capture date/time: 2026-10-22 ~12:50–13:00 UTC

## Per-section checks

| Section / route | Viewport | Scroll behavior | Animation / media | Interaction states | Verification method | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| CRT frame + glass | desktop / tablet / mobile | n/a | CRT lines, grain, roll render | — | Observed visually (paired screenshots) | Pass for declared evidence |
| Header + logo + timecode | desktop / tablet / mobile | n/a | reveal + counter | — | Observed visually | Pass for declared evidence |
| VHS carousel (WebGL) | desktop / tablet / mobile | wheel virtual scroll | entrance, sleeves textured | ArrowRight, wheel step | Interaction-tested | Pass for declared evidence |
| Caption block | desktop / mobile | — | swap on centre change | follows carousel | Interaction-tested | Pass for declared evidence |
| Footer + B&W switch | desktop | — | — | B&W on → greyscale, off → colour | Interaction-tested | Pass for declared evidence |
| Tape click / Enter → `/work/*` | — | — | — | — | Not exercised | Out of scope |
| Cursor caption hover, drag fling | — | — | — | — | Not exercised | Not exercised |

## Global checks

- [x] Typography and spacing checks completed for the declared comparison scope (paired screenshots match)
- [x] All kept same-site links resolve locally, intentionally point live/external, or are documented out of scope
- [x] Every in-scope structured module exists and is structurally recognizable
- [x] No unresolved critical overlap, stuck/frozen behavior, or missing asset was found within exercised coverage
- [ ] Performance observations recorded (not measured)
- [x] Active module validation results recorded: webgl, runtime-assets
- [x] Asset Preservation Table statuses verified — no silent substitutions

## Static Mirror audit

- Result tier: `Partial static mirror`. The hero itself rendered and behaved the same in every exercised cell. The strict validator still fails each local cell on five same-origin 404s that are classified, not resolved: 3 RSC Link prefetches (`/?_rsc`, `/profile?_rsc`, `/news-watch?_rsc`) and 2 Vercel telemetry scripts.
- Discovery coverage: `Complete for declared triggers` — bundle scan plus local 404 loop until nothing new surfaced.
- Declared viewport: validator desktop preset (1440×900 @2x screenshots at 2880×1800).
- Experience gate: loader present — terminal usable state reached: yes, in every local cell and in the browser pane.
- Evidence gates: boot ☑ / dependency ☐ (5 classified out-of-scope/telemetry 404s) / experience ☑
- Asset count: 60 downloaded entries; 64 files incl. generated artifacts. Total: 3.8 MB of file bytes (≈21 MB on disk because of exFAT 128 KB clusters plus macOS `._` sidecars).
- Missing or unresolved files within declared coverage: none for hero rendering.
- Remaining external requests: none needed by the hero. Project cover images (`?w=2400`) are only referenced for `/work/*`.
- Construction-time accommodations: see the table below.

## Serving Contract

- Serve command / config: `python3 mirror/serve-local.py` (bundled `_ntsm/serve.py`), or the `arc-hero-mirror` entry in `../.claude/launch.json`
- Web root: `Project 3/mirror` · Port: 8037
- Contract / manifest schema and path: 1.3, `mirror/serve-contract.json` → `mirror/mirror-manifest.json#route_map`
- SPA fallback: `Off`
- Exact path-and-query route-map coverage: 61 entries, including 14 sleeve routes and bare `/favicon.ico`
- Plain static hosting valid: no
  - Range/206 media support: not needed
  - Content-type replay: needed (Sanity bytes are JPEG under `.webp` names; `__q_` files)
  - Query-aware / variant routing: needed (`?w=1200&auto=format`, `/_next/image?url=…&w=640&q=75`, `?favicon.…`)
- `file://` support: `Unsupported` — root-absolute `/_next/…` paths and query-routed assets need the server.

## Automated URL × Viewport Evidence

- `viewports.py` result file: `reports/viewports/viewport-results.json`
- Matrix complete: no — 0/3 local cells pass the strict gate; 3/3 source cells are complete.
- Per-cell status and final URL recorded: yes (200 → http://localhost:8037/)
- Rejected states: none (no challenge, login or consent)
- Scroll mechanisms exercised: `wheel_virtual_scroll`
- Service-worker results: none registered
- Settling method: `DOMContentLoaded + bounded reported settling` — max 8000 ms

## Construction-Time Accommodations

| Artifact / path | Phase / actor | Required local accommodation | Source / provenance evidence | Revalidation evidence |
| --- | --- | --- | --- | --- |
| `_/index.html` | `construction` / Claude | 7 sleeve URLs repointed from `https://cdn.sanity.io/images/ngr7c3v4/production/` to `/_external/cdn.sanity.io/images/ngr7c3v4/production/` (Sanity blocks CORS for localhost) | `pristine/_/index.html` + sha256 in `local_modifications` | sleeves render, all 7 requests 200 locally |
| `mirror-manifest.json#route_map` | `construction` / Claude | 14 exact sleeve routes (desktop w=1200, mobile `/_next/image…&w=640`) + bare `/favicon.ico` | `local_modifications[route-map-sleeves]` | mobile cell matches source |
| `serve-local.py`, `_ntsm/serve.py`, `serve-contract.json` | `construction` / Claude | Written by `tools/accommodate.py` because the pipeline emits them only when no required item fails, and its only failures were the 2 telemetry scripts | `generated_artifacts` | server boots via the launcher |

All of it is reproducible with `python3 tools/accommodate.py`.

## Interaction Coverage

- Exercised: load → loader → usable (pass); ArrowRight → next tape + caption swap (pass); wheel down → advances (pass); B&W on/off (pass).
- Not exercised: drag fling, cursor caption hover, Enter/click into `/work/*` (out of scope).

## External Runtime Dependencies

| Dependency | Handling | Fidelity impact | Evidence |
| --- | --- | --- | --- |
| cdn.sanity.io sleeves | Localized | none | route_map hits |
| Vercel Web Analytics / Speed Insights | Blocked (telemetry, not replayed) | none | console notice only |
| RSC prefetch for other routes | Blocked (out of scope) | none for hero | 404 in server log |
| `mailto:hello@arcmarumo.com` | Kept external | — | — |

## Fidelity Gaps

| Feature | Missing / downgraded behavior | Constraint | Available baseline paths | Status |
| --- | --- | --- | --- | --- |
| — | none observed within the declared scope | — | — | — |

## Project status

`Partial`. Hero route `/` at desktop, tablet and mobile looks and behaves like the source in every exercised state.

- Completed: boot, loader, WebGL carousel with all 7 sleeves, caption swap, B&W toggle, responsive variants.
- Blocked: Vercel telemetry (by policy); RSC prefetch for out-of-scope routes.
- Approved baseline approximations: none.
- Not exercised / unresolved: drag fling, cursor caption, navigation into `/work/*`, offline (network-blocked) run.
