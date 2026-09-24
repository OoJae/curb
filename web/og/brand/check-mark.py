#!/usr/bin/env python3
"""Overlay the rendered mark tile on script/asp/curb-avatar.png and measure the deviation.

    node web/og/brand/raster.mjs && python3 web/og/brand/check-mark.py

Deviation = symmetric Hausdorff distance between the 50 % coverage contours of each colour (ivory C, amber arc),
measured on an 8x bilinear upsample, in source pixels. Pass: <= 2 px. Writes web/public/brand/_check/mark-vs-avatar.png.
"""
import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy import ndimage

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.dirname(os.path.dirname(HERE))
ROOT = os.path.dirname(WEB)
SRC = os.path.join(ROOT, 'script', 'asp', 'curb-avatar.png')
RENDER = os.path.join(WEB, 'public', 'brand', 'avatar-512.png')
LITERAL = os.path.join(WEB, 'public', 'brand', '_check', 'spec-literal-512.png')
OUT = os.path.join(WEB, 'public', 'brand', '_check', 'mark-vs-avatar.png')

INK = np.array([15, 23, 32.])
IVORY = np.array([244, 239, 230.])
AMBER = np.array([245, 165, 36.])
UP = 8


def load(p):
    return np.array(Image.open(p).convert('RGB')).astype(float)


def coverage(a):
    """Per-pixel coverage of ivory and amber over ink (least squares on the two colour directions)."""
    M = np.stack([IVORY - INK, AMBER - INK], axis=1)  # 3x2
    with np.errstate(all="ignore"):  # numpy+Accelerate raises spurious matmul warnings
        x = (a - INK).reshape(-1, 3) @ np.linalg.pinv(M).T
    x = np.clip(x, 0, 1).reshape(a.shape[0], a.shape[1], 2)
    return x[..., 0], x[..., 1]


def contour(cov):
    up = ndimage.zoom(cov, UP, order=1) >= 0.5
    return up & ~ndimage.binary_erosion(up), up


def hausdorff(ca, cb):
    da = ndimage.distance_transform_edt(~ca)
    db = ndimage.distance_transform_edt(~cb)
    return max(da[cb].max(), db[ca].max()) / UP, np.percentile(np.r_[da[cb], db[ca]], 99) / UP


def measure(a, b):
    res = {}
    for name, ia, ib in zip(('ivory C', 'amber arc'), coverage(a), coverage(b)):
        (ca, _), (cb, _) = contour(ia), contour(ib)
        h, p99 = hausdorff(ca, cb)
        res[name] = (h, p99, float(np.abs(ia - ib).mean() * 100))
    return res


src, ren = load(SRC), load(RENDER)
r_ren = measure(src, ren)
have_lit = os.path.exists(LITERAL)
if have_lit:
    lit = load(LITERAL)
    r_lit = measure(src, lit)

# ── composite ────────────────────────────────────────────────────────────────────────────────────────────────────────
def heat(a, b):
    d = np.abs(a - b).sum(axis=2)
    d = np.clip(d / 3 * 4, 0, 255)  # 4x amplified
    img = np.zeros_like(a)
    img[..., 0] = d
    img[..., 1] = d * 0.2
    img[..., 2] = d
    return Image.fromarray(img.astype(np.uint8))


def overlay_zoom(a, b, box, z=4):
    """Source underneath; render's ivory/amber 50 % contours drawn on top, zoomed z x."""
    x0, y0, x1, y1 = box
    crop = Image.fromarray(a[y0:y1, x0:x1].astype(np.uint8)).resize(((x1 - x0) * z, (y1 - y0) * z), Image.NEAREST)
    arr = np.array(crop).astype(float)
    iv, am = coverage(b[y0:y1, x0:x1])
    for cov, col in ((iv, (0, 200, 255)), (am, (255, 0, 200))):
        up = ndimage.zoom(cov, z, order=1) >= 0.5
        edge = up & ~ndimage.binary_erosion(up)
        arr[edge] = col
    return Image.fromarray(arr.astype(np.uint8))


W = 512
panels = [Image.fromarray(src.astype(np.uint8)), Image.fromarray(ren.astype(np.uint8)), heat(src, ren)]
labels = ['script/asp/curb-avatar.png', 'brand/mark-tile.svg rendered', '|difference| x4']
if have_lit:
    panels.append(heat(src, lit))
    labels.append('spec §1 literal (250°, arc r1.09) x4')
zooms = [overlay_zoom(src, ren, (295, 88, 423, 216)), overlay_zoom(src, ren, (295, 296, 423, 424))]
zlabels = ['C end + arc end, top: avatar with render contours (4x)', 'bottom (4x)']

cols = len(panels)
sheet = Image.new('RGB', (cols * (W + 16) + 16, 16 + 24 + W + 24 + 16 + 24 + 512 + 16 + 150), (15, 23, 32))
d = ImageDraw.Draw(sheet)
try:
    font = ImageFont.truetype('/System/Library/Fonts/Menlo.ttc', 15)
except Exception:
    font = ImageFont.load_default()
for i, (p, lab) in enumerate(zip(panels, labels)):
    x = 16 + i * (W + 16)
    d.text((x, 16), lab, fill=(244, 239, 230), font=font)
    sheet.paste(p, (x, 40))
y = 40 + W + 24
for i, (z, lab) in enumerate(zip(zooms, zlabels)):
    x = 16 + i * (512 + 16)
    d.text((x, y), lab, fill=(244, 239, 230), font=font)
    sheet.paste(z, (x, y + 24))

lines = []
ok = True
for name, (h, p99, mad) in r_ren.items():
    ok &= h <= 2.0
    lines.append(f'mark-tile.svg vs avatar  {name:9s}  max deviation {h:4.2f} px  p99 {p99:4.2f} px  mean |coverage diff| {mad:4.2f}%')
if have_lit:
    for name, (h, p99, mad) in r_lit.items():
        lines.append(f'spec literal vs avatar   {name:9s}  max deviation {h:5.2f} px  p99 {p99:5.2f} px')
lines.append(('PASS' if ok else 'FAIL') + ': mark within 2 px of the avatar' + ('' if ok else ' -- NOT'))
tx = 16 + 2 * (512 + 16)
for i, line in enumerate(lines):
    d.text((tx, y + 24 + i * 24), line, fill=(245, 165, 36) if i == len(lines) - 1 else (244, 239, 230), font=font)

os.makedirs(os.path.dirname(OUT), exist_ok=True)
sheet.save(OUT, optimize=True)
print('\n'.join(lines))
print('wrote', os.path.relpath(OUT, WEB))
sys.exit(0 if ok else 1)
