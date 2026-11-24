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

# Cleaning a tracked hand (clean_track). Costs are in units where a palm turning TURN_DEG between frames costs 1.
MIRROR_PRIOR = 0.3  # taking a mirror image of the reading when nothing says which is right
TURN_DEG = 45.0
SHAPE_FREE = 0.12   # finger joints may move this far between frames for free (in palm lengths)...
SHAPE_STEP = 0.2    # ...and each further SHAPE_STEP costs 1
DROP_COST = 1.5     # leaving a frame out as a misreading
MAX_DROP = 3        # at most this many in a row
SHORT_GAP = 4       # gaps up to this long turn the palm straight across; longer ones follow the pose model's hand
END_TURN = 20.0     # before and after the tracked frames the palm follows the pose model's hand at most this fast (deg/frame)
# The hand's shape is smoothed with each frame trusted by how still the hand was: a fast hand is blurred in the video
# and its fingers are read badly (above a palm length a frame they wander about 8 times as far as a still hand's)
FAST = 0.3          # palm lengths a frame at which a frame's handshape counts half
SHAPE_LAMBDA = 1.0  # smoothing strength for a fully trusted frame (about a 5-frame window)
SHAPE_HOLD = 0.25   # the shape is held, not smoothed on towards the ends, beyond the first and last frames trusted this much
# A palm seen edge-on is often read squashed flat (its knuckles almost in line with the wrist): its width across the
# knuckles, against its length, is about 0.57 normally. Below FLAT_PALM its shape counts for less, down to nearly
# nothing at FLAT_PALM / 2.
FLAT_PALM = 0.35
# The tracker finding one hand twice: two finds this close (mean point gap, in palm sizes) are one hand; so are two
# whose wrists are within DUP_WRIST and points within DUP_NEAR, when one sits nearer the other arm's wrist than its own
DUP_SAME = 0.15
DUP_WRIST = 0.5
DUP_NEAR = 0.6
DUP_LOOK = 6        # frames either side to look for both hands seen apart, to tell which hand a copy is
# the four fingers' knuckle, middle and end joints, and every point but the wrist and knuckles (the palm's shape)
FINGERS = [(5, 6, 7), (9, 10, 11), (13, 14, 15), (17, 18, 19)]
SHAPE_POINTS = [1, 2, 3, 4, 6, 7, 8, 10, 11, 12, 14, 15, 16, 18, 19, 20]


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


def unit(v):
    return v / (np.linalg.norm(v, axis=-1, keepdims=True) + 1e-9)


def turn_deg(a, b):
    """Angle in degrees between two rotation matrices."""
    return float(np.degrees(np.arccos(np.clip((np.trace(a.T @ b) - 1) / 2, -1, 1))))


def palm_width(h: np.ndarray) -> np.ndarray:
    """(T,) how wide each tracked palm is across the knuckles (index to little finger, at right angles to the wrist to
    middle-knuckle line), in its own lengths; 1 where there is no hand."""
    f = h[:, 9] - h[:, 0]
    length = np.linalg.norm(f, axis=-1)
    f = f / np.maximum(length, 1e-9)[:, None]
    s = h[:, 5] - h[:, 17]
    s = s - (s * f).sum(axis=-1, keepdims=True) * f
    return np.nan_to_num(np.linalg.norm(s, axis=-1) / np.maximum(length, 1e-9), nan=1.0)


def whittaker(y: np.ndarray, w: np.ndarray, lam: float) -> np.ndarray:
    """Weighted Whittaker smoother along axis 0: stays near frames with high weight w and bends as little as it can
    (second differences, strength lam) through the rest, so frames with low weight follow their neighbours."""
    n = len(y)
    if n < 3:
        return y
    d2 = np.diff(np.eye(n), 2, axis=0)
    flat = y.reshape(n, -1)
    out = np.linalg.solve(np.diag(w) + lam * d2.T @ d2, w[:, None] * flat)
    return out.reshape(y.shape)


