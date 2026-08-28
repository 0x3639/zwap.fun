import { finalizeEvent, getEventHash } from "nostr-tools";
import { describe, expect, it } from "vitest";

import { createOrderState, type OrderRecord } from "../order/model.js";
import { deploymentFor, type ZwapTradeMessage } from "../trade/messages.js";
import { publicTradeView, type TradeSession } from "../trade/session.js";
import {
  createTakerSession,
  type SessionFactoryEntropy
} from "../trade/session-factory.js";
import {
  FIXTURE_ANCHOR,
  FIXTURE_COUNTERPARTY_ADDRESS,
  FIXTURE_LOCAL_ADDRESS,
  FIXTURE_MAKER_PUBKEY,
  FIXTURE_MAKER_SECRET,
  FIXTURE_OFFERED_PROJECTION_ID,
  FIXTURE_ORDER_ADDRESS,
  FIXTURE_ORDER_ID,
  FIXTURE_RESERVATION_ID,
  FIXTURE_SESSION_ID,
  FIXTURE_SESSION_PUBKEY,
  FIXTURE_SESSION_SECRET,
  FIXTURE_THIRD_ADDRESS,
  sessionFixture
} from "../trade/test-fixtures.js";
import { QSR_ZTS, ZNN_ZTS } from "../zenon/types.js";
import { MemoryStorageDriver } from "./driver.js";
import { EncryptedStorageDriver } from "./encrypted-storage.js";
import {
  TradeSessionRepository,
  type TakerStartIntent,
  type TradeSessionExclusiveRunner
} from "./trade-session.js";

const STORAGE_KEY = "granola.trade-sessions.v2";

function fixedKey(byte: number): Uint8Array {
  return new Uint8Array(32).fill(byte);
}

function bytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g) ?? [], (part) => Number.parseInt(part, 16));
}

async function sha256Hex(hex: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes(hex) as BufferSource);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

const makerSecret = FIXTURE_MAKER_SECRET;
const sessionSecret = FIXTURE_SESSION_SECRET;
const outerSecret = fixedKey(3);
const remoteSecret = fixedKey(4);
const incomingOuterSecret = fixedKey(5);
const maker = FIXTURE_MAKER_PUBKEY;
const sessionPubkey = FIXTURE_SESSION_PUBKEY;
const remotePubkey = finalizeEvent(
  { kind: 1, created_at: 0, tags: [], content: "" },
  remoteSecret
).pubkey;

const sessionId = FIXTURE_SESSION_ID;
const reservationId = FIXTURE_RESERVATION_ID;
const messageId = "33333333-3333-4333-8333-333333333333";
const acceptedMessageId = "55555555-5555-4555-8555-555555555555";
const acceptedRumorId = "19".repeat(32);
const orderId = FIXTURE_ORDER_ID;
const offeredProjectionId = FIXTURE_OFFERED_PROJECTION_ID;
const orderAddress = FIXTURE_ORDER_ADDRESS;
const operationId = "44444444-4444-4444-8444-444444444444";
const preimage = "04".repeat(32);
const htlcHash = await sha256Hex(preimage);
const baseHtlcId = "1e".repeat(32);
const transcriptHash = "05".repeat(32);

const publicationRelays = [
  "wss://discovery-one.example",
  "wss://discovery-two.example"
];
const inboxRelays = ["wss://inbox-one.example", "wss://inbox-two.example"];
const registration = structuredClone(finalizeEvent({
  kind: 10050,
  created_at: FIXTURE_ANCHOR,
  tags: inboxRelays.map((relay) => ["relay", relay]),
  content: ""
}, sessionSecret));
const wrongRegistrationSigner = structuredClone(finalizeEvent({
  kind: 10050,
  created_at: FIXTURE_ANCHOR,
  tags: inboxRelays.map((relay) => ["relay", relay]),
  content: ""
}, makerSecret));
const projection = structuredClone(finalizeEvent({
  kind: 30078,
  created_at: FIXTURE_ANCHOR + 5,
  tags: [["d", `zwap:order:v1:${orderId}`]],
  content: "exact-signed-order-projection"
}, makerSecret));
const wrapper = structuredClone(finalizeEvent({
  kind: 1059,
  created_at: FIXTURE_ANCHOR,
  tags: [["p", "55".repeat(32)], ["expiration", "1700007200"]],
  content: "encrypted-private-wrapper"
}, outerSecret));
const seal = structuredClone(finalizeEvent({
  kind: 13,
  created_at: FIXTURE_ANCHOR,
  tags: [],
  content: "encrypted-private-seal"
}, sessionSecret));

const outboxMessage: ZwapTradeMessage = {
  schema: "granola/dm/v1",
  deployment: deploymentFor("1"),
  type: "base_lock",
  message_id: messageId,
  session_id: sessionId,
  reservation_id: reservationId,
  order_address: orderAddress,
  order_projection_id: projection.id,
  order_revision: "1",
  maker_order_pubkey: maker,
  author_pubkey: sessionPubkey,
  recipient_pubkey: "55".repeat(32),
  sequence: "1",
  previous_message_id: acceptedMessageId,
  previous_transcript_hash: transcriptHash,
  sent_at: FIXTURE_ANCHOR,
  expires_at: FIXTURE_ANCHOR + 3_600,
  terms_hash: "07".repeat(32),
  body: { htlc_id: baseHtlcId }
};
const rumorTemplate = {
  pubkey: sessionPubkey,
  created_at: FIXTURE_ANCHOR,
  kind: 14 as const,
  tags: [["p", "55".repeat(32)], ["e", acceptedRumorId, "", "reply"]],
  content: JSON.stringify(outboxMessage)
};
const rumor = { ...rumorTemplate, id: getEventHash(rumorTemplate) };
const incomingMessage: ZwapTradeMessage = {
  ...outboxMessage,
  message_id: "77777777-7777-4777-8777-777777777777",
  author_pubkey: remotePubkey,
  recipient_pubkey: sessionPubkey
};
const incomingRumorTemplate = {
  pubkey: remotePubkey,
  created_at: incomingMessage.sent_at,
  kind: 14 as const,
  tags: [["p", sessionPubkey], ["e", acceptedRumorId, "", "reply"]],
  content: JSON.stringify(incomingMessage)
};
const incomingRumor = {
  ...incomingRumorTemplate,
  id: getEventHash(incomingRumorTemplate)
};
const incomingSeal = structuredClone(finalizeEvent({
  kind: 13,
  created_at: FIXTURE_ANCHOR,
  tags: [],
  content: "encrypted-incoming-seal"
}, remoteSecret));
const incomingWrapper = structuredClone(finalizeEvent({
  kind: 1059,
  created_at: FIXTURE_ANCHOR,
  tags: [["p", sessionPubkey], ["expiration", "1700007200"]],
  content: "encrypted-incoming-wrapper"
}, incomingOuterSecret));

