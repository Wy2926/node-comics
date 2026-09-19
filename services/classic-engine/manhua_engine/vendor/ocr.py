"""Adapted from yakuyomi-engine parity/ocr_parity.py @ bbe5740; GPL-3.0."""
import numpy as np
BLANK=0

def sort_pnts(pts):
    pts = np.array(pts, dtype=np.float64)
    pv = (pts[:, None] - pts[None]).reshape((16, -1))
    lsv = pv[np.argsort(np.linalg.norm(pv, axis=1))[[8, 10]]]
    if (lsv[0] * lsv[1]).sum() < 0:
        lsv[0] = -lsv[0]
    struc = np.abs(lsv.mean(axis=0))
    is_v = struc[0] <= struc[1]
    if is_v:
        pts = pts[np.argsort(pts[:, 1])]
        pts = pts[[*np.argsort(pts[:2, 0]), *(np.argsort(pts[2:, 0])[::-1] + 2)]]
        return pts, True
    pts = pts[np.argsort(pts[:, 0])]
    out = np.zeros_like(pts)
    out[[0, 3]] = sorted(pts[[0, 1]], key=lambda p: p[1])
    out[[1, 2]] = sorted(pts[[2, 3]], key=lambda p: p[1])
    return out, False

def ctc_decode(logits, dictionary, colors=None):
    """greedy CTC（blank=0、收合重複+去blank）。
    傳入 colors（[T,6]＝fg_rgb+bg_rgb，未 clamp）則回傳 (text, prob, fg, bg)；
    色＝保留的非空白 char 對應 timestep 取色、clip 0..1、整行平均 ×255（對齊 model_48px_ctc.decode_ctc_top1）。"""
    # Argmax is invariant under log-softmax. Normalize only emitted CTC frames:
    # blank/repeated frames contribute neither confidence nor color statistics.
    idx = logits.argmax(1)
    emitted = (idx != BLANK) & np.r_[True, idx[1:] != idx[:-1]]
    selected = logits[emitted]
    lp = selected - selected.max(1, keepdims=True)
    lp = lp - np.log(np.exp(lp).sum(1, keepdims=True))
    chars, probs = [], []
    fgs, bgs = [], []
    for row,t in enumerate(np.flatnonzero(emitted)):
        c = int(idx[t])
        ch = dictionary[c]
        sp = ch == '<SP>'
        chars.append(' ' if sp else ch)
        probs.append(lp[row, c])
        if colors is not None and not sp:
            cv = np.clip(colors[t], 0.0, 1.0)
            fgs.append(cv[:3]); bgs.append(cv[3:6])
    text = ''.join(chars)
    prob = float(np.exp(np.mean(probs))) if probs else 0.0
    if colors is None:
        return text, prob
    fg = tuple(int(round(v * 255)) for v in (np.mean(fgs, axis=0) if fgs else (0.0, 0.0, 0.0)))
    bg = tuple(int(round(v * 255)) for v in (np.mean(bgs, axis=0) if bgs else (1.0, 1.0, 1.0)))
    return text, prob, fg, bg
