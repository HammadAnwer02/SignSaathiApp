"""Download the source data the pipeline needs into pipeline/.cache/.

Sources (all public):
- PSL dictionary videos + word mapping from the sign-language-translator project,
  licensed CC BY 4.0: https://github.com/sign-language-translator/sign-language-datasets
  Videos recorded at Hamza Foundation Academy for the Deaf, Lahore (collection pk-hfad-1).
- MediaPipe task models (Apache 2.0) from Google's model storage.

Usage:  pipeline/.venv/bin/python pipeline/fetch.py
"""

from __future__ import annotations

import sys
import urllib.request
import zipfile
from pathlib import Path

CACHE = Path(__file__).resolve().parent / ".cache"

DATASETS = "https://github.com/sign-language-translator/sign-language-datasets"
FILES = {
    "pk-dictionary-mapping.json": f"{DATASETS}/raw/main/parallel_texts/pk-dictionary-mapping.json",
    "text-preprocessing.json": f"{DATASETS}/raw/main/text-preprocessing.json",
    "pk-hfad-1.videos-mp4.zip": f"{DATASETS}/releases/download/v0.0.3/pk-hfad-1.videos-mp4.zip",
}
MP = "https://storage.googleapis.com/mediapipe-models"
MODELS = {
    "holistic_landmarker.task": f"{MP}/holistic_landmarker/holistic_landmarker/float16/latest/holistic_landmarker.task",
    "pose_landmarker_heavy.task": f"{MP}/pose_landmarker/pose_landmarker_heavy/float16/latest/pose_landmarker_heavy.task",
    "hand_landmarker.task": f"{MP}/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task",
    "face_landmarker.task": f"{MP}/face_landmarker/face_landmarker/float16/latest/face_landmarker.task",
}


def download(url: str, dest: Path) -> None:
    if dest.exists() and dest.stat().st_size > 0:
        print(f"  have {dest.name}")
        return
    print(f"  get  {dest.name} ...", flush=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    with urllib.request.urlopen(url, timeout=120) as r, open(tmp, "wb") as f:
        while chunk := r.read(1 << 20):
            f.write(chunk)
    tmp.rename(dest)
    print(f"       {dest.stat().st_size / 1e6:.1f} MB")


def main() -> int:
    (CACHE / "models").mkdir(parents=True, exist_ok=True)
    for name, url in FILES.items():
        download(url, CACHE / name)
    for name, url in MODELS.items():
        download(url, CACHE / "models" / name)

    videos = CACHE / "videos"
    if not videos.exists() or not any(videos.glob("*.mp4")):
        print("  unzip videos ...", flush=True)
        videos.mkdir(exist_ok=True)
        with zipfile.ZipFile(CACHE / "pk-hfad-1.videos-mp4.zip") as z:
            for member in z.infolist():
                name = Path(member.filename).name
                if not name.endswith(".mp4"):
                    continue
                with z.open(member) as src, open(videos / name, "wb") as dst:
                    dst.write(src.read())
    print(f"  {len(list(videos.glob('*.mp4')))} videos ready in {videos}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