def hand_speed(d, side: int) -> np.ndarray:
    """How fast the hand moves across the picture in each frame, in its own palm lengths per frame."""
    w, h = float(d["width"]), float(d["height"])
    img = d["hand_image"][:, side, :, :2] * [w, h]
    centre = np.where(np.isfinite(img).all(axis=(1, 2))[:, None], img.mean(axis=1), d["pose_image"][:, 15 + side, :2] * [w, h])
    centre = fill_nan_linear(centre)
    palm = np.nanmedian(np.linalg.norm(img[:, 9] - img[:, 0], axis=1)) if np.isfinite(img).any() else np.nan
    if not np.isfinite(palm) or palm < 1:
        palm = 0.3 * np.nanmedian(np.linalg.norm((d["pose_image"][:, 11, :2] - d["pose_image"][:, 12, :2]) * [w, h], axis=1))
    speed = np.zeros(len(centre))
    if len(centre) > 2:
        speed[1:-1] = np.linalg.norm(centre[2:] - centre[:-2], axis=1) / 2
        speed[0], speed[-1] = speed[1], speed[-2]
    return speed / max(palm, 1.0)


# ---------------------------------------------------------------------------- per-hand processing

def handedness_cue(h, side: int) -> float:
    """How much one tracked hand looks like the signer's own hand of that side rather than its mirror image.

    The tracker sometimes returns a mirror image of the hand: a left hand for a right one (seen from behind with the
    fingers together, they look alike) or the fingers bent the wrong way. Real fingers bend towards the palm and the
    thumb sits in front of it, so this is positive when the reading has them there, negative when it has them behind
    (a mirror image), and near 0 for a flat hand with the thumb in the palm's plane. A mirror image's cue is -cue."""
    r = hand_frame(h)
    if r is None:
        return 0.0
    palm = r[:, 2] if side == 0 else -r[:, 2]  # the palm frame is right-handed for both hands
    bends = []
    for mcp, pip, dip in FINGERS:
        for a, b, c in ((0, mcp, pip), (mcp, pip, dip)):
            u = unit(h[b] - h[a])
            v = unit(h[c] - h[b])
            q = unit(palm - u * np.dot(palm, u))
            bends.append(np.arctan2(np.dot(v, q), np.dot(v, u)))
    curl = np.degrees(np.mean(bends))
    size = np.linalg.norm(h[9] - h[0]) + 1e-9
    return float(np.tanh(curl / 25) + np.tanh(np.dot(h[2] - h[0], palm) / size / 0.12)
                 + 0.5 * np.tanh(np.dot(h[3] - h[0], palm) / size / 0.15))


def mirror_hand(h, reading: int):
    """A hand reading (21,3) reflected through its own centre: 1 across its middle (thumb and little-finger sides
    swapped, so the palm turns half round about the middle finger), 2 across the palm (the fingers bend the other
    way, the palm stays put). In the palm's own coordinates both just turn the fingers' bend round."""
    r = hand_frame(h)
    m = r[:, 1] if reading == 1 else r[:, 2]
    c = h - h.mean(axis=0)
    return h - 2 * np.outer(c @ m, m)


# the palm's turn and the hand's shape (in palm coordinates) for each reading of a frame: as tracked, mirrored across
# the middle, mirrored across the palm
READING_TURN = [np.eye(3), np.diag([1.0, -1.0, -1.0]), np.eye(3)]
READING_SHAPE = [np.ones(3), np.array([1.0, 1.0, -1.0]), np.array([1.0, 1.0, -1.0])]