const plan = sessionFixture().plan;
const expectedBaseLock = {
  leg: "base" as const,
  chainId: "1",
  tokenStandard: ZNN_ZTS,
  amount: "20",
  hashLock: htlcHash,
  hashType: 1 as const,
  keyMaxSize: 32 as const,
  hashLockedAddress: FIXTURE_COUNTERPARTY_ADDRESS,
  timeLockedAddress: FIXTURE_LOCAL_ADDRESS,
  expirationTime: plan.longLocktime,
  binding: {
    protocolVersion: "1" as const,
    network: "zenon-1",
    orderId,
    reservationId,
    sessionId,
    transcriptHash
  }
};

const session: TradeSession = sessionFixture({
  phase: "base_locked",
  reserveProjectionId: projection.id,
  reserveProjectionRevision: "1",
  pendingOrderPublication: {
    operation: "reserve",
    orderId,
    projection,
    receipts: publicationRelays.map((relay) => ({ relay, ok: true, message: "stored" })),
    status: "acknowledged",
    stagedAt: FIXTURE_ANCHOR + 5,
    acknowledgedAt: FIXTURE_ANCHOR + 6,
    committedAt: null
  },
  evidence: {
    commitments: [htlcHash],
    chainStates: ["base:LOCKED"],
    reserveProjectionId: projection.id,
    reserveProjectionRevision: "1",
    reservation: {
      proposalSealId: seal.id,
      takerCommitment: "18".repeat(32),
      abortSeal: null
    },
    legs: {
      base: {
        htlcId: baseHtlcId,
        validationCommitment: "ff".repeat(32),
        htlcState: "LOCKED",
        observedAt: FIXTURE_ANCHOR + 9,
        spendCommitment: null,
        claimOperationCommitment: null,
        refundOperationCommitment: null
      }
    }
  },
  privateState: {
    preimage,
    htlcHash,
    settlementTranscriptHash: transcriptHash,
    inbox: {
      status: "registered",
      quorum: 2,
      event: registration,
      discoveryRelays: publicationRelays,
      inboxRelays,
      receipts: publicationRelays.map((relay) => ({ relay, ok: true, message: "stored" })),
      readbacks: publicationRelays.map((relay) => ({
        relay,
        found: true,
        event: registration,
        observedAt: FIXTURE_ANCHOR + 3
      })),
      stagedAt: FIXTURE_ANCHOR,
      acknowledgedAt: FIXTURE_ANCHOR + 2,
      registeredAt: FIXTURE_ANCHOR + 3
    },
    transcript: {
      choreography: { phase: "awaiting_base_lock_ack" },
      nextSequence: "1",
      lastRumorId: acceptedRumorId,
      lastMessageId: acceptedMessageId,
      lastTranscriptHash: transcriptHash,
      accepted: [{
        sequence: "0",
        messageId: acceptedMessageId,
        rumorId: acceptedRumorId,
        transcriptHash
      }]
    },
    outbox: {
      message: outboxMessage,
      rumor,
      seal,
      wrapper,
      recipientInboxListId: "08".repeat(32),
      recipientRelays: ["wss://auth.example"],
      receipts: [{ relay: "wss://auth.example", ok: true, message: "stored" }],
      nextChoreography: {
        phase: "awaiting_base_lock_ack",
        participants: { makerOrderPubkey: maker },
        refundedLegs: []
      },
      status: "acknowledged"
    },
    chainOperation: {
      operationId,
      leg: "base",
      kind: "lock",
      status: "completed",
      preparedAt: FIXTURE_ANCHOR + 4,
      fundsReserved: true,
      artifact: {
        version: 1,
        kind: "lock",
        chainId: "1",
        tokenStandard: ZNN_ZTS,
        amount: "20",
        htlcId: null,
        expected: structuredClone(expectedBaseLock),
        operationCommitment: "0d".repeat(32)
      },
      result: {
        blockHash: baseHtlcId,
        htlcId: baseHtlcId,
        tokenStandard: ZNN_ZTS,
        amount: "20"
      }
    },
    legs: {
      base: {
        htlcId: baseHtlcId,
        expected: structuredClone(expectedBaseLock),
        observations: [{
          observedAt: FIXTURE_ANCHOR + 9,
          state: "LOCKED",
          witnessCommitment: null
        }]
      }
    }
  }
});

function takerEntropy(id = "12".repeat(32)): SessionFactoryEntropy {
  return {
    sessionId: () => id,
    reservationId: () => "88888888-8888-4888-8888-888888888888",
    privateKey: () => "06".repeat(32),
    htlcMaterial: async () => ({ preimage, hash: htlcHash })
  };
}

