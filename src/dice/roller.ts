import type { RollPlan } from "../net/protocol";
import { correctionFor, type Quat } from "./faces";
import { simulate, type SimResult } from "./physics";

export type Playback = {
  sim: SimResult;
  /** Per-die rotation applied to the visual mesh inside its physics body. */
  corrections: Quat[];
};

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * Simulates the host's throw locally and works out how to rotate each die's
 * mesh so that the faces the host chose are the ones that land on top.
 * The correction is applied from the first frame, so it is never visible.
 */
export function preparePlayback(plan: RollPlan): Playback {
  const sim = simulate(plan.bodies);
  const seed = hash(plan.rollId);
  const corrections = plan.faces.map((desired, i) => correctionFor(sim.landed[i], desired, (seed >> (i * 2)) & 3));
  return { sim, corrections };
}
