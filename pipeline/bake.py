"""Turn extracted landmarks into compact, clean sign clips for the app.

For every sign:
  1. Convert MediaPipe axes to the app's (three.js) axes: (x, -y, -z).
  2. Decide when each hand is actually signing (detected, plus a short ramp in/out).
     Pose estimates for hands outside the frame are hallucinated, so arms with no
     detected hand are left to the app's idle pose (weight 0).
  3. Fill hand-tracking gaps: keep the hand shape from the nearest detections and
     orient it with the pose model's coarse hand points.
  4. Smooth (Savitzky-Golay), trim rest frames, quantise and write a binary clip.

Writes public/signs/index.json and public/signs/clips/<file>.bin

Binary clip format (little-endian):
  'SSG1' | u16 frames | u8 points | u8 faceChannels
  per frame: i16[points*3] (metres * 10000) | u8 leftHandWeight | u8 rightHandWeight | u8[2] reserved
             | u8[faceChannels] (0..255)
Points: 13 body points (BODY below) + 21 left-hand + 21 right-hand points (hand-centred).

Usage:  pipeline/.venv/bin/python pipeline/bake.py
"""

from __future__ import annotations

import json
import re
import struct
import sys
from pathlib import Path

import numpy as np
from scipy.signal import savgol_filter
from scipy.spatial.transform import Rotation, Slerp

ROOT = Path(__file__).resolve().parent
CACHE = ROOT / ".cache"
LANDMARKS = CACHE / "landmarks"
OUT = ROOT.parent / "public" / "signs"
FPS = 25

# pose ids kept for the body: nose, eyes, ears, shoulders, elbows, wrists, hips
BODY = [0, 2, 5, 7, 8, 11, 12, 13, 14, 15, 16, 23, 24]
BODY_NAMES = ["nose", "lEye", "rEye", "lEar", "rEar", "lShoulder", "rShoulder",
              "lElbow", "rElbow", "lWrist", "rWrist", "lHip", "rHip"]
# pose ids for the coarse palm of each side: wrist, pinky knuckle, index knuckle
POSE_HAND = {0: (15, 17, 19), 1: (16, 18, 20)}

MP_BLENDSHAPES = [
    "_neutral", "browDownLeft", "browDownRight", "browInnerUp", "browOuterUpLeft", "browOuterUpRight",
    "cheekPuff", "cheekSquintLeft", "cheekSquintRight", "eyeBlinkLeft", "eyeBlinkRight",
    "eyeLookDownLeft", "eyeLookDownRight", "eyeLookInLeft", "eyeLookInRight", "eyeLookOutLeft",
    "eyeLookOutRight", "eyeLookUpLeft", "eyeLookUpRight", "eyeSquintLeft", "eyeSquintRight",
    "eyeWideLeft", "eyeWideRight", "jawForward", "jawLeft", "jawOpen", "jawRight", "mouthClose",
    "mouthDimpleLeft", "mouthDimpleRight", "mouthFrownLeft", "mouthFrownRight", "mouthFunnel",
    "mouthLeft", "mouthLowerDownLeft", "mouthLowerDownRight", "mouthPressLeft", "mouthPressRight",
    "mouthPucker", "mouthRight", "mouthRollLower", "mouthRollUpper", "mouthShrugLower",
    "mouthShrugUpper", "mouthSmileLeft", "mouthSmileRight", "mouthStretchLeft", "mouthStretchRight",
    "mouthUpperLeft", "mouthUpperRight", "noseSneerLeft", "noseSneerRight",
]
FACE = ["browDownLeft", "browDownRight", "browInnerUp", "browOuterUpLeft", "browOuterUpRight",
        "eyeBlinkLeft", "eyeBlinkRight", "eyeWideLeft", "eyeWideRight", "eyeSquintLeft",
        "eyeSquintRight", "jawOpen", "mouthFunnel", "mouthPucker", "mouthSmileLeft",
        "mouthSmileRight", "mouthFrownLeft", "mouthFrownRight", "mouthPressLeft", "mouthPressRight"]
FACE_IDX = [MP_BLENDSHAPES.index(n) for n in FACE]

