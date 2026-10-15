import type { Faces } from "../game/rules";
import type { GameState } from "../game/sevenElevenDoubles";
import type { Quat, Vec3 } from "../dice/faces";

export type Player = {
  id: string;
  name: string;
  avatarUrl?: string;
  color: string;
  joinedAt: number;
  /** Id of the phone paired as this player's shaker remote (see SHAKER-REMOTE.md). */
  remoteId?: string;
  /** Whether that phone is connected right now. */
  remoteOnline?: boolean;
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
  /** host → all. `game` is the state to show once the dice settle, about `landsInMs` after this arrives. */
  | { t: "roll"; plan: RollPlan; game: GameState; landsInMs?: number }
  /** player → host: make this remote id my shaker remote, replacing any other */
  | { t: "pair"; remoteId: string }
  /** player → host: forget my shaker remote */
  | { t: "unpair" }
  /** remote → host, on (re)connect: please send the current state */
  | { t: "remote-hello" };

export type Target = "host" | "all";

/**
 * `remote` is set by the relay or the PeerJS host when the sender connected
 * as a shaker remote. It is never taken from the sender.
 */
export type Envelope = { from: string; to: Target; msg: Msg; remote?: boolean };

/** The only message type a non-host may broadcast; transports drop the rest. */
export const CLIENT_BROADCASTS: ReadonlySet<string> = new Set(["shake"]);

const MSG_TYPES = new Set(["hello", "state", "shake", "throw", "roll", "pair", "unpair", "remote-hello"]);

export type Role = "player" | "remote";

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
