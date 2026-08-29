import { describe, expect, it } from "vitest";

import { TakeRequestRegistry } from "./take-request-registry.js";

function counting(): () => string {
  let next = 0;
  return () => `request-${(next += 1)}`;
}

const KEY = "z1address:aa11:20";

describe("TakeRequestRegistry", () => {
  it("hands the same request id to every attempt until it is settled", () => {
    const registry = new TakeRequestRegistry(counting());

    expect(registry.reserve(KEY)).toBe("request-1");
    expect(registry.reserve(KEY)).toBe("request-1");
    registry.settle(KEY);
    expect(registry.reserve(KEY)).toBe("request-2");
  });

  it("keeps the reservation after a failed attempt so the retry reuses it", () => {
    // The failed attempt may already hold an on-chain lock. A fresh id would
    // open a second session against the same order and settle both.
    const registry = new TakeRequestRegistry(counting());
    const requestId = registry.reserve(KEY);

    // …takeOrder or runUntilSettled rejects; nothing calls settle…

    expect(registry.reserve(KEY)).toBe(requestId);
    expect(registry.peek(KEY)).toBe(requestId);
  });

  it("keeps separate keys apart and releases only the settled one", () => {
    const registry = new TakeRequestRegistry(counting());
    const other = "z1address:aa11:5";

    const first = registry.reserve(KEY);
    const second = registry.reserve(other);
    registry.settle(KEY);

    expect(first).not.toBe(second);
    expect(registry.peek(KEY)).toBeUndefined();
    expect(registry.peek(other)).toBe(second);
    expect(registry.size).toBe(1);
  });

  it("tolerates settling a key it never reserved", () => {
    const registry = new TakeRequestRegistry(counting());

    expect(() => registry.settle(KEY)).not.toThrow();
    expect(registry.size).toBe(0);
  });
});
