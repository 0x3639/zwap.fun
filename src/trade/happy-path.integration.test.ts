import {
  finalizeEvent,
  getPublicKey,
  type EventTemplate
} from "nostr-tools/pure";
import { describe, expect, it } from "vitest";

import { OrderApi } from "../api/order-api.js";
import { createInboxList } from "../nostr/inbox.js";
import type { DiscoveredTradeInbox } from "../nostr/trade-transport.js";
import type { NostrEvent, UnsignedNostrEvent } from "../order/events.js";
import type { OrderRecord } from "../order/model.js";
import {
  NostrOrderService,
  type OrderRelayPort,
  type OrderSigner
} from "../order/service.js";
import { MemoryStorageDriver } from "../storage/driver.js";
import { OrderOutboxRepository } from "../storage/order-outbox.js";
import { TradeSessionRepository } from "../storage/trade-session.js";
import { ZenonAccount } from "../zenon/account.js";
import { FakeZenonNode } from "../zenon/fake-node.js";
import { FundsReservationRepository } from "../zenon/funds-reservations.js";
import { fakeReclaimDecoder, fakeUnlockDecoder } from "../zenon/htlc.js";
import { createHtlcMaterial } from "../zenon/htlc-material.js";
import { ZenonTradeClient } from "../zenon/trade-client.js";
import { QSR_ZTS, ZNN_ZTS } from "../zenon/types.js";
import { nextCoordinatorAction, type CoordinatorAction } from "./coordinator-plan.js";
import { TradeCoordinator } from "./coordinator.js";
import { ZwapCoordinatorEffects } from "./effects.js";
import {
  deploymentFor,
  unwrapInitialReserveProposalForMaker
} from "./messages.js";
import {
  createMakerSession,
  createTakerSession,
  type SessionFactoryEntropy
} from "./session-factory.js";
import type { TradeSession } from "./session.js";

const NOW = 1_800_000_000;
const CHAIN_ID = "1";
const NETWORK = deploymentFor(CHAIN_ID);
const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22".repeat(32);
const RESERVATION_ID = "33333333-3333-4333-8333-333333333333";

/** 20 base minor units at price 5000000 settle for exactly 1 quote unit. */
const BASE_AMOUNT = "20";
const QUOTE_AMOUNT = "1";
const PRICE = "5000000";

const SHORT_LOCK_SECONDS = 1_800;
const LONG_LOCK_SECONDS = 3_600;
const RESERVATION_GRACE_SECONDS = 600;
const REFUND_GUARD_SECONDS = 60;

const DISCOVERY_RELAYS = [
  "wss://discovery-one.example",
  "wss://discovery-two.example",
  "wss://discovery-three.example"
];
const INBOX_RELAY = "wss://inbox.example";
const ORDER_RELAYS = ["wss://orders-one.example", "wss://orders-two.example"];

function secret(lastByte: number): Uint8Array {
  const result = new Uint8Array(32);
  result[31] = lastByte;
  return result;
}

function hex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );
  return hex(new Uint8Array(digest));
}

function uuid(counter: number): string {
  return `00000000-0000-4000-8000-${counter.toString().padStart(12, "0")}`;
}

function sessionEntropy(role: "maker" | "taker"): SessionFactoryEntropy {
  return {
    sessionId: () => SESSION_ID,
    reservationId: () => RESERVATION_ID,
    privateKey: () => hex(secret(role === "maker" ? 5 : 2)),
    htlcMaterial: () => createHtlcMaterial()
  };
}

function effectEntropy(seed: number) {
  let message = seed;
  let operation = seed + 100;
  let ephemeral = seed / 100 + 20;
  let nonce = seed / 100 + 30;
  return {
    messageId: () => uuid(message++),
    operationId: () => uuid(operation++),
    ephemeralSecretKey: () => secret(ephemeral++),
    nonce: () => new Uint8Array(32).fill(nonce++),
    randomizedTimestamp: (now: number, purpose: "seal" | "wrapper") =>
      now - (purpose === "seal" ? 1 : 2),
    outerExpiration: (expiration: number) => expiration + 3_600
  };
}

class MemoryOrderRelay implements OrderRelayPort {
  private readonly projections = new Map<string, NostrEvent>();

