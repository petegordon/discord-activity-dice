import * as THREE from "three";
import { FRAME_DT, FRAME_STRIDE, type Impact } from "../dice/physics";
import type { Playback } from "../dice/roller";
import { DIE_SIZE, HAND_SPREAD, HAND_Y, HAND_Z, TABLE_LENGTH, TABLE_WIDTH } from "../dice/table";
import { diceGeometry, diceMaterials } from "./diceMesh";

const RAIL = 0.7;
const CAMERA_PITCH = THREE.MathUtils.degToRad(58);
const FOV = 38;

type DiceMode =
  | { kind: "table" }
  | { kind: "hand" }
  | { kind: "rolling"; playback: Playback; start: number; nextImpact: number; onImpact: (i: Impact) => void; done: () => void };

/**
 * The 3D table. Dice are two-level: an outer group follows the physics body,
 * an inner mesh carries the face correction from roller.ts.
 */
export class DiceScene {
  readonly renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 200);
  private dice: { body: THREE.Group; mesh: THREE.Mesh }[] = [];
  private mode: DiceMode = { kind: "hand" };
  private shake = 0;
  private shakeTarget = 0;
  private color = "#e63946";
  private clock = new THREE.Clock();
  private handBlend = 1;
  private restPose: { pos: THREE.Vector3; quat: THREE.Quaternion }[] = [];
  private tmpQ = new THREE.Quaternion();
  private tmpQ2 = new THREE.Quaternion();

  constructor(private readonly container: HTMLElement) {
    const lowPower = /Android|iPhone|iPad/i.test(navigator.userAgent) && Math.min(screen.width, screen.height) < 500;
    this.renderer = new THREE.WebGLRenderer({ antialias: !lowPower, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = lowPower ? THREE.BasicShadowMap : THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color("#0f1a14");
    this.scene.fog = new THREE.Fog("#0f1a14", 40, 80);
    this.buildTable();
    this.buildLights(lowPower);
    this.buildDice();

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  private buildTable() {
    const felt = new THREE.Mesh(
      new THREE.PlaneGeometry(TABLE_WIDTH, TABLE_LENGTH),
      new THREE.MeshStandardMaterial({ map: feltTexture(), roughness: 0.95 }),
    );
    felt.rotation.x = -Math.PI / 2;
    felt.receiveShadow = true;
    this.scene.add(felt);

    const wood = new THREE.MeshStandardMaterial({ color: "#5b3a1e", roughness: 0.55, metalness: 0.05 });
    const railH = 0.9;
    const add = (w: number, d: number, x: number, z: number) => {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(w, railH, d), wood);
      rail.position.set(x, railH / 2, z);
      rail.castShadow = true;
      rail.receiveShadow = true;
      this.scene.add(rail);
    };
    const W = TABLE_WIDTH, L = TABLE_LENGTH;
    add(W + RAIL * 2, RAIL, 0, -L / 2 - RAIL / 2);
    add(W + RAIL * 2, RAIL, 0, L / 2 + RAIL / 2);
    add(RAIL, L, -W / 2 - RAIL / 2, 0);
    add(RAIL, L, W / 2 + RAIL / 2, 0);

    // Felt markings: a faint "7 · 11 · DOUBLES" across the middle.
    const label = new THREE.Mesh(
      new THREE.PlaneGeometry(TABLE_WIDTH * 0.8, TABLE_WIDTH * 0.2),
      new THREE.MeshBasicMaterial({ map: labelTexture(), transparent: true, depthWrite: false }),
    );
    label.rotation.x = -Math.PI / 2;
    label.position.set(0, 0.01, -TABLE_LENGTH * 0.12);
    this.scene.add(label);

    const floor = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshStandardMaterial({ color: "#0b120e", roughness: 1 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.02;
    this.scene.add(floor);
  }

  private buildLights(lowPower: boolean) {
    this.scene.add(new THREE.HemisphereLight("#fff6e5", "#20302a", 1.4));
    const sun = new THREE.DirectionalLight("#ffffff", 2.2);
    sun.position.set(-6, 18, 8);
    sun.castShadow = true;
    sun.shadow.mapSize.set(lowPower ? 512 : 1024, lowPower ? 512 : 1024);
    const s = sun.shadow.camera;
    s.left = -TABLE_WIDTH / 2 - 2;
    s.right = TABLE_WIDTH / 2 + 2;
    s.top = TABLE_LENGTH / 2 + 2;
    s.bottom = -TABLE_LENGTH / 2 - 2;
    s.near = 1;
    s.far = 50;
    sun.shadow.bias = -0.0005;
    this.scene.add(sun);
  }

  private buildDice() {
    for (let i = 0; i < 2; i++) {
      const body = new THREE.Group();
      const mesh = new THREE.Mesh(diceGeometry(), diceMaterials(this.color));
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      body.add(mesh);
      this.scene.add(body);
      this.dice.push({ body, mesh });
      this.restPose.push({ pos: new THREE.Vector3(i ? 1 : -1, DIE_SIZE / 2, 0), quat: new THREE.Quaternion() });
    }
  }

  setColor(color: string) {
    if (color === this.color) return;
    this.color = color;
    for (const d of this.dice) d.mesh.material = diceMaterials(color);
  }

  /** 0..1 shake intensity of the dice in hand. */
  setShake(intensity: number) {
    this.shakeTarget = Math.max(0, Math.min(1, intensity));
  }

  get isRolling() {
    return this.mode.kind === "rolling";
  }

  /** Pick the dice up (start of a turn). */
  toHand() {
    if (this.mode.kind === "rolling") return;
    if (this.mode.kind === "table") this.handBlend = 0;
    this.mode = { kind: "hand" };
  }

  /** Leave the dice where they landed. */
  toTable() {
    if (this.mode.kind !== "rolling") this.mode = { kind: "table" };
  }

  get inHand() {
    return this.mode.kind === "hand";
  }

  play(playback: Playback, onImpact: (i: Impact) => void): Promise<void> {
    return new Promise((done) => {
      if (this.mode.kind === "rolling") this.mode.done();
      this.dice.forEach((d, i) => d.mesh.quaternion.set(...playback.corrections[i]));
      this.shake = this.shakeTarget = 0;
      this.mode = { kind: "rolling", playback, start: performance.now(), nextImpact: 0, onImpact, done };
    });
  }

  private resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // Fit the whole table (plus rails) in view at the fixed pitch.
    const halfW = TABLE_WIDTH / 2 + RAIL + 0.3;
    const halfL = TABLE_LENGTH / 2 + RAIL + 0.3;
    const vFov = THREE.MathUtils.degToRad(FOV);
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * this.camera.aspect);
    const distForWidth = halfW / Math.tan(hFov / 2) + halfL * Math.cos(CAMERA_PITCH) * 0.5;
    const projectedL = halfL * Math.sin(CAMERA_PITCH) + 0.6;
    const distForLength = projectedL / Math.tan(vFov / 2) + halfL * Math.cos(CAMERA_PITCH);
    const dist = Math.max(distForWidth, distForLength);
    const target = new THREE.Vector3(0, 0, 0.4);
    this.camera.position.set(0, Math.sin(CAMERA_PITCH) * dist, target.z + Math.cos(CAMERA_PITCH) * dist);
    this.camera.lookAt(target);
    this.camera.updateProjectionMatrix();
  }

  private frame() {
    const dt = Math.min(this.clock.getDelta(), 0.1);
    const t = this.clock.elapsedTime;
    this.shake += (this.shakeTarget - this.shake) * Math.min(1, dt * 12);

    if (this.mode.kind === "rolling") this.updateRolling();
    else if (this.mode.kind === "hand") this.updateHand(t, dt);
    this.renderer.render(this.scene, this.camera);
  }

  private updateRolling() {
    if (this.mode.kind !== "rolling") return;
    const { playback, start } = this.mode;
    const { frames, frameCount, impacts } = playback.sim;
    const f = (performance.now() - start) / 1000 / FRAME_DT;
    const i0 = Math.min(Math.floor(f), frameCount - 1);
    const i1 = Math.min(i0 + 1, frameCount - 1);
    const a = f - i0;
    this.dice.forEach((d, k) => {
      const fr = frames[k];
      const o0 = i0 * FRAME_STRIDE, o1 = i1 * FRAME_STRIDE;
      d.body.position.set(
        fr[o0] + (fr[o1] - fr[o0]) * a,
        fr[o0 + 1] + (fr[o1 + 1] - fr[o0 + 1]) * a,
        fr[o0 + 2] + (fr[o1 + 2] - fr[o0 + 2]) * a,
      );
      this.tmpQ.set(fr[o0 + 3], fr[o0 + 4], fr[o0 + 5], fr[o0 + 6]);
      this.tmpQ2.set(fr[o1 + 3], fr[o1 + 4], fr[o1 + 5], fr[o1 + 6]);
      d.body.quaternion.slerpQuaternions(this.tmpQ, this.tmpQ2, Math.min(1, a));
    });
    while (this.mode.nextImpact < impacts.length && impacts[this.mode.nextImpact].frame <= f) {
      this.mode.onImpact(impacts[this.mode.nextImpact++]);
    }
    if (f >= frameCount - 1) {
      this.dice.forEach((d, k) => {
        this.restPose[k].pos.copy(d.body.position);
        this.restPose[k].quat.copy(d.body.quaternion);
      });
      const done = this.mode.done;
      this.mode = { kind: "table" };
      done();
    }
  }

  private updateHand(t: number, dt: number) {
    this.handBlend = Math.min(1, this.handBlend + dt * 4);
    const ease = 1 - (1 - this.handBlend) ** 3;
    const s = this.shake;
    this.dice.forEach((d, k) => {
      const side = k ? 1 : -1;
      const bob = Math.sin(t * 2 + k) * 0.06;
      const jx = s * 0.35 * Math.sin(t * 37 + k * 2.1);
      const jy = s * 0.25 * Math.sin(t * 43 + k * 1.3);
      const jz = s * 0.3 * Math.sin(t * 31 + k * 0.7);
      const target = new THREE.Vector3(side * HAND_SPREAD * 0.5 + jx, HAND_Y + bob + jy, HAND_Z + jz);
      d.body.position.lerpVectors(this.restPose[k].pos, target, ease);
      // Idle: slow tumble. Shaking: fast, chaotic spin.
      const spin = 0.6 + s * 14;
      d.body.rotateX(spin * dt * (1 + k * 0.3));
      d.body.rotateY(spin * dt * 0.7);
      d.body.rotateZ(s * 9 * dt * Math.sin(t * 5 + k));
    });
    if (this.handBlend >= 1) {
      // Remember where we are so the next blend starts here.
      this.dice.forEach((d, k) => this.restPose[k].pos.copy(d.body.position));
    }
  }
}

function feltTexture(): THREE.Texture {
  const size = 512;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const grad = ctx.createRadialGradient(size / 2, size / 2, size * 0.1, size / 2, size / 2, size * 0.75);
  grad.addColorStop(0, "#1f7a4a");
  grad.addColorStop(1, "#11512f");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const img = ctx.getImageData(0, 0, size, size);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 14;
    img.data[i] += n;
    img.data[i + 1] += n;
    img.data[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function labelTexture(): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 256;
  const ctx = canvas.getContext("2d")!;
  ctx.font = "bold 120px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "rgba(255, 240, 200, 0.16)";
  ctx.fillText("7 · 11 · DOUBLES", 512, 128);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