RAMP = 6          # frames of arm blend before the first / after the last detected hand
MAX_FILL = 18     # interior gaps up to this long are filled; longer ones only if the hand stays in frame
AXES = np.array([1.0, -1.0, -1.0], np.float32)  # MediaPipe -> app axes


# ---------------------------------------------------------------------------- helpers

def palm_frame(wrist, middle_or_mid, index, pinky):
    """Rotation matrix (columns f, s, n) of a palm from 4 points; None if degenerate."""
    f = middle_or_mid - wrist
    s = index - pinky
    nf = np.linalg.norm(f)
    if nf < 1e-6:
        return None
    f = f / nf
    s = s - f * np.dot(f, s)
    ns = np.linalg.norm(s)
    if ns < 1e-6:
        return None
    s = s / ns
    return np.stack([f, s, np.cross(f, s)], axis=1)


def hand_frame(h):  # h: (21,3)
    return palm_frame(h[0], h[9], h[5], h[17])


def pose_hand_frame(p, side):  # p: (33,3)
    w, pk, ix = POSE_HAND[side]
    return palm_frame(p[w], (p[ix] + p[pk]) / 2, p[ix], p[pk])


def fill_nan_linear(x: np.ndarray) -> np.ndarray:
    """Linear-interpolate NaNs along axis 0 (holds ends)."""
    x = x.copy()
    flat = x.reshape(len(x), -1)
    t = np.arange(len(x))
    for c in range(flat.shape[1]):
        col = flat[:, c]
        ok = np.isfinite(col)
        if ok.all():
            continue
        if not ok.any():
            col[:] = 0
            continue
        col[~ok] = np.interp(t[~ok], t[ok], col[ok])
    return flat.reshape(x.shape)


def smooth(x: np.ndarray, window: int) -> np.ndarray:
    if len(x) < window + 2:
        return x
    return savgol_filter(x, window, 2, axis=0, mode="interp")


# ---------------------------------------------------------------------------- per-hand processing

def process_hand(d, side: int, pose_world: np.ndarray):
    """Returns (hand points (T,21,3) in MediaPipe axes, weight (T,), stats dict)."""
    t_len = len(pose_world)
    hw = d["hand_world"][:, side]
    hi = d["hand_image"][:, side]
    det = (d["hand_src"][:, side] > 0) & np.isfinite(hw).all(axis=(1, 2))

    # drop isolated orientation spikes (a single frame flipped > 70 deg from both neighbours)
    frames = [hand_frame(hw[i]) if det[i] else None for i in range(t_len)]
    for i in range(1, t_len - 1):
        if det[i] and det[i - 1] and det[i + 1] and frames[i] is not None:
            a = Rotation.from_matrix(frames[i - 1]).inv() * Rotation.from_matrix(frames[i])
            b = Rotation.from_matrix(frames[i + 1]).inv() * Rotation.from_matrix(frames[i])
            if a.magnitude() > np.radians(70) and b.magnitude() > np.radians(70):
                det[i] = False
                frames[i] = None
    det &= np.array([f is not None for f in frames])

    weight = np.zeros(t_len, np.float32)
    stats = {"detected": int(det.sum()), "active": 0, "maxGap": 0}
    if det.sum() < 3:
        return np.zeros((t_len, 21, 3), np.float32), weight, stats

    idx = np.flatnonzero(det)
    first, last = idx[0], idx[-1]
    active = np.zeros(t_len, bool)
    active[first:last + 1] = True
    # long interior gaps where the hand left the frame are not "active"
    for a, b in zip(idx[:-1], idx[1:]):
        gap = b - a - 1
        if gap > MAX_FILL:
            wrist_y = hi[a:b, 0, 1]
            pose_y = d["pose_image"][a + 1:b, 15 + side, 1]
            if np.nanmedian(pose_y) > 0.9:  # hand dropped out of the frame
                active[a + 1:b] = False
        if active[a + 1:b].all():
            stats["maxGap"] = max(stats["maxGap"], int(gap))
    stats["active"] = int(active.sum())

    # weights: 1 inside active spans, linear ramps of RAMP frames around each span
    weight[active] = 1.0
    edges = np.flatnonzero(np.diff(active.astype(np.int8)))
    for e in edges:
        if active[e + 1]:  # rising edge at e+1
            for k in range(1, RAMP + 1):
                if e + 1 - k >= 0:
                    weight[e + 1 - k] = max(weight[e + 1 - k], 1 - k / (RAMP + 1))
        else:  # falling edge after e
            for k in range(1, RAMP + 1):
                if e + k < t_len:
                    weight[e + k] = max(weight[e + k], 1 - k / (RAMP + 1))

    # palm-local shapes and pose->hand offsets at detected frames
    centred = hw - np.nanmean(hw, axis=1, keepdims=True)
    local = np.full((t_len, 21, 3), np.nan, np.float32)
    offsets = [None] * t_len
    for i in idx:
        r_hand = frames[i]
        local[i] = centred[i] @ r_hand  # rows: point in palm coordinates
        r_pose = pose_hand_frame(pose_world[i], side)
        if r_pose is not None:
            offsets[i] = Rotation.from_matrix(r_pose.T @ r_hand)

    local = fill_nan_linear(local)  # interpolate shapes across gaps, hold at the ends
    off_idx = [i for i in range(t_len) if offsets[i] is not None]
    out = centred.copy()
    if off_idx:
        if len(off_idx) == 1:
            off_all = [offsets[off_idx[0]]] * t_len
        else:
            slerp = Slerp(off_idx, Rotation.concatenate([offsets[i] for i in off_idx]))
            tt = np.clip(np.arange(t_len), off_idx[0], off_idx[-1])
            off_all = slerp(tt)
        for i in range(t_len):
            if det[i]:
                continue
            r_pose = pose_hand_frame(pose_world[i], side)
            if r_pose is None:
                out[i] = np.nan
                continue
            r_off = off_all[i] if isinstance(off_all, list) else off_all[i]
            r_hand = r_pose @ r_off.as_matrix()
            out[i] = local[i] @ r_hand.T
    else:
        out[~det] = np.nan
    out = fill_nan_linear(out)
    out = smooth(out, 5)
    return out.astype(np.float32), weight, stats