  async publish(event: NostrEvent) {
    if (event.kind === 30078) {
      const identifier = event.tags.find((tag) => tag[0] === "d")?.[1];
      if (!identifier) throw new Error("Projection lacks its replaceable identifier");
      this.projections.set(`${event.pubkey}:${identifier}`, structuredClone(event));
    }
    return ORDER_RELAYS.map((relay) => ({ relay, ok: true, message: "stored" }));
  }

  async queryProjections(): Promise<NostrEvent[]> {
    return structuredClone([...this.projections.values()]);
  }

  async queryOrder(address: string): Promise<NostrEvent[]> {
    const [, author, ...identifierParts] = address.split(":");
    const identifier = identifierParts.join(":");
    const event = this.projections.get(`${author}:${identifier}`);
    return event === undefined ? [] : [structuredClone(event)];
  }
}

/**
 * The two-party Nostr side of the protocol, in memory. Gift wraps land in the
 * recipient's bucket exactly once, which is what makes `poll_inbox` retries and
 * replay skipping observable.
 */
class MemoryTradeTransport {
  private readonly registrations = new Map<string, NostrEvent>();
  private readonly wrappers = new Map<string, NostrEvent[]>();

  constructor(private readonly clock: { now: number }) {}

  createRegistration(protocolSecretKey: Uint8Array): NostrEvent {
    return createInboxList([INBOX_RELAY], protocolSecretKey, this.clock.now);
  }

  async publishRegistration(event: NostrEvent, _key: Uint8Array) {
    this.registrations.set(event.pubkey, structuredClone(event));
    return {
      event: structuredClone(event),
      receipts: DISCOVERY_RELAYS.map((relay) => ({
        relay,
        ok: true,
        message: "stored"
      })),
      readback: DISCOVERY_RELAYS.map((relay) => ({
        relay,
        found: true,
        event: structuredClone(event),
        observedAt: this.clock.now
      })),
      confirmed: [...DISCOVERY_RELAYS]
    };
  }

  async discoverInbox(
    authorPubkey: string,
    _requesterSecretKey: Uint8Array
  ): Promise<DiscoveredTradeInbox> {
    const event = this.registrations.get(authorPubkey);
    if (!event) throw new Error("Recipient inbox is not registered");
    return {
      event: structuredClone(event),
      eventId: event.id,
      relays: [INBOX_RELAY]
    };
  }

  async send(wrapper: NostrEvent, _relays: readonly string[]) {
    const recipient = wrapper.tags.find((tag) => tag[0] === "p")?.[1];
    if (!recipient) throw new Error("Gift wrap has no recipient");
    const current = this.wrappers.get(recipient) ?? [];
    if (!current.some((event) => event.id === wrapper.id)) {
      current.push(structuredClone(wrapper));
      this.wrappers.set(recipient, current);
    }
    return [{ relay: INBOX_RELAY, ok: true, message: "stored" }];
  }

  async read(recipientPubkey: string): Promise<NostrEvent[]> {
    return structuredClone(this.wrappers.get(recipientPubkey) ?? []);
  }

  wrappersFor(recipientPubkey: string): NostrEvent[] {
    return structuredClone(this.wrappers.get(recipientPubkey) ?? []);
  }
}

interface Party {
  role: "maker" | "taker";
  address: string;
  sessions: TradeSessionRepository;
  coordinator: TradeCoordinator;
  reservations: FundsReservationRepository;
  account: ZenonAccount;
}

interface Stack {
  clock: { now: number };
  node: FakeZenonNode;
  transport: MemoryTradeTransport;
  orderService: NostrOrderService;
  order: OrderRecord;
  makerOrderKey: Uint8Array;
  makerPubkey: string;
  maker: Party;
  taker: Party;
}

