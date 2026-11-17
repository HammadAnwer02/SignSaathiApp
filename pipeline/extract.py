"""Extract per-frame body, hand and face data from the PSL dictionary videos.

Runs MediaPipe's HolisticLandmarker over every video in .cache/videos. Where it
misses a hand that the pose says is up in signing space, a second pass runs the
HandLandmarker on an upscaled crop around that wrist (small hands in 640x480
video are the main reason for dropouts).

Writes .cache/landmarks/<word>.npz with float32 arrays (NaN = not detected):
  pose_world (T,33,3)  metres, origin between the hips, MediaPipe axes (x right, y down)
  pose_image (T,33,3)  normalised image coordinates
  pose_vis   (T,33)    visibility
  hand_world (T,2,21,3) per hand, metres around the hand centre (0 = signer's left, 1 = right)
  hand_image (T,2,21,3)
  hand_src   (T,2)     0 none, 1 holistic, 2 crop pass
  face_bs    (T,52)    ARKit-style blendshape scores
plus fps, width, height.

Usage:  pipeline/.venv/bin/python pipeline/extract.py [--only word1,word2] [--workers 6]
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from multiprocessing import Pool
from pathlib import Path

import cv2
import numpy as np

CACHE = Path(__file__).resolve().parent / ".cache"
VIDEOS = CACHE / "videos"
OUT = CACHE / "landmarks"
MODELS = CACHE / "models"

# pose landmark ids
L_WRIST, R_WRIST, L_PINKY, R_PINKY, L_INDEX, R_INDEX = 15, 16, 17, 18, 19, 20
L_HIP, R_HIP, L_SHOULDER, R_SHOULDER = 23, 24, 11, 12

_holistic = None
_hands = None


def _init_worker() -> None:
    global _holistic, _hands
    os.environ.setdefault("GLOG_minloglevel", "2")
    from mediapipe.tasks.python import BaseOptions, vision

    _holistic = vision.HolisticLandmarker.create_from_options(
        vision.HolisticLandmarkerOptions(
            base_options=BaseOptions(model_asset_path=str(MODELS / "holistic_landmarker.task")),
            running_mode=vision.RunningMode.VIDEO,
            min_pose_detection_confidence=0.4,
            min_pose_landmarks_confidence=0.4,
            min_hand_landmarks_confidence=0.3,
            min_face_detection_confidence=0.4,
            min_face_landmarks_confidence=0.4,
            output_face_blendshapes=True,
        )
    )
    _hands = vision.HandLandmarker.create_from_options(
        vision.HandLandmarkerOptions(
            base_options=BaseOptions(model_asset_path=str(MODELS / "hand_landmarker.task")),
            running_mode=vision.RunningMode.IMAGE,
            num_hands=2,
            min_hand_detection_confidence=0.25,
            min_hand_presence_confidence=0.25,
        )
    )


def _arr(landmarks, dims=3) -> np.ndarray:
    if not landmarks:
        return None
    if dims == 3:
        return np.array([[p.x, p.y, p.z] for p in landmarks], np.float32)
    return np.array([getattr(p, "visibility", 0.0) or 0.0 for p in landmarks], np.float32)


def _crop_hand(rgb: np.ndarray, pose_img: np.ndarray, side: int, mp):
    """Run the hand model on a square crop around one wrist; return (image21, world21) or None."""
    h, w = rgb.shape[:2]
    wrist, index, pinky = (L_WRIST, L_INDEX, L_PINKY) if side == 0 else (R_WRIST, R_INDEX, R_PINKY)
    pts = pose_img[[wrist, index, pinky], :2] * [w, h]
    centre = pts.mean(axis=0)
    shoulder_w = np.linalg.norm((pose_img[L_SHOULDER, :2] - pose_img[R_SHOULDER, :2]) * [w, h])
    size = max(64.0, 0.85 * shoulder_w)
    x0, y0 = int(centre[0] - size / 2), int(centre[1] - size / 2)
    x1, y1 = int(x0 + size), int(y0 + size)
    if x1 <= 0 or y1 <= 0 or x0 >= w or y0 >= h:
        return None
    pad = ((max(0, -y0), max(0, y1 - h)), (max(0, -x0), max(0, x1 - w)), (0, 0))
    crop = rgb[max(0, y0):min(h, y1), max(0, x0):min(w, x1)]
    crop = np.pad(crop, pad, mode="edge")
    crop = cv2.resize(crop, (256, 256), interpolation=cv2.INTER_CUBIC)
    res = _hands.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(crop)))
    if not res.hand_landmarks:
        return None
    # pick the detection whose wrist is closest to the pose wrist (crop centre-ish)
    target = (pose_img[wrist, :2] * [w, h] - [x0, y0]) / size
    best = min(
        range(len(res.hand_landmarks)),
        key=lambda i: np.hypot(res.hand_landmarks[i][0].x - target[0], res.hand_landmarks[i][0].y - target[1]),
    )
    img = _arr(res.hand_landmarks[best])
    # map crop coords back to full-image normalised coords (z keeps the crop's relative scale)
    img[:, 0] = (img[:, 0] * size + x0) / w
    img[:, 1] = (img[:, 1] * size + y0) / h
    img[:, 2] = img[:, 2] * size / w
    return img, _arr(res.hand_world_landmarks[best])


def _hand_up(pose_img: np.ndarray, pose_vis: np.ndarray, side: int) -> bool:
    wrist = L_WRIST if side == 0 else R_WRIST
    hip_y = pose_img[[L_HIP, R_HIP], 1].mean()
    sh_y = pose_img[[L_SHOULDER, R_SHOULDER], 1].mean()
    return bool(pose_img[wrist, 1] < hip_y - 0.15 * (hip_y - sh_y) and pose_img[wrist, 1] < 0.98)


def extract(video: Path) -> tuple[str, int, int, int]:
    import mediapipe as mp

    cap = cv2.VideoCapture(str(video))
    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    width, height = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    frames = []
    while True:
        ok, bgr = cap.read()
        if not ok:
            break
        frames.append(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB))
    cap.release()
    t = len(frames)
    nan = np.float32("nan")
    pose_world = np.full((t, 33, 3), nan, np.float32)
    pose_image = np.full((t, 33, 3), nan, np.float32)
    pose_vis = np.zeros((t, 33), np.float32)
    hand_world = np.full((t, 2, 21, 3), nan, np.float32)
    hand_image = np.full((t, 2, 21, 3), nan, np.float32)
    hand_src = np.zeros((t, 2), np.uint8)
    face_bs = np.full((t, 52), nan, np.float32)

    # A fresh landmarker per video keeps VIDEO-mode tracking from leaking across files.
    global _holistic
    _holistic.close()
    _init_worker()

    for i, rgb in enumerate(frames):
        img = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
        r = _holistic.detect_for_video(img, int(i * 1000 / fps))
        if r.pose_landmarks:
            pose_image[i] = _arr(r.pose_landmarks)
            pose_vis[i] = _arr(r.pose_landmarks, dims=1)
        if r.pose_world_landmarks:
            pose_world[i] = _arr(r.pose_world_landmarks)
        for side, (im, wd) in enumerate(
            [(r.left_hand_landmarks, r.left_hand_world_landmarks), (r.right_hand_landmarks, r.right_hand_world_landmarks)]
        ):
            if im and wd:
                hand_image[i, side], hand_world[i, side], hand_src[i, side] = _arr(im), _arr(wd), 1
        if r.face_blendshapes:
            cats = r.face_blendshapes
            vals = [c.score for c in cats]
            if len(vals) == 52:
                face_bs[i] = vals
            elif len(vals) == 53:  # some builds include "_neutral" first
                face_bs[i] = vals[1:]

        # second pass for hands that are up but were missed
        if r.pose_landmarks:
            for side in (0, 1):
                if hand_src[i, side] == 0 and _hand_up(pose_image[i], pose_vis[i], side):
                    got = _crop_hand(rgb, pose_image[i], side, mp)
                    if got is not None:
                        hand_image[i, side], hand_world[i, side] = got
                        hand_src[i, side] = 2

    OUT.mkdir(parents=True, exist_ok=True)
    word = video.stem.split("_", 1)[1] if "_" in video.stem else video.stem
    np.savez_compressed(
        OUT / f"{word}.npz",
        pose_world=pose_world, pose_image=pose_image, pose_vis=pose_vis,
        hand_world=hand_world, hand_image=hand_image, hand_src=hand_src, face_bs=face_bs,
        fps=np.float32(fps), width=np.int32(width), height=np.int32(height),
    )
    return word, t, int((hand_src == 1).sum()), int((hand_src == 2).sum())


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="", help="comma-separated words to (re)extract")
    ap.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 4) - 2))
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()

    videos = sorted(VIDEOS.glob("*.mp4"))
    if args.only:
        wanted = set(args.only.split(","))
        videos = [v for v in videos if v.stem.split("_", 1)[-1] in wanted]
    if not args.force:
        videos = [v for v in videos if not (OUT / f"{v.stem.split('_', 1)[-1]}.npz").exists()]
    print(f"extracting {len(videos)} videos with {args.workers} workers", flush=True)
    t0 = time.time()
    with Pool(args.workers, initializer=_init_worker) as pool:
        for n, (word, t, holo, crop) in enumerate(pool.imap_unordered(extract, videos), 1):
            if n % 25 == 0 or n == len(videos) or args.only:
                print(f"  {n}/{len(videos)}  {word}: {t} frames, hands holistic={holo} crop={crop}  "
                      f"({time.time() - t0:.0f}s)", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
