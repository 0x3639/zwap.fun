import { describe, expect, it, vi } from "vitest";
import { finalizeEvent, getPublicKey, verifyEvent } from "nostr-tools/pure";

import type { OrderApi } from "../api/order-api.js";
import type { NostrTradeTransport } from "../nostr/trade-transport.js";
import {
  createProjectionTemplate,
  parseProjectionEvent,
  type NostrEvent
} from "../order/events.js";
import {
  createOrderState,
  fillOrder,
  reserveOrder
} from "../order/model.js";
import { MemoryStorageDriver } from "../storage/driver.js";
import type { OrderOutboxEntry, OrderOutboxPort } from "../storage/order-outbox.js";
import { FakeZenonNode } from "../zenon/fake-node.js";
import { FundsReservationRepository } from "../zenon/funds-reservations.js";
import { hexToBytes, sha256Hex } from "../zenon/hex.js";
import {
  fakeUnlockDecoder,
  HtlcValidationError,
  type ExpectedZenonLock
} from "../zenon/htlc.js";
import { ZenonTradeClient, ZenonTradeError } from "../zenon/trade-client.js";
import { QSR_ZTS, ZNN_ZTS } from "../zenon/types.js";
import type { AtomicSwapBody, AtomicSwapChoreography } from "./atomic-messages.js";
import type { CoordinatorAction } from "./coordinator-plan.js";
import {
  classifyChainError,
  ZwapChainEffectError,
  ZwapCoordinatorEffects,
  type CoordinatorOrderReadPort,
  type PublishedOrderProjection
} from "./effects.js";
import { termsHash, type ZwapTradeMessage, type ZwapTradeTerms } from "./messages.js";
import type { TradeSession } from "./session.js";
import {
  FIXTURE_MAKER_PUBKEY,
  FIXTURE_ORDER_ADDRESS,
  FIXTURE_ORDER_ID,
  FIXTURE_RESERVATION_ID,
  FIXTURE_SESSION_ID,
  FIXTURE_SESSION_PUBKEY,
  sessionFixture,
  type DeepPartial
} from "./test-fixtures.js";

const NOW = 1_800_000_100;
const NETWORK = "zenon-1-v1";
const ANCHOR = NOW - 100;
const SHORT_LOCKTIME = NOW + 500;
const MAKER_CLAIM_CUTOFF = NOW + 380;
const LONG_LOCKTIME = NOW + 1_100;
const TAKER_CLAIM_CUTOFF = NOW + 980;
const RESERVATION_EXPIRES_AT = NOW + 1_700;
const REFUND_GUARD_SECONDS = 60;

const PREIMAGE = "04".repeat(32);
const HTLC_HASH = await sha256Hex(hexToBytes(PREIMAGE));
const SETTLEMENT_TRANSCRIPT_HASH = "77".repeat(32);

const DISCOVERY_RELAYS = [
  "wss://discovery-one.example",
  "wss://discovery-two.example"
];
const INBOX_RELAYS = ["wss://inbox.example"];
const ORDER_SIGNING_KEY = new Uint8Array(32).fill(12);

/** The counterparty's session key: the fixture's own key is the local side. */
const COUNTERPARTY_PUBKEY = getPublicKey(new Uint8Array(32).fill(3));
const RESERVE_PROJECTION_ID = "34".repeat(32);
const LAST_MESSAGE_ID = "11111111-1111-4111-8111-111111111111";
const LAST_TRANSCRIPT_HASH = "78".repeat(32);

const TERMS: ZwapTradeTerms = {
  maker_side: "sell",
  chain_id: "1",
  base_token: ZNN_ZTS,
  quote_token: QSR_ZTS,
  base_amount: "20",
  quote_amount: "1",
  price: "5000000"
};
const TERMS_HASH = await termsHash(TERMS);