async function stack(side: "buy" | "sell" = "sell"): Promise<Stack> {
  const clock = { now: NOW };
  const node = new FakeZenonNode({ chainId: 1, now: () => clock.now });
  const makerAddress = node.createAddress("maker");
  const takerAddress = node.createAddress("taker");
  // The maker funds the leg it offers; the taker funds the other one.
  node.fund(makerAddress, side === "sell" ? ZNN_ZTS : QSR_ZTS,
    side === "sell" ? BASE_AMOUNT : QUOTE_AMOUNT);
  node.fund(takerAddress, side === "sell" ? QSR_ZTS : ZNN_ZTS,
    side === "sell" ? QUOTE_AMOUNT : BASE_AMOUNT);

  const makerOrderKey = secret(1);
  const makerPubkey = getPublicKey(makerOrderKey);
  const signer: OrderSigner = {
    publicKey: async () => makerPubkey,
    sign: async (template: UnsignedNostrEvent) =>
      finalizeEvent(template as EventTemplate, makerOrderKey)
  };
  const orderRelay = new MemoryOrderRelay();
  const orderService = new NostrOrderService(signer, orderRelay);
  const orderOutbox = new OrderOutboxRepository(new MemoryStorageDriver());
  const orderApi = new OrderApi(
    { publicKey: async () => makerPubkey },
    orderService,
    () => clock.now,
    () => ORDER_ID,
    orderOutbox
  );
  await orderApi.publishOrder({
    side,
    amount: BASE_AMOUNT,
    price: PRICE,
    expiresAt: NOW + 9 * 86_400
  });
  const book = (await orderService.loadBook(
    { chainId: CHAIN_ID, baseToken: ZNN_ZTS, quoteToken: QSR_ZTS },
    NOW
  )).book;
  const order = (side === "sell" ? book.asks[0] : book.bids[0])!;

  const transport = new MemoryTradeTransport(clock);
  await transport.publishRegistration(
    transport.createRegistration(makerOrderKey),
    makerOrderKey
  );

  // One shared clock for the chain, the order projections and both
  // coordinators. `tick` advances *before* handing the step its time, so
  // anything an effect stamps during that step lands on the same second rather
  // than after it - a readback observed later than its own registration is a
  // durable-validator failure.
  const tick = (): number => {
    clock.now += 1;
    return clock.now;
  };
  const party = (role: "maker" | "taker", address: string, seed: number): Party => {
    const driver = new MemoryStorageDriver();
    const sessions = new TradeSessionRepository(driver);
    const reservations = new FundsReservationRepository(new MemoryStorageDriver());
    const chain = new ZenonTradeClient({
      node,
      signer: node.signer(address),
      decodeUnlock: fakeUnlockDecoder,
      decodeReclaim: fakeReclaimDecoder,
      now: () => clock.now
    });
    const effects = new ZwapCoordinatorEffects({
      orderApi,
      orderOutbox,
      orderReader: orderService,
      nostr: transport,
      chain,
      node,
      reservations,
      makerIdentity: {
        publicKey: async () => makerPubkey,
        useSecretKey: async <T>(action: (key: Uint8Array) => Promise<T>) =>
          action(Uint8Array.from(makerOrderKey))
      },
      discoveryRelays: DISCOVERY_RELAYS,
      withAccountLock: async <T>(action: () => Promise<T>) => action(),
      network: NETWORK,
      entropy: effectEntropy(seed),
      commitment: sha256
    });
    return {
      role,
      address,
      sessions,
      reservations,
      coordinator: new TradeCoordinator({ repository: sessions, effects, now: tick }),
      account: new ZenonAccount({
        node,
        signer: node.signer(address),
        now: () => clock.now
      })
    };
  };

  return {
    clock,
    node,
    transport,
    orderService,
    order,
    makerOrderKey,
    makerPubkey,
    maker: party("maker", makerAddress, 1_000),
    taker: party("taker", takerAddress, 2_000)
  };
}

async function session(party: Party): Promise<TradeSession> {
  const value = await party.sessions.get(SESSION_ID);
  if (!value) throw new Error(`${party.role} session is missing`);
  return value;
}

/**
 * Drives whichever parties still have work, one durable action at a time,
 * deferring the polling actions so a party never spins on an inbox that its
 * counterparty has not written to yet.
 */