# ---------------------------------------------------------------------------- per-sign bake

def bake_sign(npz: Path):
    d = np.load(npz)
    pose_world = fill_nan_linear(d["pose_world"])
    t_len = len(pose_world)

    hands, weights, stats = [], [], []
    for side in (0, 1):
        h, w, s = process_hand(d, side, pose_world)
        hands.append(h)
        weights.append(w)
        stats.append(s)
    w_any = np.maximum(weights[0], weights[1])
    if w_any.max() < 0.99:
        return None, stats

    on = np.flatnonzero(w_any > 0.05)
    a, b = max(0, on[0] - 1), min(t_len, on[-1] + 2)

    body = smooth(pose_world[:, BODY], 7)
    # head points are noisier; smooth harder
    body[:, :5] = smooth(pose_world[:, BODY[:5]], 9)
    face = fill_nan_linear(d["face_bs"])[:, FACE_IDX]
    face = np.clip(smooth(face, 5), 0, 1)

    pts = np.concatenate([body, hands[0], hands[1]], axis=1)[a:b]
    # Some signers stand turned towards the camera at an angle; rotate every clip about the
    # vertical axis so the shoulders face the viewer (median shoulder-line yaw over the clip).
    sh = pts[:, 5] - pts[:, 6]  # left shoulder - right shoulder (MediaPipe axes)
    yaw = float(np.median(np.arctan2(sh[:, 2], sh[:, 0])))
    c, s = np.cos(yaw), np.sin(yaw)
    x, z = pts[..., 0].copy(), pts[..., 2].copy()
    pts[..., 0] = x * c + z * s
    pts[..., 2] = -x * s + z * c
    pts = pts * AXES
    weights = [w[a:b] for w in weights]
    face = face[a:b]
    stats.append({"start": int(a)})
    return (pts, weights, face), stats


