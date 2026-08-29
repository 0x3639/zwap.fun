import { describe, expect, it, vi } from "vitest";

import { startInboxListeners } from "./startup.js";

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
}

describe("browser inbox startup", () => {
  it("starts the maker and persisted session inboxes together", async () => {
    const startSessions = vi.fn(async () => undefined);
    const startMaker = vi.fn(async () => undefined);

    await startInboxListeners({ startSessions, startMaker });

    expect(startSessions).toHaveBeenCalledOnce();
    expect(startMaker).toHaveBeenCalledOnce();
  });

  it("waits for both inbox startup tasks to finish", async () => {
    let releaseSessions!: () => void;
    let releaseMaker!: () => void;
    const sessions = new Promise<void>((resolve) => { releaseSessions = resolve; });
    const maker = new Promise<void>((resolve) => { releaseMaker = resolve; });
    const startup = startInboxListeners({
      startSessions: vi.fn(() => sessions),
      startMaker: vi.fn(() => maker)
    });
    let settled = false;
    void startup.then(() => { settled = true; });

    // `vi.waitFor` would return on the first passing poll, which proves
    // nothing about a promise that is *supposed* to stay pending. Drain the
    // microtask queue explicitly, then assert.
    await flushMicrotasks();
    expect(settled).toBe(false);
    releaseSessions();
    await flushMicrotasks();
    expect(settled).toBe(false);
    releaseMaker();
    await startup;
    expect(settled).toBe(true);
  });
});
