import type { ThrowInput } from "../net/protocol";

const MIN_FORWARD = 0.5;
export const MIN_SPEED = 0.25;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const finite = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

/**
 * Sanitises a throw from any client: finite values, a forward-pointing unit
 * direction (at most ~60° off straight), and speed/spin within playable range.
 * Runs on the host, so it must tolerate arbitrary input.
 */
export function normalizeThrow(input: Partial<ThrowInput> | null | undefined): ThrowInput {
  const rawDir = Array.isArray(input?.dir) ? input!.dir : [0, 1];
  let x = finite(rawDir[0], 0);
  let y = Math.max(finite(rawDir[1], 1), 0);
  const len = Math.hypot(x, y);
  if (len < 1e-6) {
    x = 0;
    y = 1;
  } else {
    x /= len;
    y /= len;
  }
  if (y < MIN_FORWARD) {
    y = MIN_FORWARD;
    x = Math.sign(x || 1) * Math.sqrt(1 - MIN_FORWARD * MIN_FORWARD);
  }
  const source = input?.source === "motion" || input?.source === "flick" ? input.source : "button";
  return {
    dir: [x, y],
    speed: clamp(finite(input?.speed, 0.6), MIN_SPEED, 1),
    spin: clamp(finite(input?.spin, 0.5), 0, 1),
    source,
  };
}

/** A pleasant randomised throw for the Roll button. */
export function buttonThrow(rand: () => number = Math.random): ThrowInput {
  const angle = (rand() - 0.5) * 0.5;
  return normalizeThrow({
    dir: [Math.sin(angle), Math.cos(angle)],
    speed: 0.55 + rand() * 0.35,
    spin: 0.4 + rand() * 0.5,
    source: "button",
  });
}