def write_clip(path: Path, pts: np.ndarray, weights, face: np.ndarray) -> int:
    n, p, _ = pts.shape
    q = np.clip(np.round(pts * 10000), -32767, 32767).astype("<i2")
    w = np.stack([np.round(weights[0] * 255), np.round(weights[1] * 255),
                  np.zeros(n), np.zeros(n)], axis=1).astype(np.uint8)
    f = np.round(face * 255).astype(np.uint8)
    with open(path, "wb") as fh:
        fh.write(b"SSG1" + struct.pack("<HBB", n, p, f.shape[1]))
        for i in range(n):
            fh.write(q[i].tobytes())
            fh.write(w[i].tobytes())
            fh.write(f[i].tobytes())
    return path.stat().st_size


# ---------------------------------------------------------------------------- vocabulary

def file_id(label_word: str) -> str:
    return re.sub(r"[^a-z0-9-]+", "_", label_word.lower()).strip("_")


def classify(word: str, en: list[str]) -> str:
    if "single-handed-letter" in word or "double-handed-letter" in word:
        return "letter-en"
    if re.fullmatch(r"\d+", word):
        return "number"
    if en == [] or (len(en) <= 2 and all(len(t) == 1 and not t.isascii() for t in en)):
        return "letter-ur"
    return "word"


def main() -> int:
    mapping = json.load(open(CACHE / "pk-dictionary-mapping.json", encoding="utf-8"))
    dictionary, phrases_src = mapping[0]["mapping"], mapping[1]["mapping"] if len(mapping) > 1 else []
    (OUT / "clips").mkdir(parents=True, exist_ok=True)
    for old in (OUT / "clips").glob("*.bin"):
        old.unlink()

    signs, skipped, total_bytes = [], [], 0
    quality_count = {"good": 0, "fair": 0, "poor": 0}
    for entry in dictionary:
        label = entry["label"]
        word = label.split("_", 1)[1]
        npz = LANDMARKS / f"{word}.npz"
        if not npz.exists():
            skipped.append((word, "no video"))
            continue
        baked, stats = bake_sign(npz)
        if baked is None:
            skipped.append((word, "no hands detected"))
            continue
        pts, weights, face = baked
        fid = file_id(word)
        total_bytes += write_clip(OUT / "clips" / f"{fid}.bin", pts, weights, face)
        start = stats.pop()["start"]
        cov = [s["detected"] / s["active"] for s in stats if s["active"] > 0]
        worst = min(cov) if cov else 0
        quality = "good" if worst >= 0.8 else "fair" if worst >= 0.55 else "poor"
        quality_count[quality] += 1
        tok = entry["token"]
        en, ur = tok.get("en", []), tok.get("ur", [])
        signs.append({
            "id": fid, "label": word, "en": en, "ur": ur, "kind": classify(word, en),
            "frames": int(len(pts)), "start": start,
            "hands": "".join("LR"[i] for i in (0, 1) if weights[i].max() > 0.5),
            "quality": quality,
        })

    by_label = {s["label"]: s["id"] for s in signs}
    phrases = []
    for entry in phrases_src:
        parts = [p.split("_", 1)[1] for p in entry.get("components", [])]
        if parts and all(p in by_label for p in parts):
            phrases.append({"en": entry["token"].get("en", []), "ur": entry["token"].get("ur", []),
                            "seq": [by_label[p] for p in parts]})

    index = {
        "version": 1,
        "fps": FPS,
        "points": {"body": BODY_NAMES, "hand": 21},
        "face": FACE,
        "source": {
            "name": "Pakistan Sign Language dictionary (pk-hfad-1)",
            "recordedAt": "Hamza Foundation Academy for the Deaf, Lahore",
            "via": "sign-language-translator project",
            "url": "https://github.com/sign-language-translator/sign-language-datasets",
            "license": "CC BY 4.0",
            "changes": "Motion re-extracted from the videos with MediaPipe, cleaned and retargeted to a 3D avatar.",
        },
        "signs": signs,
        "phrases": phrases,
    }
    with open(OUT / "index.json", "w", encoding="utf-8") as fh:
        json.dump(index, fh, ensure_ascii=False, separators=(",", ":"))

    print(f"baked {len(signs)} signs ({total_bytes / 1e6:.1f} MB), {len(phrases)} phrases; quality {quality_count}")
    print(f"skipped {len(skipped)}: {skipped[:12]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
