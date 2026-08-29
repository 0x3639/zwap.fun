// @vitest-environment node
import { describe, expect, it } from "vitest";

import { MemoryStorageDriver } from "../storage/driver.js";
import { KeystoreRepository } from "../zenon/keystore-repository.js";
import { composeKeystore } from "./keystore-compose.js";
import { withAccountLock, withKeystoreLock, withKeystoreWriteLock } from "./lock.js";

/** Resolves to "timed-out" rather than hanging the suite on a deadlock. */
async function within<T>(
  budgetMs: number,
  action: () => Promise<T>
): Promise<T | "timed-out"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      action(),
      new Promise<"timed-out">((resolve) => {
        timer = setTimeout(() => resolve("timed-out"), budgetMs);
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

describe("keystore composition", () => {
  it("creates a wallet from inside the account lock the facade holds", async () => {
    // `window.zwap.createWallet` runs `withAccountLock(profile, …)`, and the
    // keystore's encrypted driver re-acquires its own runner underneath. The
    // two locks must be different names or this never returns.
    const keystore = composeKeystore(new MemoryStorageDriver(), "maker");

    const created = await within(2_000, () =>
      withAccountLock("maker", () => keystore.create()));

    expect(created).not.toBe("timed-out");
    expect((created as { address: string }).address)
      .toMatch(/^z1[02-9ac-hj-np-z]{38}$/);
  }, 10_000);

  it("reads back through the account lock the same way", async () => {
    const keystore = composeKeystore(new MemoryStorageDriver(), "taker");
    await keystore.create();

    const mnemonic = await within(2_000, () =>
      withAccountLock("taker", () => keystore.revealMnemonic("REVEAL SEED")));

    expect(mnemonic).not.toBe("timed-out");
    expect(String(mnemonic).split(" ")).toHaveLength(24);
  }, 10_000);

  it("lets the account lock serialize two racing wallet creations", async () => {
    // The keystore's own lock guards its encrypted namespace, not the
    // check-then-write in `create()`. The account lock the facade holds is
    // what makes a double click produce one wallet — and it can only do that
    // because the two locks no longer wait on each other.
    const keystore = composeKeystore(new MemoryStorageDriver(), "solo");

    const settled = await within(2_000, () => Promise.allSettled([
      withAccountLock("solo", () => keystore.create()),
      withAccountLock("solo", () => keystore.create())
    ]));

    expect(settled).not.toBe("timed-out");
    const results = settled as PromiseSettledResult<{ address: string }>[];
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(String((rejected[0] as PromiseRejectedResult).reason))
      .toMatch(/already exists/);
  }, 10_000);

  it("keeps the keystore lock distinct from the account lock", async () => {
    const order: string[] = [];
    const port = {
      request: async (
        name: string,
        _options: { mode: "exclusive" },
        callback: () => Promise<unknown>
      ) => {
        order.push(name);
        return callback();
      }
    };

    await withAccountLock("maker", async () => undefined, port);
    await withKeystoreLock("maker", async () => undefined, port);

    expect(order).toEqual(["zwap-account-maker-write", "zwap-keystore-maker"]);
  });

  it("hands back a real KeystoreRepository", () => {
    expect(composeKeystore(new MemoryStorageDriver(), "maker"))
      .toBeInstanceOf(KeystoreRepository);
  });
  it("serializes racing creations with no account lock held at all", async () => {
    // The account lock is the facade's doing; the keystore must not depend on
    // it. Its own write lock has to be enough.
    const keystore = composeKeystore(new MemoryStorageDriver(), "bare");

    const settled = await within(2_000, () => Promise.allSettled([
      keystore.create(),
      keystore.create()
    ]));

    expect(settled).not.toBe("timed-out");
    const results = settled as PromiseSettledResult<{ address: string }>[];
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(String(
      (results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason
    )).toMatch(/already exists/);
  }, 10_000);

  it("keeps the keystore write lock distinct from the account and driver locks", async () => {
    const order: string[] = [];
    const port = {
      request: async (
        name: string,
        _options: { mode: "exclusive" },
        callback: () => Promise<unknown>
      ) => {
        order.push(name);
        return callback();
      }
    };

    await withAccountLock("maker", async () => undefined, port);
    await withKeystoreLock("maker", async () => undefined, port);
    await withKeystoreWriteLock("maker", async () => undefined, port);

    expect(order).toEqual([
      "zwap-account-maker-write",
      "zwap-keystore-maker",
      "zwap-keystore-maker-write"
    ]);
    expect(new Set(order).size).toBe(3);
  });
});
