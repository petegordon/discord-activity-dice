/**
 * Is this Discord user in the Activity instance they ask a room ticket for?
 *
 * /api/token gets the instance id from the client. Discord's "get activity
 * instance" call (GET /applications/{id}/activity-instances/{instance_id})
 * lists the users in an instance, so the Worker asks it before handing out a
 * ticket. The call needs the application's bot token, so the check runs only
 * when the DISCORD_BOT_TOKEN secret is set; without it the Worker says so once
 * in its log and issues tickets as before.
 *
 * With the secret set the check never passes by default:
 * - "ok": Discord lists the user in the instance.
 * - "refused": Discord says there is no such instance, or the user isn't in
 *   it, or it answered with something unexpected (a wrong bot token included).
 * - "retry": Discord couldn't be reached or is busy (network failure, 429,
 *   5xx). The caller refuses with an error the client may retry.
 * A user who has only just joined may not be listed yet, so a "not there"
 * answer is asked once more after a short pause before it counts.
 */
export type InstanceVerdict = "ok" | "skipped" | "refused" | "retry";

export type InstanceDeps = {
  fetch: (url: string, init: { headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
  appId: string;
  botToken?: string;
  warn?: (...args: unknown[]) => void;
  /** Pause before asking again. Tests pass their own. */
  sleep?: (ms: number) => Promise<void>;
};

export const INSTANCE_RECHECK_MS = 700;

let warnedNoToken = false;

async function ask(deps: InstanceDeps, instanceId: string, userId: string): Promise<"ok" | "absent" | "refused" | "retry"> {
  let res: Awaited<ReturnType<InstanceDeps["fetch"]>>;
  try {
    res = await deps.fetch(`https://discord.com/api/v10/applications/${deps.appId}/activity-instances/${encodeURIComponent(instanceId)}`, {
      headers: { authorization: `Bot ${deps.botToken}` },
    });
  } catch {
    return "retry";
  }
  if (res.status === 404) return "absent";
  if (res.status === 429 || res.status >= 500) return "retry";
  if (!res.ok) {
    deps.warn?.("activity instance check: Discord answered", res.status);
    return "refused";
  }
  let body: { users?: unknown };
  try {
    body = (await res.json()) as { users?: unknown };
  } catch {
    return "retry";
  }
  return Array.isArray(body?.users) && body.users.includes(userId) ? "ok" : "absent";
}

export async function userInInstance(deps: InstanceDeps, instanceId: string, userId: string): Promise<InstanceVerdict> {
  if (!deps.botToken) {
    if (!warnedNoToken) deps.warn?.("DISCORD_BOT_TOKEN is not set: room tickets are issued without checking the Activity instance");
    warnedNoToken = true;
    return "skipped";
  }
  let answer = await ask(deps, instanceId, userId);
  if (answer === "absent") {
    await (deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(INSTANCE_RECHECK_MS);
    answer = await ask(deps, instanceId, userId);
  }
  return answer === "absent" ? "refused" : answer;
}
