import { describe, expect, it } from "vitest";

import { MemoryStorageDriver } from "../storage/driver.js";
import { FundsReservationRepository, reservedAmount } from "./funds-reservations.js";
import { ZNN_ZTS, QSR_ZTS } from "./types.js";

describe("FundsReservationRepository", () => {
  it("reserves once per session with optimistic revisions", async () => {
    const repo = new FundsReservationRepository(new MemoryStorageDriver());
    const empty = await repo.load();
    expect(empty).toEqual({ version: 1, revision: 0, reservations: [] });
    const one = await repo.reserve(0, { sessionId: "s1", tokenStandard: ZNN_ZTS, amount: "5", reservedAt: 1 });
    expect(one.revision).toBe(1);
    await expect(repo.reserve(0, { sessionId: "s2", tokenStandard: ZNN_ZTS, amount: "5", reservedAt: 1 })).rejects.toThrow(/revision/);
    await expect(repo.reserve(1, { sessionId: "s1", tokenStandard: ZNN_ZTS, amount: "5", reservedAt: 1 })).rejects.toThrow(/already/);
    const two = await repo.reserve(1, { sessionId: "s2", tokenStandard: ZNN_ZTS, amount: "7", reservedAt: 1 });
    expect(reservedAmount(two, ZNN_ZTS)).toBe(12n);
    expect(reservedAmount(two, ZNN_ZTS, "s1")).toBe(7n);
    const released = await repo.release(2, { sessionId: "s1" });
    expect(released.reservations.map((r) => r.sessionId)).toEqual(["s2"]);
  });

  it("keeps reservations per token standard and survives a reload", async () => {
    const driver = new MemoryStorageDriver();
    const repo = new FundsReservationRepository(driver);
    await repo.reserve(0, { sessionId: "s1", tokenStandard: ZNN_ZTS, amount: "5", reservedAt: 1 });
    await repo.reserve(1, { sessionId: "s2", tokenStandard: QSR_ZTS, amount: "9", reservedAt: 2 });

    const reloaded = await new FundsReservationRepository(driver).load();
    expect(reloaded.revision).toBe(2);
    expect(reservedAmount(reloaded, ZNN_ZTS)).toBe(5n);
    expect(reservedAmount(reloaded, QSR_ZTS)).toBe(9n);
    expect(reservedAmount(reloaded, QSR_ZTS, "s2")).toBe(0n);
  });

  it("refuses a release at a stale revision and tolerates an unknown session", async () => {
    const repo = new FundsReservationRepository(new MemoryStorageDriver());
    await repo.reserve(0, { sessionId: "s1", tokenStandard: ZNN_ZTS, amount: "5", reservedAt: 1 });
    await expect(repo.release(0, { sessionId: "s1" })).rejects.toThrow(/revision/);
    const unchanged = await repo.release(1, { sessionId: "absent" });
    expect(unchanged.reservations.map((r) => r.sessionId)).toEqual(["s1"]);
    expect(unchanged.revision).toBe(2);
  });

  it("fails closed on corrupt persisted state", async () => {
    const driver = new MemoryStorageDriver();
    await driver.set("zwap.funds-reservations.v1", { version: 2, revision: 0, reservations: [] });
    await expect(new FundsReservationRepository(driver).load())
      .rejects.toThrow(/Corrupt funds reservation state/);

    const badEntry = new MemoryStorageDriver();
    await badEntry.set("zwap.funds-reservations.v1", {
      version: 1,
      revision: 1,
      reservations: [{ sessionId: "s1", tokenStandard: "not-a-zts", amount: "5", reservedAt: 1 }]
    });
    await expect(new FundsReservationRepository(badEntry).load())
      .rejects.toThrow(/Corrupt funds reservation entry/);

    const badAmount = new MemoryStorageDriver();
    await badAmount.set("zwap.funds-reservations.v1", {
      version: 1,
      revision: 1,
      reservations: [{ sessionId: "s1", tokenStandard: ZNN_ZTS, amount: "0", reservedAt: 1 }]
    });
    await expect(new FundsReservationRepository(badAmount).load())
      .rejects.toThrow(/Corrupt funds reservation entry/);
  });
});
