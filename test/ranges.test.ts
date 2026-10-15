import { describe, expect, it } from "vitest";
import { byteRange } from "../worker/src/ranges";

describe("byteRange", () => {
  it("reads the ranges video players ask for", () => {
    expect(byteRange("bytes=0-1", 100)).toEqual({ start: 0, end: 1 }); // Safari's probe
    expect(byteRange("bytes=10-", 100)).toEqual({ start: 10, end: 99 });
    expect(byteRange("bytes=-30", 100)).toEqual({ start: 70, end: 99 });
    expect(byteRange("bytes=90-500", 100)).toEqual({ start: 90, end: 99 });
  });

  it("serves the whole file when there's no single byte range", () => {
    expect(byteRange(null, 100)).toBeNull();
    expect(byteRange("bytes=0-1,5-9", 100)).toBeNull();
    expect(byteRange("items=0-1", 100)).toBeNull();
  });

  it("refuses ranges outside the file", () => {
    expect(byteRange("bytes=100-", 100)).toBe("bad");
    expect(byteRange("bytes=5-2", 100)).toBe("bad");
    expect(byteRange("bytes=-", 100)).toBe("bad");
  });
});