async function drive(
  stackValue: Stack,
  parties: Party[],
  options: { stopWhen?: (party: Party, session: TradeSession) => boolean; steps?: number } = {}
): Promise<string[]> {
  const trace: string[] = [];
  const limit = options.steps ?? 300;
  for (let step = 0; step < limit; step += 1) {
    const candidates: Array<{
      party: Party;
      action: CoordinatorAction;
      phase: string;
    }> = [];
    for (const party of parties) {
      const current = await session(party);
      if (options.stopWhen?.(party, current)) continue;
      const action = nextCoordinatorAction(current, stackValue.clock.now);
      if (action.kind === "none") continue;
      candidates.push({
        party,
        action,
        phase: current.privateState.transcript.choreography.phase
      });
    }
    if (candidates.length === 0) return trace;
    const priority = ({ action }: (typeof candidates)[number]): number =>
      action.kind === "observe_base"
        ? 2
        : action.kind === "observe_quote" || action.kind === "poll_inbox"
          ? 1
          : 0;
    candidates.sort((left, right) => priority(left) - priority(right));

    let advanced = false;
    for (const candidate of candidates) {
      try {
        await candidate.party.coordinator.advance(SESSION_ID);
        trace.push(`${candidate.party.role}:${candidate.action.kind}`);
        advanced = true;
        break;
      } catch (error) {
        if (
          candidate.action.kind !== "poll_inbox" ||
          !(error instanceof Error) ||
          !/private trade message/.test(error.message)
        ) {
          throw new Error(
            `${candidate.party.role} ${candidate.phase} ${candidate.action.kind} failed: ` +
            `${String(error)}`,
            { cause: error }
          );
        }
      }
    }
    if (!advanced) return trace;
  }
  throw new Error(`Coordinator loop stalled: ${trace.slice(-20).join(", ")}`);
}

async function startTaker(stackValue: Stack): Promise<void> {
  await stackValue.taker.sessions.save(await createTakerSession({
    order: stackValue.order,
    expectedOrderProjectionId: stackValue.order.eventId,
    expectedOrderRevision: "0",
    market: { chainId: CHAIN_ID, baseToken: ZNN_ZTS, quoteToken: QSR_ZTS },
    fillBaseAmount: BASE_AMOUNT,
    clocks: { localNow: NOW, chainNow: NOW },
    localAddress: stackValue.taker.address
  }, sessionEntropy("taker")), null);
}

async function startMaker(stackValue: Stack): Promise<void> {
  const wrapper = stackValue.transport.wrappersFor(stackValue.makerPubkey)[0]!;
  const proposal = await unwrapInitialReserveProposalForMaker(
    wrapper,
    stackValue.makerOrderKey,
    { now: stackValue.clock.now }
  );
  await stackValue.maker.sessions.save(await createMakerSession({
    order: stackValue.order,
    proposal,
    market: { chainId: CHAIN_ID, baseToken: ZNN_ZTS, quoteToken: QSR_ZTS },
    clocks: { localNow: NOW, chainNow: NOW },
    localAddress: stackValue.maker.address
  }, sessionEntropy("maker")), null);
}

async function balance(
  node: FakeZenonNode,
  address: string,
  token: string
): Promise<string> {
  const balances = await node.getBalances(address);
  return balances.find((entry) => entry.tokenStandard === token)?.balance ?? "0";
}

