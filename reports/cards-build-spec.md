# NomadaToast Cards: Stage 1 build spec ("Tailwind Deal", final)

Stage 1 is only the introduction:
- the deal,
- the idle hand afterwards,
- organic, windy spinning and scrolling.

Clicking cards does nothing. Header and footer links are inert. The old VHS "Supporter" tape is removed; its place in the set is the **9 "3D Lab" video card** (see §10). `Tino Assets/Suporter.jpg` is not used.

Static web root: `Project 3/cards/`. Serve it with:
`python3 -m http.server 8040 --directory "/Volumes/SSD/Atoms 1:2 - Alex/Project 3/cards"`, then open http://localhost:8040/.
Plain HTML/CSS and ES modules, no build step. `site/` and `mirror/` are never modified.

---

## 0. Decisions that resolve contradictions between proposals

| Topic | Decision |
|---|---|
| Motion engine | A guided channel (art-directed path with a guaranteed touchdown pose, time and velocity) plus a physically computed flat-plate aero perturbation from one shared wind field. The contact model is stylised but simulated. There is no free rigid-body planner (P1) and no pure-sines wind (P2). |
| Units | Centimetres, seconds, degrees in the API, y up, player at +z, table plane y = 0. |
| Simulation | Fixed 240 Hz (dt = 1/240), accumulator capped at 16 steps per frame (beyond that, time is dropped). The render uses the latest state. |
| Dealer | Unseen, across the table (far side, -z). Cards skim in low, pop up, flip and fall toward the player. |
| Deal order | Left to right, ascending: 9, 10, J, Q, K, A. The A comes last, with an extra 0.12 s beat and a 540 deg flip. |
| Hand at the end | The closing gust slides the hand half a slot left. The 9 leaves the left edge (it wraps off-screen) and the hand reads **10 J Q K A**, Q centred, A fully in on the right and on top. |
| Bounce | Exactly two visible hops (bounce, then rebounce), then a sub-pixel felt "grab". |
| Trackpad | Target accumulation (P2), not impulse (P3). |
| Wear map format | RGB without alpha. The silhouette is an SDF in R. |
| three.js import | Relative path, no import map. |
| Tests | Python Playwright (same toolchain as `patches/build_brand_assets.py`). Exact determinism is guaranteed within one engine; tests run in Chromium. |
| Felt | Bottle green by default. `?felt=charcoal` is available for A/B. |
| Video | The 9's photo window plays a muted loop of `Meshy 2.mp4` when it is visible and settled. Under `?debug` and reduced motion it shows the baked still, so tests stay deterministic. |

---

## 1. Architecture and file ownership

```
Project 3/cards/
  index.html                      [C]
  css/crt.css                     [C]
  vendor/three.module.min.js      [B]  three@0.169.0 build/three.module.min.js (687.5 kB, MIT)
  vendor/three-LICENSE.txt        [B]
  data/cards.json                 [A]  manifest (schema §4.7)
  assets/cards/{hi,lo}/...        [A]
  assets/cards/clip-9.mp4         [A]
  assets/cards/dimple-normal-256.png [A]
  assets/table/{hi,lo}/...        [C]
  assets/crt/ tv-glass.webp, tv-glass-1280.webp, tv-glass-960.avif, logo.svg, grain.png   [C]
  assets/fonts/ NeueBit-Bold.woff2, PPNeueMontrealMono-Medium.woff2                     [C]
  js/main.js        [B]  boot, flags, asset load, loop, wiring of chrome/table
  js/config.js      [B]  CONFIG, deep-frozen. Every number in this spec lives here.
  js/rng.js         [B]  mulberry32, cyrb53, fork(seed, name)
  js/noise.js       [B]  seeded simplex3 with analytic gradient, curl2(), valueNoise1()
  js/wind.js        [B]  WindField
  js/aero.js        [B]  flat-plate forces and torques, vortex-shedding drive, ground-effect lift
  js/fan.js         [B]  slotPose, wrap, imperfection, layer, fitCamera, slotPx
  js/flight.js      [B]  guided channel, flip/yaw/pitch schedule, perturbation layer
  js/contact.js     [B]  bouncy-felt contact, slot springs, rest/settle detection (also spin tap-downs)
  js/spin.js        [B]  leader, history ring, trailing cards with air carry, hover/bank/yaw/flutter
  js/input.js       [B]  pointer/wheel/key -> step-stamped commands, hurry mode, input log
  js/sim.js         [B]  World: phase machine, timeline, events, step, snapshot/restore/clone
  js/render/view.js     [B]  renderer, camera, resize, DPR governor, painter order, state -> meshes
  js/render/cardMesh.js [B]  card geometry and material patch, video window
  js/render/dust.js     [B]  Points advected by the WindField
  js/render/table.js    [C]  felt, print decal, near rail, lamp, hemi, PMREM env, ShadowDecals
  js/chrome.js      [C]  timecode, clock, caption, power-on, B&W
  js/debug.js       [B]  window.__deal, HUD, wind arrows
  js/fallback.js    [C]  static CSS fan when WebGL2 is missing
  tests/check_deal.py   [I]
  README.md             [I]
Project 3/patches/build_cards.py   [A]  single file, run with python3 -I
Project 3/patches/build_table.py   [C]  felt/print/rail/grain textures plus copying CRT, logo and fonts
```

Owners: A = card-art builder, B = scene and motion engine, C = page chrome and table, I = integrator.

Vendoring three.js (B): the tarball is already in the npm cache (verified: `npm pack three@0.169.0 --offline` resolves offline). Unpack it in `patches/build/vendor/`, then copy `package/build/three.module.min.js` and `package/LICENSE`. No network is needed. Every module imports it with
`import * as THREE from '../vendor/three.module.min.js'` (adjust the relative depth per file). No addons are used.

### 1.1 Cross-builder contracts

**DOM (C provides, B consumes):**
```html
<html data-phase="boot" data-ready="0">
<div class="tv">
  <header class="chrome top">HOME · <span id="timecode"></span> · <img logo> YEAR 2026 · PROFILE · CONTACT</header>
  <div class="screen" id="screen">            <!-- pointer, wheel and key target; touch-action:none -->
    <canvas id="table"></canvas>
    <div class="crt-triad"></div><div class="crt-scan"></div><div class="crt-roll"></div>
    <div class="crt-vignette"></div><div class="crt-grain"></div>
    <div class="caption" id="caption"><b class="rank"></b><span class="title"></span><small class="sub"></small></div>
  </div>
  <footer class="chrome bottom"><span id="clock"></span> · <button id="bw">B&W [OFF]</button> · SOURCE: NOMADA TOAST · EMAIL</footer>
  <div class="tv-glass"></div>
</div>
<div id="fallback" hidden></div>
<script type="module" src="js/main.js"></script>
```
All overlay layers use `pointer-events: none`. `.screen` uses `cursor: grab`, and `cursor: grabbing` while dragging.

