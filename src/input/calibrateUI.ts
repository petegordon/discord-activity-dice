import "./calibrate.css";
import { analyzeThrow, buildProfile, PRACTICE_THROWS, saveProfile, shakeLevel, type PracticeThrow } from "./calibration";
import type { ThrowController } from "./controller";
import { mag, NOISE_FLOOR, type MotionSample } from "./motion";

/** Seconds of real shaking to measure. */
const SHAKE_MS = 2_000;
/** Movement above the noise floor (m/s²) that counts as shaking. */
const SHAKING_ABOVE = 2;

type Step = "intro" | "shake" | "throws" | "done" | "unavailable";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

/**
 * The optional "Calibrate your throw" sheet: shake once, throw straight at the
 * table three times, and the controller adapts to that (calibration.ts).
 * Builds its own DOM so both the table and the phone remote can use it.
 */
export class CalibrationSheet {
  private layer = el("section", "cal-layer");
  private title = el("h2", "cal-title");
  private text = el("p", "cal-text");
  private meter = el("div", "cal-meter");
  private fill = el("div", "cal-fill");
  private pad = el("div", "cal-pad", "Hold here, throw, then let go");
  private dots = el("div", "cal-dots");
  private actions = el("div", "cal-actions");
  private step: Step = "intro";
  private shakeSamples: MotionSample[] = [];
  private shakeMs = 0;
  private lastT = 0;
  private recording: MotionSample[] | null = null;
  private throws: PracticeThrow[] = [];
  private level = 0;
  private angle = 0;

  constructor(
    private readonly controller: ThrowController,
    private readonly onChange: (message: string) => void = () => {},
  ) {
    const card = el("div", "cal-card");
    this.meter.append(this.fill);
    card.append(this.title, this.text, this.meter, this.pad, this.dots, this.actions);
    this.layer.append(card);
    this.layer.hidden = true;
    this.layer.setAttribute("role", "dialog");
    this.layer.setAttribute("aria-modal", "true");
    document.body.append(this.layer);

    this.pad.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      this.pad.setPointerCapture(e.pointerId);
      this.pad.classList.add("holding");
      this.recording = [];
    });
    const release = () => {
      if (!this.recording) return;
      this.pad.classList.remove("holding");
      const samples = this.recording;
      this.recording = null;
      this.practiceThrow(samples);
    };
    this.pad.addEventListener("pointerup", release);
    this.pad.addEventListener("pointercancel", () => {
      this.recording = null;
      this.pad.classList.remove("holding");
    });
    this.pad.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  get isOpen() {
    return !this.layer.hidden;
  }

  open() {
    this.layer.hidden = false;
    this.show(this.controller.motionOff ? "unavailable" : "intro");
  }

  close() {
    this.layer.hidden = true;
    this.controller.sampleListener = null;
    this.recording = null;
  }

  private button(label: string, kind: "primary" | "secondary", onClick: () => void) {
    const b = el("button", `cal-btn ${kind}`, label);
    b.type = "button";
    b.addEventListener("click", onClick);
    return b;
  }

  private show(step: Step, note?: string) {
    this.step = step;
    this.meter.hidden = step !== "shake";
    this.pad.hidden = step !== "throws";
    this.dots.hidden = step !== "throws";
    this.actions.replaceChildren();
    const cancel = this.button("Cancel", "secondary", () => this.close());

    if (step === "intro") {
      this.title.textContent = "🎯 Calibrate your throw";
      this.text.textContent =
        "Teach the game how you shake and throw: one quick shake, then three throws straight at the table. Afterwards, a flick like yours throws, and your \"straight\" goes straight. Takes about 20 seconds.";
      if (this.controller.profile) {
        this.actions.append(
          this.button("Reset to default", "secondary", () => {
            saveProfile(null);
            this.controller.setProfile(null);
            this.onChange("Throw calibration reset to default");
            this.close();
          }),
        );
      }
      this.actions.append(cancel, this.button("Start", "primary", () => void this.start()));
    } else if (step === "shake") {
      this.title.textContent = "1. Shake";
      this.text.textContent = "Hold your phone the way you play and shake it like you're rattling dice in your hand.";
      this.fill.style.width = "0%";
      this.actions.append(cancel);
    } else if (step === "throws") {
      this.title.textContent = "2. Throw straight at the table";
      this.text.textContent =
        note ?? "Hold the pad, throw the way you'd toss dice straight ahead, then let go. As gentle or as hard as you like, just be consistent.";
      this.paintDots();
      this.actions.append(cancel);
    } else if (step === "done") {
      this.title.textContent = "✅ Calibrated";
      this.text.textContent = "Throws now match your style. You can recalibrate or reset any time from 🎯.";
      this.actions.append(
        this.button("Again", "secondary", () => void this.start()),
        this.button("Done", "primary", () => this.close()),
      );
    } else {
      this.title.textContent = "Motion isn't available";
      this.text.textContent = "This browser isn't sharing the phone's motion sensors, so there's nothing to calibrate here.";
      this.actions.append(this.button("OK", "primary", () => this.close()));
    }
  }

  private paintDots() {
    this.dots.replaceChildren(
      ...Array.from({ length: PRACTICE_THROWS }, (_, i) => el("span", i < this.throws.length ? "cal-dot done" : "cal-dot")),
    );
  }

  private async start() {
    // iOS only grants motion from inside a tap; this runs from the Start button.
    if (this.controller.motion === "needs-permission") await this.controller.requestMotionPermission();
    if (this.controller.motionOff) return this.show("unavailable");
    this.shakeSamples = [];
    this.shakeMs = 0;
    this.lastT = 0;
    this.throws = [];
    this.controller.sampleListener = (s, angle) => this.onSample(s, angle);
    this.show("shake");
  }

  private onSample(s: MotionSample, angle: number) {
    this.angle = angle;
    if (this.step === "shake") {
      const dt = this.lastT ? Math.min(100, s.t - this.lastT) : 0;
      this.lastT = s.t;
      if (mag(s) - NOISE_FLOOR < SHAKING_ABOVE) return;
      this.shakeSamples.push(s);
      this.shakeMs += dt;
      this.fill.style.width = `${Math.min(100, (this.shakeMs / SHAKE_MS) * 100)}%`;
      if (this.shakeMs >= SHAKE_MS) {
        this.level = shakeLevel(this.shakeSamples);
        if ("vibrate" in navigator) navigator.vibrate(30);
        this.show("throws");
      }
    } else if (this.step === "throws" && this.recording) {
      this.recording.push(s);
      // Only the last few seconds of a long hold matter.
      if (this.recording.length > 600) this.recording.shift();
    }
  }

  private practiceThrow(samples: MotionSample[]) {
    if (this.step !== "throws") return;
    const t = analyzeThrow(samples, this.angle);
    if (!t) return this.show("throws", "We didn't feel a throw. Hold the pad, give it a little more snap, then let go.");
    this.throws.push(t);
    if ("vibrate" in navigator) navigator.vibrate(30);
    if (this.throws.length < PRACTICE_THROWS) {
      return this.show("throws", `Got it (${this.throws.length} of ${PRACTICE_THROWS}). Again, the same way.`);
    }
    const result = buildProfile(this.level, this.throws);
    if ("redo" in result) {
      this.throws.splice(result.redo, 1);
      return this.show("throws", "One of those went a different way from the others. Throw once more, straight ahead.");
    }
    saveProfile(result.profile);
    this.controller.setProfile(result.profile);
    this.controller.sampleListener = null;
    this.onChange("🎯 Throw calibrated");
    this.show("done");
  }
}