def clean_track(hw: np.ndarray, found: np.ndarray, side: int):
    """Decide for every frame where the tracker found the hand whether to keep its reading, take one of the reading's
    mirror images (mirror_hand), or leave the frame out as a misreading: whichever path looks most like a real hand
    while turning and changing shape least from frame to frame (dynamic programming over the frames).

    Returns reading (T,) int: -1 not used, 0 as tracked, 1 or 2 mirrored (see mirror_hand)."""
    t_len = len(hw)
    reading = np.full(t_len, -1)
    idx = np.flatnonzero(found)
    n = len(idx)
    if n == 0:
        return reading
    S = len(READING_TURN)
    rots = np.zeros((n, S, 3, 3))
    shapes = np.zeros((n, S, len(SHAPE_POINTS), 3))
    cue = np.zeros(n)
    for k, i in enumerate(idx):
        h = hw[i]
        r = hand_frame(h)
        local = (h - h.mean(axis=0)) @ r / (np.linalg.norm(h[9] - h[0]) + 1e-9)
        for st in range(S):
            rots[k, st] = r @ READING_TURN[st]
            shapes[k, st] = local[SHAPE_POINTS] * READING_SHAPE[st]
        cue[k] = handedness_cue(h, side)

    def unary(k, st):
        return 2 * max(0.0, -cue[k] if st == 0 else cue[k]) + (MIRROR_PRIOR if st else 0.0)

    def step(j, ps, k, st):
        gap = idx[k] - idx[j]
        turn = turn_deg(rots[j, ps], rots[k, st]) / (TURN_DEG * np.sqrt(gap))
        moved = np.mean(np.linalg.norm(shapes[j, ps] - shapes[k, st], axis=1))
        return turn + max(0.0, moved - SHAPE_FREE * gap) / SHAPE_STEP

    best = np.full((n, S), np.inf)
    prev = np.full((n, S, 2), -1, int)
    for k in range(n):
        for st in range(S):
            u = unary(k, st)
            if k <= MAX_DROP:  # the path may start here, leaving out the frames before
                best[k, st] = k * DROP_COST + u
            for j in range(max(0, k - MAX_DROP - 1), k):
                for ps in range(S):
                    c = best[j, ps] + (k - j - 1) * DROP_COST + step(j, ps, k, st) + u
                    if c < best[k, st]:
                        best[k, st] = c
                        prev[k, st] = (j, ps)
    ends = [(best[k, st] + (n - 1 - k) * DROP_COST, k, st) for k in range(max(0, n - 1 - MAX_DROP), n) for st in range(S)]
    _, k, st = min(ends)
    while k >= 0:
        reading[idx[k]] = st
        k, st = prev[k, st]
    return reading


def hands_found(d) -> np.ndarray:
    """(T,2): the frames where each hand was found, less two kinds of false find. The second, zoomed-in pass
    (extract.py) sometimes takes part of the face for a hand: a find far smaller than the hand the main tracker sees
    in the same video is dropped. And the main tracker sometimes gives one hand for both: when the two are on top of
    each other, or one is a copy of the other on the wrong side, only the side whose wrist the body model puts nearest
    keeps it."""
    w, h = float(d["width"]), float(d["height"])
    img = d["hand_image"][..., :2] * [w, h]  # (T,2,21,2) pixels
    src = d["hand_src"]
    found = (src > 0) & np.isfinite(d["hand_world"]).all(axis=(2, 3)) & np.isfinite(img).all(axis=(2, 3))
    size = np.maximum(np.linalg.norm(img[..., 9, :] - img[..., 0, :], axis=-1),
                      np.linalg.norm(img[..., 5, :] - img[..., 17, :], axis=-1))
    main = found & (src == 1)
    if main.any():
        found &= ~((src == 2) & (size < 0.5 * np.median(size[main])))
    both = found.all(axis=1)
    dup = {}
    for i in np.flatnonzero(both):
        a, b = img[i, 0], img[i, 1]
        palm = max(size[i, 0], size[i, 1], 1.0)
        gap = np.mean(np.linalg.norm(a - b, axis=1)) / palm
        if gap >= DUP_SAME and not (np.linalg.norm(a[0] - b[0]) < DUP_WRIST * palm and gap < DUP_NEAR):
            continue
        wrists = d["pose_image"][i, [15, 16], :2] * [w, h]
        own = [np.linalg.norm(wrists[s] - img[i, s, 0]) for s in (0, 1)]
        other = [np.linalg.norm(wrists[1 - s] - img[i, s, 0]) for s in (0, 1)]
        dup[i] = (gap < DUP_SAME, own, other)
    # Which hand a copy is, decided once for each run of such frames: the one that was there in the nearest frames
    # either side where both hands were seen apart; failing those, the one whose arm's wrist is nearer over the run.
    # (Frame by frame, the wrists alone would hand a still hand back and forth between the sides while the other
    # passes over it, since the body model then confuses the wrists too.)
    apart = np.flatnonzero(both & ~np.isin(np.arange(len(both)), list(dup)))
    centre = img.mean(axis=2)  # (T,2,2)
    runs = []
    for i in sorted(dup):
        if runs and i == runs[-1][-1] + 1:
            runs[-1].append(i)
        else:
            runs.append([i])
    for run in runs:
        near = 0.0  # > 0: the copy is the left hand
        for k, js in ((run[0], apart[(apart < run[0]) & (apart >= run[0] - DUP_LOOK)][-1:]),
                      (run[-1], apart[(apart > run[-1]) & (apart <= run[-1] + DUP_LOOK)][:1])):
            for j in js:
                shared = centre[k].mean(axis=0)
                near += (np.linalg.norm(centre[j, 1] - shared) - np.linalg.norm(centre[j, 0] - shared)) / max(
                    size[j].max(), 1.0)
        if abs(near) >= 0.5:
            drop = 1 if near > 0 else 0
        else:
            drop = 0 if sum(np.log((dup[i][1][0] + 1) / (dup[i][1][1] + 1)) for i in run) > 0 else 1
        for i in run:
            clear, own, other = dup[i]
            # a looser overlap only counts as a copy when the find sits nearer the other arm's wrist than its own,
            # so two real hands held together both stay
            if clear or other[drop] < own[drop]:
                found[i, drop] = False
    for s in (0, 1):
        for i in np.flatnonzero(found[:, s]):
            if hand_frame(d["hand_world"][i, s].astype(np.float64)) is None:
                found[i, s] = False
    return found


