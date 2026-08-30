import { describe, expect, it, vi } from "vitest";

import {
  withOrderOutboxLock,
  withTradeSessionLock,
  withTradeSessionStorageLock,
  withAccountLock,
  type LockPort
} from "./lock.js";

describe("wallet mutation lock", () => {
  it("serializes work under an exclusive Web Lock", async () => {
    const request = vi.fn(async (
      _name: string,
      _options: { mode: "exclusive" },
      callback: () => Promise<unknown>
    ) => callback());
    const locks: LockPort = { request };

    await expect(withAccountLock(async () => "done", locks)).resolves.toBe("done");
    expect(request).toHaveBeenCalledWith(
      "zwap-account-default-write",
      { mode: "exclusive" },
      expect.any(Function)
    );
  });

  it("serializes work in one page when Web Locks are unavailable", async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = withAccountLock(async () => {
      events.push("first-start");
      await firstStarted;
      events.push("first-end");
      return "first";
    }, undefined);
    const second = withAccountLock(async () => {
      events.push("second");
      return "second";
    }, undefined);

    await Promise.resolve();
    expect(events).toEqual(["first-start"]);
    releaseFirst();
    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
    expect(events).toEqual(["first-start", "first-end", "second"]);
  });
});

describe("order outbox mutation lock", () => {
  it("uses a separate exclusive Web Lock", async () => {
    const request = vi.fn(async (
      _name: string,
      _options: { mode: "exclusive" },
      callback: () => Promise<unknown>
    ) => callback());
    const locks: LockPort = { request };

    await expect(withOrderOutboxLock(async () => "done", locks)).resolves.toBe("done");
    expect(request).toHaveBeenCalledWith(
      "zwap-order-outbox-default-write",
      { mode: "exclusive" },
      expect.any(Function)
    );
  });
});

describe("trade session mutation lock", () => {
  it("uses an exclusive session-scoped Web Lock", async () => {
    const request = vi.fn(async (
      _name: string,
      _options: { mode: "exclusive" },
      callback: () => Promise<unknown>
    ) => callback());
    const locks: LockPort = { request };
    const sessionId = "ab".repeat(32);

    await expect(withTradeSessionLock(
      sessionId,
      async () => "done",
      locks
    )).resolves.toBe("done");
    expect(request).toHaveBeenCalledWith(
      `zwap-trade-default-${sessionId}-write`,
      { mode: "exclusive" },
      expect.any(Function)
    );
  });

  it("rejects a malformed session lock name", async () => {
    const locks: LockPort = { request: vi.fn() };

    await expect(withTradeSessionLock("not-a-session", async () => {}, locks))
      .rejects.toThrow("session");
    expect(locks.request).not.toHaveBeenCalled();
  });
});

describe("trade session storage lock", () => {
  it("uses one global lock for the shared session array", async () => {
    const request = vi.fn(async (
      _name: string,
      _options: { mode: "exclusive" },
      callback: () => Promise<unknown>
    ) => callback());
    const locks: LockPort = { request };

    await expect(withTradeSessionStorageLock(
      async () => "done",
      locks
    )).resolves.toBe("done");
    expect(request).toHaveBeenCalledWith(
      "zwap-trade-default-storage-write",
      { mode: "exclusive" },
      expect.any(Function)
    );
  });
});
