import type { ThrowInput } from "../net/protocol";
import { motionEnv, motionVerdict } from "../platform/capabilities";
import { inDiscord } from "../platform/env";
import { loadProfile } from "./calibration";
import { MotionReader, SHAKE_TO_THROW, ShakeTracker, type MotionSample, type ThrowProfile } from "./motion";
import { normalizeThrow } from "./throw";

/** "blocked": the browser forbids motion in this frame (Discord); "unavailable": no sensors or permission. */
export type MotionState = "unknown" | "needs-permission" | "active" | "blocked" | "unavailable";

export type ControllerCallbacks = {
  /** 0..1 while holding, ~15 Hz; 0 once when the hold ends. */
  onShake: (intensity: number) => void;
  onThrow: (input: ThrowInput) => void;
  onHint: (text: string) => void;
  onHoldChange: (holding: boolean) => void;
  onMotionState: (state: MotionState) => void;
};

const SHAKE_TICK_MS = 66;
const FLICK_WINDOW_MS = 100;
const MIN_FLICK_SPEED = 0.45; // px/ms
const FULL_FLICK_SPEED = 2.6; // px/ms
const POINTER_SHAKE_TO_THROW = 0.3;

type PointerSample = { t: number; x: number; y: number };

type DeviceMotionEventIOS = typeof DeviceMotionEvent & { requestPermission?: () => Promise<"granted" | "denied"> };

/**
 * Hold-to-shake input on the "cup" zone. With device motion, shake the phone
 * and flick it or let go to throw. Without it, wiggle and flick the pointer.
 */
export class ThrowController {
  motion: MotionState = "unknown";
  private enabled = false;
  private holding = false;
  private pointerId: number | null = null;
  private tracker = new ShakeTracker();
  private reader = new MotionReader();
  private pointer: PointerSample[] = [];
  private pointerEnergy = 0;
  private tick: ReturnType<typeof setInterval> | undefined;
  private lastBuzz = 0;
  private listening = false;
  /** Sees every motion sample, held or not (used by calibration). */
  sampleListener: ((sample: MotionSample, screenAngle: number) => void) | null = null;

  constructor(
    private readonly zone: HTMLElement,
    private readonly cb: ControllerCallbacks,
  ) {
    zone.addEventListener("pointerdown", (e) => this.down(e));
    zone.addEventListener("pointermove", (e) => this.move(e));
    zone.addEventListener("pointerup", (e) => this.up(e));
    zone.addEventListener("pointercancel", () => this.endHold());
    zone.addEventListener("contextmenu", (e) => e.preventDefault());

    this.tracker.profile = loadProfile();
    const verdict = motionVerdict(motionEnv(inDiscord));
    if (verdict === "probe") this.listen();
    else this.setMotion(verdict);
  }

  get profile() {
    return this.tracker.profile;
  }

  /** Apply a calibrated throw (or null for the defaults). */
  setProfile(profile: ThrowProfile | null) {
    this.tracker.profile = profile;
  }

