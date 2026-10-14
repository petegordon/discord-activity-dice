import type { Faces } from "../game/rules";
import type { GameState } from "../game/sevenElevenDoubles";
import type { Quat, Vec3 } from "../dice/faces";

export type Player = {
  id: string;
  name: string;
  avatarUrl?: string;
  color: string;
  joinedAt: number;
};

/** A throw gesture, already reduced to table space. See input/throw.ts. */
export type ThrowInput = {
  /** Unit vector on the table: x = sideways (right +), y = forward (away from the shooter). */
  dir: [number, number];
  /** 0..1 */
  speed: number;
  /** 0..1 */
  spin: number;
  source: "motion" | "flick" | "button";
};

export type BodyInit = { pos: Vec3; quat: Quat; vel: Vec3; angVel: Vec3 };

export type RollPlan = {
  rollId: string;
  shooter: string;
  faces: Faces;
  bodies: [BodyInit, BodyInit];
};

export type Msg =
  /** peer → host, on (re)connect */
  | { t: "hello"; player: { name: string; avatarUrl?: string } }
  /** host → all, whenever players or game change outside a roll */
  | { t: "state"; players: Player[]; game: GameState; hostId: string }
  /** shooter → all, ~15 Hz while holding the dice; 0 = stopped */
  | { t: "shake"; intensity: number }
  /** shooter → host */
  | { t: "throw"; input: ThrowInput }
  /** host → all. `game` is the state to show once the dice settle. */
  | { t: "roll"; plan: RollPlan; game: GameState };

export type Target = "host" | "all";

export type Envelope = { from: string; to: Target; msg: Msg };

/** The only message type a non-host may broadcast; transports drop the rest. */
export const CLIENT_BROADCASTS: ReadonlySet<string> = new Set(["shake"]);

const MSG_TYPES = new Set(["hello", "state", "shake", "throw", "roll"]);

/** Light structural validation for anything arriving off the wire. */
export function isEnvelope(value: unknown): value is Envelope {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  const msg = v.msg as Record<string, unknown> | undefined;
  return (
    typeof v.from === "string" &&
    (v.to === "host" || v.to === "all") &&
    !!msg &&
    typeof msg === "object" &&
    typeof msg.t === "string" &&
    MSG_TYPES.has(msg.t)
  );
}