function clone<T>(value: T): T {
  return structuredClone(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deep-merges two fixture patches the same way `sessionFixture` merges one. */
function merge(base: unknown, patch: unknown): unknown {
  if (!isPlainObject(patch) || !isPlainObject(base)) return patch;
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    merged[key] = Object.hasOwn(base, key) ? merge(base[key], value) : value;
  }
  return merged;
}

function event(kind: number, idByte: string, tags: string[][] = []): NostrEvent {
  return {
    kind,
    created_at: NOW - 100,
    tags,
    content: "",
    id: idByte.repeat(32),
    pubkey: FIXTURE_MAKER_PUBKEY,
    sig: "ee".repeat(64)
  };
}

/**
 * The exact HTLC terms for one protocol slot, restated independently of
 * `effects.ts`. The suite's order is sell-side, so slot and leg coincide: the
 * maker funds `base` (long locktime, taker hash-locked) and the taker funds
 * `quote` (short locktime, maker hash-locked).
 */
function expectedFor(
  slot: "base" | "quote",
  addresses: { maker: string; taker: string }
): ExpectedZenonLock {
  return {
    leg: slot,
    chainId: "1",
    tokenStandard: slot === "base" ? ZNN_ZTS : QSR_ZTS,
    amount: slot === "base" ? "20" : "1",
    hashLock: HTLC_HASH,
    hashType: 1,
    keyMaxSize: 32,
    hashLockedAddress: slot === "base" ? addresses.taker : addresses.maker,
    timeLockedAddress: slot === "base" ? addresses.maker : addresses.taker,
    expirationTime: slot === "base" ? LONG_LOCKTIME : SHORT_LOCKTIME,
    binding: {
      protocolVersion: "1",
      network: NETWORK,
      orderId: FIXTURE_ORDER_ID,
      sessionId: FIXTURE_SESSION_ID,
      reservationId: FIXTURE_RESERVATION_ID,
      transcriptHash: SETTLEMENT_TRANSCRIPT_HASH
    }
  };
}

function boundSession(
  role: "maker" | "taker",
  addresses: { maker: string; taker: string },
  overrides: DeepPartial<TradeSession> = {}
): TradeSession {
  const local = role === "maker" ? addresses.maker : addresses.taker;
  const counterparty = role === "maker" ? addresses.taker : addresses.maker;
  return sessionFixture(merge({
    revision: 4,
    role,
    phase: "reserved",
    createdAt: NOW - 200,
    updatedAt: NOW - 10,
    reserveProjectionId: RESERVE_PROJECTION_ID,
    reserveProjectionRevision: "1",
    plan: {
      anchor: ANCHOR,
      shortLocktime: SHORT_LOCKTIME,
      makerClaimCutoff: MAKER_CLAIM_CUTOFF,
      longLocktime: LONG_LOCKTIME,
      takerClaimCutoff: TAKER_CLAIM_CUTOFF,
      reservationExpiresAt: RESERVATION_EXPIRES_AT,
      refundGuardSeconds: REFUND_GUARD_SECONDS
    },
    evidence: {
      commitments: [HTLC_HASH],
      reserveProjectionId: RESERVE_PROJECTION_ID,
      reserveProjectionRevision: "1",
      reservation: {
        proposalSealId: "35".repeat(32),
        takerCommitment: "36".repeat(32)
      }
    },
    privateState: {
      localAddress: local,
      counterpartyAddress: counterparty,
      htlcHash: HTLC_HASH,
      settlementTranscriptHash: SETTLEMENT_TRANSCRIPT_HASH,
      inbox: {
        quorum: 2,
        discoveryRelays: [...DISCOVERY_RELAYS],
        inboxRelays: [...INBOX_RELAYS]
      },
      transcript: {
        choreography: {
          phase: "awaiting_base_lock",
          deployment: NETWORK,
          sessionId: FIXTURE_SESSION_ID,
          reservationId: FIXTURE_RESERVATION_ID,
          orderAddress: FIXTURE_ORDER_ADDRESS,
          orderProjectionId: RESERVE_PROJECTION_ID,
          orderRevision: "1",
          termsHash: TERMS_HASH,
          terms: clone(TERMS),
          lastMessageId: LAST_MESSAGE_ID,
          settlementHash: HTLC_HASH,
          reserveProjectionId: RESERVE_PROJECTION_ID,
          reserveProjectionRevision: "1",
          shortLocktime: SHORT_LOCKTIME,
          longLocktime: LONG_LOCKTIME,
          participants: {
            makerOrderPubkey: FIXTURE_MAKER_PUBKEY,
            makerSessionPubkey: role === "maker"
              ? FIXTURE_SESSION_PUBKEY
              : COUNTERPARTY_PUBKEY,
            takerSessionPubkey: role === "maker"
              ? COUNTERPARTY_PUBKEY
              : FIXTURE_SESSION_PUBKEY,
            makerAddress: addresses.maker,
            takerAddress: addresses.taker
          },
          refundedLegs: []
        },
        nextSequence: "3",
        lastRumorId: "90".repeat(32),
        lastMessageId: LAST_MESSAGE_ID,
        lastTranscriptHash: LAST_TRANSCRIPT_HASH
      }
    },
  }, overrides) as DeepPartial<TradeSession>);
}

interface Participant {
  effects: ZwapCoordinatorEffects;
  chain: ZenonTradeClient;
  reservations: FundsReservationRepository;
  address: string;
  accountLocks: () => number;
  orderApi: {
    ensureReserveStaged: ReturnType<typeof vi.fn>;
    ensureFillStaged: ReturnType<typeof vi.fn>;
    ensureReleaseStaged: ReturnType<typeof vi.fn>;
    publishNextStage: ReturnType<typeof vi.fn>;
  };
  orderOutbox: { load: ReturnType<typeof vi.fn> };
  orderReader: {
    loadPublishedProjection: ReturnType<typeof vi.fn>;
    loadLatestPublishedProjection: ReturnType<typeof vi.fn>;
  };
  nostr: {
    send: ReturnType<typeof vi.fn>;
    read: ReturnType<typeof vi.fn>;
    discoverInbox: ReturnType<typeof vi.fn>;
  };
}

interface Harness {
  node: FakeZenonNode;
  clock: { now: number };
  addresses: { maker: string; taker: string };
  maker: Participant;
  taker: Participant;
}

function harness(
  options: { makerBalance?: string; takerBalance?: string } = {}
): Harness {
  const clock = { now: NOW };
  const node = new FakeZenonNode({ chainId: 1, now: () => clock.now });
  const addresses = {
    maker: node.createAddress("maker"),
    taker: node.createAddress("taker")
  };
  node.fund(addresses.maker, ZNN_ZTS, options.makerBalance ?? "20");
  node.fund(addresses.taker, QSR_ZTS, options.takerBalance ?? "1");

  const participant = (address: string): Participant => {
    const chain = new ZenonTradeClient({
      node,
      signer: node.signer(address),
      decodeUnlock: fakeUnlockDecoder,
      now: () => clock.now
    });
    const reservations = new FundsReservationRepository(new MemoryStorageDriver());
    const orderApi = {
      ensureReserveStaged: vi.fn(),
      ensureFillStaged: vi.fn(),
      ensureReleaseStaged: vi.fn(),
      publishNextStage: vi.fn(),
      clearAcknowledgedOrderPublication: vi.fn(),
      pruneCommittedOrderPublication: vi.fn()
    };
    const orderOutbox = { load: vi.fn() };
    const orderReader = {
      loadPublishedProjection: vi.fn(),
      loadLatestPublishedProjection: vi.fn()
    };
    const nostr = {
      createRegistration: vi.fn(),
      publishRegistration: vi.fn(),
      discoverInbox: vi.fn(),
      send: vi.fn(),
      read: vi.fn()
    };
    let accountLocks = 0;
    const effects = new ZwapCoordinatorEffects({
      orderApi: orderApi as unknown as OrderApi,
      orderOutbox: orderOutbox as unknown as OrderOutboxPort,
      orderReader: orderReader as unknown as CoordinatorOrderReadPort,
      nostr: nostr as unknown as NostrTradeTransport,
      chain,
      node,
      reservations,
      makerIdentity: {
        publicKey: async () => FIXTURE_MAKER_PUBKEY,
        useSecretKey: async (action) => action(new Uint8Array(32).fill(9))
      },
      discoveryRelays: DISCOVERY_RELAYS,
      withAccountLock: async <T>(action: () => Promise<T>): Promise<T> => {
        accountLocks += 1;
        return action();
      },
      network: NETWORK,
      entropy: {
        messageId: () => "11111111-1111-4111-8111-111111111113",
        operationId: () => "11111111-1111-4111-8111-111111111114",
        ephemeralSecretKey: () => new Uint8Array(32).fill(7),
        nonce: () => new Uint8Array(32).fill(8),
        randomizedTimestamp: (now: number) => now - 1,
        outerExpiration: (expiration: number) => expiration + 3_600
      },
      commitment: async () => "ab".repeat(32)
    });
    return {
      effects,
      chain,
      reservations,
      address,
      accountLocks: () => accountLocks,
      orderApi,
      orderOutbox,
      orderReader,
      nostr
    };
  };

  return {
    node,
    clock,
    addresses,
    maker: participant(addresses.maker),
    taker: participant(addresses.taker)
  };
}

function externalInput(action: CoordinatorAction, session: TradeSession) {
  return {
    action,
    session: clone(session),
    now: NOW,
    revision: session.revision,
    fingerprint: `${action.kind}:fixed-test-fingerprint`
  };
}

function externalInputAt(
  action: CoordinatorAction,
  session: TradeSession,
  now: number
) {
  return { ...externalInput(action, session), now };
}

async function publishedFill(): Promise<PublishedOrderProjection> {
  const maker = getPublicKey(ORDER_SIGNING_KEY);
  const initial = createOrderState({
    orderId: FIXTURE_ORDER_ID,
    createdAt: NOW - 200,
    expiresAt: NOW + 2_000,
    side: "sell",
    chainId: "1",
    baseToken: ZNN_ZTS,
    quoteToken: QSR_ZTS,
    amount: "20",
    price: "5000000"
  });
  const reserved = reserveOrder(initial, {
    reservationId: FIXTURE_RESERVATION_ID,
    amount: "20",
    acceptedAt: NOW - 150,
    expiresAt: NOW + 1_700,
    proposalEventId: "31".repeat(32),
    takerCommitment: "32".repeat(32)
  });
  const filled = fillOrder(reserved, {
    reservationId: reserved.reservation!.id,
    amount: reserved.reservation!.amount
  });
  const projection = finalizeEvent(
    await createProjectionTemplate(filled, maker, NOW - 120),
    ORDER_SIGNING_KEY
  );
  const record = await parseProjectionEvent(projection, verifyEvent);
  return { eventId: projection.id, revision: filled.revision, projection, record };
}

describe("ZwapCoordinatorEffects", () => {
  it("classifies every planner action at an explicit I/O boundary", () => {
    const { maker } = harness();
    const local = [
      "stage_inbox_registration",
      "commit_outbox",
      "commit_incoming",
      "clear_chain_operation",
      "enter_recovery",
      "none"
    ] satisfies CoordinatorAction["kind"][];
    const external = [
      "publish_order_projection",
      "commit_order_publication",
      "clear_order_publication",
      "publish_inbox_registration",
      "verify_inbox_registration",
      "deliver_outbox",
      "validate_incoming",
      "reserve_funds",
      "execute_chain_operation",
      "reconcile_account",
      "stage_reserve_propose",
      "stage_order_reserve",
      "stage_reserve_accept",
      "poll_inbox",
      "stage_session_ack",
      "prepare_base_lock",
      "stage_base_lock",
      "stage_base_lock_ack",
      "prepare_quote_lock",
      "stage_quote_lock",
      "stage_quote_lock_ack",
      "prepare_quote_claim",
      "stage_claim_notice",
      "observe_quote",
      "prepare_base_claim",
      "stage_fill_request",
      "observe_base",
      "stage_order_fill",
      "verify_order_fill",
      "stage_order_release",
      "stage_settlement_ack",
      "prepare_quote_refund",
      "prepare_base_refund"
    ] satisfies CoordinatorAction["kind"][];
    const allKinds = [...local, ...external];

    expect(new Set(allKinds).size).toBe(allKinds.length);
    expect(allKinds).toHaveLength(39);
    for (const kind of local) {
      expect(maker.effects.classify({ kind } as CoordinatorAction), kind).toBe("local");
    }
    for (const kind of external) {
      expect(maker.effects.classify({ kind } as CoordinatorAction), kind).toBe("external");
    }
  });

  describe("classifyChainError", () => {
    class ZnnClientException extends Error {
      constructor(message: string) {
        super(message);
        this.name = "ZnnClientException";
      }
    }

    it("maps every Zenon failure onto the atomic-swap error vocabulary", () => {
      expect(classifyChainError(new ZenonTradeError("insufficient-balance")))
        .toEqual({ code: "chain_rejected", retryable: false });
      expect(classifyChainError(new HtlcValidationError("htlc-amount")))
        .toEqual({ code: "terms_mismatch", retryable: false });
      expect(classifyChainError(new Error("not enough plasma for this block")))
        .toEqual({ code: "plasma_unavailable", retryable: true });
      expect(classifyChainError(new Error("PoW link generation failed")))
        .toEqual({ code: "plasma_unavailable", retryable: true });
      expect(classifyChainError(new ZnnClientException("closed")))
        .toEqual({ code: "node_unavailable", retryable: true });
      expect(classifyChainError(new Error("socket hang up")))
        .toEqual({ code: "node_unavailable", retryable: true });
      expect(classifyChainError(new Error("request timeout")))
        .toEqual({ code: "node_unavailable", retryable: true });
      expect(classifyChainError(new ZenonTradeError("claim-cutoff")))
        .toEqual({ code: "chain_rejected", retryable: false });
      expect(classifyChainError(new Error("something else")))
        .toEqual({ code: "internal_error", retryable: false });
    });

    it("keeps polling on a missing HTLC unless the leg was already reclaimed", () => {
      const missing = new ZenonTradeError("htlc-missing");
      expect(classifyChainError(missing))
        .toEqual({ code: "htlc_state_invalid", retryable: true });
      expect(classifyChainError(missing, { reclaimed: true }))
        .toEqual({ code: "htlc_state_invalid", retryable: false });
    });
  });

  describe("prepare_base_lock", () => {
    it("stores the artifact under the account lock and reserves nothing yet", async () => {
      const { maker, addresses } = harness();
      const session = boundSession("maker", addresses);

      const prepared = await maker.effects.performExternal(
        externalInput({ kind: "prepare_base_lock" }, session)
      );

      expect(maker.accountLocks()).toBe(1);
      expect(prepared.privateState.legs.base.expected)
        .toEqual(expectedFor("base", addresses));
      expect(prepared.privateState.chainOperation).toMatchObject({
        operationId: "11111111-1111-4111-8111-111111111114",
        leg: "base",
        kind: "lock",
        status: "prepared",
        preparedAt: NOW,
        fundsReserved: false,
        result: null
      });
      expect(prepared.privateState.chainOperation?.artifact).toMatchObject({
        version: 1,
        kind: "lock",
        chainId: "1",
        tokenStandard: ZNN_ZTS,
        amount: "20",
        htlcId: null
      });
      expect((await maker.reservations.load()).reservations).toEqual([]);
      expect(prepared.evidence.legs.base.htlcId).toBeNull();
      expect(prepared.revision).toBe(session.revision + 1);
    });

    it("rejects with chain_rejected when the balance minus other reservations is short", async () => {
      const { maker, addresses } = harness({ makerBalance: "20" });
      const session = boundSession("maker", addresses);
      const before = await maker.reservations.load();
      await maker.reservations.reserve(before.revision, {
        sessionId: "another-session",
        tokenStandard: ZNN_ZTS,
        amount: "10",
        reservedAt: NOW - 50
      });

      const failure = await maker.effects.performExternal(
        externalInput({ kind: "prepare_base_lock" }, session)
      ).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(ZwapChainEffectError);
      expect((failure as ZwapChainEffectError).code).toBe("chain_rejected");
      expect((failure as ZwapChainEffectError).retryable).toBe(false);
    });

    it("ignores this session's own reservation so a retry still prepares", async () => {
      const { maker, addresses } = harness({ makerBalance: "20" });
      const session = boundSession("maker", addresses);
      const before = await maker.reservations.load();
      await maker.reservations.reserve(before.revision, {
        sessionId: session.sessionId,
        tokenStandard: ZNN_ZTS,
        amount: "20",
        reservedAt: NOW - 50
      });

      const prepared = await maker.effects.performExternal(
        externalInput({ kind: "prepare_base_lock" }, session)
      );

      expect(prepared.privateState.chainOperation?.kind).toBe("lock");
    });
  });

  describe("reserve_funds → execute → reconcile → clear", () => {
    it("locks funds on chain and leaves no reservation behind", async () => {
      const { maker, node, addresses } = harness();
      const session = boundSession("maker", addresses);

      const prepared = await maker.effects.performExternal(
        externalInput({ kind: "prepare_base_lock" }, session)
      );
      const reserved = await maker.effects.performExternal(
        externalInput({ kind: "reserve_funds" }, prepared)
      );

      expect(reserved.privateState.chainOperation?.fundsReserved).toBe(true);
      expect((await maker.reservations.load()).reservations).toEqual([{
        sessionId: session.sessionId,
        tokenStandard: ZNN_ZTS,
        amount: "20",
        reservedAt: NOW
      }]);

      const executed = await maker.effects.performExternal(
        externalInput({ kind: "execute_chain_operation" }, reserved)
      );
      const htlcId = executed.privateState.legs.base.htlcId!;

      expect(htlcId).toMatch(/^[0-9a-f]{64}$/);
      expect(await node.getHtlc(htlcId)).toMatchObject({
        id: htlcId,
        tokenStandard: ZNN_ZTS,
        amount: "20",
        hashLock: HTLC_HASH,
        hashLocked: addresses.taker,
        timeLocked: addresses.maker,
        expirationTime: LONG_LOCKTIME
      });
      expect(executed.evidence.legs.base).toMatchObject({
        htlcId,
        htlcState: "LOCKED",
        observedAt: NOW
      });
      expect(executed.evidence.legs.base.validationCommitment)
        .toMatch(/^[0-9a-f]{64}$/);
      expect(executed.privateState.legs.base.observations).toEqual([
        { observedAt: NOW, state: "LOCKED", witnessCommitment: null }
      ]);
      expect(executed.privateState.chainOperation).toMatchObject({
        status: "completed",
        result: {
          blockHash: htlcId,
          htlcId,
          tokenStandard: ZNN_ZTS,
          amount: "20"
        }
      });
      expect(await node.getBalances(addresses.maker)).toEqual([]);

      const reconciled = await maker.effects.performExternal(
        externalInput({ kind: "reconcile_account" }, executed)
      );

      expect(reconciled.privateState.chainOperation?.status).toBe("account_applied");
      expect((await maker.reservations.load()).reservations).toEqual([]);

      const cleared = await maker.effects.applyLocal({
        action: { kind: "clear_chain_operation" },
        session: reconciled,
        now: NOW
      });

      expect(cleared.privateState.chainOperation).toBeNull();
      expect(cleared.privateState.legs.base.htlcId).toBe(htlcId);
    });

    it("refuses to execute before the funds are reserved", async () => {
      const { maker, addresses } = harness();
      const session = boundSession("maker", addresses);
      const prepared = await maker.effects.performExternal(
        externalInput({ kind: "prepare_base_lock" }, session)
      );

      await expect(maker.effects.performExternal(
        externalInput({ kind: "execute_chain_operation" }, prepared)
      )).rejects.toThrow(/not checkpointed for execution/i);
    });
  });

  describe("validate_incoming for a base_lock body", () => {
    async function incoming(
      htlcAmount: string
    ): Promise<{
      harness: Harness;
      session: TradeSession;
      body: AtomicSwapBody<"base_lock">;
      pendingOf: (body: AtomicSwapBody<"base_lock">) => TradeSession;
    }> {
      const context = harness({ makerBalance: "40" });
      const { addresses, maker, taker } = context;
      const expected = expectedFor("base", addresses);
      const onChain = { ...expected, amount: htlcAmount };
      const completed = await maker.chain.completeLock(
        await maker.chain.prepareLock({ expected: onChain, now: NOW })
      );
      const body: AtomicSwapBody<"base_lock"> = {
        schema: "zwap/atomic-swap-body/v1",
        htlc_id: completed.htlcId,
        validation_commitment: completed.summary.validationCommitment,
        settlement_hash: HTLC_HASH,
        chain_id: "1",
        token_standard: ZNN_ZTS,
        amount: "20",
        hash_locked_address: addresses.taker,
        time_locked_address: addresses.maker,
        expiration_time: LONG_LOCKTIME
      };
      const session = boundSession("taker", addresses);
      const pendingOf = (used: AtomicSwapBody<"base_lock">): TradeSession => {
        const message: ZwapTradeMessage = {
          schema: "granola/dm/v1",
          deployment: NETWORK,
          type: "base_lock",
          message_id: "11111111-1111-4111-8111-111111111116",
          session_id: FIXTURE_SESSION_ID,
          reservation_id: FIXTURE_RESERVATION_ID,
          order_address: FIXTURE_ORDER_ADDRESS,
          order_projection_id: RESERVE_PROJECTION_ID,
          order_revision: "1",
          maker_order_pubkey: FIXTURE_MAKER_PUBKEY,
          author_pubkey: COUNTERPARTY_PUBKEY,
          recipient_pubkey: FIXTURE_SESSION_PUBKEY,
          sequence: "3",
          previous_message_id: LAST_MESSAGE_ID,
          previous_transcript_hash: LAST_TRANSCRIPT_HASH,
          sent_at: NOW - 10,
          expires_at: NOW + 300,
          terms_hash: TERMS_HASH,
          body: used
        };
        const opened = {
          wrapper: event(1059, "96", [["p", FIXTURE_SESSION_PUBKEY]]),
          seal: event(13, "95"),
          rumor: {
            kind: 14 as const,
            created_at: NOW - 10,
            tags: [["p", FIXTURE_SESSION_PUBKEY]],
            content: "encrypted-rumor",
            id: "94".repeat(32),
            pubkey: COUNTERPARTY_PUBKEY
          },
          message,
          transcriptHash: "79".repeat(32)
        };
        Object.assign(taker.effects, {
          openIncoming: async () => clone(opened)
        });
        const next = clone(session);
        next.privateState.pendingIncoming = {
          ...clone(opened),
          receivedAt: NOW - 5,
          validation: { status: "unvalidated", checkedAt: null, error: null }
        };
        return next;
      };
      return { harness: context, session, body, pendingOf };
    }

    it("accepts a body backed by a matching on-chain HTLC", async () => {
      const { harness: context, body, pendingOf } = await incoming("20");
      const pending = pendingOf(body);

      const validated = await context.taker.effects.performExternal(
        externalInput({ kind: "validate_incoming" }, pending)
      );

      expect(validated.privateState.pendingIncoming?.validation).toEqual({
        status: "validated",
        checkedAt: NOW,
        error: null
      });
      expect(validated.privateState.legs.base).toMatchObject({
        htlcId: body.htlc_id,
        expected: expectedFor("base", context.addresses)
      });
      expect(validated.privateState.legs.base.observations).toEqual([
        { observedAt: NOW, state: "LOCKED", witnessCommitment: null }
      ]);
      expect(validated.evidence.legs.base).toMatchObject({
        htlcId: body.htlc_id,
        validationCommitment: body.validation_commitment,
        htlcState: "LOCKED",
        observedAt: NOW
      });
    });

    it("rejects a tampered amount with terms_mismatch", async () => {
      const { harness: context, body, pendingOf } = await incoming("19");
      const pending = pendingOf(body);

      const failure = await context.taker.effects.performExternal(
        externalInput({ kind: "validate_incoming" }, pending)
      ).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(ZwapChainEffectError);
      expect((failure as ZwapChainEffectError).code).toBe("terms_mismatch");
      expect((failure as ZwapChainEffectError).retryable).toBe(false);
    });

    it("rejects a validation commitment that does not match the observed HTLC", async () => {
      const { harness: context, body, pendingOf } = await incoming("20");
      const pending = pendingOf({ ...body, validation_commitment: "cd".repeat(32) });

      const failure = await context.taker.effects.performExternal(
        externalInput({ kind: "validate_incoming" }, pending)
      ).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(ZwapChainEffectError);
      expect((failure as ZwapChainEffectError).code).toBe("terms_mismatch");
    });
  });

  describe("observe_quote", () => {
    async function lockedQuote(): Promise<{
      context: Harness;
      makerSession: TradeSession;
      takerSession: TradeSession;
      htlcId: string;
    }> {
      const context = harness();
      const { addresses, taker } = context;
      const expected = expectedFor("quote", addresses);
      const completed = await taker.chain.completeLock(
        await taker.chain.prepareLock({ expected, now: NOW })
      );
      const locked = (role: "maker" | "taker"): TradeSession => boundSession(
        role,
        addresses,
        {
          privateState: {
            preimage: null,
            legs: {
              quote: {
                htlcId: completed.htlcId,
                expected: clone(expected),
                observations: [
                  { observedAt: NOW - 5, state: "LOCKED", witnessCommitment: null }
                ]
              }
            }
          },
          evidence: {
            legs: {
              quote: {
                htlcId: completed.htlcId,
                validationCommitment: completed.summary.validationCommitment,
                htlcState: "LOCKED",
                observedAt: NOW - 5
              }
            }
          }
        }
      );
      return {
        context,
        makerSession: locked("maker"),
        takerSession: locked("taker"),
        htlcId: completed.htlcId
      };
    }

    it("still reports LOCKED while the maker has not unlocked", async () => {
      const { context, takerSession } = await lockedQuote();

      const observed = await context.taker.effects.performExternal(
        externalInput({ kind: "observe_quote" }, takerSession)
      );

      expect(observed.evidence.legs.quote.htlcState).toBe("LOCKED");
      expect(observed.privateState.preimage).toBeNull();
    });

    it("learns the preimage from the chain once the maker unlocks", async () => {
      const { context, takerSession, htlcId } = await lockedQuote();
      await context.node.signer(context.addresses.maker).send({
        kind: "htlc_unlock",
        id: htlcId,
        preimage: PREIMAGE
      });

      const observed = await context.taker.effects.performExternal(
        externalInput({ kind: "observe_quote" }, takerSession)
      );

      expect(observed.privateState.preimage).toBe(PREIMAGE);
      expect(observed.evidence.legs.quote).toMatchObject({
        htlcState: "UNLOCKED",
        observedAt: NOW
      });
      expect(observed.evidence.legs.quote.spendCommitment)
        .toMatch(/^[0-9a-f]{64}$/);
      expect(observed.privateState.legs.quote.observations.at(-1)).toEqual({
        observedAt: NOW,
        state: "UNLOCKED",
        witnessCommitment: observed.evidence.legs.quote.spendCommitment
      });
    });

    it("never hands the maker a preimage it already knows through the same path", async () => {
      const { context, makerSession, htlcId } = await lockedQuote();
      await context.node.signer(context.addresses.maker).send({
        kind: "htlc_unlock",
        id: htlcId,
        preimage: PREIMAGE
      });

      const observed = await context.maker.effects.performExternal(
        externalInput({ kind: "observe_quote" }, makerSession)
      );

      expect(observed.evidence.legs.quote.htlcState).toBe("UNLOCKED");
      expect(observed.privateState.preimage).toBeNull();
    });

    it("freezes the session when the observed HTLC contradicts the agreed terms", async () => {
      const { context, takerSession } = await lockedQuote();
      const contradicted = clone(takerSession);
      contradicted.privateState.legs.quote.expected!.amount = "2";

      const frozen = await context.taker.effects.performExternal(
        externalInput({ kind: "observe_quote" }, contradicted)
      );

      expect(frozen.phase).toBe("frozen");
      expect(frozen.privateState.transcript.choreography.phase).toBe("failed");
      expect(frozen.evidence.chainStates).toEqual(["terms_mismatch:quote:htlc-amount"]);
    });
  });

  describe("prepare_quote_refund", () => {
    async function lockedQuote(): Promise<{
      context: Harness;
      makerSession: TradeSession;
      takerSession: TradeSession;
      htlcId: string;
    }> {
      const context = harness();
      const { addresses, taker } = context;
      const expected = expectedFor("quote", addresses);
      const completed = await taker.chain.completeLock(
        await taker.chain.prepareLock({ expected, now: NOW })
      );
      const locked = (role: "maker" | "taker"): TradeSession => boundSession(
        role,
        addresses,
        {
          phase: "quote_locked",
          privateState: {
            legs: {
              quote: {
                htlcId: completed.htlcId,
                expected: clone(expected),
                observations: [
                  { observedAt: NOW - 5, state: "LOCKED", witnessCommitment: null }
                ]
              }
            }
          },
          evidence: {
            legs: {
              quote: {
                htlcId: completed.htlcId,
                validationCommitment: completed.summary.validationCommitment,
                htlcState: "LOCKED",
                observedAt: NOW - 5
              }
            }
          }
        }
      );
      return {
        context,
        makerSession: locked("maker"),
        takerSession: locked("taker"),
        htlcId: completed.htlcId
      };
    }

    it("refuses before the expiry guard and leaves the recovery path intact", async () => {
      const { context, takerSession } = await lockedQuote();

      const failure = await context.taker.effects.performExternal(
        externalInput({ kind: "prepare_quote_refund" }, takerSession)
      ).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(ZwapChainEffectError);
      expect((failure as ZwapChainEffectError).code).toBe("chain_rejected");

      const recovering = await context.taker.effects.applyLocal({
        action: { kind: "enter_recovery" },
        session: takerSession,
        now: NOW
      });

      expect(recovering.phase).toBe("waiting_quote_refund");
      expect(recovering.privateState.transcript.choreography.phase).toBe("refunding");
    });

    it("reclaims after the expiry guard, and the counterparty then observes RECLAIMED", async () => {
      const { context, takerSession, makerSession, htlcId } = await lockedQuote();
      const after = SHORT_LOCKTIME + REFUND_GUARD_SECONDS + 1;
      context.clock.now = after;

      const prepared = await context.taker.effects.performExternal(
        externalInputAt({ kind: "prepare_quote_refund" }, takerSession, after)
      );

      // A refund spends an HTLC, not this account's free balance, so the
      // planner goes straight to execution with no reservation step.
      expect(prepared.privateState.chainOperation).toMatchObject({
        leg: "quote",
        kind: "refund",
        status: "prepared",
        fundsReserved: true
      });
      expect(prepared.evidence.legs.quote.refundOperationCommitment)
        .toBe(prepared.privateState.chainOperation?.artifact.operationCommitment);
      expect((await context.taker.reservations.load()).reservations).toEqual([]);

      const executed = await context.taker.effects.performExternal(
        externalInputAt({ kind: "execute_chain_operation" }, prepared, after)
      );

      expect(executed.privateState.chainOperation).toMatchObject({
        status: "completed",
        result: { htlcId, tokenStandard: QSR_ZTS, amount: "1" }
      });
      expect(await context.node.getHtlc(htlcId)).toBeNull();
      expect(await context.node.listUnreceived(context.addresses.taker))
        .toHaveLength(1);

      const observed = await context.maker.effects.performExternal(
        externalInputAt({ kind: "observe_quote" }, makerSession, after)
      );

      expect(observed.evidence.legs.quote).toMatchObject({
        htlcState: "RECLAIMED",
        observedAt: after,
        spendCommitment: null
      });
    });
  });

  describe("externalFingerprintMaterial", () => {
    it("changes when the funds reservation revision changes", async () => {
      const { maker, addresses } = harness();
      const session = boundSession("maker", addresses);

      const before = await maker.effects.externalFingerprintMaterial!(
        { kind: "prepare_base_lock" },
        session
      );
      await maker.reservations.reserve(
        (await maker.reservations.load()).revision,
        {
          sessionId: "another-session",
          tokenStandard: ZNN_ZTS,
          amount: "5",
          reservedAt: NOW - 50
        }
      );
      const after = await maker.effects.externalFingerprintMaterial!(
        { kind: "prepare_base_lock" },
        session
      );

      expect(before).toEqual({
        reservationRevision: 0,
        address: addresses.maker,
        expected: expectedFor("base", addresses)
      });
      expect(after).toEqual({
        reservationRevision: 1,
        address: addresses.maker,
        expected: expectedFor("base", addresses)
      });
      expect(after).not.toEqual(before);
    });

    it("binds a claim to its HTLC ID rather than to the account address", async () => {
      const { maker, taker, addresses } = harness();
      const expected = expectedFor("quote", addresses);
      const completed = await taker.chain.completeLock(
        await taker.chain.prepareLock({ expected, now: NOW })
      );
      const session = boundSession("maker", addresses, {
        privateState: {
          legs: {
            quote: {
              htlcId: completed.htlcId,
              expected: clone(expected),
              observations: []
            }
          }
        }
      });

      const material = await maker.effects.externalFingerprintMaterial!(
        { kind: "prepare_quote_claim" },
        session
      );

      expect(material).toEqual({
        reservationRevision: 0,
        htlcId: completed.htlcId,
        expected
      });
    });
  });

  describe("shared order and Nostr effects", () => {
    it("retries the exact persisted Nostr wrapper and only records its receipts", async () => {
      const { maker, addresses } = harness();
      const session = boundSession("maker", addresses);
      session.privateState.legs.base.expected = expectedFor("base", addresses);
      session.privateState.legs.base.htlcId = "5a".repeat(32);
      session.evidence.legs.base.htlcId = "5a".repeat(32);
      session.evidence.legs.base.validationCommitment = "5b".repeat(32);
      session.privateState.outbox = {
        message: {
          schema: "granola/dm/v1",
          deployment: NETWORK,
          type: "base_lock",
          message_id: "11111111-1111-4111-8111-111111111112",
          session_id: session.sessionId,
          reservation_id: session.reservationId,
          order_address: session.orderAddress,
          order_projection_id: RESERVE_PROJECTION_ID,
          order_revision: "1",
          maker_order_pubkey: FIXTURE_MAKER_PUBKEY,
          author_pubkey: FIXTURE_SESSION_PUBKEY,
          recipient_pubkey: COUNTERPARTY_PUBKEY,
          sequence: "3",
          previous_message_id: LAST_MESSAGE_ID,
          previous_transcript_hash: LAST_TRANSCRIPT_HASH,
          sent_at: NOW - 10,
          expires_at: NOW + 300,
          terms_hash: TERMS_HASH,
          body: {
            schema: "zwap/atomic-swap-body/v1",
            htlc_id: "5a".repeat(32),
            validation_commitment: "5b".repeat(32),
            settlement_hash: HTLC_HASH,
            chain_id: "1",
            token_standard: ZNN_ZTS,
            amount: "20",
            hash_locked_address: addresses.taker,
            time_locked_address: addresses.maker,
            expiration_time: LONG_LOCKTIME
          }
        },
        rumor: {
          kind: 14,
          created_at: NOW - 10,
          tags: [["p", COUNTERPARTY_PUBKEY]],
          content: "encrypted-rumor",
          id: "94".repeat(32),
          pubkey: FIXTURE_SESSION_PUBKEY
        },
        seal: event(13, "95"),
        wrapper: event(1059, "96", [["p", COUNTERPARTY_PUBKEY]]),
        recipientInboxListId: "97".repeat(32),
        recipientRelays: ["wss://recipient.example"],
        receipts: [],
        nextChoreography: clone(
          session.privateState.transcript.choreography
        ) as AtomicSwapChoreography,
        status: "staged"
      };
      const receipts = [{
        relay: "wss://recipient.example",
        ok: true,
        message: "stored"
      }];
      const sentKeys: Uint8Array[] = [];
      maker.nostr.send.mockImplementation(async (
        _wrapper: NostrEvent,
        _relays: string[],
        secretKey: Uint8Array
      ) => {
        sentKeys.push(Uint8Array.from(secretKey));
        return receipts;
      });

      const first = await maker.effects.performExternal(
        externalInput({ kind: "deliver_outbox" }, session)
      );
      const retry = await maker.effects.performExternal(
        externalInput({ kind: "deliver_outbox" }, session)
      );

      expect(maker.nostr.send).toHaveBeenCalledTimes(2);
      for (const [wrapper, relays] of maker.nostr.send.mock.calls) {
        expect(wrapper).toEqual(session.privateState.outbox!.wrapper);
        expect(relays).toEqual(session.privateState.outbox!.recipientRelays);
      }
      expect(sentKeys).toEqual([
        new Uint8Array(32).fill(1),
        new Uint8Array(32).fill(1)
      ]);
      expect(first.privateState.outbox).toEqual({
        ...session.privateState.outbox,
        receipts,
        status: "acknowledged"
      });
      expect(retry).toEqual(first);
    });

    it("uses the shared order outbox as retry authority and never republishes an acknowledged stage", async () => {
      const { maker, addresses } = harness();
      const session = boundSession("maker", addresses);
      session.pendingOrderPublication = {
        operation: "reserve",
        orderId: FIXTURE_ORDER_ID,
        projection: event(30078, "a2"),
        receipts: [],
        status: "staged",
        stagedAt: NOW - 10,
        acknowledgedAt: null,
        committedAt: null
      };
      const stagedEntry = {
        schema: "granola/order-outbox/v3",
        status: "staged",
        intent: {
          operation: "reserve",
          orderId: FIXTURE_ORDER_ID,
          address: session.orderAddress,
          createdAt: NOW - 10
        },
        publication: {
          state: { revision: "1" },
          projection: session.pendingOrderPublication.projection,
          receipts: []
        }
      } as unknown as OrderOutboxEntry;
      const acknowledgedEntry = clone(stagedEntry);
      acknowledgedEntry.status = "acknowledged";
      acknowledgedEntry.publication.receipts = [{
        relay: "wss://orders.example",
        ok: true,
        message: "stored"
      }];
      let durableEntry = stagedEntry;
      maker.orderOutbox.load.mockImplementation(async () => clone(durableEntry));
      maker.orderApi.publishNextStage.mockImplementation(async () => {
        durableEntry = acknowledgedEntry;
        return { orderId: FIXTURE_ORDER_ID };
      });

      const first = await maker.effects.performExternal(
        externalInput({ kind: "publish_order_projection" }, session)
      );
      const retry = await maker.effects.performExternal(
        externalInput({ kind: "publish_order_projection" }, session)
      );

      expect(maker.orderApi.publishNextStage).toHaveBeenCalledTimes(1);
      expect(maker.orderApi.publishNextStage).toHaveBeenCalledWith(FIXTURE_ORDER_ID);
      expect(first.pendingOrderPublication?.status).toBe("acknowledged");
      expect(first.pendingOrderPublication?.receipts)
        .toEqual(acknowledgedEntry.publication.receipts);
      expect(retry).toEqual(first);
    });

    it("advances the session clock when order staging crosses a wall-clock second", async () => {
      const { maker, addresses } = harness();
      const session = boundSession("maker", addresses, {
        reserveProjectionId: null,
        reserveProjectionRevision: null,
        evidence: {
          reserveProjectionId: null,
          reserveProjectionRevision: null,
          reservation: { takerCommitment: null }
        },
        privateState: {
          transcript: {
            choreography: { phase: "awaiting_reserve_accept" }
          }
        }
      });
      const projection = event(30078, "b2");
      projection.created_at = NOW + 1;
      const stagedEntry = {
        schema: "granola/order-outbox/v3",
        status: "staged",
        intent: {
          operation: "reserve",
          orderId: FIXTURE_ORDER_ID,
          address: session.orderAddress,
          createdAt: NOW + 1,
          state: { reservation: { taker_commitment: "bc".repeat(32) } }
        },
        publication: {
          state: {
            revision: "1",
            reservation: { taker_commitment: "bc".repeat(32) }
          },
          projection,
          receipts: []
        }
      } as unknown as OrderOutboxEntry;
      maker.orderApi.ensureReserveStaged.mockResolvedValue({
        orderId: FIXTURE_ORDER_ID
      });
      maker.orderOutbox.load.mockResolvedValue(stagedEntry);

      const staged = await maker.effects.performExternal(
        externalInput({ kind: "stage_order_reserve" }, session)
      );

      expect(staged.pendingOrderPublication?.stagedAt).toBe(NOW + 1);
      expect(staged.updatedAt).toBe(NOW + 1);
    });

    it("accepts only the maker's exact current published fill before taker termination", async () => {
      const { taker, addresses } = harness();
      const publication = await publishedFill();
      const session = boundSession("taker", addresses, {
        phase: "quote_locked",
        orderAddress:
          `30078:${publication.projection.pubkey}:zwap:order:v1:${FIXTURE_ORDER_ID}`,
        reserveProjectionId: "32".repeat(32),
        reserveProjectionRevision: "1",
        evidence: {
          makerPubkey: publication.projection.pubkey,
          reserveProjectionId: "32".repeat(32),
          reserveProjectionRevision: "1"
        },
        privateState: {
          transcript: { choreography: { phase: "settling" } }
        }
      });

      taker.orderReader.loadLatestPublishedProjection.mockRejectedValueOnce(
        new Error("fill is absent from relays")
      );
      await expect(taker.effects.performExternal(
        externalInput({ kind: "verify_order_fill" }, session)
      )).rejects.toThrow(/absent/i);

      taker.orderReader.loadLatestPublishedProjection.mockResolvedValueOnce({
        ...publication,
        eventId: "ff".repeat(32)
      });
      await expect(taker.effects.performExternal(
        externalInput({ kind: "verify_order_fill" }, session)
      )).rejects.toThrow(/projection|fill/i);

      taker.orderReader.loadLatestPublishedProjection
        .mockResolvedValueOnce(publication);
      const verified = await taker.effects.performExternal(
        externalInput({ kind: "verify_order_fill" }, session)
      );

      expect(taker.orderReader.loadLatestPublishedProjection)
        .toHaveBeenLastCalledWith(session.orderAddress);
      expect(verified.fillProjectionId).toBe(publication.eventId);
      expect(verified.evidence.fillProjectionId).toBe(publication.eventId);
      expect(verified.privateState.transcript.choreography.phase).toBe("settled");
    });

    it("polls with the bounded NIP-17 lookback and skips replayed wrappers", async () => {
      const { maker, addresses } = harness();
      const session = boundSession("maker", addresses);
      const replay = event(1059, "81");
      replay.created_at = session.updatedAt - 120;
      const fresh = event(1059, "82");
      fresh.created_at = session.updatedAt - 60;
      maker.nostr.read.mockImplementation(async (
        _recipient: string,
        _key: Uint8Array,
        since: number
      ) => [replay, fresh].filter((wrapper) => wrapper.created_at >= since));
      const openIncoming = vi.fn()
        .mockRejectedValueOnce(new Error("message was already accepted"))
        .mockResolvedValueOnce({
          wrapper: fresh,
          seal: event(13, "83"),
          rumor: event(14, "84"),
          message: { message_id: "11111111-1111-4111-8111-111111111115" },
          transcriptHash: "85".repeat(32)
        });
      Object.assign(maker.effects, { openIncoming });

      const polled = await maker.effects.performExternal(
        externalInput({ kind: "poll_inbox" }, session)
      );

      expect(maker.nostr.read).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Uint8Array),
        session.updatedAt - 172_800
      );
      expect(openIncoming).toHaveBeenCalledTimes(2);
      expect(polled.privateState.pendingIncoming?.wrapper).toEqual(fresh);
    });
  });
});
