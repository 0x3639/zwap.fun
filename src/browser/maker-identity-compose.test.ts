// @vitest-environment node
import { describe, expect, it } from "vitest";

import { MakerIdentity } from "../nostr/identity.js";
import { MemoryStorageDriver } from "../storage/driver.js";
import {
  withAccountLock,
  withKeystoreLock,
  withMakerIdentityLock,
  withMakerIdentityWriteLock
} from "./lock.js";
import { composeMakerIdentity } from "./maker-identity-compose.js";

const ORDER_ID = "3f1d2c4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";

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

async function dump(raw: MemoryStorageDriver): Promise<string> {
  const entries: unknown[] = [];
  for (const key of [
    "zwap.nostr.order-keys.v1",
    "zwap.maker-identity.data.zwap.nostr.order-keys.v1"
  ]) entries.push(await raw.get(key));
  return JSON.stringify(entries);
}

describe("maker identity composition", () => {
  it("hands back a real MakerIdentity", () => {
    expect(composeMakerIdentity(new MemoryStorageDriver(), "maker"))
      .toBeInstanceOf(MakerIdentity);
  });

  it("never writes an order secret key to the raw driver in the clear", async () => {
    const raw = new MemoryStorageDriver();
    const identity = composeMakerIdentity(raw, "maker");

    const publicKey = await identity.publicKey(ORDER_ID);
    const secretKey = await identity.useOrderSecretKey(
      ORDER_ID,
      async (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
    );

    expect(publicKey).toMatch(/^[0-9a-f]{64}$/);
    expect(secretKey).toMatch(/^[0-9a-f]{64}$/);
    const raws = await dump(raw);
    expect(raws).not.toContain(secretKey);
    expect(raws).not.toContain(ORDER_ID);
    // The plaintext key is gone entirely - the encrypted namespace holds it.
    await expect(raw.get("zwap.nostr.order-keys.v1")).resolves.toBeUndefined();
  });

  it("ignores a pre-existing plaintext order-key record", async () => {
    const raw = new MemoryStorageDriver();
    await raw.set("zwap.nostr.order-keys.v1", {
      version: 1,
      keys: { [ORDER_ID]: "11".repeat(32) }
    });
    const identity = composeMakerIdentity(raw, "maker");

    await expect(identity.listOrderIds()).resolves.toEqual([]);
  });

  it("works from inside the account lock the facade holds", async () => {
    const identity = composeMakerIdentity(new MemoryStorageDriver(), "maker");

    const publicKey = await within(2_000, () =>
      withAccountLock("maker", () => identity.publicKey(ORDER_ID)));

    expect(publicKey).not.toBe("timed-out");
    expect(publicKey).toMatch(/^[0-9a-f]{64}$/);
  }, 10_000);

  it("keeps the maker identity lock distinct from the account and keystore locks", async () => {
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
    await withMakerIdentityLock("maker", async () => undefined, port);
    await withMakerIdentityWriteLock("maker", async () => undefined, port);

    expect(order).toEqual([
      "zwap-account-maker-write",
      "zwap-keystore-maker",
      "zwap-maker-identity-maker",
      "zwap-maker-identity-maker-write"
    ]);
    expect(new Set(order).size).toBe(4);
  });
});