**chrome.js (C):**
```js
export function createChrome(root /* document */) -> {
  setTime(tSec),            // timecode MM:SS:FF at 30 fps, from sim time
  setCaption(card|null),    // {rank, title, sub}; 220 ms crossfade; null hides it
  setPowerOn(k),            // 0..1 -> CSS var --power on .screen (line-expand + flash), sim-time driven
  setPhase(phase),          // writes <html data-phase>
  setReady(),               // <html data-ready="1">
  onBW(cb)                  // toggles .screen.bw (filter: grayscale(1)); cb(bool)
}
```

**table.js (C):**
```js
export async function createTable(THREE, { renderer, scene, tier, seed, felt /* 'green'|'charcoal' */ }) -> {
  lamp: { pos: THREE.Vector3 /* live, cm */, color: THREE.Color, light: THREE.SpotLight },
  envMap,                   // PMREM texture for the card clearcoat
  layout({ railZ }),        // called by view on resize
  update(t),                // lamp warm-up and closed-form pendulum from seed; pure function of t
  setShadows(list),         // 6 entries {corners: Float32Array(12) world cm, height: cm (mean corner), contact: cm (min corner)}
  dispose()
}
```
ShadowDecals are drawn at renderOrder 10-15. Cards are drawn at 20 and above (B). Felt and rail are at 0-5.

**cards.json (A provides, B consumes):** schema in §4.7.

---

## 2. Renderer

three.js r169, WebGL2 `WebGLRenderer`:
- `outputColorSpace = SRGB`, ACESFilmic tone mapping at exposure 1.0, clear colour #050505.
- `powerPreference: 'high-performance'`.
- `antialias` only when the pixel ratio is below 1.5. Card silhouettes are anti-aliased analytically.
- PerspectiveCamera.
- Cards: `MeshPhysicalMaterial` (clearcoat) patched with `onBeforeCompile`, `transparent: true`, `depthWrite: false`, painter's order (§11).
- Without WebGL2: `fallback.js` lays out the six 640 px fronts as a static CSS fan inside `.screen`.

---

## 3. World, camera and layout (cm)

- **Card:** 6.35 x 8.89 x 0.024. Base corner radius 0.32. Mass is implied by K below.
- **Fan:** pivot P = (0, 0, +30), R = 30, spacing 11.5 deg.
  - For slot coordinate s: u = max(0, |s| - 2.2), theta = 11.5 deg * s + sign(s) * 14 deg * u^2, r = 30 + 18u^2.
  - Centre = (r sin theta, layer, 30 - r cos theta). Yaw = -theta (card tops fan away from the player, giving an ∩ arc).
  - layer = 0.03 * (s + 3) cm, so each card lies over its left neighbour.
  - The wrap seam |s| = 3 sits off-screen at x of about 28.6 cm.
- **Imperfection** (seeded, fork 'imperfection'): delta-theta +/-1.4 deg, delta-r +/-0.3, tangential +/-0.25, yaw +/-1.8 deg.
- **Card index i** (ring order): 9 = 0, 10 = 1, J = 2, Q = 3, K = 4, A = 5. Slot s_i = wrap(i - phi, [-3, 3)), where phi is the fan offset in slots.
  - phi increasing means the cards move left.
  - Deal phase: phi = 2.5. After the closing gust: phi = 3.0 (Q centred).
- **Camera:** vertical FOV 30 deg, elevation 55 deg, target (0, 0, -1).
  - `fitCamera(aspect)` sets the distance so the outer corners of slots +/-2 sit 1-3% outside the screen edges. The half-width at the hand is about 16.5 cm on the 1371 x 853 screen (1440 x 900 page), about 41 px/cm, so the centre card is about 264 px wide.
  - Below aspect 1.25, FOV eases toward 46 deg and the half-width to 10.8 cm (centre card plus neighbours, slivers of +/-2).
  - The fit is clamped so any card with |s| >= 2.92 stays more than 2 cm off-screen, even mid-overshoot.
- **slotPx** = projected distance between the slot 0 and slot 1 centres (about 245 px desktop). Recomputed on resize.
- **Pointer parallax** (fine pointers only, off under ?debug and reduced motion): camera orbit +/-1.5 deg azimuth and +/-1.0 deg elevation on a spring (omega 4, zeta 1).

---

## 4. Card art (builder A): `patches/build_cards.py`

Command: `python3 -I patches/build_cards.py [--only a,k] [--seed 7331] [--sheet] [--install]`.

Toolchain: Pillow, numpy, Playwright Chromium, ffmpeg. HTML/CSS templates are inline, in the same style as `build_brand_assets.py`. Fonts:
- local HelveticaNeue-CondensedBlack and HelveticaNeue-Bold (baked into the images, never shipped);
- PP Neue Montreal Mono via a file URL from `site/_next/static/immutable/media/`.

Masters are 1500 x 2100 px (about 600 dpi; 1 mm = 23.6 px). Output is deterministic per seed, using `cyrb53(seed + rank)`.

### 4.1 Sources