async function revisionZeroTaker(id = "12".repeat(32)): Promise<TradeSession> {
  const state = createOrderState({
    orderId,
    createdAt: FIXTURE_ANCHOR - 100,
    expiresAt: FIXTURE_ANCHOR + 777_600,
    side: "sell",
    chainId: "1",
    baseToken: ZNN_ZTS,
    quoteToken: QSR_ZTS,
    amount: "20",
    price: "5000000"
  });
  const record: OrderRecord = {
    address: orderAddress,
    eventId: offeredProjectionId,
    makerPubkey: maker,
    verified: true,
    state
  };
  return createTakerSession({
    order: record,
    expectedOrderProjectionId: offeredProjectionId,
    expectedOrderRevision: "0",
    market: { chainId: "1", baseToken: ZNN_ZTS, quoteToken: QSR_ZTS },
    fillBaseAmount: "20",
    clocks: { localNow: FIXTURE_ANCHOR, chainNow: FIXTURE_ANCHOR },
    localAddress: FIXTURE_COUNTERPARTY_ADDRESS
  }, takerEntropy(id));
}

const takerStartIntent: TakerStartIntent = {
  requestId: "99999999-9999-4999-8999-999999999999",
  address: orderAddress,
  expectedProjectionId: offeredProjectionId,
  expectedRevision: "0",
  fillBaseAmount: "20"
};

