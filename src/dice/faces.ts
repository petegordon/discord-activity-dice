/**
 * Standard d6 face layout (opposite faces sum to 7) and the cube-rotation math
 * used to make a die show a predetermined value.
 *
 * Quaternions are plain [x, y, z, w] tuples so this module stays engine-agnostic
 * and unit-testable.
 */
export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

/** Local outward normal of the face showing each value (index = value). */
export const FACE_NORMALS: Record<number, Vec3> = {
  1: [1, 0, 0],
  6: [-1, 0, 0],
  2: [0, 1, 0],
  5: [0, -1, 0],
  3: [0, 0, 1],
  4: [0, 0, -1],
};

/** Face values in three.js BoxGeometry material order: +X, -X, +Y, -Y, +Z, -Z. */
export const BOX_MATERIAL_VALUES = [1, 6, 2, 5, 3, 4] as const;

const VALUES = [1, 2, 3, 4, 5, 6];

export function rotate(q: Quat, v: Vec3): Vec3 {
  const [qx, qy, qz, qw] = q;
  const [vx, vy, vz] = v;
  // t = 2 * cross(q.xyz, v)
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  return [
    vx + qw * tx + (qy * tz - qz * ty),
    vy + qw * ty + (qz * tx - qx * tz),
    vz + qw * tz + (qx * ty - qy * tx),
  ];
}

export function multiply(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export function axisAngle(axis: Vec3, angle: number): Quat {
  const s = Math.sin(angle / 2);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)];
}

/** The value facing up and how flat the die is (1 = perfectly flat). */
export function topFace(q: Quat): { value: number; dot: number } {
  let best = { value: 1, dot: -Infinity };
  for (const value of VALUES) {
    const dot = rotate(q, FACE_NORMALS[value])[1];
    if (dot > best.dot) best = { value, dot };
  }
  return best;
}

/** All 24 rotations of the cube, built from axis-aligned quarter turns. */
export const CUBE_ROTATIONS: Quat[] = (() => {
  const out: Quat[] = [];
  const seen = new Set<string>();
  // q and -q are the same rotation, so canonicalise on the sign of the first non-zero component.
  const key = (q: Quat) => {
    const first = q.find((c) => Math.abs(c) > 1e-6) ?? 1;
    const s = first < 0 ? -1 : 1;
    return q.map((c) => (Math.round(c * s * 1e4) / 1e4 + 0).toFixed(4)).join(",");
  };
  const gens: Quat[] = [axisAngle([1, 0, 0], Math.PI / 2), axisAngle([0, 1, 0], Math.PI / 2), axisAngle([0, 0, 1], Math.PI / 2)];
  const queue: Quat[] = [[0, 0, 0, 1]];
  seen.add(key(queue[0]));
  while (queue.length) {
    const q = queue.shift()!;
    out.push(q);
    for (const g of gens) {
      const n = multiply(g, q);
      const k = key(n);
      if (!seen.has(k)) {
        seen.add(k);
        queue.push(n);
      }
    }
  }
  return out;
})();

const near = (a: Vec3, b: Vec3) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) < 1e-6;

/**
 * A cube rotation R to apply to the die's *visual* mesh (inside the physics body)
 * so that, when the body lands with `landed` up, the mesh shows `desired` up.
 * Needs R * n(desired) = n(landed). `pick` chooses among the 4 valid rotations.
 */
export function correctionFor(landed: number, desired: number, pick = 0): Quat {
  const target = FACE_NORMALS[landed];
  const source = FACE_NORMALS[desired];
  const matches = CUBE_ROTATIONS.filter((r) => near(rotate(r, source), target));
  return matches[((pick % matches.length) + matches.length) % matches.length];
}

/**
 * The flat orientation closest to q: q followed by the smallest world rotation
 * that brings the currently-highest face normal exactly to +Y.
 */
export function settleFlat(q: Quat): Quat {
  const { value } = topFace(q);
  const n = rotate(q, FACE_NORMALS[value]);
  // Rotate n onto +Y: axis = n × Y, angle = acos(n·Y).
  const axis: Vec3 = [-n[2], 0, n[0]];
  const len = Math.hypot(axis[0], axis[2]);
  if (len < 1e-9) return q;
  const angle = Math.acos(Math.max(-1, Math.min(1, n[1])));
  const fix = axisAngle([axis[0] / len, 0, axis[2] / len], angle);
  return normalize(multiply(fix, q));
}

export function normalize(q: Quat): Quat {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

export function slerp(a: Quat, b: Quat, t: number): Quat {
  let [bx, by, bz, bw] = b;
  let cos = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
  if (cos < 0) {
    cos = -cos;
    bx = -bx; by = -by; bz = -bz; bw = -bw;
  }
  if (cos > 0.9995) {
    return normalize([a[0] + (bx - a[0]) * t, a[1] + (by - a[1]) * t, a[2] + (bz - a[2]) * t, a[3] + (bw - a[3]) * t]);
  }
  const theta = Math.acos(cos);
  const sin = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / sin;
  const wb = Math.sin(t * theta) / sin;
  return [a[0] * wa + bx * wb, a[1] * wa + by * wb, a[2] * wa + bz * wb, a[3] * wa + bw * wb];
}
