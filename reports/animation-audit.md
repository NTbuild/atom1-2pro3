# Animation Audit

| # | Element / section | Trigger | Duration | Easing | Delay | Start state | End state | Transforms / opacity | Parallax / pin / scrub | Sequencing | Asset or module |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Loader (`.vhs-loader`) | page load | until textures ready (~1–3 s observed) | Unknown | 0 | "Loading 0", empty tick bar | removed, scene visible | `--loaded` drives the bar | — | precedes the tape entrance | DOM/CSS |
| 2 | Tape entrance | loader complete | `ENTER_SECONDS` = 2.2 s (from bundle) | Unknown (spring) | — | off-arc | resting on arc, centre tape forward | 3D position/rotation | — | after loader | WebGL / R3F |
| 3 | Carousel step | ArrowLeft/Right, wheel (idle 140 ms), drag fling (max 5200) | ~0.5–1 s (est.) | spring (est.) | 0 | tape n centred | tape n±1 centred | rotation along `onArc` | wheel-driven virtual scroll | caption swap follows | WebGL / R3F |
| 4 | Header/footer reveal (`.rv-i`) | load | Unknown | Unknown | 70–770 ms stagger (inline `transition-delay`) | hidden | visible | translate/opacity (est.) | — | header L→R, then caption, then footer | CSS |
| 5 | Caption swap (`.swap-i`) | centre tape changes | Unknown | Unknown | 0 / 0.07 / 0.14 s | old text | new text | Unknown | — | title → description → discipline | CSS |
| 6 | Timecode counter | continuous | 1 s ticks | linear | — | 00:00:00 | counting | text | — | — | JS |
| 7 | CRT lines / grain / roll | continuous | Unknown | Unknown | — | — | — | canvas redraw + CSS | — | — | 2D canvas + CSS |
| 8 | B&W mode | switch click | instant (est.) | — | — | colour | greyscale (`html.bw`, persisted in `localStorage.bw`) | filter | — | — | CSS + JS |

## Motion evidence summary

- Observed motion system(s) and evidence: three.js r185 / R3F scene (`__THREE__ = "185"`), CSS transitions with inline delays, 2D CRT canvas.
- Shared measured values: `ENTER_SECONDS 2.2`, `WHEEL_IDLE_MS 140`, `FLING_MAX 5200` (bundle constants); reveal delays 70–770 ms (HTML).
- Declared states exercised: load → usable, ArrowRight, wheel down, B&W on/off (local + source, in-app browser).
- Blocked, unexercised, or uncertain behavior: drag fling and cursor caption were not exercised; spring easings unknown.
