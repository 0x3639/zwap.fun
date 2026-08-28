import { describe, expect, it } from "vitest";

import { IndexedDbStorageDriver, MemoryStorageDriver } from "./driver.js";

describe("memory storage driver", () => {
  it("round-trips structured values without sharing references", async () => {
    const driver = new MemoryStorageDriver();
    expect(await driver.get("absent")).toBeUndefined();

    const stored = { nested: { amount: "9007199254740993" }, list: [1, 2] };
    await driver.set("key", stored);
    stored.nested.amount = "mutated-after-write";

    const first = await driver.get("key") as typeof stored;
    expect(first).toEqual({ nested: { amount: "9007199254740993" }, list: [1, 2] });
    first.nested.amount = "mutated-after-read";
    expect(await driver.get("key")).toEqual({
      nested: { amount: "9007199254740993" },
      list: [1, 2]
    });
  });

  it("deletes only the named key", async () => {
    const driver = new MemoryStorageDriver();
    await driver.set("a", 1);
    await driver.set("b", 2);

    await driver.delete("a");

    expect(await driver.get("a")).toBeUndefined();
    expect(await driver.get("b")).toBe(2);
    await expect(driver.delete("absent")).resolves.toBeUndefined();
  });
});

describe("indexed db storage driver", () => {
  it("defaults to the zwap wallet database and private store", () => {
    const driver = new IndexedDbStorageDriver();
    expect(driver).toMatchObject({
      databaseName: "zwap-wallet",
      storeName: "private-wallet"
    });
  });
});
