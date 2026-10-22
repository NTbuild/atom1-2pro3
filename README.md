# atom1-2pro3 — VHS hero, NomadaToast edition

The arcmarumo.com hero (a CRT TV with a 3D carousel of VHS tapes), mirrored locally and rebranded to NomadaToast: tech, AI and social media growth.

- `site/` — the NomadaToast edition: "+ nomada toast" logo, six tapes (Nomada Toast, AI Studio, Viral Loop, X-Ray, Road Test, Supporter) with sleeves built from the Tino Assets. Opening a tape plays its video on the TV.
- `mirror/` — the untouched mirror of the original, kept as the restore point.

Run either one through its local server (not `file://`):

```bash
python3 site/serve-local.py --port 8038
```

```bash
python3 mirror/serve-local.py
```

Then open http://localhost:8038 (or :8037 for the original). Arrow keys, scroll or drag move the tapes, and B&W switches the screen to greyscale.
Click the centre tape (or its title) to play it. While it plays: Space pauses, ← / → seek 5 s, M mutes, and Esc or Eject goes back to the tapes. A tape ejects itself when it ends.

| Tape | Video (Tino Assets/Vids) |
| --- | --- |
| Nomada Toast | FREEPIK 4 YT |
| AI Studio | Invideo 10 |
| Viral Loop | 3750349c….MOV |
| X-Ray | Rabbit r1 |
| Road Test | Plaud |
| Supporter | Artlist 2 |

To re-pair videos, edit `TAPE_VIDEOS` in `patches/encode_videos.py` and run it. To change the tapes, edit `TAPES` in `patches/p1_tape_data.py` and `SLEEVES` in `patches/build_brand_assets.py`, and keep `site/nt/tapes.json` in step. Then re-run, in order:

```bash
python3 patches/p1_tape_data.py && python3 patches/p2_identity.py && python3 patches/p6_player.py && python3 patches/build_brand_assets.py && for p in p3 p4 p5; do python3 patches/install_assets.py $p; done && python3 patches/encode_videos.py
```

`reports/` holds the mirror and edit reports. `audit/` holds the before/after screenshots and checks.

This is a showcase piece. CONTACT and EMAIL point at a dead-end placeholder (`hello@example.com`) on purpose, and Profile, News Watch and the tape links aren't included. The 3D engine, layout and UI fonts are the source site's deployed code.
