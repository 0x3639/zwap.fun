import { describe, expect, it, vi } from "vitest";

import type { CoordinatorAction } from "./coordinator-plan.js";
import {
  TradeCoordinator,
  type CoordinatorEffectPort,
  type CoordinatorSessionRepository,
  type RunCoordinatorSessionExclusive
} from "./coordinator.js";
import type { TradeSession } from "./session.js";
import {
  FIXTURE_COUNTERPARTY_ADDRESS,
  FIXTURE_LOCAL_ADDRESS,
  FIXTURE_ORDER_ID,
  FIXTURE_SESSION_PRIVATE_KEY,
  sessionFixture
} from "./test-fixtures.js";

function clone<T>(value: T): T {
  return structuredClone(value);
}

const ANCHOR = 1_800_000_000;

/**
 * The shared storage-valid fixture, retimed onto this suite's clock and frozen
 * in the terminal `failed` choreography so `nextCoordinatorAction` reports
 * `none` unless a test moves the session somewhere else.
 */
function session(): TradeSession {
  return sessionFixture({
    createdAt: ANCHOR,
    updatedAt: ANCHOR,
    plan: {
      anchor: ANCHOR,
      shortLocktime: ANCHOR + 600,
      makerClaimCutoff: ANCHOR + 480,
      longLocktime: ANCHOR + 1_200,
      takerClaimCutoff: ANCHOR + 1_080,
      reservationExpiresAt: ANCHOR + 1_800,
      refundGuardSeconds: 60
    },
    evidence: {
      reservation: {
        abortSeal: {
          kind: 13,
          created_at: ANCHOR,
          tags: [],
          content: "encrypted-abort-secret",
          id: "44".repeat(32),
          pubkey: "55".repeat(32),
          sig: "66".repeat(64)
        }
      }
    },
    privateState: {
      inbox: {
        stagedAt: ANCHOR,
        acknowledgedAt: ANCHOR,
        registeredAt: ANCHOR,
        readbacks: []
      },
      transcript: { choreography: { phase: "failed" } }
    }
  });
}

class MemorySessionRepository implements CoordinatorSessionRepository {
  readonly save = vi.fn(async (
    next: TradeSession,
    expectedRevision: number | null
  ): Promise<void> => {
    const current = this.value;
    if (current === undefined || expectedRevision === null) {
      throw new Error("Test repository requires an existing CAS revision");
    }
    if (current.revision !== expectedRevision) {
      throw new Error("Trade session compare-and-swap revision failed");
    }
    if (next.revision !== expectedRevision + 1) {
      throw new Error("Trade session revision must advance exactly one step");
    }
    if (next.updatedAt < current.updatedAt) {
      throw new Error("Trade session update time regressed");
    }
    this.value = clone(next);
  });

  constructor(private value: TradeSession | undefined) {}

  async list(): Promise<TradeSession[]> {
    return this.value === undefined ? [] : [clone(this.value)];
  }

  async get(sessionId: string): Promise<TradeSession | undefined> {
    return this.value?.sessionId === sessionId ? clone(this.value) : undefined;
  }
}

function stagedInbox(current = session()): TradeSession {
  current.privateState.inbox.status = "staged";
  current.privateState.inbox.receipts = [];
  current.privateState.inbox.readbacks = [];
  current.privateState.inbox.acknowledgedAt = null;
  current.privateState.inbox.registeredAt = null;
  return current;
}

function acknowledgeInbox(current: TradeSession, now: number): TradeSession {
  const next = clone(current);
  next.revision += 1;
  next.updatedAt = now;
  next.privateState.inbox.status = "acknowledged";
  next.privateState.inbox.receipts = [{
    relay: next.privateState.inbox.discoveryRelays[0]!,
    ok: true,
    message: "stored"
  }];
  next.privateState.inbox.acknowledgedAt = now;
  return next;
}