| id | rank | title | sub-line | source (in /Volumes/SSD/Tino Assets) | accent |
|---|---|---|---|---|---|
| a | A | Nomada Toast | ACE OF TOAST | PP Toast.jpg (B&W, red + kept) | #E33131 |
| k | K | AI Studio | KING OF TOAST | 8.1-invideo-nanobanana_2 2.png | #FF5AD9 |
| q | Q | Viral Loop | QUEEN OF TOAST | hf_20260627_145124_0ec89523-…png | #3FD0BD |
| j | J | X-Ray | JACK OF TOAST | xray skeleton 2.png (greyscale, #5B7CFF duotone in shadows) | #5B7CFF |
| 10 | 10 | Road Test | TEN OF TOAST | 5b.png (warm film) | #FF8A00 |
| 9 | 9 | 3D Lab | NINE OF TOAST | Vids/Meshy 2.mp4 still at **16.55 s** (robot by burning fireplace; checked clean) | #F2B31B |

Meshy timing (checked by contact sheet):
- 15.0 s shows browser UI. Avoid 15.0-15.3 s.
- Robot shots run from about 15.3 s to 18.2 s.
- 18.5 s is a blurred transition with the caption "COME ON."; 19 s+ is a talking head.
- Avoid 0-7.5 s and 22.5-25 s (Mario-like model).

### 4.2 Front layout (aged stock #F2EDE3, edges yellowing to #E6DCC8)

- **Indices** (top-left and 180 deg bottom-right):
  - rank in HelveticaNeue-CondensedBlack, cap height 7.5 mm, print red #D42F2F;
  - a 1 px #151515 misregistration ghost offset (+1, +1) at 35%;
  - below it, the brush "+" (`patches/build/wordmark/plus.png`) 5.2 mm wide.
- **Ace:** no window.
  - A 38 mm red brush "+" fills the centre. Inside it sits a 24 mm circular medallion of PP Toast (B&W, contrast 1.1, focus 50%/30%) with a 0.6 mm bone ring and a 0.3 mm black keyline.
  - Title band inverted: a black band holding red "nomada" (HelveticaNeue-Bold) over the white `toast.png` wordmark with the face in the "o".
- **Court cards K, Q, J:** double-headed window 9.0-54.5 mm by 6.0-66.5 mm.
  - Top half is a landscape crop of the source; the bottom half is the same crop rotated 180 deg.
  - A 0.7 mm #151515 bar with a small red "+" splits them.
  - Small red "+" corner flourishes.
- **Pip cards 10, 9:** portrait window 17-46.5 mm by 6-66.5 mm, flanked by columns of 2.2 mm brush-"+" pips (10 = 5 + 5; 9 = 5 + 4).
  - The 9's window rectangle (normalised UV) goes in the manifest for the video (§10).
- **Every window:** 0.3 mm #151515 frame, then a 0.13 mm #E33131 keyline 0.6 mm inside it, radius 1.4 mm.
- **Title band** (y 69-82 mm):
  - title in CondensedBlack, 7 mm caps, #151515, left-aligned at x 9 mm;
  - a 15 x 0.8 mm accent rule;
  - a 1.5 mm PP Neue Montreal Mono line, tracking 0.18em: "N°Q · VIRAL LOOP · NOMADA TOAST".
- **Photo grade ("faded ink"):** contrast 0.9, saturation 0.86, blacks lifted to #1B1917, warm multiply #F6EBD3 at 10%.

### 4.3 Back (shared, point-symmetric)

- 3.0 mm bone border #EFE8DA, then a print-red field #D42F2F (radius 2 mm) with a bone double hairline 1.2 mm inside.
- Field: a 45 deg diamond lattice at 4.2 mm pitch of 2.4 mm bone brush "+" marks, rotated +/-8 deg alternately, with 0.5 mm dots between.
- Centre: a 28 x 40 mm bone oval medallion holding a red brush "+", with "nomada toast" running round the ring (top upright, bottom rotated 180 deg) and the toast wordmark recoloured red (face kept).
- Micro-print at both ends: "NOMADA TOAST PLAYING CARDS · No.26 · CASINO FINISH".

### 4.4 Wear (numpy, seeded per card)

**(a) Baked into the front albedo:**
- 8-15% desaturation and black lift;
- edge yellowing (#E9DCC2 at 25%);
- edge grime #6B5D4A at 10% inside a 0.2-1.2 mm rubbed-white band (#F4F0E6);
- 1-2 creases, each a 0.1 mm highlight at +18% beside a 0.1 mm shadow at -22%;
- 30-60 scuff strokes (6-14% alpha), weighted to thumb zones and shuffle arcs;
- low-frequency fade +/-5%.

**(b) Wear map `<id>-wear.png`:** RGB, no alpha, linear (NoColorSpace). Both faces sample it; the back samples with u mirrored, so creases and chips line up through the card.
- **R = signed distance to the frayed silhouette**, encoded 0.5 + d / 0.13 cm, clamped. It includes:
  - per-corner radius 0.32-0.55 cm;
  - fbm fray +/-0.012 cm along edges and up to 0.035 cm at corners;
  - 3 + round(5 * wear) semicircular chips of r 0.03-0.08 cm;
  - 1-2 V nicks.
- **G = ink loss / whitening:**
  - an edge band of 0.08 cm with a noisy threshold, x1.6 at corners;
  - scuff arcs;
  - crease ridges.
  - On the back this shows as white flecks on red (the strongest "used" signal). On the front it lightens toward paper #F4F0E8.
- **B = height**, 0.5 neutral:
  - crease V-profiles (depth 0.12, width 0.04 cm);
  - the dog-ear crease;
  - scratches -0.02.

**(c) Gloss map `<id>-gloss.png`:** L, half the wear-map resolution.
- base 0.62, low-frequency fbm +/-0.12;
- thumb zones -0.25 with fingerprint whorls (+0.10 grease);
- scuffs -0.30, edges within 0.15 cm -0.35, creases -0.30, stain interior -0.20.

**(d) Shared `dimple-normal-256.png`:** tiling "air-cushion" emboss, about 0.05 cm period, normalScale 0.25.

**Per-card personality:**

| Card | Wear level | Character |
|---|---|---|
| A | 0.85, most handled | Dog-ear across the top-right corner (1.1 cm, hinged up 7 deg, flutters, §8); strongest whitening; greasy thumbprint (gloss only). |
| K | 0.70 | Long soft bend crease across the lower third; thumbprint on the right edge. |
| Q | 0.45 | Shuffle-ring scuffs; right-edge nick. |
| J | 0.85 | Long diagonal crease; sun-faded (saturation -18%); chip on the top edge. |
| 10 | 0.65 | Partial coffee ring: radius 1.2 cm at (4.3, 2.7) cm, 210-260 deg arc, rim #8A5A2B at 10% plus a drip blot; frayed bottom-right corner. |
| 9 | 0.50, freshest | One ink fleck; diagonal pressure crease at the bottom-right. |

### 4.5 Geometry parameters (written to the manifest, used by B's vertex shader)

- `curl.long` 0.08-0.22 cm (corners up);
- `curl.lat` 0.02-0.06 cm;
- `curl.twist` 0-0.09 cm;
- `dogEar` {corner, sizeCm, liftDeg} or null.

### 4.6 Outputs

| Tier | Front (RGB webp q88, no alpha) | Wear | Gloss |
|---|---|---|---|
| hi | 1024 x 1434 | 512 x 717 | 256 x 358 |
| lo | 640 x 896 | 256 x 358 | 128 x 179 |

Files:
- `assets/cards/{hi,lo}/<id>-front.webp`, `<id>-wear.png`, `<id>-gloss.png`
- `assets/cards/{hi,lo}/back.webp`
- `assets/cards/dimple-normal-256.png`
- `assets/cards/clip-9.mp4`:
  - `ffmpeg -ss 15.5 -to 18.2 -i "Meshy 2.mp4" -an -vf "crop=<window aspect from 1080x1920>,scale=360:-2" -c:v libx264 -profile:v main -pix_fmt yuv420p -crf 26 -movflags +faststart`
  - target 600 KB or less;
  - the 9's still is the frame at 16.55 s, which is clip offset 1.05 s.
- Contact sheet `patches/build/cards/contact.jpg`: fronts, backs, the wear channels and 4 fps clip frames, for human review. Confirm there is no Mario-like figure.
- Intermediates go to `patches/build/cards/`.

### 4.7 `data/cards.json`

```json
{ "version":1, "seed":7331, "cardCm":[6.35,8.89], "cornerCm":0.32,
  "ring":["9","10","j","q","k","a"],
  "cards":[{ "id":"a","rank":"A","title":"Nomada Toast","sub":"ACE OF TOAST","accent":"#E33131",
             "wear":0.85,"backFade":0.08,"curl":{"long":0.18,"lat":0.04,"twist":0.05},
             "dogEar":{"corner":"tr","sizeCm":1.1,"liftDeg":7},
             "files":{"hi":{"front":"assets/cards/hi/a-front.webp","wear":"…","gloss":"…"},"lo":{…}} }, …],
  "back":{"hi":"assets/cards/hi/back.webp","lo":"assets/cards/lo/back.webp"},
  "dimple":"assets/cards/dimple-normal-256.png",
  "video9":{"file":"assets/cards/clip-9.mp4","startSec":15.5,"endSec":18.2,"posterSec":16.55,"posterOffset":1.05,
            "windowUV":[u0,v0,u1,v1]} }
```

---

## 5. Table and CRT (builder C)

### 5.1 Felt

- 120 x 90 cm plane, MeshStandardMaterial, roughness 0.96, envMapIntensity 0.
- `felt-green-1024.jpg` is a tileable fibre/lint texture repeated 6 x 4.5; `felt-normal-512.jpg` at strength 0.35.
- Under the lamp it reads #1E5642, falling to #0B2A21 in shadow and about #06120D at the screen corners.
- `?felt=charcoal` switches to #141615 -> #34383A.

### 5.2 Print decal

`felt-print-2048.png` (lo 1024) on a plane at y 0.001. Its alpha is broken by fibre noise, as if the dye soaked in.
- A NomadaToast-red betting line: 0.35 cm wide, #E33131 at 70%, arc radius 39 about (0, 0, 30), spanning +/-48 deg. It sits just above the hand on screen.
- Arc text along its inside: 0.6 cm mono caps at 12% #E9E2D2, "NOMADA TOAST · TECH · AI · SOCIAL MEDIA GROWTH — SERVED HOT EVERY WEEK".
- A faded "+ nomada toast" lockup, 12 cm wide, at (0, -, -14), 8%. The lamp reveals it.
- One faint glass ring at bottom-left.

### 5.3 Near rail

- A cylinder of radius 2.6 cm along x. Red leather #C2272A, roughness 0.55, leather normal tile, a cream stitch line, rubbed-light scuffs.
- A 0.6 cm black-lacquer strip between rail and felt.
- `layout({railZ})` places it so its top lands at screen-y of about 0.97: a sliver under the footer text.
- The far side has no rail; it dissolves into darkness under the header.

### 5.4 Light

- **SpotLight "lamp":** #FFE2B8, position (0, 58, -2) aimed at (0, 0, -1), angle 35.5 deg, penumbra 0.75, decay 0, intensity 2.2.
- **Warm-up:** intensity keys 0 / 0.6 / 0.25 / 1.0 at t = 0.38 / 0.47 / 0.53 / 0.80 s.
- **Pendulum:** a closed-form sway of the position by +/-0.6 deg around (0, 120, -2), using `valueNoise1(seed, t/2.6)`. This is a pure function of t, so seeking stays exact.
- **Fill:** HemisphereLight, sky #5D6A78, ground #0A0D0C, 0.18.
- **Environment:** PMREM `fromScene` of a black BackSide sphere plus an emissive disc of radius 6 cm, #FFE2B8 x 6, at the lamp, plus a dim red strip low (#E33131 x 0.4). Built once at boot.

### 5.5 ShadowDecals (one per card, multiply blend, no shadow maps)

- Each frame the 4 card corners are projected from `lamp.pos` onto y = 0, and the fragment draws a rounded-quad SDF.
  - softness sigma = 0.08 + 0.11 h, where h is the mean corner height in cm;
  - alpha = max(0.18, 0.62 (1 - 0.045 h)).
- **Contact core:** under 0.4 cm, add sigma 0.06 at alpha 0.35 * (1 - min/0.4).
- **AO blob:** sigma 1.2, alpha 0.12.
- The shadow visibly sharpens and darkens through the bounce and rebounce.

### 5.6 CRT layer (CSS, ported from site)

- `.tv` is #050505; `.screen` is inset 2.6vh 2.4vw, radius clamp(18px, 3.2vw, 46px).
- **RGB triad:** `repeating-linear-gradient(90deg,#ff28280f 0 1px,#28ff5a0d 1px 2px,#326eff0f 2px 3px)` with a 0.12 s steps(2) flicker.
- **Scanlines:** rgba(0,0,0,.18), 1 px every 3 px.
- A 7 s roll band.
- **Vignette:** `radial-gradient(75% 70%, #0000 55%, #0000008c)` plus an inset 120px shadow.
- **Grain:** a 256 x 256 PNG with steps(8) background-position at 0.06. Frozen under `?nofx` and `?debug`.
- `.tv-glass` uses image-set(tv-glass.webp / -1280.webp / -960.avif) with the site's media queries.
- **Power-on**, driven by `setPowerOn(k)` over sim t 0-0.38 s: a 0.4%-tall line expands, with a brightness flash.

### 5.7 Chrome

- Fonts: NeueBit Bold and PP Neue Montreal Mono.
- Text #ECE9E1 with a chromatic text-shadow (-0.6px #ff284659 / +0.6px #2896ff59). No exclusion blend.
- Caption under the hand: rank and title in NeueBit, sub-line in mono.
- B&W toggle: `filter: grayscale(1)` on `.screen`.

---

## 6. Wind model (`js/wind.js`), cm/s, deterministic

```
W(x,y,z,t) = BL(y)·(W_base + W_curl + Σ gusts) + ŷ·W_y
BL(y) = 0.35 + 0.65·smoothstep(0, 3, y)            // air cannot blow through felt
```

**W_curl:**
- Divergence-free horizontal curl of seeded simplex psi(x/l, z/l, nu t), with an analytic gradient.
- Two octaves: l = 14, then l/2.3 at amplitude 0.45.
- The domain is shifted by -W_base * t (frozen turbulence: eddies drift with the breeze).
- Deal: A = 9 RMS, nu = 0.35 Hz. It eases over 1.5 s after the closing gust to idle A = 2.2, nu = 0.12.

**W_y:** A_y * psi2 * smoothstep(0, 2.5, y), with A_y = 4 during the deal and 0.8 at idle.

**W_base:**
- Idle: (-1.4, 0, 0.6). The prevailing breeze runs right to left, matching the closing gust.
- Dealer's gust: (0, 0, +9). It ramps up over 0.52-0.90 s, holds, and fades out from 3.0 to 3.6 s.

**Gust fronts:** at most 8 alive. Each is a moving Gaussian:
`a·dir·exp(-(d∥ - c·age)²/2σ²)·exp(-d⊥²/2σ⊥²)·fade(age/life)`

| Front | Behaviour |
|---|---|
| THROW PUFF (one per card) | Rides its card's channel: c = channel speed, a = 0.85 x that, sigma 7, life T_f + 0.4. |
| SQUEEZE-OUT (at first impact) | Radial, a 14, sigma 5, life 0.35. Kicks dust outward and lifts neighbours' near edges 0.1-0.2 cm. |
| BREATH (idle) | c 22, a 7, sigma 10, sigma-perp 40, life 2.5. Heading -x within +/-30 deg. Seeded every 4.5-8.5 s; breath #0 at closingGust + 1.6 s. |
| CLOSING GUST | c 240, a 14, sigma 12, life 1.2. Sweeps from x = +25 toward -x. |
| USER JET (spin) | Air along the fan arc in the push direction at 0.55 x the leader's arc speed. Rises through a 0.12 s low-pass, decays with tau 0.60 s, radial sigma 7 around r = 30. |

**Aero (`aero.js`, after Andersen, Pesavento & Wang 2005):**
- v_rel = W(p) - v_card; alpha = asin|v̂_rel · n|.
- Normal force: a_N = K C_N |v_rel|^2 sign(v_rel · n) n, with K = 0.012 cm^-1 and C_N = 2 sin alpha.
- Skin drag: 0.06 K |v_rel| v_rel,t.
- Centre of pressure (1/4 - alpha/(2 pi)) of the chord ahead of centre; torque gain K_tau 2.5.
- Turbulence side-force gain 1.6.
- Vortex-shedding drive f_s = 0.17 |v_rel| / 5 cm into the pitch/roll flutter oscillators:
  - omega 13.8 -> 29.8 rad/s toward landing, zeta 0.18;
  - drive 22 rad/s^2 on pitch and 16 rad/s^2 on roll;
  - also drives the flex mode.
- Ground-effect lift: a = g' (|v_rel| / 10)^2 (1 - y/2.0), height capped at 1.4 cm, with g' = 300 cm/s^2.

**Dust (`dust.js`):**
- 140 Points (70 on lite) in the box x +/-24, y 0.3-14, z -16..+10.
- Advected by W, with -0.15 cm/s settling and 0.3 cm/s seeded jitter.
- Size 1.2-2.6 px, #FFF3E0, alpha 0.05-0.22 times the spot-cone falloff, additive blending.
- Within 6 cm of a card whose flip rate exceeds 6 rad/s, motes get an extra swirl omega_flip x r * 0.4: the air "catching" the card.
- Dust is deterministic: it is integrated in sim steps and included in snapshots.

---

## 7. The deal (`flight.js`, `contact.js`, `sim.js`)

### 7.1 Timeline (seconds; default seed 7331; expected values)

| t | Event |
|---|---|
| 0-0.38 | power-on |
| 0.38-0.80 | lamp warm-up |
| 0.52 | dealer's gust starts |
| 0.70, 1.00, 1.30, 1.60, 1.90 | throws of 9, 10, J, Q, K (+/-0.025 s seeded) |
| 2.02 | A (extra 0.12 s beat) |
| ≈ throw + 0.95 | touch for each card; A at about 2.97 |
| ≈ 3.27 | A rests |
| **3.40** | **closing gust**; input unlocks (`interactiveAt`) |
| ≈ 4.6 | all visible cards settled |
| ≈ 5.0 | breath #0 |
| ≤ 4.8 | phase `idle` |

Hurry mode: any input before 3.40 sets timeScale to 2.5 until `interactiveAt`. It eases in over 0.15 s.

During the deal phi = 2.5, so the slots are 9 -2.5, 10 -1.5, J -0.5, Q +0.5, K +1.5, A +2.5. The +/-2.5 cards are half cropped by the screen edges.

### 7.2 Launch

- L_k = (0.55 * x_slot + j, 1.8, -20), with j in +/-0.8 cm. That is beyond the betting line, entering from under the header.
- The card leaves face down, nose down 10 deg, with yaw offset delta-theta_k of +/-110-200 deg (seeded) from its slot yaw: spinning flat like a pitched card.

### 7.3 Guided channel (tau = t / T_f)

- **Flight time:** T_f = 0.84 + 0.004 D +/- 0.03 s (D = launch-to-touchdown distance, 22-26 cm), so 0.93-0.97 s. The A gets +0.06 s.
- **Touchdown point:** TD = slot - **2.6 cm** along the approach direction û.
- **Horizontal:** p_h = lerp(L, TD, e(tau)), with e = tau (1.5 - 0.5 tau). It arrives at about 12 cm/s along û.
- **Vertical:** cubic Hermite through (tau, y cm, v_y cm/s):

  | tau | y | v_y | Meaning |
  |---|---|---|---|
  | 0 | 1.8 | 0 | skim |
  | 0.32 | 2.4 | +6 | skim |
  | 0.56 | 5.4 | +3 | ground-effect pop |
  | 0.80 | 3.8 | -5 | float, 150-190 ms near level |
  | 1.0 | 0.62 | -48 +/- 3 | stall-drop |

  The touchdown v_y is seeded per card. 0.62 cm is the 8 deg flare contact height.
- **Yaw:** theta_slot + delta-theta_k (1 - spr(t, 6.5, 0.62)), where spr is Project 2's damped spring.
- **Flip** (roll about the card's long axis, roughly the travel direction):
  - roll = pi * n_k * (1 - spr(t - 0.25 T_f, 8.5, 0.74)), with n = 1 (180 deg) and n = 3 (540 deg) for the A only;
  - flip axis tilted +/-12 deg (seeded);
  - about 95% complete by tau 0.73;
  - a 2.6% overshoot gives a 5 deg wobble past face-up (14 deg on the A).
- **Pitch:** -10 deg at launch -> 0 by tau 0.5 -> +8 deg nose-up flare over tau 0.88-1, so the trailing edge touches first.
- **Perturbation layer** (from aero.js on W):
  - a translational offset delta and flutter angles ride on the channel;
  - tethered by springs omega_g = 2.6 + 13.4 tau^3, zeta 0.9;
  - faded by 1 - smoothstep(0.80, 0.98, tau), so the touchdown pose is exact;
  - expected wander 0.5-1.6 cm and flutter 8-17 deg at 1-2 Hz, growing with airspeed.
- **Flex mode:** omega 2 pi * 7 Hz, zeta 0.18, driven by face pressure. It is a vertex bend in the shader (amplitude cap 0.3 cm).

### 7.4 Contact: stylised bouncy felt (also used for spin tap-downs)

- **Centre height:** the card's centre hops under g' = 300 cm/s^2. Height above felt = hop(t) + contactLift, where contactLift is a **soft-min** (log-sum-exp, k = 60 per cm) over the 4 corners plus the centre of the curled, tilted card. The lowest point sits on the felt and there is no corner-switch jitter.
- **Restitution by impact number:** e = [**0.55, 0.58**], then the third impact is absorbed (the felt grabs: rest when the post-impact speed would be below 6 cm/s).
  - With v_imp = 48 cm/s this gives hop1 = (0.55 * 48)^2 / 600 = 1.16 cm, airtime 0.176 s.
  - hop2 = (0.58 * 26.4)^2 / 600 = 0.39 cm, airtime 0.102 s.
  - The third impact is 15.3 cm/s with rebound below 6, so the card rests.
  - On screen at 1440 x 900: about 28 px and 9 px of rise, plus the shadow-gap change.
- **Tilt rocking** (pitch and roll): oscillator omega 20 rad/s, zeta 0.28, rendered as rocking about the lowest edge. Each impact kicks it:
  - pitch rate -0.054 * v_n * sign(pitch);
  - roll rate -0.021 * v_n * sign(roll).
- **Each impact:**
  - the felt grabs 35% of planar and yaw velocity;
  - kicks the flex by 0.0006 * v_n (omega 2 pi * 9 Hz, zeta 0.12), which shows as a "thwap" ripple in the clearcoat highlight for about 0.3 s;
  - the first impact emits a SQUEEZE-OUT gust.
- **Slot springs** (ramped in over 0.12 s from touchdown):
  - planar omega 10.5, **zeta 0.32** while hopping, 0.45 once at rest;
  - yaw omega 9, zeta 0.36.
  - Expected result: the card slides 2.6 cm forward, **overshoots 0.35-0.7 cm** past its slot, swings back once, yaw overshoot 1-3 deg, settled within 1.4 s of touchdown.
- **REST:** 4 corners within 0.03 cm for 24 steps.
- **SETTLED:** slot error below 0.02 cm and 0.2 deg, speed below 0.2 cm/s, for 0.15 s.

### 7.5 Closing gust (t = 3.40)

- The leader phi is driven 2.5 -> 3.0 by the snap spring (omega 7, zeta 0.62).
- The CLOSING GUST jet (§6) blows right to left. Trailing lag starts at the right (upwind) end, so the ripple travels leftward.
- Cards hover up to about 0.4 cm, bank and tap down (§9).
- The 9 crosses s = -3 off-screen and wraps.
- Caption: "Q · VIRAL LOOP". Phase becomes `closing`, then `idle`.

---

## 8. Post-deal idle

Each card sits on small springs around its imperfect rest pose, all driven by local W:

| Spring | Response |
|---|---|
| Drift (omega 3.0, zeta 0.6) | 0.02 cm per cm/s of wind, so about +/-0.15 cm in a breath. |
| Yaw | +/-0.4 deg, same spring. |
| Upwind-edge lift | 0.35 deg per cm/s across an edge, cap 4 deg; oscillator omega 2 pi * 1.4 Hz, zeta 0.45; rocks on the downwind edge. |
| Curl breathing | b0 x (1 +/- 0.25) with the local breeze, so corners rise and fall 0.01-0.02 cm. |
| Flex | omega 2 pi * 6 Hz, zeta 0.3, lightly driven. Mostly visible as the highlight crawling across the coating. |
| A's dog-ear hinge | 4 Hz, zeta 0.2, +/-1.5 deg in breeze, up to +/-5 deg in a breath. |

What it looks like:
- Breaths cross the hand right to left at 22 cm/s (a wave over about 1.5 s). Dust drifts with them and the cards sink back with about 5% overshoot.
- The lamp pendulum drifts the warm specular.
- No global scale breathing.
- Amplitude caps: 0.2 cm and 4 deg.
- The caption follows the card nearest s = 0.

---

## 9. Spinning and scrolling (`spin.js`, `input.js`)

### 9.1 Direction

- Drag right moves the cards right (they stay under the finger).
- Wheel deltaY > 0 or deltaX > 0 moves the cards left (the next card comes in from the right). This is phi increasing.
- ArrowRight: phi + 1 (cards move left). ArrowLeft: phi - 1.

### 9.2 Leader phi (slots)

**Drag** (pointer on `.screen`, phase idle, or hurry before that):
- phi = phi0 - delta-x / slotPx.
- velocity EMA: phi-dot <- 0.65 phi-dot + 0.35 delta-phi / delta-t (delta-t at least 8 ms), clamped to +/-9 slots/s.
- On release:
  - pointer still for 90 ms or more before release: phi-dot = 0;
  - fast release with displacement under 0.5 slot: target round(phi) +/- 1;
  - otherwise free glide phi-dot *= exp(-dt / 0.42) until |phi-dot| < 2.2, then target = round(phi + 0.42 phi-dot), clamped to within 4 of phi.

**Wheel:**
- Use the dominant axis. deltaMode 1 multiplies by 16, deltaMode 2 by 400.
- Notch mode: deltaMode is not 0, or |delta| >= 40 and an integer with no deltaX and more than 30 ms since the last event. Each notch is target +/-1, queued at most +/-3 ahead.
- Trackpad mode: G += delta / 220. phi follows G on a spring (omega 9, zeta 0.55). 140 ms after the last event, G = (dir > 0 ? ceil(G - 0.35) : floor(G + 0.35)).
- Clamp |G - phi| <= 3.
- preventDefault only while the pointer is over `.screen`.

**Keys:**
- target +/-1, repeats throttled to one per 0.16 s, queue at most 3;
- plus a jet impulse of 0.6 x one-slot arc speed.

**Snap spring:** omega 7.0, zeta 0.62 (about 8% leader overshoot). Reduced motion: omega 12, zeta 1.

### 9.3 Trailing cards ("leaves") with air carry

Each card has an unwrapped phi_i:

```
φ_i'' = ω_i²·(φ_L(t - lag_i) - φ_i) + 2ζ_iω_i·(A_i - φ_i')
A_i' = (φ̇_L(t - lag_i) - A_i)/0.14 s          // the air the hand pushed: keeps blowing after the hand stops
ω_i = 10·(1 + 0.08 r_i), ζ_i = 0.45 + 0.05 r_i, r_i ∈ [-1,1] seeded
lag_i = |x_i - x_origin| / 240 cm/s
```

- The leader history is a 0.5 s ring buffer at 240 Hz with linear interpolation.
- x_origin is the pointer ray's hit on the felt (drag), or the upwind end x = +/-18 cm (wheel, keys, closing gust).
- The grabbed card uses omega 18, zeta 0.7, lag 0 and A = leader velocity, so it stays under the finger within 4 px.
- **Accordion:** effective spacing = 11.5 deg * (1 + 0.035 min(|phi-dot_L|, 6)).

### 9.4 Wind response

Same plate model, with v_rel = W - v_card along the arc.

- **Hover:** ground-effect lift (cap 1.4 cm).
  - flick at 8 slots/s: 1.2-1.4 cm;
  - wheel notch or arrow key: about 0.4-0.6 cm;
  - slow drag: none.
  - Cards come down through contact.js with restitution 0.35 above 8 cm/s, giving a 0.1-0.15 cm tap-down hop, at rest about 0.5 s later.
- **Bank:** roll target 0.45 deg per cm/s of tangential v_rel, clamped +/-14 deg, spring omega 14, zeta 0.4.
  - The leading edge rises while the hand accelerates through still air.
  - When the hand stops and the lingering jet overtakes the cards, the **trailing** edge rises (a sign flip).
- **Yaw lag (weathervane):** -1.6 deg * phi-dot_i, clamped +/-9 deg, spring omega 9, zeta 0.5.
- **Flutter:** vortex drive at seeded f_i of 3.0-4.2 Hz on flex (2 pi * 6, zeta 0.15) and on pitch/roll with gains x 0.5 (|v_rel| / 40)^2. At 30 cm/s that is about a 0.08 cm edge ripple and 2-5 deg of rocking.
- **Wrap:** s jumps from +3 to -3 only off-screen. Each wrap emits a 'wrap' event.

---

## 10. The video card (replaces "Supporter")

- `cardMesh.js` creates `<video muted playsinline loop preload=auto src=clip-9.mp4>` as a `THREE.VideoTexture`.
- The 9's front shader mixes it into `windowUV` with `uVideoMix`. The wear G/B/gloss and the faded-ink grade (saturation 0.86, lifted blacks, warm multiply) are still applied over it, so it reads as printed and used.
- **Live when** all of these hold:
  - not `?debug` (unless `&live9=1`);
  - not reduced motion;
  - the 9 has emitted `settled`;
  - |s_9| < 2.7.
- Start at `currentTime = posterOffset` (1.05 s, the exact baked still), so there is no visible switch. Pause when |s| >= 2.7 or the tab is hidden.
- Emits a 'video-start' event.

---

## 11. Card rendering (`cardMesh.js`, `view.js`)

**Geometry:**
- front and back planes 6.35 x 8.89, 10 x 14 segments (lite 8 x 11);
- a 64-segment edge ribbon 0.024 thick, bone #E7E0D1 with a red #D42F2F core line at mid-thickness. It discards where the wear-map SDF is negative.

**Vertex shader displacement** along the normal (analytic normals so the sheen moves):

`d = c_long((2z/H)² - ⅓) + c_lat((2x/W)² - ⅓) + c_tw(2x/W)(2z/H) + dogEar(hinge) + flex·φ1 + edgeLift(wind)`

**Material:** MeshPhysicalMaterial plus onBeforeCompile.
- roughness from the gloss map: mix(0.22, 0.8, 1 - gloss);
- clearcoat 0.55, clearcoatRoughness 0.38 * gloss modulation;
- envMap = table.envMap;
- dimple normal at scale 0.25 plus crease normals from wear B (4 taps).
- Silhouette alpha = smoothstep(-fw, fw, sdf), with fw = fwidth(sdf) and sdf from wear R.
- Back = back.webp, mixed toward bone by wear G plus uBackFade. The back reads with u mirrored.
- Card-on-card shadows: uniform `uOcc[2]` holds the 2 nearest higher cards' lamp-projected quads, applied with the same SDF as the decals.
- Lite: MeshStandardMaterial with the same chunks minus clearcoat and occluder shadows.

**Painter's order** (resorted every frame):
- renderOrder = 20 + rank by layer(s);
- cards in flight or hovering above 0.1 cm always draw last, sorted by height.
- Tilt is capped at 14 deg and rocks about the lowest edge, so neighbouring cards never visibly interpenetrate.

**Per frame:**
- copy World state to the meshes;
- compute the corners;
- call `table.setShadows`;
- set uniforms;
- render.
- No layout reads inside the loop (rect and slotPx are cached on resize).

---

## 12. Determinism, clock and debug

### 12.1 Determinism

- Randomness: `mulberry32` (Project 2's rng), `cyrb53`, and `fork(seed, 'card:A'|'wind'|'breaths'|'dust'|'imperfection'|'flight')`.
- Default seed **7331**; `?seed=` accepts an int or a string.
- No Math.random, Date or performance.now inside the sim.
- Sim time = step / 240 exactly.

### 12.2 Input

- Real events become commands stamped with the next step. While a drag is held, the pointer x is sampled every step.
- Everything goes into the input log.
- `World.snapshot()/restore()` use typed arrays (about 4 KB including dust). A snapshot is kept every 0.25 s, so a seek costs at most 60 steps.

### 12.3 URL flags

| Flag | Effect |
|---|---|
| `?debug` | installs `window.__deal` and the HUD, uses a virtual clock, turns parallax and grain off, keeps the live video off |
| `?debug=wind` | adds a 12 x 8 arrow grid at y = 1 cm |
| `?seed=` | seed override |
| `?t=<s>` | seek, then pause |
| `?paused` | start paused |
| `?rate=<k>` | time scale |
| `?quality=high|lite` | quality tier |
| `?reduced=1|0` | overrides the media query |
| `?felt=green|charcoal` | felt colour |
| `?dust=0` | dust off |
| `?nofx` | CSS animation frozen |
| `?live9=1` | live video even under ?debug |
| `?w=&h=` | fixed canvas size |

`<html>` always carries `data-phase` and `data-ready`.

### 12.4 `window.__deal` (with ?debug)

```
version:'cards-stage1@1', seed, simHz:240, dt, quality, reduced, config
ready: Promise                         // textures uploaded, first frame drawn
timeline() -> {powerOn, lampOn, dealerGust, throws:[{id,t}], touch:[{id,t}], rest:[…], settled:[…],
               closingGust, interactiveAt, dealEnd}   // from a silent pre-simulation at boot
now() -> {t, step, phase}
pause(), play(), isPaused(), setRate(k)
step(n=1) -> now()
seek(t) -> Promise<state>              // replays the input log from the nearest snapshot, then renders
render() -> Promise                    // resolves after the frame for the current state is painted
state() -> {t, step, phase:'boot'|'deal'|'closing'|'idle'|'drag'|'glide'|'snap'|'step',
            fan:{phi, phiDot, target, mode}, wind:{base:[…], gusts:n, jet}, cards:[CardState]}
card(id|rank) -> CardState
trace(id, t0, t1, dt=1/120) -> [{t, pos, quat, euler, centreH, minCornerH, phase, faceUp, flexCm, sx, sy}]
     // cloned World; the live state is untouched
events(type?) -> [{t, step, type, card, data}]
     // types: throw, enter-view, flip-edge, flip-done, touchdown, bounce{hop,peakCm,vImp,airtime},
     //        rest, settled, closing-gust, breath, input, snap, wrap, video-start
inputs(), replay(log)
input.drag(dxPx, dur=0.2, {y}), input.wheel(deltaY, deltaX=0, deltaMode=0), input.key(code), input.flick(slotsPerSec)
project([x,y,z]) -> {x,y} CSS px; wind([x,y,z], t) -> [wx,wy,wz]
hash() -> FNV-1a of state() rounded to 1e-5
perf() -> {fps, p50, p95, frames, dpr, tier}
verify() -> {ok, failures:[…]}           // the §15 motion checks, run headless on a clone
```

**CardState:**
- id, rank, title, index, s, restS
- phase: 'queued'|'flight'|'contact'|'settling'|'rest'|'spin'
- pos [cm], quat, euler {yaw, pitch, roll} (deg), vel, speed
- centreH, minCornerH, faceUp (n · y), flipDeg
- flex {curl, flex, twist}
- hops [peakCm…], touchdownAt, restAt, settledAt
- slotErrCm (signed along û), yawErrDeg
- hoverCm, bankDeg
- screen {x, y, corners[4], visible}
- shadow {alpha, sigma}

**HUD:** t, step, phase, fps, a phase chip per card, and a scrubber. Keys: Space pause/play; `.` / `,` step +/-1; `[` / `]` seek +/-0.1 s; R replays the deal.

---

## 13. Reduced motion (media query or `?reduced=1`)

- No throw: cards appear at rest at phi = 3, each fading in over 0.24 s with a 0.08 s stagger. The lamp fades up over 0.4 s.
- No idle wind response, no dust, no CRT flicker, roll or grain, no parallax, no live video.
- Spin: drag is direct; release, wheel and keys use one critically damped spring (omega 12, zeta 1). No lag, hover, bank or flutter.
- The timecode still runs.

---

## 14. Performance budget

**Tiers:** lite when any of these hold:
- `(pointer: coarse)` and min(screen) < 900;
- hardwareConcurrency <= 4;
- deviceMemory <= 4;
- MAX_TEXTURE_SIZE < 4096;
- `?quality=lite`.

The sim runs at 240 Hz in every tier, so the motion is identical.

| | hi | lite |
|---|---|---|
| Textures | 1024 fronts / 512 wear | 640 fronts / 256 wear |
| Card material | MeshPhysical clearcoat | MeshStandard |
| Occluder shadows | yes | none |
| Dust | 140 | 70 |
| DPR cap | 2 | 1.25 |
| CSS animations | on | off |

**Budgets:**
- About 30 draw calls; about 5k triangles; no shadow maps or post-processing.
- Sim and dust: 0.5 ms or less per frame on an M1.
- GPU memory: about 66 MB (hi) and 24 MB (lite).
- Download: about 5.5 MB (hi, three.js uncompressed included) and about 2.6 MB (lite).
- Textures decode via `createImageBitmap` (`imageOrientation: 'flipY'`, `premultiplyAlpha: 'none'`, `colorSpaceConversion: 'none'`). Albedo is SRGB; wear and gloss are NoColorSpace.
- The deal starts after `ready`, or after a 3.5 s timeout with lit felt.

**Dynamic resolution:** if the frame EMA exceeds 18 ms for 1 s, DPR drops by 0.25 (floor 1.0). If it stays under 11 ms for 3 s, DPR goes back up.

The loop pauses on `document.hidden`. The sim clock is the step count, so there is no catch-up burst on return.

---

## 15. Acceptance criteria

Measured by `tests/check_deal.py` (Python Playwright, Chromium, `http.server 8040`):
- URL: `?debug&seed=7331&paused&nofx`
- Viewports: 1440 x 900 and 390 x 844, plus aspect checks at 21:9 and 4:3.
- **Seed sweep:** criteria 1-6 must pass for seeds 1-20 via `verify()`.

**Deal**

1. **Flip.** Every dealt card has faceUp < -0.95 at its throw and faceUp > 0.98 from touchdown - 0.10 s onward. The edge-on moment (|faceUp| < 0.1) happens while `screen.visible` and screenY >= 0.14 x screen height.
2. **Exactly two decreasing bounces.** After first touchdown there are exactly two airborne intervals: all 4 corners above 0.03 cm, each lasting at least 0.04 s.
   - hop1 (peak centre height above rest) 0.9-1.4 cm, airtime 0.15-0.20 s;
   - hop2 0.28-0.50 cm, airtime 0.08-0.12 s;
   - hop2 / hop1 in 0.25-0.45;
   - after the third impact, no lift above 0.05 cm;
   - on screen at 1440 x 900: hop1 rise >= 20 px, hop2 >= 6 px.
3. **Elastic settle.** Signed slot progress along û overshoots by 0.35-0.70 cm, has at least one return crossing, and yaw overshoot is 1-3 deg. SETTLED (below 0.02 cm and 0.2 deg, speed below 0.2 cm/s for 0.15 s) by touchdown + 1.4 s.
4. **Sanity:**
   - minCornerH >= -0.01 cm everywhere;
   - no position jump above 1.0 cm per 1/240 step;
   - velocity is continuous except at touchdown and bounce events;
   - peak flight height 4.5-7.5 cm.
5. **Organic, not canned:**
   - peak lateral wander per card 0.5-1.6 cm, with a standard deviation across the 6 cards >= 0.2 cm;
   - peak flutter roll 8-17 deg;
   - hash() differs between seeds 7331 and 7332 at t = 2.0.
6. **Timeline:**
   - throws as in §7.1 +/-0.03 s;
   - `interactiveAt` <= 3.5;
   - after the closing gust phi is within 0.005 of 3.0, the centre card is Q, the visible ranks left to right are 10 J Q K A, and the 9's `screen.visible` is false;
   - all visible cards settled by 4.8 s.

**Idle**

7. From 5 to 15 s:
   - every card has |slotErr| <= 0.2 cm, |yawErr| <= 4 deg and centreH <= 0.25 cm;
   - at least one breath event in each 8.5 s window;
   - during a breath each card's max minCornerH lift is >= 0.03 cm, with per-card peak times ordered along the breath direction;
   - the Ace's dog-ear angle varies by >= 1 deg.

**Spin**

8. **ArrowRight from idle:**
   - every visible card's x first decreases;
   - the upwind lead card moves within 0.06 s;
   - per-card peak overshoot in the push direction is 0.08-0.30 slot;
   - per-card peak times are ordered by distance from the upwind end;
   - hover 0.3-0.7 cm;
   - phi lands on the integer, the centre becomes K, and everything is settled within 1.6 s.
9. **flick(8):**
   - hover 0.8-1.4 cm;
   - bank sign matches the push;
   - after release, at least one card shows a trailing-edge-up bank sign flip;
   - 2-4 slots travelled;
   - settled within 1.2 s after phi-dot falls below 0.1;
   - per-card overshoot at most 0.35 slot.
10. **Drag:** `input.drag(-1.2*slotPx, 0.18)`. During the drag the grabbed card stays within 4 px of the pointer. On release the offset ends on an integer within 1.8 s.
11. **Wrap invisible:** any card with |s| >= 2.92 has `screen.visible` false at 21:9, 16:10, 4:3 and 9:19.5, including mid-overshoot after flick(9).

**Determinism**

12. Two loads with the same seed give equal hash() at t = 2.0 and after a scripted input sequence. seek(2.0) after playing to 4.0 equals a fresh run's hash at 2.0. trace() leaves the live hash unchanged.

**Reduced motion**

13. With `emulateMedia(reduced_motion='reduce')`:
    - centreH never exceeds 0.01 cm;
    - all cards are at rest by 0.6 s;
    - hash at t = 5 equals hash at t = 9.

**Video**

14. Under ?debug the 9's window pixels match the baked still. Without ?debug, after the 9 is spun into view, the 'video-start' event fires and `video.currentTime` advances.

**Performance** (headed Chromium, M1)

15. p95 frame time <= 16.7 ms from 0 to 8 s at 1440 x 900 on the hi tier. On lite at 390 x 844 with 4x CPU throttle, p95 <= 33 ms. The sim step cost is <= 0.5 ms per frame.

**Screenshots**

16. Saved to `Project 3/audit/shots/cards/` at t = 0.30, 1.10 (Q mid-flip), 2.50, 3.00 (A touchdown + 0.03), 3.20, 3.60 (closing gust), 4.80 and 6.5 (idle), plus mid-flick and the phone portrait. A human reviews them together with `patches/build/cards/contact.jpg`.

---

## 16. Integrator checklist

- Run `build_cards.py --install` and `build_table.py`. Vendor three.
- Confirm cards.json paths resolve, `ready` resolves, and the console has no errors in Chromium and WebKit.
- Wire `chrome.setTime/setCaption/setPowerOn/setPhase` from main.js. Wire `table.update(t)`, `layout`, `setShadows`.
- Tune only config.js values, to bring §15 into band at seeds 1-20. Record final values in the README.
- No click handlers on cards. Header and footer links are inert.
- README: how to run, flags, the `__deal` API, how to rebuild the art.