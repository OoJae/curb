/**
 * The C band and the amber arc: the logo, as two enamel badges that dissolve along their angle in time order.
 *
 * Geometry is TorusGeometry's own parametrisation (same vertices and winding as
 * `new TorusGeometry(R, tube, radial, tubular, arc)`), flattened in z, rotated so the gap faces east, with flat
 * radial end caps so the ends read as the mark's straight cuts rather than an open tube. Everything is baked into
 * object space (mesh transform = identity), so the fragment shader can take the dial angle straight from `position`.
 */
import { BufferAttribute, BufferGeometry, Vector3 } from 'three';
import type { Material, WebGLProgramParametersWithUniforms } from 'three';
import { SLOTS } from './layout';

export interface ArcSpec {
  radius: number;
  tube: number;
  radialSegments: number;
  tubularSegments: number;
  startDeg: number; // CCW from +X
  arcDeg: number;
  flatten: number; // z scale
}

export function capsuleArc(s: ArcSpec): BufferGeometry {
  const { radius: R, tube: r, radialSegments: rs, tubularSegments: ts, flatten: f } = s;
  const u0 = (s.startDeg * Math.PI) / 180;
  const arc = (s.arcDeg * Math.PI) / 180;
  const pos: number[] = [];
  const nor: number[] = [];
  const idx: number[] = [];
  const p = new Vector3();
  const n = new Vector3();

  // Tube (TorusGeometry, flattened: normals follow the inverse-transpose of diag(1,1,f)).
  for (let j = 0; j <= rs; j++) {
    for (let i = 0; i <= ts; i++) {
      const u = u0 + (i / ts) * arc;
      const v = (j / rs) * Math.PI * 2;
      p.set((R + r * Math.cos(v)) * Math.cos(u), (R + r * Math.cos(v)) * Math.sin(u), r * Math.sin(v) * f);
      n.set(Math.cos(v) * Math.cos(u), Math.cos(v) * Math.sin(u), Math.sin(v) / f).normalize();
      pos.push(p.x, p.y, p.z);
      nor.push(n.x, n.y, n.z);
    }
  }
  for (let j = 1; j <= rs; j++) {
    for (let i = 1; i <= ts; i++) {
      const a = (ts + 1) * j + i - 1;
      const b = (ts + 1) * (j - 1) + i - 1;
      const c = (ts + 1) * (j - 1) + i;
      const d = (ts + 1) * j + i;
      idx.push(a, b, d, b, c, d);
    }
  }

  // Flat caps at both ends: a fan from the section centre, facing away from the arc.
  for (const end of [0, 1]) {
    const u = u0 + end * arc;
    const t = new Vector3(-Math.sin(u), Math.cos(u), 0); // tangent in the direction of increasing u
    const out = end ? t : t.clone().negate();
    const centre = pos.length / 3;
    pos.push(R * Math.cos(u), R * Math.sin(u), 0);
    nor.push(out.x, out.y, out.z);
    const ring0 = pos.length / 3;
    for (let j = 0; j < rs; j++) {
      const v = (j / rs) * Math.PI * 2;
      pos.push((R + r * Math.cos(v)) * Math.cos(u), (R + r * Math.cos(v)) * Math.sin(u), r * Math.sin(v) * f);
      nor.push(out.x, out.y, out.z);
    }
    for (let j = 0; j < rs; j++) {
      const a = centre;
      let b = ring0 + j;
      let c = ring0 + ((j + 1) % rs);
      // wind counter-clockwise as seen from `out`
      const pa = new Vector3(pos[a * 3], pos[a * 3 + 1], pos[a * 3 + 2]);
      const pb = new Vector3(pos[b * 3], pos[b * 3 + 1], pos[b * 3 + 2]).sub(pa);
      const pc = new Vector3(pos[c * 3], pos[c * 3 + 1], pos[c * 3 + 2]).sub(pa);
      if (pb.cross(pc).dot(out) < 0) [b, c] = [c, b];
      idx.push(a, b, c);
    }
  }

  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(nor), 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

/** Uniforms shared by every dissolving mesh; ring.ts owns the values. */
export interface SweepUniforms {
  uSweep: { value: number }; // slots passed, -edge..SLOTS+edge
  uNow: { value: number }; // nowIndex
  uEdge: { value: number }; // width of the crumbling front, in slots
}

/**
 * Patch a lit material so fragments whose slot has been swept are discarded, with a fine stochastic front
 * ("enamel flaking") uEdge slots wide. The slot of a fragment comes from its dial angle:
 *   angle = -(i - now) · 2π/2016  ⇒  i = now - angle · 2016/2π  (mod 2016)
 */
export function applyDissolve(material: Material, u: SweepUniforms): void {
  material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vDial;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvDial = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vDial;
uniform float uSweep;
uniform float uNow;
uniform float uEdge;
float curbHash(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}`,
      )
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
{
  float slot = mod(uNow - atan(vDial.y, vDial.x) * ${(SLOTS / (2 * Math.PI)).toFixed(6)}, ${SLOTS.toFixed(1)});
  float grain = curbHash(floor(vDial * 150.0));
  if (slot < uSweep - grain * uEdge) discard;
}`,
      );
  };
  material.customProgramCacheKey = () => 'curb-dissolve';
}