describe("two-party Zenon atomic swap", () => {
  async function settle(side: "buy" | "sell"): Promise<void> {
    const value = await stack(side);
    await startTaker(value);
    await drive(value, [value.taker], {
      stopWhen: (_party, current) =>
        current.privateState.transcript.choreography.phase === "awaiting_reserve_accept"
    });
    await startMaker(value);

    // The acceptance stage is chain-free by design: until the taker's
    // session_ack arrives the maker has published a reservation but holds no
    // HTLC and has no chain operation in flight.
    await drive(value, [value.maker, value.taker], {
      stopWhen: (party, current) =>
        party.role === "maker" &&
        current.privateState.transcript.choreography.phase === "awaiting_session_ack"
    });
    const accepted = await session(value.maker);
    expect(accepted.reserveProjectionId).not.toBeNull();
    expect(accepted.privateState.legs.base.htlcId).toBeNull();
    expect(accepted.privateState.legs.quote.htlcId).toBeNull();
    expect(accepted.privateState.chainOperation).toBeNull();

    const trace = await drive(value, [value.maker, value.taker]);

    expect(trace.some((action) =>
      action.includes("refund") || action.endsWith(":enter_recovery")
    )).toBe(false);
    const maker = await session(value.maker);
    const taker = await session(value.taker);
    expect([maker.phase, taker.phase]).toEqual(["filled", "filled"]);
    expect(nextCoordinatorAction(maker, value.clock.now)).toEqual({ kind: "none" });
    expect(nextCoordinatorAction(taker, value.clock.now)).toEqual({ kind: "none" });

    // Both HTLCs were unlocked with the preimage, never reclaimed.
    for (const current of [maker, taker]) {
      expect(current.evidence.legs.base.htlcState).toBe("UNLOCKED");
      expect(current.evidence.legs.quote.htlcState).toBe("UNLOCKED");
    }

    // Each side ends up holding exactly the leg it was owed. A sell-side maker
    // is paid in quote; a buy-side maker is paid in base.
    const makerReceives = side === "sell"
      ? { tokenStandard: QSR_ZTS, symbol: "QSR", decimals: 8, balance: QUOTE_AMOUNT }
      : { tokenStandard: ZNN_ZTS, symbol: "ZNN", decimals: 8, balance: BASE_AMOUNT };
    const takerReceives = side === "sell"
      ? { tokenStandard: ZNN_ZTS, symbol: "ZNN", decimals: 8, balance: BASE_AMOUNT }
      : { tokenStandard: QSR_ZTS, symbol: "QSR", decimals: 8, balance: QUOTE_AMOUNT };

    // The claimed funds arrive as unreceived blocks until each side sweeps.
    expect(await value.node.getBalances(value.maker.address)).toEqual([]);
    expect(await value.node.getBalances(value.taker.address)).toEqual([]);
    await expect(value.maker.account.receiveAll()).resolves.toBe(1);
    await expect(value.taker.account.receiveAll()).resolves.toBe(1);

    expect(await value.node.getBalances(value.maker.address)).toEqual([makerReceives]);
    expect(await value.node.getBalances(value.taker.address)).toEqual([takerReceives]);

    // Every reservation the locks took out was released again.
    expect((await value.maker.reservations.load()).reservations).toEqual([]);
    expect((await value.taker.reservations.load()).reservations).toEqual([]);

    // The maker's published order ends filled and the taker verified it.
    const published = await value.orderService.loadPublishedProjection(
      maker.orderAddress,
      maker.fillProjectionId!,
      maker.fillProjectionRevision!
    );
    expect(published.record.state).toMatchObject({
      status: "filled",
      remaining_amount: "0",
      reserved_amount: "0",
      reservation: null
    });
    expect(taker.evidence.fillProjectionId).toBe(maker.fillProjectionId);

    // Nothing private leaks through the public coordinator view.
    const views = JSON.stringify([
      await value.maker.coordinator.get(SESSION_ID),
      await value.taker.coordinator.get(SESSION_ID)
    ]);
    for (const secretValue of [
      maker.privateState.preimage!,
      maker.privateState.nostrPrivateKey,
      taker.privateState.nostrPrivateKey
    ]) {
      expect(views).not.toContain(secretValue);
    }
  }

  it("settles a sell-side ZNN/QSR order end to end on one fake node", async () => {
    await settle("sell");
  }, 60_000);

  it("settles a buy-side order with the market legs reversed", async () => {
    await settle("buy");
  }, 60_000);

  it("freezes a maker abandoned before session_ack with nothing on chain", async () => {
    // The point of deferring the base lock: a reservation proposal that is
    // never followed up costs the maker no chain funds and no plasma - only
    // the published reservation, which expires on its own.
    const value = await stack("sell");
    await startTaker(value);
    await drive(value, [value.taker], {
      stopWhen: (_party, current) =>
        current.privateState.transcript.choreography.phase === "awaiting_reserve_accept"
    });
    await startMaker(value);
    await drive(value, [value.maker], {
      stopWhen: (_party, current) =>
        current.privateState.transcript.choreography.phase === "awaiting_session_ack"
    });

    const accepted = await session(value.maker);
    value.clock.now = accepted.plan.reservationExpiresAt;
    const trace = await drive(value, [value.maker]);

    expect(trace[0]).toBe("maker:enter_recovery");
    const frozen = await session(value.maker);
    expect(frozen.phase).toBe("frozen");
    expect(frozen.privateState.legs.base.htlcId).toBeNull();
    expect(frozen.privateState.legs.quote.htlcId).toBeNull();
    // No lock, no refund, no reservation: the maker's funds never moved.
    expect(await balance(value.node, value.maker.address, ZNN_ZTS)).toBe(BASE_AMOUNT);
    expect((await value.maker.reservations.load()).reservations).toEqual([]);
  }, 60_000);

  it("refunds the maker after a slept-through cutoff when the taker never locks", async () => {
    const value = await stack("sell");
    await startTaker(value);
    await drive(value, [value.taker], {
      stopWhen: (_party, current) =>
        current.privateState.transcript.choreography.phase === "awaiting_reserve_accept"
    });
    await startMaker(value);

    // Drive both sides until the taker is the one who owes the quote lock,
    // then abandon the taker.
    await drive(value, [value.maker, value.taker], {
      stopWhen: (party, current) =>
        party.role === "taker" &&
        current.privateState.transcript.choreography.phase === "awaiting_quote_lock"
    });
    const stalled = await session(value.maker);
    expect(stalled.phase).toBe("base_locked");
    expect(stalled.privateState.legs.base.htlcId).not.toBeNull();
    expect(await balance(value.node, value.maker.address, ZNN_ZTS)).toBe("0");

    const plan = stalled.plan;
    expect(plan.shortLocktime).toBe(plan.anchor + SHORT_LOCK_SECONDS);
    expect(plan.longLocktime).toBe(plan.anchor + LONG_LOCK_SECONDS);
    expect(plan.reservationExpiresAt)
      .toBe(plan.anchor + LONG_LOCK_SECONDS + RESERVATION_GRACE_SECONDS);
    expect(plan.refundGuardSeconds).toBe(REFUND_GUARD_SECONDS);

    // ONE jump, straight over `makerClaimCutoff` and the refund guard: a maker
    // whose tab was closed for the whole window never evaluates a per-phase
    // cutoff, so the planner has to put it on the refund ladder itself. The
    // release projection is only publishable once the reservation has expired,
    // which is 600s past the long locktime, so that bound sets the jump.
    expect(plan.reservationExpiresAt)
      .toBeGreaterThan(plan.longLocktime + plan.refundGuardSeconds);
    value.clock.now = plan.reservationExpiresAt;

    const trace = await drive(value, [value.maker]);

    // The ladder was walked rather than jumped.
    expect(trace[0]).toBe("maker:enter_recovery");
    expect(trace).toContain("maker:prepare_base_refund");
    const maker = await session(value.maker);
    expect(maker.phase).toBe("released");
    expect(nextCoordinatorAction(maker, value.clock.now)).toEqual({ kind: "none" });
    // The refund is evidenced by its operation commitment; the HTLC itself is
    // gone from the chain rather than re-observed as RECLAIMED.
    expect(maker.evidence.legs.base.refundOperationCommitment).toMatch(/^[0-9a-f]{64}$/);
    await expect(value.node.getHtlc(stalled.privateState.legs.base.htlcId!))
      .resolves.toBeNull();
    expect((await value.maker.reservations.load()).reservations).toEqual([]);

    await expect(value.maker.account.receiveAll()).resolves.toBe(1);
    expect(await balance(value.node, value.maker.address, ZNN_ZTS)).toBe(BASE_AMOUNT);
    expect(await balance(value.node, value.taker.address, QSR_ZTS)).toBe(QUOTE_AMOUNT);

    const published = await value.orderService.loadLatestPublishedProjection(
      maker.orderAddress
    );
    expect(published.record.state).toMatchObject({
      status: "open",
      reserved_amount: "0",
      reservation: null
    });
  }, 60_000);

  /** Drives both sides until each one has locked its own leg. */
  async function bothLegsLocked(): Promise<Stack> {
    const value = await stack("sell");
    await startTaker(value);
    await drive(value, [value.taker], {
      stopWhen: (_party, current) =>
        current.privateState.transcript.choreography.phase === "awaiting_reserve_accept"
    });
    await startMaker(value);
    await drive(value, [value.maker, value.taker], {
      stopWhen: (_party, current) =>
        current.privateState.transcript.choreography.phase === "settling"
    });
    return value;
  }

  it("reclaims the maker's base leg after both legs lock and both tabs sleep", async () => {
    const value = await bothLegsLocked();
    const stalled = await session(value.maker);
    expect(stalled.phase).toBe("quote_locked");
    expect(stalled.privateState.transcript.choreography.phase).toBe("settling");
    expect(stalled.privateState.legs.base.htlcId).not.toBeNull();
    expect(stalled.privateState.legs.quote.htlcId).not.toBeNull();

    // One jump over `makerClaimCutoff`, the long locktime and the refund guard:
    // the maker never evaluated a per-phase cutoff while it slept.
    value.clock.now = stalled.plan.reservationExpiresAt;

    const trace = await drive(value, [value.maker]);
    expect(trace[0]).toBe("maker:enter_recovery");
    expect(trace).toContain("maker:prepare_base_refund");

    const maker = await session(value.maker);
    expect(maker.phase).toBe("released");
    expect(nextCoordinatorAction(maker, value.clock.now)).toEqual({ kind: "none" });
    await expect(value.node.getHtlc(stalled.privateState.legs.base.htlcId!))
      .resolves.toBeNull();
    await expect(value.maker.account.receiveAll()).resolves.toBe(1);
    expect(await balance(value.node, value.maker.address, ZNN_ZTS)).toBe(BASE_AMOUNT);
    expect((await value.maker.reservations.load()).reservations).toEqual([]);

    const published = await value.orderService.loadLatestPublishedProjection(
      maker.orderAddress
    );
    expect(published.record.state).toMatchObject({
      status: "open",
      reserved_amount: "0",
      reservation: null
    });
  }, 60_000);

  it("refunds the taker's quote leg when the maker never claims it", async () => {
    const value = await bothLegsLocked();
    const stalled = await session(value.taker);
    expect(stalled.phase).toBe("quote_locked");
    expect(stalled.privateState.legs.quote.htlcId).not.toBeNull();

    value.clock.now = stalled.plan.shortLocktime + REFUND_GUARD_SECONDS + 1;

    const trace = await drive(value, [value.taker]);
    expect(trace[0]).toBe("taker:enter_recovery");
    expect(trace).toContain("taker:prepare_quote_refund");

    const taker = await session(value.taker);
    expect(taker.phase).toBe("released");
    expect(nextCoordinatorAction(taker, value.clock.now)).toEqual({ kind: "none" });
    await expect(value.node.getHtlc(stalled.privateState.legs.quote.htlcId!))
      .resolves.toBeNull();
    await expect(value.taker.account.receiveAll()).resolves.toBe(1);
    expect(await balance(value.node, value.taker.address, QSR_ZTS)).toBe(QUOTE_AMOUNT);
    expect((await value.taker.reservations.load()).reservations).toEqual([]);
  }, 60_000);

  it("reclaims a frozen session's live lock and releases the order", async () => {
    const value = await stack("sell");
    await startTaker(value);
    await drive(value, [value.taker], {
      stopWhen: (_party, current) =>
        current.privateState.transcript.choreography.phase === "awaiting_reserve_accept"
    });
    await startMaker(value);
    await drive(value, [value.maker, value.taker], {
      stopWhen: (party, current) =>
        party.role === "taker" &&
        current.privateState.transcript.choreography.phase === "awaiting_quote_lock"
    });
    const stalled = await session(value.maker);
    expect(stalled.phase).toBe("base_locked");

    // A contradiction froze the session while its base leg was still on chain.
    const frozen = structuredClone(stalled);
    frozen.revision += 1;
    frozen.updatedAt = value.clock.now;
    frozen.phase = "frozen";
    frozen.privateState.transcript.choreography.phase = "failed";
    frozen.evidence.chainStates.push("terms_mismatch:quote:htlc-amount");
    await value.maker.sessions.save(frozen, stalled.revision);

    value.clock.now = stalled.plan.reservationExpiresAt;
    const trace = await drive(value, [value.maker]);
    expect(trace[0]).toBe("maker:enter_recovery");
    expect(trace).toContain("maker:prepare_base_refund");

    const maker = await session(value.maker);
    expect(maker.phase).toBe("released");
    expect(nextCoordinatorAction(maker, value.clock.now)).toEqual({ kind: "none" });
    await expect(value.maker.account.receiveAll()).resolves.toBe(1);
    expect(await balance(value.node, value.maker.address, ZNN_ZTS)).toBe(BASE_AMOUNT);
  }, 60_000);
});
