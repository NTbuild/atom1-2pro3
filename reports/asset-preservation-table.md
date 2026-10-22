# Asset Preservation Table

| Asset | Source / evidence (URL or authorized code path) | Status | Baseline handling and constraints | Fidelity impact |
| --- | --- | --- | --- | --- |
| HTML document `/` | https://www.arcmarumo.com/ → `mirror/_/index.html` | Local Copy | Pristine copy in `pristine/_/index.html`. The mirror copy has only the sleeve-URL accommodation (see validation report) | none |
| Next/Turbopack JS chunks (27) incl. R3F scene chunks | `/_next/static/immutable/chunks/*.js` | Local Copy | First-load plus bundle-scan chunks, unmodified bytes | none |
| CSS chunk | `/_next/static/immutable/chunks/24l721ux8dkx7.css` | Local Copy | unmodified | none |
| Fonts: NeueBit Bold, PP Neue Montreal Mono Medium, Neue Montreal Regular, Advercase Regular | `/_next/static/immutable/media/*.woff2` | Local Copy | Self-hosted by the site, covered by the user's stated permission; not redistributable beyond this project | none |
| TV glass overlay (960 avif / 1280 webp / full webp) | `/brand/tv-glass*.{avif,webp}` | Local Copy | 1280 variant added by extra-urls (tablet preload) | none |
| Logo / rule / bands / arrow SVGs | `/brand/*.svg` | Local Copy | unmodified | none |
| Sleeve decals | `/about/{arc-mark,vhs-logo,mpa}.svg` (runtime `new Image()`) | Local Copy | Found through local 404 loop | none |
| 7 VHS sleeves (762×1150, w=1200 and w=640) | cdn.sanity.io/images/ngr7c3v4/production/*-762x1150.webp | Local Copy | `--allow-host cdn.sanity.io`; served same-origin through exact route_map entries because Sanity CORS blocks localhost | Bytes are Sanity's JPEG rendition (no webp Accept on download); visually equivalent at observed sizes |
| 7 project cover images (2400 w) | cdn.sanity.io …?w=2400 | Kept External | Only used on `/work/*` pages (out of scope); not requested by the hero | none for declared scope |
| Favicons / apple icon / og.jpg | metadata references | Local Copy | bare `/favicon.ico` routed to the same bytes (sha256-verified against origin) | none |
| Vercel Web Analytics `/aafe13344bef70fc/script.js` | runtime-injected | Blocked (telemetry, not replayed) | brotli-only response; telemetry is never replayed. 404s locally, logs a console notice only | none |
| Vercel Speed Insights `/5d18c82ce29be22e/script.js` | runtime-injected | Blocked (telemetry, not replayed) | as above | none |
| RSC flight data `?_rsc=` for `/`, `/profile`, `/news-watch`, `/work/*` | Link prefetch fetches | Blocked (not static; out-of-scope routes) | Responses vary on RSC router headers, so they cannot be replayed as static GETs. Next falls back to a full page load on navigation | Link prefetch only; no hero impact |

## Baseline approximations requiring approval

- None.
