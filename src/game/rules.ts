export type Faces = [number, number];
export type HitKind = "seven" | "eleven" | "doubles";

export const HIT_POINTS: Record<HitKind, number> = { seven: 1, eleven: 1, doubles: 2 };
export const TARGET_OPTIONS = [5, 10, 21] as const;
export const DEFAULT_TARGET = 10;

/** Doubles always total an even number and 7/11 are odd, so the kinds never overlap. */
export function classify([a, b]: Faces): HitKind | null {
  if (a === b) return "doubles";
  const total = a + b;
  if (total === 7) return "seven";
  if (total === 11) return "eleven";
  return null;
}

export function pointsFor(faces: Faces): number {
  const hit = classify(faces);
  return hit ? HIT_POINTS[hit] : 0;
}
