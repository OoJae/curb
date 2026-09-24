#!/usr/bin/env python3
"""Sub-pixel measurement of the avatar's mark (script/asp/curb-avatar.png): 50 % coverage crossings along rays, joint
circle fits. The numbers it prints are the MARK constants in geometry.mjs.   python3 web/og/brand/measure-avatar.py"""
import os
import numpy as np
from PIL import Image
from scipy import ndimage, optimize

SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..', 'script', 'asp', 'curb-avatar.png')
a = np.array(Image.open(SRC).convert('RGB')).astype(float)
INK = np.array([15, 23, 32.]); IV = np.array([244, 239, 230.]); AM = np.array([245, 165, 36.])
M = np.stack([IV - INK, AM - INK], axis=1)
with np.errstate(all='ignore'):
    cov = np.clip((a - INK).reshape(-1, 3) @ np.linalg.pinv(M).T, 0, 1).reshape(512, 512, 2)
iv, am = cov[..., 0], cov[..., 1]


def sample(img, x, y):
    # pixel centres at i + 0.5
    return ndimage.map_coordinates(img, [np.atleast_1d(y) - 0.5, np.atleast_1d(x) - 0.5], order=1, mode='nearest')


def crossings(img, cx, cy, deg, r0, r1, step=0.02):
    t = np.radians(deg)
    rs = np.arange(r0, r1, step)
    v = sample(img, cx + rs * np.cos(t), cy - rs * np.sin(t))
    out = []
    for i in range(len(v) - 1):
        if (v[i] - 0.5) * (v[i + 1] - 0.5) < 0:
            out.append(rs[i] + step * (0.5 - v[i]) / (v[i + 1] - v[i]))
    return out


# 1. C edges along rays through the C (away from the ends): inner and outer crossings
cx, cy = 256.19, 256.13
for _ in range(3):
    pts_in, pts_out = [], []
    for deg in np.arange(70, 290, 1.0):
        c = crossings(iv, cx, cy, deg, 90, 200)
        if len(c) == 2:
            t = np.radians(deg)
            pts_in.append((cx + c[0] * np.cos(t), cy - c[0] * np.sin(t)))
            pts_out.append((cx + c[1] * np.cos(t), cy - c[1] * np.sin(t)))
    pi, po = np.array(pts_in), np.array(pts_out)

    def res(p):
        x, y, ri, ro = p
        return np.r_[np.hypot(pi[:, 0] - x, pi[:, 1] - y) - ri, np.hypot(po[:, 0] - x, po[:, 1] - y) - ro]

    p = optimize.least_squares(res, [cx, cy, 113, 175]).x
    cx, cy, ri, ro = p
rr = res(p)
R = (ri + ro) / 2
print(f'C centre ({cx:.3f}, {cy:.3f})  inner {ri:.3f}  outer {ro:.3f}  centreline R {R:.3f}  stroke {ro-ri:.3f} = {(ro-ri)/R:.4f} R  rms {np.sqrt((rr**2).mean()):.3f}px')

# 2. C end angles: walk along arcs at several radii, find the 50 % crossing in angle
def angle_crossings(img, r, a0, a1, step=0.002):
    angs = np.arange(a0, a1, step)
    t = np.radians(angs)
    v = sample(img, cx + r * np.cos(t), cy - r * np.sin(t))
    out = []
    for i in range(len(v) - 1):
        if (v[i] - 0.5) * (v[i + 1] - 0.5) < 0:
            out.append(angs[i] + step * (0.5 - v[i]) / (v[i + 1] - v[i]))
    return out

ends = []
for r in np.linspace(ri + 4, ro - 4, 9):
    top = angle_crossings(iv, r, 40, 90)
    bot = angle_crossings(iv, r, -90, -40)
    ends.append((r, top[0] if top else np.nan, bot[-1] if bot else np.nan))
ends = np.array(ends)
print('C end angle by radius (top, bottom):')
for r, t, b in ends:
    print(f'   r {r:6.1f}  +{t:.3f}  {b:.3f}')
print(f'C half-gap mean {np.nanmean(np.r_[ends[:,1], -ends[:,2]]):.3f} deg (spread {np.nanstd(np.r_[ends[:,1], -ends[:,2]]):.3f})')

# 3. Amber: radial crossings along rays, fit concentric radii (same centre as the C) and a free centre
ai, ao, pts = [], [], []
for deg in np.arange(-40, 40.5, 0.5):
    c = crossings(am, cx, cy, deg, 100, 200)
    if len(c) == 2:
        ai.append(c[0]); ao.append(c[1])
        t = np.radians(deg)
        pts.append((cx + c[0] * np.cos(t), cy - c[0] * np.sin(t), cx + c[1] * np.cos(t), cy - c[1] * np.sin(t)))
ai, ao = np.array(ai), np.array(ao)
print(f'amber about the C centre: inner {ai.mean():.3f} (sd {ai.std():.3f})  outer {ao.mean():.3f} (sd {ao.std():.3f})  '
      f'mid {(ai.mean()+ao.mean())/2:.3f} = {(ai.mean()+ao.mean())/2/R:.4f} R  thickness {ao.mean()-ai.mean():.3f} = {(ao.mean()-ai.mean())/R:.4f} R')
P = np.array(pts)

def res2(p):
    x, y, r1, r2 = p
    return np.r_[np.hypot(P[:, 0] - x, P[:, 1] - y) - r1, np.hypot(P[:, 2] - x, P[:, 3] - y) - r2]

q = optimize.least_squares(res2, [cx, cy, ai.mean(), ao.mean()]).x
print(f'amber free-centre fit: centre ({q[0]:.3f}, {q[1]:.3f}) inner {q[2]:.3f} outer {q[3]:.3f} (offset from C centre {np.hypot(q[0]-cx, q[1]-cy):.3f} px)')

aends = []
for r in np.linspace(ai.mean() + 3, ao.mean() - 3, 7):
    top = angle_crossings(am, r, 20, 70)
    bot = angle_crossings(am, r, -70, -20)
    aends.append((r, top[-1] if top else np.nan, bot[0] if bot else np.nan))
aends = np.array(aends)
for r, t, b in aends:
    print(f'   amber r {r:6.1f}  +{t:.3f}  {b:.3f}')
print(f'amber half-span mean {np.nanmean(np.r_[aends[:,1], -aends[:,2]]):.3f} deg')