function port(
  overrides: Partial<CoordinatorEffectPort> = {}
): CoordinatorEffectPort {
  return {
    classify: () => "local",
    applyLocal: async ({ session: current, now }) => ({
      ...clone(current),
      revision: current.revision + 1,
      updatedAt: now
    }),
    performExternal: async ({ session: current, now }) =>
      acknowledgeInbox(current, now),
    ...overrides
  };
}

function trackingSessionLock(): {
  run: RunCoordinatorSessionExclusive;
  isHeld: () => boolean;
} {
  let held = false;
  let tail = Promise.resolve();
  return {
    isHeld: () => held,
    run: async <T>(_sessionId: string, action: () => Promise<T>): Promise<T> => {
      const previous = tail;
      let release = (): void => {};
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      held = true;
      try {
        return await action();
      } finally {
        held = false;
        release();
      }
    }
  };
}

describe("durable trade coordinator shell", () => {
  it("lists and gets only redacted views, while none performs no save or effect", async () => {
    const repository = new MemorySessionRepository(session());
    const effects = port({
      applyLocal: vi.fn(),
      performExternal: vi.fn()
    });
    const coordinator = new TradeCoordinator({
      repository,
      effects,
      now: () => 1_800_000_100
    });

    const [listed] = await coordinator.list();
    const found = await coordinator.get(session().sessionId);
    const advanced = await coordinator.advance(session().sessionId);

    for (const view of [listed, found, advanced]) {
      const serialized = JSON.stringify(view);
      expect(serialized).not.toContain("privateState");
      expect(serialized).not.toContain("encrypted-abort-secret");
      expect(serialized).not.toContain(FIXTURE_SESSION_PRIVATE_KEY);
      expect(view?.evidence.reservation.abortSealId).toBe("44".repeat(32));
    }
    expect(repository.save).not.toHaveBeenCalled();
    expect(effects.applyLocal).not.toHaveBeenCalled();
    expect(effects.performExternal).not.toHaveBeenCalled();
  });

  it("runs a local staging transition and one CAS save under the session lock", async () => {
    const current = session();
    current.privateState.inbox = {
      status: "unregistered",
      quorum: 1,
      event: null,
      discoveryRelays: [],
      inboxRelays: [],
      receipts: [],
      readbacks: [],
      stagedAt: null,
      acknowledgedAt: null,
      registeredAt: null
    };
    const repository = new MemorySessionRepository(current);
    const lock = trackingSessionLock();
    const applyLocal = vi.fn(async ({
      action,
      session: before,
      now
    }: {
      action: CoordinatorAction;
      session: TradeSession;
      now: number;
    }) => {
      expect(lock.isHeld()).toBe(true);
      expect(action.kind).toBe("stage_inbox_registration");
      const next = stagedInbox(clone(before));
      next.revision += 1;
      next.updatedAt = now;
      return next;
    });
    const performExternal = vi.fn();
    const effects = port({ applyLocal, performExternal });
    const coordinator = new TradeCoordinator({
      repository,
      effects,
      now: () => 1_800_000_100,
      runSessionExclusive: lock.run
    });

    const view = await coordinator.advance(current.sessionId);

    expect(view.revision).toBe(1);
    expect(applyLocal).toHaveBeenCalledTimes(1);
    expect(repository.save).toHaveBeenCalledTimes(1);
    expect(performExternal).not.toHaveBeenCalled();
  });

  it("rejects an external action without its complete persisted checkpoint", async () => {
    const current = stagedInbox();
    current.privateState.inbox.event = null;
    const repository = new MemorySessionRepository(current);
    const performExternal = vi.fn();
    const coordinator = new TradeCoordinator({
      repository,
      effects: port({
        classify: () => "external",
        performExternal
      }),
      now: () => 1_800_000_100
    });

    await expect(coordinator.advance(current.sessionId))
      .rejects.toThrow(/persisted.*checkpoint/i);
    expect(performExternal).not.toHaveBeenCalled();
    expect(repository.save).not.toHaveBeenCalled();
  });

  it("releases the session lock for one external effect and coalesces same-session calls", async () => {
    const current = stagedInbox();
    const repository = new MemorySessionRepository(current);
    const lock = trackingSessionLock();
    let releaseEffect = (): void => {};
    const effectGate = new Promise<void>((resolve) => {
      releaseEffect = resolve;
    });
    let effectStarted = (): void => {};
    const started = new Promise<void>((resolve) => {
      effectStarted = resolve;
    });
    const performExternal = vi.fn(async (input) => {
      expect(lock.isHeld()).toBe(false);
      expect(input.action).toEqual({ kind: "publish_inbox_registration" });
      expect(input.revision).toBe(0);
      expect(input.fingerprint).toMatch(/publish_inbox_registration/);
      effectStarted();
      await effectGate;
      return acknowledgeInbox(input.session, input.now);
    });
    const coordinator = new TradeCoordinator({
      repository,
      effects: port({
        classify: () => "external",
        performExternal
      }),
      now: () => 1_800_000_100,
      runSessionExclusive: lock.run
    });

    const first = coordinator.advance(current.sessionId);
    await started;
    const second = coordinator.advance(current.sessionId);
    releaseEffect();
    const [left, right] = await Promise.all([first, second]);

    expect(left).toEqual(right);
    expect(performExternal).toHaveBeenCalledTimes(1);
    expect(repository.save).toHaveBeenCalledTimes(1);
  });

  it("converges when another retry has already saved the exact external result", async () => {
    const current = stagedInbox();
    const repository = new MemorySessionRepository(current);
    const coordinator = new TradeCoordinator({
      repository,
      effects: port({
        classify: () => "external",
        performExternal: async ({ session: before, now }) => {
          const result = acknowledgeInbox(before, now);
          await repository.save(result, before.revision);
          return result;
        }
      }),
      now: () => 1_800_000_100
    });

    await expect(coordinator.advance(current.sessionId))
      .resolves.toMatchObject({ revision: 1 });
    expect(repository.save).toHaveBeenCalledTimes(1);
  });

  it("fails closed when concurrent state conflicts with the external result", async () => {
    const current = stagedInbox();
    const repository = new MemorySessionRepository(current);
    const coordinator = new TradeCoordinator({
      repository,
      effects: port({
        classify: () => "external",
        performExternal: async ({ session: before, now }) => {
          const result = acknowledgeInbox(before, now);
          const conflict = clone(result);
          conflict.terms.quoteAmount = "2";
          await repository.save(conflict, before.revision);
          return result;
        }
      }),
      now: () => 1_800_000_100
    });

    await expect(coordinator.advance(current.sessionId))
      .rejects.toThrow(/conflicting concurrent state/i);
    expect(repository.save).toHaveBeenCalledTimes(1);
  });

  it("rejects effect results that do not preserve the snapshotted session identity", async () => {
    const current = stagedInbox();
    const repository = new MemorySessionRepository(current);
    const coordinator = new TradeCoordinator({
      repository,
      effects: port({
        classify: () => "external",
        performExternal: async ({ session: before, now }) => ({
          ...acknowledgeInbox(before, now),
          sessionId: "aa".repeat(32)
        })
      }),
      now: () => 1_800_000_100
    });

    await expect(coordinator.advance(current.sessionId))
      .rejects.toThrow(/session identity/i);
    expect(repository.save).not.toHaveBeenCalled();
  });

  it("fingerprints chain preparation with the persisted expected HTLC terms", async () => {
    const current = session();
    current.privateState.transcript.choreography.phase = "awaiting_base_lock";
    current.privateState.settlementTranscriptHash = "ab".repeat(32);
    current.privateState.htlcHash = "cd".repeat(32);
    current.privateState.legs.base.expected = {
      leg: "base",
      chainId: current.terms.chainId,
      tokenStandard: current.terms.baseToken,
      amount: current.terms.baseAmount,
      hashLock: current.privateState.htlcHash,
      hashType: 1,
      keyMaxSize: 32,
      hashLockedAddress: FIXTURE_COUNTERPARTY_ADDRESS,
      timeLockedAddress: FIXTURE_LOCAL_ADDRESS,
      expirationTime: current.plan.longLocktime,
      binding: {
        protocolVersion: "1",
        network: "zenon-1-v1",
        orderId: FIXTURE_ORDER_ID,
        sessionId: current.sessionId,
        reservationId: current.reservationId,
        transcriptHash: current.privateState.settlementTranscriptHash
      }
    };
    const repository = new MemorySessionRepository(current);
    const externalFingerprintMaterial = vi.fn(async () => ({
      reservationRevision: 4,
      address: FIXTURE_LOCAL_ADDRESS
    }));
    const performExternal = vi.fn(async (input) => ({
      ...clone(input.session),
      revision: input.revision + 1,
      updatedAt: input.now
    }));
    const coordinator = new TradeCoordinator({
      repository,
      effects: port({
        classify: () => "external",
        externalFingerprintMaterial,
        performExternal
      }),
      now: () => 1_800_000_100
    });

    await coordinator.advance(current.sessionId);

    expect(externalFingerprintMaterial).toHaveBeenCalledWith(
      { kind: "prepare_base_lock" },
      expect.objectContaining({ revision: 0 })
    );
    expect(performExternal).toHaveBeenCalledWith(expect.objectContaining({
      action: { kind: "prepare_base_lock" },
      revision: 0,
      fingerprint: expect.stringMatching(/^prepare_base_lock:/)
    }));
  });
  /**
   * The protocol's "base" slot is the maker's offered leg. On a buy-side order
   * that leg is the market *quote* leg, and the effects apply `slotLeg` to get
   * there. The pre-effect checkpoint has to look at the same leg or it
   * validates - and fingerprints - the wrong half of the swap.
   */
  function settlingBuySession(): TradeSession {
    const current = session();
    current.orderSide = "buy";
    current.privateState.transcript.choreography.phase = "awaiting_settlement_ack";
    // Market base leg = protocol quote slot on a buy: already claimed.
    current.evidence.legs.base.htlcState = "UNLOCKED";
    current.evidence.legs.base.observedAt = ANCHOR + 10;
    current.evidence.legs.base.spendCommitment = "ee".repeat(32);
    current.privateState.legs.base.observations = [{
      observedAt: ANCHOR + 10,
      state: "UNLOCKED",
      witnessCommitment: "ee".repeat(32)
    }];
    // Market quote leg = protocol base slot on a buy: locked, still to observe.
    current.privateState.legs.quote.htlcId = "77".repeat(32);
    current.evidence.legs.quote.htlcId = "77".repeat(32);
    current.evidence.legs.quote.htlcState = "LOCKED";
    return current;
  }

  it("checkpoints observe_base against the flipped leg of a buy-side session", async () => {
    const current = settlingBuySession();
    const repository = new MemorySessionRepository(current);
    const performExternal = vi.fn(async (input) => ({
      ...clone(input.session),
      revision: input.revision + 1,
      updatedAt: input.now
    }));
    const coordinator = new TradeCoordinator({
      repository,
      effects: port({ classify: () => "external", performExternal }),
      now: () => 1_800_000_100
    });

    await coordinator.advance(current.sessionId);

    expect(performExternal).toHaveBeenCalledWith(expect.objectContaining({
      action: { kind: "observe_base" }
    }));
  });

  it("still rejects observe_base when the buy-side protocol base slot has no lock", async () => {
    const current = settlingBuySession();
    current.privateState.legs.quote.htlcId = null;
    current.evidence.legs.quote.htlcId = null;
    const repository = new MemorySessionRepository(current);
    const performExternal = vi.fn();
    const coordinator = new TradeCoordinator({
      repository,
      effects: port({ classify: () => "external", performExternal }),
      now: () => 1_800_000_100
    });

    await expect(coordinator.advance(current.sessionId))
      .rejects.toThrow(/observe_base requires a complete persisted pre-effect checkpoint/i);
    expect(performExternal).not.toHaveBeenCalled();
  });
});
