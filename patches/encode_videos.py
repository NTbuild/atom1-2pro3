#!/usr/bin/env python3
"""Encode the tape videos (P6) from Tino Assets/Vids into site/nt/videos/.

Each tape slug gets <slug>.mp4 (H.264 + AAC, ≤1280 px on the long side, fast-start
for streaming over the local server's Range support) and <slug>.jpg (poster frame).
Edit TAPE_VIDEOS to re-pair tapes and videos, then re-run.
Usage: python3 patches/encode_videos.py
"""
import subprocess
from pathlib import Path

PROJECT = Path(__file__).resolve().parent.parent
VIDS = Path("/Volumes/SSD/Tino Assets/Vids")
OUT = PROJECT / "site/nt/videos"

TAPE_VIDEOS = {
    "nomada-toast": "FREEPIK 4 YT.mp4",
    "ai-studio": "Invideo 10.mp4",
    "viral-loop": "3750349ce79e4d589131e2742baff3c4.MOV.mov",
    "x-ray": "Rabbit r1.mp4",
    "road-test": "Plaud.mp4",
    "supporter": "Artlist 2.mp4",
}


def run(*args: str) -> None:
    subprocess.run(["ffmpeg", "-v", "error", "-y", *args], check=True)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for slug, name in TAPE_VIDEOS.items():
        src = VIDS / name
        # fit inside 1280×1280 keeping aspect (vertical → 720×1280, 16:9 → 1280×720)
        scale = "scale='if(gt(iw,ih),1280,-2)':'if(gt(iw,ih),-2,1280)':flags=lanczos"
        run("-i", str(src), "-vf", f"{scale},format=yuv420p", "-c:v", "libx264", "-preset", "medium",
            "-crf", "24", "-profile:v", "high", "-c:a", "aac", "-b:a", "128k", "-ac", "2",
            "-movflags", "+faststart", str(OUT / f"{slug}.mp4"))
        run("-ss", "1.5", "-i", str(OUT / f"{slug}.mp4"), "-frames:v", "1", "-q:v", "4",
            str(OUT / f"{slug}.jpg"))
        print(slug, "<-", name)


if __name__ == "__main__":
    main()