describe("zwap trade session repository", () => {
  it("atomically persists and reloads an encrypted exact taker request binding", async () => {
    const raw = new MemoryStorageDriver();
    const repository = new TradeSessionRepository(raw);
    const candidate = await revisionZeroTaker();

    const created = await repository.createTakerForRequest(takerStartIntent, candidate);
    const reloaded = new TradeSessionRepository(raw);

    expect(created).toEqual(candidate);
    expect(await reloaded.getTakerForRequest(takerStartIntent)).toEqual(candidate);
    expect(await reloaded.list()).toEqual([candidate]);
    const decrypted = await new EncryptedStorageDriver(
      raw,
      "granola-trade-sessions"
    ).get(STORAGE_KEY);
    expect(decrypted).toEqual({
      schema: "zwap/trade-session-store/v1",
      sessions: [candidate],
      takerStarts: [{ ...takerStartIntent, sessionId: candidate.sessionId }]
    });
    const rawText = JSON.stringify(
      await raw.get(`granola-trade-sessions.data.${STORAGE_KEY}`)
    );
    expect(rawText).not.toContain(takerStartIntent.requestId);
    expect(rawText).not.toContain(candidate.privateState.nostrPrivateKey);
    expect(rawText).not.toContain(candidate.privateState.localAddress);
  });

  it("returns exact retries and rejects conflicting reuse of a durable request ID", async () => {
    const repository = new TradeSessionRepository(new MemoryStorageDriver());
    const first = await revisionZeroTaker();
    const retryCandidate = await revisionZeroTaker("13".repeat(32));

    await repository.createTakerForRequest(takerStartIntent, first);
    await expect(repository.createTakerForRequest(takerStartIntent, retryCandidate))
      .resolves.toEqual(first);
    await expect(repository.getTakerForRequest({
      ...takerStartIntent,
      fillBaseAmount: "19"
    })).rejects.toThrow(/request ID conflicts/i);
    await expect(repository.createTakerForRequest({
      ...takerStartIntent,
      fillBaseAmount: "19"
    }, retryCandidate)).rejects.toThrow(/request ID conflicts/i);
    expect(await repository.list()).toEqual([first]);
  });

  it("converges a true async request race under the shared storage lock", async () => {
    const repository = new TradeSessionRepository(new MemoryStorageDriver());
    const left = await revisionZeroTaker("14".repeat(32));
    const right = await revisionZeroTaker("15".repeat(32));

    const [first, second] = await Promise.all([
      repository.createTakerForRequest(takerStartIntent, left),
      repository.createTakerForRequest(takerStartIntent, right)
    ]);

    expect(first.sessionId).toBe(second.sessionId);
    expect(await repository.list()).toHaveLength(1);
    expect(await repository.getTakerForRequest(takerStartIntent)).toEqual(first);
  });

  it("idempotently returns one maker session for an exact proposal retry", async () => {
    const repository = new TradeSessionRepository(new MemoryStorageDriver());

    const [first, retried] = await Promise.all([
      repository.createMakerForOrder(session),
      repository.createMakerForOrder(structuredClone(session))
    ]);

    expect(retried).toEqual(first);
    expect(await repository.list()).toEqual([session]);
  });

  it("lets only one taker open a maker session for the same order", async () => {
    const repository = new TradeSessionRepository(new MemoryStorageDriver());
    // A second taker proposing against the same all-or-none order arrives with
    // its own session and reservation IDs, so it is not the idempotent retry
    // above - it is a race for the one reservation the order can grant.
    const competing = sessionFixture({
      sessionId: "77".repeat(32),
      reservationId: "77777777-7777-4777-8777-777777777777"
    });

    await repository.createMakerForOrder(session);

    expect(competing.orderAddress).toBe(session.orderAddress);
    await expect(repository.createMakerForOrder(competing))
      .rejects.toThrow(/already being taken by another trader/i);
    expect(await repository.list()).toEqual([session]);
  });

  it("rejects unknown or bearer fields in the exact request-binding store", async () => {
    const driver = new MemoryStorageDriver();
    const candidate = await revisionZeroTaker();
    await driver.set(STORAGE_KEY, {
      schema: "zwap/trade-session-store/v1",
      sessions: [candidate],
      takerStarts: [{
        ...takerStartIntent,
        sessionId: candidate.sessionId,
        bearer: "must-not-be-stored"
      }]
    });

    await expect(new TradeSessionRepository(driver).list())
      .rejects.toThrow(/unknown fields/i);
  });

  it("durably round-trips the complete crash-recovery journal", async () => {
    const repository = new TradeSessionRepository(new MemoryStorageDriver());

    await repository.save(session, null);
    const restored = await repository.get(session.sessionId);

    expect(restored).toEqual(session);
    expect(restored).not.toBe(session);
  });

  it("round-trips a taker settlement while its announced fill awaits relay verification", async () => {
    const repository = new TradeSessionRepository(new MemoryStorageDriver());
    const awaitingVerification = structuredClone(session);
    awaitingVerification.role = "taker";
    awaitingVerification.phase = "filled";
    awaitingVerification.fillProjectionId = "aa".repeat(32);
    awaitingVerification.evidence.fillProjectionId = null;
    awaitingVerification.pendingOrderPublication = null;
    awaitingVerification.privateState.outbox = null;
    awaitingVerification.privateState.chainOperation = null;
    awaitingVerification.privateState.transcript.choreography.phase = "settled";

    await repository.save(awaitingVerification, null);

    expect(await repository.get(awaitingVerification.sessionId))
      .toEqual(awaitingVerification);
  });

  it("round-trips UNLOCKED evidence only when it is bound to a matching private observation", async () => {
    const repository = new TradeSessionRepository(new MemoryStorageDriver());
    const spent = structuredClone(session);
    spent.evidence.legs.base = {
      ...spent.evidence.legs.base,
      htlcState: "UNLOCKED",
      observedAt: FIXTURE_ANCHOR + 11,
      spendCommitment: "12".repeat(32)
    };
    spent.privateState.legs.base.observations.push({
      observedAt: FIXTURE_ANCHOR + 11,
      state: "UNLOCKED",
      witnessCommitment: "12".repeat(32)
    });

    await repository.save(spent, null);

    expect(await repository.get(spent.sessionId)).toEqual(spent);
  });

  it("orders multiple chain observations made in the same wall-clock second", async () => {
    const repository = new TradeSessionRepository(new MemoryStorageDriver());
    const observedTwice = structuredClone(session);
    observedTwice.privateState.legs.base.observations.push({
      observedAt: FIXTURE_ANCHOR + 9,
      state: "LOCKED",
      witnessCommitment: null
    });

    await repository.save(observedTwice, null);

    expect(await repository.get(observedTwice.sessionId)).toEqual(observedTwice);
  });

  it("round-trips each monotonic inbox registration checkpoint with the exact signed event", async () => {
    const checkpoints: TradeSession["privateState"]["inbox"][] = [
      {
        status: "unregistered",
        quorum: 2,
        event: null,
        discoveryRelays: [],
        inboxRelays: [],
        receipts: [],
        readbacks: [],
        stagedAt: null,
        acknowledgedAt: null,
        registeredAt: null
      },
      {
        status: "staged",
        quorum: 2,
        event: registration,
        discoveryRelays: publicationRelays,
        inboxRelays,
        receipts: [{
          relay: publicationRelays[0]!,
          ok: true,
          message: "stored below quorum"
        }],
        readbacks: [],
        stagedAt: FIXTURE_ANCHOR,
        acknowledgedAt: null,
        registeredAt: null
      },
      {
        status: "acknowledged",
        quorum: 2,
        event: registration,
        discoveryRelays: publicationRelays,
        inboxRelays,
        receipts: publicationRelays.map((relay) => ({ relay, ok: true, message: "stored" })),
        readbacks: [],
        stagedAt: FIXTURE_ANCHOR,
        acknowledgedAt: FIXTURE_ANCHOR + 2,
        registeredAt: null
      },
      session.privateState.inbox
    ];

    for (const inbox of checkpoints) {
      const candidate = structuredClone(session);
      candidate.privateState.inbox = structuredClone(inbox);
      await new TradeSessionRepository(new MemoryStorageDriver()).save(candidate, null);
    }
  });

  it("round-trips an exact pending incoming wrapper and its validation decision", async () => {
    const repository = new TradeSessionRepository(new MemoryStorageDriver());
    const candidate = structuredClone(session);
    candidate.privateState.pendingIncoming = {
      wrapper: structuredClone(incomingWrapper),
      seal: structuredClone(incomingSeal),
      rumor: structuredClone(incomingRumor),
      message: structuredClone(incomingMessage),
      transcriptHash: "1a".repeat(32),
      receivedAt: FIXTURE_ANCHOR + 6,
      validation: {
        status: "validated",
        checkedAt: FIXTURE_ANCHOR + 7,
        error: null
      }
    };
    candidate.privateState.outbox = null;

    await repository.save(candidate, null);

    expect((await repository.get(candidate.sessionId))?.privateState.pendingIncoming)
      .toEqual(candidate.privateState.pendingIncoming);
  });

  it("accepts a durable staged release publication without regenerating the signed projection", async () => {
    const repository = new TradeSessionRepository(new MemoryStorageDriver());
    const candidate = structuredClone(session);
    const releaseProjection = structuredClone(finalizeEvent({
      kind: 30078,
      created_at: FIXTURE_ANCHOR + 5,
      tags: [["d", `zwap:order:v1:${orderId}`]],
      content: "exact-signed-release-projection"
    }, makerSecret));
    candidate.pendingOrderPublication = {
      operation: "release",
      orderId,
      projection: releaseProjection,
      receipts: [{ relay: publicationRelays[0]!, ok: false, message: "offline" }],
      status: "staged",
      stagedAt: FIXTURE_ANCHOR + 5,
      acknowledgedAt: null,
      committedAt: null
    };

    await repository.save(candidate, null);

    expect((await repository.get(candidate.sessionId))?.pendingOrderPublication)
      .toEqual(candidate.pendingOrderPublication);
  });

  it("persists an authenticated abort seal only when the counterparty signed it", async () => {
    const repository = new TradeSessionRepository(new MemoryStorageDriver());
    const candidate = structuredClone(session);
    candidate.privateState.transcript.choreography.participants.takerSessionPubkey =
      remotePubkey;
    candidate.evidence.reservation.abortSeal = structuredClone(incomingSeal);

    await repository.save(candidate, null);

    expect((await repository.get(candidate.sessionId))?.evidence.reservation.abortSeal)
      .toEqual(incomingSeal);

    const corrupt = structuredClone(candidate);
    corrupt.evidence.reservation.abortSeal = structuredClone(seal);
    const driver = new MemoryStorageDriver();
    await driver.set(STORAGE_KEY, [corrupt]);
    await expect(new TradeSessionRepository(driver).list())
      .rejects.toThrow(/counterparty author/i);
  });

  it("binds a completed chain operation result to its prepared artifact", async () => {
    const repository = new TradeSessionRepository(new MemoryStorageDriver());
    await repository.save(session, null);
    expect(session.privateState.chainOperation?.result).toMatchObject({
      blockHash: baseHtlcId,
      htlcId: baseHtlcId,
      tokenStandard: ZNN_ZTS,
      amount: "20"
    });

    for (const mutate of [
      (candidate: TradeSession) => {
        candidate.privateState.chainOperation!.result!.amount = "21";
      },
      (candidate: TradeSession) => {
        candidate.privateState.chainOperation!.result!.tokenStandard = QSR_ZTS;
      },
      (candidate: TradeSession) => {
        candidate.privateState.chainOperation!.result!.blockHash = "not-a-hash";
      }
    ]) {
      const corrupt = structuredClone(session);
      mutate(corrupt);
      const driver = new MemoryStorageDriver();
      await driver.set(STORAGE_KEY, [corrupt]);
      await expect(new TradeSessionRepository(driver).list())
        .rejects.toThrow(/chain operation result/i);
    }
  });

  it("uses compare-and-swap revisions and rejects stale or skipped writes", async () => {
    const repository = new TradeSessionRepository(new MemoryStorageDriver());
    await repository.save(session, null);
    const updated = { ...session, revision: 1, updatedAt: session.updatedAt + 1 };

    await repository.save(updated, 0);
    await expect(repository.save({ ...updated, revision: 2 }, 0))
      .rejects.toThrow("compare-and-swap");
    await expect(repository.save({ ...updated, revision: 3 }, 1))
      .rejects.toThrow("exactly one");
    await expect(repository.save(session, null))
      .rejects.toThrow("already exists");
  });

  it("keeps happy-path effect checkpoints monotonic and requires the timeout state before release", async () => {
    const repository = new TradeSessionRepository(new MemoryStorageDriver());
    await repository.save(session, null);

    const inboxRegression = structuredClone(session);
    inboxRegression.revision = 1;
    inboxRegression.updatedAt += 1;
    inboxRegression.privateState.inbox = {
      ...inboxRegression.privateState.inbox,
      status: "acknowledged",
      readbacks: [],
      registeredAt: null
    };
    await expect(repository.save(inboxRegression, 0)).rejects.toThrow(/inbox.*regress/i);

    const outboxRegression = structuredClone(session);
    outboxRegression.revision = 1;
    outboxRegression.updatedAt += 1;
    outboxRegression.privateState.outbox!.status = "staged";
    await expect(repository.save(outboxRegression, 0)).rejects.toThrow(/outbox.*regress/i);

    const chainRegression = structuredClone(session);
    chainRegression.revision = 1;
    chainRegression.updatedAt += 1;
    chainRegression.privateState.chainOperation!.status = "prepared";
    chainRegression.privateState.chainOperation!.result = null;
    await expect(repository.save(chainRegression, 0)).rejects.toThrow(/chain.*regress/i);

    const publicationRegression = structuredClone(session);
    publicationRegression.revision = 1;
    publicationRegression.updatedAt += 1;
    publicationRegression.pendingOrderPublication!.status = "staged";
    publicationRegression.pendingOrderPublication!.receipts = [];
    publicationRegression.pendingOrderPublication!.acknowledgedAt = null;
    await expect(repository.save(publicationRegression, 0))
      .rejects.toThrow(/publication.*regress/i);

    const earlyRelease = structuredClone(session);
    earlyRelease.revision = 1;
    earlyRelease.updatedAt += 1;
    earlyRelease.phase = "released";
    await expect(repository.save(earlyRelease, 0)).rejects.toThrow(/phase.*checkpoint/i);

    const timeoutCheckpoint = structuredClone(session);
    timeoutCheckpoint.revision = 1;
    timeoutCheckpoint.updatedAt += 1;
    timeoutCheckpoint.phase = "waiting_base_refund";
    await expect(repository.save(timeoutCheckpoint, 0)).resolves.toBeUndefined();
  });

  it("pins staged inbox and outbox retry artifacts across CAS revisions", async () => {
    const inboxRepository = new TradeSessionRepository(new MemoryStorageDriver());
    const stagedInbox = structuredClone(session);
    stagedInbox.privateState.inbox = {
      ...stagedInbox.privateState.inbox,
      status: "staged",
      receipts: [],
      readbacks: [],
      acknowledgedAt: null,
      registeredAt: null
    };
    await inboxRepository.save(stagedInbox, null);

    const retargetedInbox = structuredClone(stagedInbox);
    retargetedInbox.revision = 1;
    retargetedInbox.updatedAt += 1;
    retargetedInbox.privateState.inbox.discoveryRelays = [
      publicationRelays[0]!,
      "wss://different-discovery.example"
    ];
    await expect(inboxRepository.save(retargetedInbox, 0))
      .rejects.toThrow(/inbox.*retry artifact.*changed/i);

    const outboxRepository = new TradeSessionRepository(new MemoryStorageDriver());
    const stagedOutbox = structuredClone(session);
    stagedOutbox.privateState.outbox!.status = "staged";
    await outboxRepository.save(stagedOutbox, null);

    const retargetedOutbox = structuredClone(stagedOutbox);
    retargetedOutbox.revision = 1;
    retargetedOutbox.updatedAt += 1;
    retargetedOutbox.privateState.outbox!.recipientInboxListId = "09".repeat(32);
    await expect(outboxRepository.save(retargetedOutbox, 0))
      .rejects.toThrow(/outbox.*retry artifact.*changed/i);
  });

  it("allows only the maker order key to sign the reserve acceptance handoff", async () => {
    const reserveAccept = structuredClone(session);
    reserveAccept.privateState.transcript.choreography.participants.takerSessionPubkey =
      reserveAccept.privateState.outbox!.message.recipient_pubkey;
    const message: ZwapTradeMessage = {
      ...reserveAccept.privateState.outbox!.message,
      type: "reserve_accept",
      author_pubkey: maker,
      body: {
        schema: "zwap/atomic-swap-body/v1",
        taker_session_pubkey:
          reserveAccept.privateState.outbox!.message.recipient_pubkey,
        maker_session_pubkey: sessionPubkey,
        maker_address: FIXTURE_LOCAL_ADDRESS,
        reserve_projection_id: projection.id,
        reserve_revision: "1"
      }
    };
    const template = {
      ...reserveAccept.privateState.outbox!.rumor,
      pubkey: maker,
      content: JSON.stringify(message)
    };
    const makerRumor = { ...template, id: getEventHash(template) };
    const makerSeal = structuredClone(finalizeEvent({
      kind: 13,
      created_at: message.sent_at,
      tags: [],
      content: "encrypted-order-key-reserve-accept"
    }, makerSecret));
    reserveAccept.privateState.outbox = {
      ...reserveAccept.privateState.outbox!,
      message,
      rumor: makerRumor,
      seal: makerSeal
    };

    const repository = new TradeSessionRepository(new MemoryStorageDriver());
    await expect(repository.save(reserveAccept, null)).resolves.toBeUndefined();

    for (const mutate of [
      (candidate: TradeSession) => {
        candidate.privateState.outbox!.message.type = "base_lock";
      },
      (candidate: TradeSession) => {
        candidate.privateState.outbox!.message.body = {
          ...candidate.privateState.outbox!.message.body,
          maker_session_pubkey: remotePubkey
        };
      },
      (candidate: TradeSession) => {
        candidate.privateState.outbox!.message.body = {
          ...candidate.privateState.outbox!.message.body,
          reserve_projection_id: offeredProjectionId
        };
      }
    ]) {
      const corrupt = structuredClone(reserveAccept);
      mutate(corrupt);
      const driver = new MemoryStorageDriver();
      await driver.set(STORAGE_KEY, [corrupt]);
      await expect(new TradeSessionRepository(driver).list()).rejects.toThrow();
    }
  });

  it("serializes different session IDs under one shared-array storage lock", async () => {
    let tail = Promise.resolve();
    const runExclusive: TradeSessionExclusiveRunner = async <T>(
      action: () => Promise<T>
    ): Promise<T> => {
      const previous = tail;
      let release = (): void => {};
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await action();
      } finally {
        release();
      }
    };
    const repository = new TradeSessionRepository(
      new MemoryStorageDriver(),
      runExclusive
    );
    const other: TradeSession = {
      ...structuredClone(session),
      sessionId: "10".repeat(32),
      reservationId: "99999999-9999-4999-8999-999999999999",
      privateState: {
        ...structuredClone(session.privateState),
        outbox: null,
        chainOperation: null,
        settlementTranscriptHash: null,
        legs: {
          base: { htlcId: null, expected: null, observations: [] },
          quote: { htlcId: null, expected: null, observations: [] }
        }
      },
      evidence: {
        ...structuredClone(session.evidence),
        chainStates: [],
        legs: {
          base: {
            htlcId: null,
            validationCommitment: null,
            htlcState: "UNKNOWN",
            observedAt: null,
            spendCommitment: null,
            claimOperationCommitment: null,
            refundOperationCommitment: null
          },
          quote: structuredClone(session.evidence.legs.quote)
        }
      }
    };

    await Promise.all([
      repository.save(session, null),
      repository.save(other, null)
    ]);

    expect((await repository.list()).map((item) => item.sessionId).sort())
      .toEqual([other.sessionId, session.sessionId].sort());
  });

  it("produces a secret-free public view while retaining order lineage and leg evidence", () => {
    const withAbort = structuredClone(session);
    withAbort.evidence.reservation.abortSeal = incomingSeal;
    const view = publicTradeView(withAbort);
    const serialized = JSON.stringify(view);

    expect(view).toMatchObject({
      revision: 0,
      offeredProjectionId,
      reserveProjectionId: session.reserveProjectionId,
      reserveProjectionRevision: "1",
      evidence: {
        reservation: { abortSealId: incomingSeal.id },
        legs: session.evidence.legs
      }
    });
    for (const forbidden of [
      "privateState",
      "chainOperation",
      "nostrPrivateKey",
      "localAddress",
      preimage,
      session.privateState.nostrPrivateKey,
      FIXTURE_LOCAL_ADDRESS,
      FIXTURE_COUNTERPARTY_ADDRESS,
      "encrypted-private-wrapper",
      incomingSeal.content,
      incomingSeal.sig
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("fails closed on corrupt nested journals and unsupported schemas", async () => {
    const corruptions: unknown[] = [
      { ...session, schema: "granola/trade-session/v2" },
      { ...session, revision: -1 },
      {
        ...session,
        privateState: {
          ...session.privateState,
          settlementTranscriptHash: session.privateState.htlcHash
        }
      },
      {
        ...session,
        privateState: {
          ...session.privateState,
          inbox: {
            listEventId: "12".repeat(32),
            registeredAt: null,
            relays: ["wss://relay.example"]
          }
        }
      },
      {
        ...session,
        privateState: {
          ...session.privateState,
          inbox: {
            ...session.privateState.inbox,
            inboxRelays: [...inboxRelays].reverse()
          }
        }
      },
      {
        ...session,
        evidence: {
          ...session.evidence,
          legs: {
            ...session.evidence.legs,
            base: {
              ...session.evidence.legs.base,
              htlcState: "UNLOCKED",
              spendCommitment: null
            }
          }
        }
      },
      {
        ...session,
        evidence: {
          ...session.evidence,
          legs: {
            ...session.evidence.legs,
            base: {
              ...session.evidence.legs.base,
              htlcState: "UNLOCKED",
              observedAt: FIXTURE_ANCHOR + 11,
              spendCommitment: "12".repeat(32)
            }
          }
        }
      },
      {
        ...session,
        evidence: {
          ...session.evidence,
          legs: {
            ...session.evidence.legs,
            base: {
              ...session.evidence.legs.base,
              htlcState: "UNLOCKED",
              observedAt: FIXTURE_ANCHOR + 11,
              spendCommitment: "12".repeat(32)
            }
          }
        },
        privateState: {
          ...session.privateState,
          legs: {
            ...session.privateState.legs,
            base: {
              ...session.privateState.legs.base,
              observations: [{
                observedAt: FIXTURE_ANCHOR + 11,
                state: "UNLOCKED",
                witnessCommitment: "13".repeat(32)
              }]
            }
          }
        }
      },
      {
        ...session,
        privateState: {
          ...session.privateState,
          transcript: {
            ...session.privateState.transcript,
            nextSequence: "2",
            lastRumorId: "1b".repeat(32),
            lastMessageId: acceptedMessageId,
            lastTranscriptHash: "1c".repeat(32),
            accepted: [
              ...session.privateState.transcript.accepted,
              {
                sequence: "1",
                messageId: acceptedMessageId,
                rumorId: "1b".repeat(32),
                transcriptHash: "1c".repeat(32)
              }
            ]
          }
        }
      },
      {
        ...session,
        privateState: {
          ...session.privateState,
          outbox: { ...session.privateState.outbox!, wrapper: { ...wrapper, kind: 14 } }
        }
      },
      {
        ...session,
        privateState: {
          ...session.privateState,
          chainOperation: {
            ...session.privateState.chainOperation!,
            status: "prepared",
            result: session.privateState.chainOperation!.result
          }
        }
      },
      {
        ...session,
        privateState: {
          ...session.privateState,
          chainOperation: {
            ...session.privateState.chainOperation!,
            fundsReserved: false
          }
        }
      },
      {
        ...session,
        evidence: {
          ...session.evidence,
          reservation: { ...session.evidence.reservation, takerCommitment: null }
        }
      },
      {
        ...session,
        privateState: {
          ...session.privateState,
          inbox: {
            ...session.privateState.inbox,
            readbacks: [{
              ...session.privateState.inbox.readbacks[0]!,
              event: { ...registration, content: "different-signed-event" }
            }]
          }
        }
      },
      {
        ...session,
        privateState: {
          ...session.privateState,
          inbox: {
            ...session.privateState.inbox,
            receipts: session.privateState.inbox.receipts.slice(0, 1)
          }
        }
      },
      {
        ...session,
        privateState: {
          ...session.privateState,
          inbox: {
            ...session.privateState.inbox,
            readbacks: session.privateState.inbox.readbacks.slice(0, 1)
          }
        }
      },
      {
        ...session,
        privateState: {
          ...session.privateState,
          inbox: {
            ...session.privateState.inbox,
            event: wrongRegistrationSigner,
            readbacks: session.privateState.inbox.readbacks.map((readback) => ({
              ...readback,
              event: wrongRegistrationSigner
            }))
          }
        }
      },
      {
        ...session,
        pendingOrderPublication: {
          ...session.pendingOrderPublication!,
          operation: "fill"
        }
      },
      { ...session, privateState: { ...session.privateState, preimage: "06".repeat(32) } },
      {
        ...session,
        privateState: {
          ...session.privateState,
          chainOperation: {
            ...session.privateState.chainOperation!,
            artifact: {
              ...session.privateState.chainOperation!.artifact,
              expected: {
                ...session.privateState.chainOperation!.artifact.expected,
                binding: {
                  ...session.privateState.chainOperation!.artifact.expected.binding,
                  transcriptHash: "1d".repeat(32)
                }
              }
            }
          }
        }
      }
    ];

    for (const corrupt of corruptions) {
      const driver = new MemoryStorageDriver();
      await driver.set(STORAGE_KEY, [corrupt]);
      await expect(new TradeSessionRepository(driver).list()).rejects.toThrow();
    }
  });

  it.each([
    ["a non-Zenon local settlement address", (candidate: TradeSession) => {
      candidate.privateState.localAddress = "0xdeadbeef";
    }, /local settlement address is invalid/i],
    ["a non-Zenon counterparty address", (candidate: TradeSession) => {
      candidate.privateState.counterpartyAddress = "z1nope";
    }, /counterparty settlement address is invalid/i],
    ["identical settlement addresses", (candidate: TradeSession) => {
      candidate.privateState.counterpartyAddress = candidate.privateState.localAddress;
    }, /settlement addresses must remain distinct/i],
    ["a leaked bearer key in the private state", (candidate: TradeSession) => {
      (candidate.privateState as unknown as Record<string, unknown>).cashuPrivateKey =
        "02".repeat(32);
    }, /private state contains missing or unknown fields/i],
    ["an unknown key in the expected lock", (candidate: TradeSession) => {
      (candidate.privateState.legs.base.expected as unknown as Record<string, unknown>)
        .refundPubkey = "02".repeat(33);
    }, /Expected Zenon lock contains missing or unknown fields/i],
    ["a non-SHA-256 hash type", (candidate: TradeSession) => {
      (candidate.privateState.legs.base.expected as unknown as Record<string, unknown>)
        .hashType = 0;
    }, /Expected Zenon lock is invalid/i],
    ["an oversized preimage window", (candidate: TradeSession) => {
      (candidate.privateState.legs.base.expected as unknown as Record<string, unknown>)
        .keyMaxSize = 64;
    }, /Expected Zenon lock is invalid/i],
    ["identical hash-locked and time-locked addresses", (candidate: TradeSession) => {
      candidate.privateState.legs.base.expected!.hashLockedAddress =
        candidate.privateState.legs.base.expected!.timeLockedAddress;
    }, /Expected Zenon lock is invalid/i],
    ["a non-Zenon hash-locked address", (candidate: TradeSession) => {
      candidate.privateState.legs.base.expected!.hashLockedAddress = "z1";
    }, /Expected Zenon lock is invalid/i],
    ["a foreign lock network", (candidate: TradeSession) => {
      candidate.privateState.legs.base.expected!.binding.network = "cashu-testnet-v1";
    }, /Expected Zenon lock binding is invalid/i],
    ["a lock hash that leaves the session HTLC hash", (candidate: TradeSession) => {
      candidate.privateState.legs.base.expected!.hashLock = "1f".repeat(32);
      candidate.privateState.chainOperation!.artifact.expected.hashLock = "1f".repeat(32);
    }, /disagrees with the trade session|matching public commitment/i],
    ["an unknown trade terms key", (candidate: TradeSession) => {
      (candidate.terms as unknown as Record<string, unknown>).baseMint =
        "https://testnut.cashu.space";
    }, /Trade terms contains missing or unknown fields/i],
    ["a non-token-standard base asset", (candidate: TradeSession) => {
      candidate.terms.baseToken = "sat";
    }, /Trade terms are invalid/i],
    ["an unknown chain evidence state", (candidate: TradeSession) => {
      (candidate.evidence.legs.base as unknown as Record<string, unknown>).htlcState =
        "SPENT";
    }, /Trade leg evidence is invalid/i],
    ["a chain operation status from the Cashu journal", (candidate: TradeSession) => {
      (candidate.privateState.chainOperation as unknown as Record<string, unknown>)
        .status = "wallet_applied";
    }, /Chain operation metadata is invalid/i],
    ["an HTLC-less claim artifact", (candidate: TradeSession) => {
      candidate.privateState.chainOperation!.kind = "claim";
      candidate.privateState.chainOperation!.artifact.kind = "claim";
    }, /require their exact HTLC ID/i],
    ["an evidence HTLC ID that leaves its private lock", (candidate: TradeSession) => {
      candidate.evidence.legs.base.htlcId = "1f".repeat(32);
    }, /lacks exact private lock evidence/i],
    ["a choreography deployment from another chain", (candidate: TradeSession) => {
      candidate.privateState.transcript.choreography.deployment = deploymentFor("9");
    }, /choreography deployment does not match/i],
    ["an outbox next-choreography deployment from another chain", (candidate: TradeSession) => {
      candidate.privateState.outbox!.nextChoreography.deployment = deploymentFor("9");
    }, /choreography deployment does not match/i],
    ["a lock expiry that is not the maker offer locktime", (candidate: TradeSession) => {
      candidate.privateState.legs.base.expected!.expirationTime =
        candidate.plan.shortLocktime;
    }, /lock expiry disagrees with the settlement plan/i],
    ["a lock whose hash-locked address is a third party", (candidate: TradeSession) => {
      candidate.privateState.legs.base.expected!.hashLockedAddress =
        FIXTURE_THIRD_ADDRESS;
    }, /not bound to the session settlement addresses/i],
    ["a lock whose time-locked address is not the local address", (candidate: TradeSession) => {
      candidate.privateState.legs.base.expected!.timeLockedAddress =
        FIXTURE_THIRD_ADDRESS;
    }, /not bound to the session settlement addresses/i]
  ])("fails closed on %s", async (_label, mutate, pattern) => {
    const corrupt = structuredClone(session);
    mutate(corrupt);
    const driver = new MemoryStorageDriver();
    await driver.set(STORAGE_KEY, [corrupt]);
    await expect(new TradeSessionRepository(driver).list()).rejects.toThrow(pattern);
  });

  it("rejects a settlement plan whose recovery window is not derived from its locktimes", async () => {
    for (const mutate of [
      (candidate: TradeSession) => {
        candidate.plan.reservationExpiresAt = candidate.plan.longLocktime + 1;
      },
      (candidate: TradeSession) => {
        candidate.plan.makerClaimCutoff = candidate.plan.shortLocktime;
      },
      (candidate: TradeSession) => {
        candidate.plan.longLocktime = candidate.plan.shortLocktime;
      },
      (candidate: TradeSession) => {
        candidate.plan.longLocktime = candidate.plan.shortLocktime + 60;
        candidate.plan.takerClaimCutoff = candidate.plan.longLocktime - 120;
        candidate.plan.reservationExpiresAt = candidate.plan.longLocktime + 600;
      }
    ]) {
      const corrupt = structuredClone(session);
      mutate(corrupt);
      const driver = new MemoryStorageDriver();
      await driver.set(STORAGE_KEY, [corrupt]);
      await expect(new TradeSessionRepository(driver).list())
        .rejects.toThrow(/Settlement plan profile is invalid/i);
    }
  });

  it("rejects an unrelated Zenon address in the durable choreography participants", async () => {
    const corrupt = structuredClone(session);
    corrupt.privateState.transcript.choreography.participants.makerAddress =
      FIXTURE_THIRD_ADDRESS.slice(0, 10);
    const driver = new MemoryStorageDriver();
    await driver.set(STORAGE_KEY, [corrupt]);
    await expect(new TradeSessionRepository(driver).list())
      .rejects.toThrow(/Trade participants are invalid/i);
  });
});