  /** No motion here, and none coming: blocked, missing, or denied. */
  get motionOff() {
    return this.motion === "blocked" || this.motion === "unavailable";
  }

  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    if (!enabled) this.endHold();
  }

  get intensity() {
    return Math.max(this.tracker.energy, this.pointerEnergy);
  }

  /** Must be called from a user gesture (iOS). */
  async requestMotionPermission(): Promise<boolean> {
    const req = (DeviceMotionEvent as DeviceMotionEventIOS).requestPermission;
    if (!req) return this.motion === "active";
    try {
      const result = await req.call(DeviceMotionEvent);
      if (result === "granted") {
        this.listen();
        return true;
      }
    } catch {
      // Rejected, or not allowed in this frame.
    }
    this.setMotion("unavailable");
    return false;
  }

  private setMotion(state: MotionState) {
    if (this.motion === state) return;
    this.motion = state;
    this.cb.onMotionState(state);
  }

  private listen() {
    if (this.listening) return;
    this.listening = true;
    // Desktop browsers expose DeviceMotionEvent but never fire it; real sensors report within ~1s.
    const timeout = setTimeout(() => this.motion !== "active" && this.setMotion("unavailable"), 1500);
    window.addEventListener("devicemotion", (e) => {
      const angle = screen.orientation?.angle ?? 0;
      this.reader.screenAngle = angle;
      const sample = this.reader.read(e, performance.now());
      if (!sample) return;
      if (this.motion !== "active") {
        clearTimeout(timeout);
        this.setMotion("active");
      }
      this.tracker.screenAngle = angle;
      this.sampleListener?.(sample, angle);
      if (this.holding && this.tracker.push(sample)) this.throwNow(this.tracker.throwInput());
    });
  }

  private down(e: PointerEvent) {
    if (!this.enabled || this.holding) return;
    e.preventDefault();
    this.holding = true;
    this.pointerId = e.pointerId;
    this.zone.setPointerCapture(e.pointerId);
    this.tracker.reset();
    this.pointer = [{ t: e.timeStamp, x: e.clientX, y: e.clientY }];
    this.pointerEnergy = 0;
    this.cb.onHoldChange(true);
    this.tick = setInterval(() => this.onTick(), SHAKE_TICK_MS);
  }

  private move(e: PointerEvent) {
    if (!this.holding || e.pointerId !== this.pointerId) return;
    const prev = this.pointer[this.pointer.length - 1];
    const now = { t: e.timeStamp, x: e.clientX, y: e.clientY };
    this.pointer.push(now);
    while (this.pointer.length > 2 && now.t - this.pointer[0].t > 400) this.pointer.shift();
    const dt = Math.max(1, now.t - prev.t);
    const speed = Math.hypot(now.x - prev.x, now.y - prev.y) / dt;
    const level = Math.min(1, speed / 3);
    this.pointerEnergy += (level - this.pointerEnergy) * (level > this.pointerEnergy ? 0.2 : 0.05);
  }

  private onTick() {
    this.pointerEnergy *= 0.92;
    const intensity = this.intensity;
    this.cb.onShake(intensity);
    const now = performance.now();
    if (intensity > 0.3 && now - this.lastBuzz > 140 && "vibrate" in navigator) {
      this.lastBuzz = now;
      navigator.vibrate(Math.round(8 + intensity * 20));
    }
  }

  private up(e: PointerEvent) {
    if (!this.holding || e.pointerId !== this.pointerId) return;
    const input = this.releaseThrow(e.timeStamp);
    if (input) this.throwNow(input);
    else {
      this.endHold();
      this.cb.onHint(this.motion === "active" ? "Shake the dice, then flick or let go!" : "Wiggle the dice, then flick upward!");
    }
  }

  private releaseThrow(t: number): ThrowInput | null {
    if (this.motion === "active" && this.tracker.peakEnergy >= SHAKE_TO_THROW) {
      return this.tracker.throwInput();
    }
    let recent = this.pointer.filter((p) => t - p.t <= FLICK_WINDOW_MS);
    // A slow device may deliver pointer events further apart than the window;
    // fall back to the last two samples if the final one is fresh.
    const last2 = this.pointer.slice(-2);
    if (recent.length < 2 && last2.length === 2 && t - last2[1].t <= FLICK_WINDOW_MS) recent = last2;
    if (recent.length >= 2) {
      const a = recent[0];
      const b = recent[recent.length - 1];
      const dt = Math.max(1, b.t - a.t);
      const vx = (b.x - a.x) / dt;
      const vy = (a.y - b.y) / dt; // screen up = forward
      const speed = Math.hypot(vx, vy);
      if (speed >= MIN_FLICK_SPEED && vy > 0) {
        return normalizeThrow({ dir: [vx, vy], speed: speed / FULL_FLICK_SPEED, spin: 0.4 + this.pointerEnergy * 0.6, source: "flick" });
      }
    }
    if (this.pointerEnergy >= POINTER_SHAKE_TO_THROW) {
      return normalizeThrow({ dir: [0, 1], speed: 0.4 + this.pointerEnergy * 0.5, spin: 0.5 + this.pointerEnergy * 0.5, source: "flick" });
    }
    return null;
  }

  private throwNow(input: ThrowInput) {
    if (!this.holding) return;
    this.endHold();
    if ("vibrate" in navigator) navigator.vibrate(40);
    this.cb.onThrow(input);
  }

  private endHold() {
    if (!this.holding) return;
    this.holding = false;
    clearInterval(this.tick);
    if (this.pointerId !== null && this.zone.hasPointerCapture(this.pointerId)) this.zone.releasePointerCapture(this.pointerId);
    this.pointerId = null;
    this.tracker.reset();
    this.pointerEnergy = 0;
    this.cb.onShake(0);
    this.cb.onHoldChange(false);
  }
}