def process_hand(d, side: int, pose_world: np.ndarray, found: np.ndarray):
    """Returns (hand points (T,21,3) in MediaPipe axes, weight (T,), stats dict). found: hands_found(d)[:, side]."""
    t_len = len(pose_world)
    hw = d["hand_world"][:, side].astype(np.float64)
    hi = d["hand_image"][:, side]

    weight = np.zeros(t_len, np.float32)
    stats = {"detected": int(found.sum()), "active": 0, "maxGap": 0, "mirrored": 0, "dropped": 0}
    if found.sum() < 3:
        return np.zeros((t_len, 21, 3), np.float32), weight, stats

    idx = np.flatnonzero(found)
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

    # which readings to trust: the tracker's, a mirror image of it, or neither
    reading = clean_track(hw, found, side)
    for i in np.flatnonzero(reading > 0):
        hw[i] = mirror_hand(hw[i], reading[i])
    det = reading >= 0
    stats["mirrored"] = int((reading > 0).sum())
    stats["dropped"] = int((found & ~det).sum())
    det_idx = np.flatnonzero(det)

    # each trusted frame split into the palm's orientation and the hand's shape in palm coordinates; the shape is
    # smoothed trusting each frame by how still the hand was, which also fills the gaps, and held before and after
    centred = hw - hw.mean(axis=1, keepdims=True)
    frames = {i: hand_frame(hw[i]) for i in det_idx}
    local = np.zeros((t_len, 21, 3))
    for i in det_idx:
        local[i] = centred[i] @ frames[i]  # rows: point in palm coordinates
    trust = np.where(det, np.maximum(0.03, 1 / (1 + (hand_speed(d, side) / FAST) ** 2)), 0.0)
    trust *= np.clip(2 * palm_width(hw) / FLAT_PALM - 1, 0.05, 1.0)
    # where the first or last frames are barely trusted the smoother would carry the shape on in a straight line past
    # them, which can turn a flattened palm inside out; the shape is held from the first and last trusted frames
    held = np.flatnonzero(trust >= SHAPE_HOLD)
    a, b = (held[0], held[-1] + 1) if len(held) else (det_idx[0], det_idx[-1] + 1)
    local[a:b] = whittaker(local[a:b], trust[a:b], SHAPE_LAMBDA)
    local[:a] = local[a]
    local[b:] = local[b - 1]

    # the palm's orientation in every frame: across short gaps it turns straight from one side to the other; through
    # longer ones and before/after the tracked frames it follows the pose model's coarse hand (wrist, index and
    # little-finger knuckles), offset to agree with the tracked hand
    pose_r = [pose_hand_frame(pose_world[i], side) for i in range(t_len)]
    off_idx = [i for i in det_idx if pose_r[i] is not None]
    offsets = (Slerp(off_idx, Rotation.from_matrix(np.stack([pose_r[i].T @ frames[i] for i in off_idx])))
               if len(off_idx) > 1 else None)

    def guided(i):
        """The pose model's hand in frame i, offset to agree with the tracked hand; None if it has none."""
        if pose_r[i] is None or not off_idx:
            return None
        r_off = (offsets([np.clip(i, off_idx[0], off_idx[-1])])[0].as_matrix() if offsets is not None
                 else pose_r[off_idx[0]].T @ frames[off_idx[0]])
        return pose_r[i] @ r_off

    rot = np.zeros((t_len, 3, 3))
    for i in det_idx:
        rot[i] = frames[i]
    for p, q in zip(det_idx[:-1], det_idx[1:]):
        if q - p < 2:
            continue
        span = range(p + 1, q)
        path = [guided(i) for i in span] if q - p - 1 > SHORT_GAP else None
        if path is not None and all(r is not None for r in path):
            # the pose model's hand blurs and spins with a fast hand: taken only if it turns the way a hand can, no
            # faster than TURN_DEG a frame and not the long way round
            steps = [turn_deg(x, y) for x, y in zip([frames[p], *path], [*path, frames[q]])]
            if max(steps) > TURN_DEG or sum(steps) > turn_deg(frames[p], frames[q]) + 90:
                path = None
        else:
            path = None
        if path is None:
            path = Slerp([p, q], Rotation.from_matrix(np.stack([frames[p], frames[q]])))(list(span)).as_matrix()
        for i, r in zip(span, path):
            rot[i] = r
    # before and after: towards the pose model's hand, turning no faster than END_TURN a frame
    for ends, start in ((range(det_idx[0] - 1, -1, -1), det_idx[0]), (range(det_idx[-1] + 1, t_len), det_idx[-1])):
        cur = frames[start]
        for i in ends:
            g = guided(i)
            if g is not None:
                ang = turn_deg(cur, g)
                cur = (g if ang <= END_TURN else
                       Slerp([0, 1], Rotation.from_matrix(np.stack([cur, g])))([END_TURN / ang])[0].as_matrix())
            rot[i] = cur

    # smooth the orientation as a rotation (quaternions kept on one side, so they average) and the shape in palm
    # coordinates, then put the hand back together
    quat = Rotation.from_matrix(rot).as_quat()
    for i in range(1, t_len):
        if np.dot(quat[i], quat[i - 1]) < 0:
            quat[i] = -quat[i]
    quat = unit(smooth(quat, 7))
    rot = Rotation.from_quat(quat).as_matrix()
    out = np.einsum("tpj,tkj->tpk", local, rot)  # local @ rot.T, per frame
    return out.astype(np.float32), weight, stats


# ---------------------------------------------------------------------------- per-sign bake

def bake_sign(npz: Path):
    d = np.load(npz)
    pose_world = fill_nan_linear(d["pose_world"])
    t_len = len(pose_world)

    hands, weights, stats = [], [], []
    found = hands_found(d)
    for side in (0, 1):
        h, w, s = process_hand(d, side, pose_world, found[:, side])
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
    hand_count = {"detected": 0, "mirrored": 0, "dropped": 0}
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
        for s in stats:
            for k in hand_count:
                hand_count[k] += s[k]
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
    print(f"tracked hand frames {hand_count['detected']}: {hand_count['mirrored']} mirror images put right, "
          f"{hand_count['dropped']} misreadings left out")
    print(f"skipped {len(skipped)}: {skipped[:12]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
