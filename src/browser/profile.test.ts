import { describe, expect, it } from "vitest";

import {
  profileFromLocation,
  resetProfileSequence,
  storageNameForProfile
} from "./profile.js";

describe("browser wallet profiles", () => {
  it("uses a named profile so two test traders can remain isolated", () => {
    expect(profileFromLocation("https://example.test/?wallet=maker")).toBe("maker");
    expect(profileFromLocation("https://example.test/?wallet=taker-2")).toBe("taker-2");
    expect(storageNameForProfile("maker")).toBe("zwap-wallet-maker");
  });

  it("defaults predictably and rejects names that could create ambiguous storage", () => {
    expect(profileFromLocation("https://example.test/")).toBe("default");
    for (const value of ["../maker", "Maker", "a b", "", "a".repeat(33)]) {
      expect(() => profileFromLocation(`https://example.test/?wallet=${encodeURIComponent(value)}`))
        .toThrow("Invalid wallet profile");
    }
  });

  it("erases the live signing key inside the lock and tears down afterwards", async () => {
    // Regression: `resetProfile` used to delete the database on its own,
    // leaving a derived key pair, a signer and a trade runtime alive for a
    // wallet whose seed no longer exists.
    const order: string[] = [];
    await resetProfileSequence({
      runLocked: async (action) => {
        order.push("lock");
        try {
          return await action();
        } finally {
          order.push("unlock");
        }
      },
      forgetWallet: () => order.push("forget"),
      resetDatabase: async () => { order.push("reset"); },
      teardown: async () => { order.push("teardown"); }
    });

    expect(order).toEqual(["lock", "forget", "reset", "unlock", "teardown"]);
  });

  it("still tears down when the database reset fails", async () => {
    const order: string[] = [];
    await expect(resetProfileSequence({
      runLocked: (action) => action(),
      forgetWallet: () => order.push("forget"),
      resetDatabase: async () => { throw new Error("blocked by another open profile tab"); },
      teardown: async () => { order.push("teardown"); }
    })).rejects.toThrow("blocked by another open profile tab");

    expect(order).toEqual(["forget", "teardown"]);
  });
});
