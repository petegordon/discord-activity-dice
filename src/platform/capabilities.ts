/**
 * What we can tell about device motion before any event arrives:
 * - "probe": listen and see; events within ~1.5 s mean it works
 * - "needs-permission": iOS, works after a tap on DeviceMotionEvent.requestPermission()
 * - "blocked": a Permissions Policy forbids it, e.g. inside Discord's Activity iframe
 * - "unavailable": no API, a desktop, or switched off with ?nomotion
 */
export type MotionVerdict = "probe" | "needs-permission" | "blocked" | "unavailable";

export type MotionEnv = {
  hasApi: boolean;
  hasRequestPermission: boolean;
  /** Whether this frame may use the accelerometer and gyroscope; null if the browser can't say (Safari, Firefox). */
  policyAllows: boolean | null;
  inDiscord: boolean;
  coarsePointer: boolean;
  touchPoints: number;
  forceOff: boolean;
};

/**
 * Motion events need the `accelerometer` and `gyroscope` Permissions Policy
 * features. Their default allowlist is 'self', so a cross-origin iframe only
 * gets them if its parent delegates them, and Discord's Activity iframe
 * doesn't. See SHAKER-REMOTE.md §1.
 */
export function motionVerdict(e: MotionEnv): MotionVerdict {
  if (e.forceOff || !e.hasApi) return "unavailable";
  if (e.policyAllows === false) return "blocked";
  // Safari can't tell us, and asking for permission there would just be refused.
  if (e.inDiscord && e.policyAllows === null) return "blocked";
  if (!e.coarsePointer && e.touchPoints === 0) return "unavailable";
  // Desktop Chrome also has requestPermission but no sensors; only ask on touch devices.
  if (e.hasRequestPermission && e.coarsePointer) return "needs-permission";
  return "probe";
}

type PolicyDoc = { allowsFeature?: (feature: string) => boolean };

function policyAllows(): boolean | null {
  const doc = document as Document & { featurePolicy?: PolicyDoc; permissionsPolicy?: PolicyDoc };
  const policy = doc.permissionsPolicy ?? doc.featurePolicy;
  if (typeof policy?.allowsFeature !== "function") return null;
  try {
    return policy.allowsFeature("accelerometer") && policy.allowsFeature("gyroscope");
  } catch {
    return null;
  }
}

/** Reads the browser. `inDiscord` comes from env.ts (kept out of here so the pure verdict is testable). */
export function motionEnv(inDiscord: boolean): MotionEnv {
  const hasApi = typeof DeviceMotionEvent !== "undefined";
  return {
    hasApi,
    hasRequestPermission: hasApi && typeof (DeviceMotionEvent as unknown as { requestPermission?: unknown }).requestPermission === "function",
    policyAllows: policyAllows(),
    inDiscord,
    coarsePointer: matchMedia("(pointer: coarse)").matches,
    touchPoints: navigator.maxTouchPoints ?? 0,
    forceOff: new URLSearchParams(location.search).has("nomotion"),
  };
}
