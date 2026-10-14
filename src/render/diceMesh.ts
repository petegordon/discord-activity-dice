import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { BOX_MATERIAL_VALUES } from "../dice/faces";
import { DIE_SIZE } from "../dice/table";

const PIPS: Record<number, [number, number][]> = {
  1: [[0.5, 0.5]],
  2: [[0.27, 0.27], [0.73, 0.73]],
  3: [[0.27, 0.27], [0.5, 0.5], [0.73, 0.73]],
  4: [[0.27, 0.27], [0.73, 0.27], [0.27, 0.73], [0.73, 0.73]],
  5: [[0.27, 0.27], [0.73, 0.27], [0.5, 0.5], [0.27, 0.73], [0.73, 0.73]],
  6: [[0.27, 0.25], [0.73, 0.25], [0.27, 0.5], [0.73, 0.5], [0.27, 0.75], [0.73, 0.75]],
};

function luminance(hex: string) {
  const c = new THREE.Color(hex);
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

const cache = new Map<string, THREE.Material[]>();
let geometry: THREE.BufferGeometry | null = null;

function faceTexture(value: number, body: string, pip: string): THREE.Texture {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = body;
  ctx.fillRect(0, 0, size, size);
  // Soft vignette so edges read as rounded.
  const g = ctx.createRadialGradient(size / 2, size / 2, size * 0.3, size / 2, size / 2, size * 0.75);
  g.addColorStop(0, "rgba(255,255,255,0.08)");
  g.addColorStop(1, "rgba(0,0,0,0.18)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const r = value === 1 ? size * 0.11 : size * 0.085;
  for (const [x, y] of PIPS[value]) {
    ctx.beginPath();
    ctx.arc(x * size, y * size, r, 0, Math.PI * 2);
    ctx.fillStyle = pip;
    ctx.fill();
    // Inset shading.
    ctx.beginPath();
    ctx.arc(x * size, y * size - r * 0.15, r * 0.85, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(0,0,0,0.12)";
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** One material per face, in BoxGeometry group order. Cached per color. */
export function diceMaterials(color: string): THREE.Material[] {
  let mats = cache.get(color);
  if (!mats) {
    const pip = luminance(color) > 0.6 ? "#1d1d1f" : "#fbfbfb";
    mats = BOX_MATERIAL_VALUES.map(
      (v) => new THREE.MeshStandardMaterial({ map: faceTexture(v, color, pip), roughness: 0.32, metalness: 0.02 }),
    );
    cache.set(color, mats);
  }
  return mats;
}

export function diceGeometry(): THREE.BufferGeometry {
  geometry ??= new RoundedBoxGeometry(DIE_SIZE, DIE_SIZE, DIE_SIZE, 4, DIE_SIZE * 0.12);
  return geometry;
}
