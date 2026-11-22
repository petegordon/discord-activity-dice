import { describe, expect, it } from "vitest";
import { playerKey, withinLimit } from "../worker/src/limits";

const from = (ip: string) => new Request("https://game.example/api/token", { headers: { "cf-connecting-ip": ip } });

describe("who a request is counted as", () => {
  it("is the Discord user when known, whatever address they arrive from", () => {
    expect(playerKey(from("198.51.100.1"), { userId: "42" })).toBe("user:42");
    expect(playerKey(from("198.51.100.2"), { userId: "42" })).toBe("user:42");
    expect(playerKey(from("198.51.100.1"), { userId: "43" })).not.toBe(playerKey(from("198.51.100.1"), { userId: "42" }));
  });

  it("is the address and the player's id together when nobody is signed in", () => {
    const a = playerKey(from("198.51.100.1"), { playerId: "p1" });
    expect(a).toBe("ip:198.51.100.1:p1");
    // two players behind one address are counted apart
    expect(playerKey(from("198.51.100.1"), { playerId: "p2" })).not.toBe(a);
    // the same id from another address is someone else
    expect(playerKey(from("198.51.100.9"), { playerId: "p1" })).not.toBe(a);
  });

  it("a missing or failing limiter is no limit; a full one refuses", async () => {
    expect(await withinLimit(undefined, "k")).toBe(true);
    expect(await withinLimit({ limit: async () => { throw new Error("down"); } }, "k")).toBe(true);
    expect(await withinLimit({ limit: async () => ({ success: false }) }, "k")).toBe(false);
  });
});
