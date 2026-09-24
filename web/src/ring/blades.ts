/**
 * 2,016 enamel blades, one per five-minute slot of the Hong Kong week, as a single InstancedMesh (one draw call).
 * Ivory = primary market open; Streetlamp = shut but still trading; past slots at 70% value.
 *
 * Blade i sits at R = 1 on angle -(i - now)·2π/2016 with its long axis radial. In the vertex shader, gl_InstanceID
 * is the slot index, so the rise (time order from Mon 00:00 HKT) and the caption focus cost no per-frame uploads.
 */
import {
  BoxGeometry,
  Color,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshPhysicalMaterial,
  Quaternion,
  Vector3,
} from 'three';
import type { WebGLProgramParametersWithUniforms } from 'three';
import { MARK, PAST_VALUE, SLOTS, slotAngle } from './layout';
import type { Palette } from './layout';

export interface BladeUniforms {
  uSweep: { value: number };
  uRise: { value: number }; // slots over which one blade grows to full size
  uFocus: { value: [number, number, number] }; // start, length (wrapping), mode: 0 none · 1 range · 2 every shut slot
  uFocusAmt: { value: number }; // 0..1, how far the unfocused blades recede
  uPitchPx: { value: number }; // device pixels per blade pitch at the ring's distance (anti-moiré LOD)
}

/** Blade pitch at R = 1 (world units); the spec's 0.0026 width leaves a 0.0005 hairline between blades. */
const PITCH = (2 * Math.PI * MARK.bladeRadius) / SLOTS;

export function createBlades(u: BladeUniforms): InstancedMesh {
  const [w, h, d] = MARK.blade;
  const geo = new BoxGeometry(w, h, d);
  // Satin, not gloss: with near-flat normals a glossy dial mirrors RoomEnvironment's ceiling panel straight back
  // at the tilted camera and bleaches half the week. Colour must read true (the clearcoat lives on the C band).
  const mat = new MeshPhysicalMaterial({ roughness: 0.62, specularIntensity: 0.12 });
  mat.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uSweep;
uniform float uRise;
uniform vec3 uFocus;
uniform float uFocusAmt;
uniform float uPitchPx;
attribute float aShut;
varying float vRecede;`,
      )
      .replace(
        '#include <beginnormal_vertex>',
        // Enamel inlay: faces shade (almost) as one surface, so sub-pixel side walls don't beat against the tops.
        '#include <beginnormal_vertex>\nobjectNormal = normalize(mix(objectNormal, vec3(0.0, 0.0, 1.0), 0.55));',
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
{
  float slot = float(gl_InstanceID);
  float rise = clamp((uSweep - slot) / uRise, 0.0, 1.0);
  rise = 1.0 - (1.0 - rise) * (1.0 - rise) * (1.0 - rise);
  transformed.y *= rise;
  // Anti-moiré LOD: while the 0.0005 hairline between blades is sub-pixel it can only alias, so the blades close
  // it (width → pitch). From ~8 device px per blade upward the spec's hairline is drawn as designed.
  transformed.x *= mix(${(PITCH / w).toFixed(4)}, 1.0, smoothstep(4.0, 8.0, uPitchPx));
  transformed.z = (transformed.z + ${(d / 2).toFixed(4)}) * rise; // grows up out of the dial face
  float inFocus = 1.0;
  if (uFocus.z > 1.5) inFocus = aShut;
  else if (uFocus.z > 0.5) inFocus = step(mod(slot - uFocus.x + ${SLOTS}.0, ${SLOTS}.0), uFocus.y - 0.5);
  vRecede = uFocusAmt * (1.0 - inFocus);
}`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vRecede;')
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= 1.0 - 0.72 * vRecede;');
  };
  mat.customProgramCacheKey = () => 'curb-blades';

  const mesh = new InstancedMesh(geo, mat, SLOTS);
  mesh.instanceMatrix.setUsage(35044); // StaticDrawUsage
  mesh.geometry.setAttribute('aShut', new InstancedBufferAttribute(new Float32Array(SLOTS), 1));
  mesh.frustumCulled = false;
  return mesh;
}

/**
 * "Past slots at 70% value" is a rule about what the eye sees. NeutralToneMapping compresses the present-day ivory
 * and amber (they sit above its 0.76 knee) but not their dimmer past, so sRGB × 0.7 would render at ~85%. These
 * linear factors [ivory, amber] were calibrated in the lab (scripts/probe.mjs) so rendered past ≈ 0.7 × rendered
 * present under this rig (RoomEnvironment 0.6 + key 2.2).
 */
const PAST_TONE: readonly [number, number] = [0.66, 0.8];

const m = new Matrix4();
const q = new Quaternion();
const z = new Vector3(0, 0, 1);
const one = new Vector3(1, 1, 1);
const p = new Vector3();
const c = new Color();

/** Lay out and colour the blades for a week. Called on mount and whenever the slots or "now" change. */
export function layoutBlades(
  mesh: InstancedMesh,
  slots: Uint8Array,
  nowIndex: number,
  pal: Palette,
  amberGain = 1,
): void {
  const shut = mesh.geometry.getAttribute('aShut') as InstancedBufferAttribute;
  for (let i = 0; i < SLOTS; i++) {
    const a = slotAngle(i, nowIndex);
    q.setFromAxisAngle(z, a - Math.PI / 2); // local +Y → radial
    p.set(Math.cos(a) * MARK.bladeRadius, Math.sin(a) * MARK.bladeRadius, 0);
    mesh.setMatrixAt(i, m.compose(p, q, one));
    const s = slots[i] === 1;
    const [r, g, b] = s ? pal.amber : pal.ivory;
    const past = i < nowIndex;
    const k = past ? PAST_VALUE : 1;
    c.setRGB(r * k, g * k, b * k, 'srgb').multiplyScalar((s ? amberGain : 1) * (past ? PAST_TONE[s ? 1 : 0] : 1));
    mesh.setColorAt(i, c);
    shut.setX(i, s ? 1 : 0);
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  shut.needsUpdate = true;
}
