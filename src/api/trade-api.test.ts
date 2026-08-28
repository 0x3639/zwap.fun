import { getPublicKey } from "nostr-tools/pure";
import { describe, expect, it, vi } from "vitest";

import { createOrderState, type ExactMarket, type OrderRecord } from "../order/model.js";
import type { LoadedOrderBook } from "../order/service.js";
import { MemoryStorageDriver } from "../storage/driver.js";
import { createHtlcMaterial } from "../zenon/htlc-material.js";
import { FakeZenonNode } from "../zenon/fake-node.js";
import { FundsReservationRepository } from "../zenon/funds-reservations.js";
import { QSR_ZTS, ZNN_ZTS } from "../zenon/types.js";
import { ATOMIC_SWAP_BODY_SCHEMA } from "../trade/atomic-messages.js";
import {
  createTradeRumor,
  deploymentFor,
  termsHash,
  unwrapInitialReserveProposal,
  wrapTradeRumor,
  type VerifiedInitialReserveProposal,
  type ZwapTradeMessage
} from "../trade/messages.js";
import {
  createMakerSession,
  createTakerSession,
  type SessionFactoryEntropy,
  type SessionMarketSelection
} from "../trade/session-factory.js";
import { publicTradeView, type PublicTradeView, type TradeSession } from "../trade/session.js";
import {
  TradeApi,
  type TradeApiOptions,
  type TradeSessionFactoryPort,
  type TakerStartIntent
} from "./trade-api.js";

const now = 1_800_000_000;
const orderId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22".repeat(32);
const reservationId = "33333333-3333-4333-8333-333333333333";
const requestId = "88888888-8888-4888-8888-888888888888";
const makerOrderSecret = Uint8Array.from(
  { length: 32 },
  (_, index) => index === 31 ? 9 : 0
);
const maker = getPublicKey(makerOrderSecret);

const market: ExactMarket = {
  chainId: "1",
  baseToken: ZNN_ZTS,
  quoteToken: QSR_ZTS
};

/** ZNN per fill: 1000 base at price 2000000 settles for 20 QSR. */
const BASE_AMOUNT = "1000";
const QUOTE_AMOUNT = "20";
const PRICE = "2000000";

function hexKey(last: number): string {
  const bytes = new Uint8Array(32);
  bytes[31] = last;
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g) ?? [], (part) => Number.parseInt(part, 16));
}

function entropy(offset = 0): SessionFactoryEntropy {
  return {
    sessionId: () => sessionId,
    reservationId: () => reservationId,
    privateKey: () => hexKey(1 + offset),
    htlcMaterial: () => createHtlcMaterial()
  };
}

function order(overrides: Partial<OrderRecord> = {}): OrderRecord {
  const state = createOrderState({
    orderId,
    createdAt: now - 100,
    expiresAt: now + 9 * 86_400,
    side: "sell",
    chainId: "1",
    baseToken: ZNN_ZTS,
    quoteToken: QSR_ZTS,
    amount: BASE_AMOUNT,
    price: PRICE
  });
  return {
    address: `30078:${maker}:zwap:order:v1:${orderId}`,
    eventId: "44".repeat(32),
    makerPubkey: maker,
    verified: true,
    state,
    ...overrides
  };
}

function bidOrder(): OrderRecord {
  return order({
    state: createOrderState({
      orderId,
      createdAt: now - 100,
      expiresAt: now + 9 * 86_400,
      side: "buy",
      chainId: "1",
      baseToken: ZNN_ZTS,
      quoteToken: QSR_ZTS,
      amount: BASE_AMOUNT,
      price: PRICE
    })
  });
}

async function proposal(
  takerAddress: string,
  current = order(),
  identifiers: {
    sessionId?: string;
    reservationId?: string;
    messageId?: string;
    entropyOffset?: number;
  } = {}
): Promise<VerifiedInitialReserveProposal> {
  const takerEntropy = entropy(identifiers.entropyOffset ?? 0);
  const takerSecret = bytes(takerEntropy.privateKey("nostr"));
  const terms = {
    maker_side: current.state.side,
    chain_id: "1",
    base_token: ZNN_ZTS,
    quote_token: QSR_ZTS,
    base_amount: BASE_AMOUNT,
    quote_amount: QUOTE_AMOUNT,
    price: PRICE
  };
  const message: ZwapTradeMessage = {
    schema: "zwap/dm/v1",
    deployment: deploymentFor("1"),
    type: "reserve_propose",
    message_id: identifiers.messageId ?? "66666666-6666-4666-8666-666666666666",
    session_id: identifiers.sessionId ?? sessionId,
    reservation_id: identifiers.reservationId ?? reservationId,
    order_address: current.address,
    order_projection_id: current.eventId,
    order_revision: "0",
    maker_order_pubkey: maker,
    author_pubkey: getPublicKey(takerSecret),
    recipient_pubkey: maker,
    sequence: "0",
    previous_message_id: null,
    previous_transcript_hash: null,
    sent_at: now,
    expires_at: now + 300,
    terms_hash: await termsHash(terms),
    terms,
    body: {
      schema: ATOMIC_SWAP_BODY_SCHEMA,
      taker_session_pubkey: getPublicKey(takerSecret),
      taker_address: takerAddress,
      fill_amount: BASE_AMOUNT
    }
  };
  const rumor = await createTradeRumor(message, takerSecret);
  const wrapped = wrapTradeRumor(rumor, takerSecret, {
    ephemeralSecretKey: bytes(hexKey(8)),
    sealCreatedAt: now - 10,
    wrapperCreatedAt: now - 20,
    outerExpiration: message.expires_at + 3_600,
    sealNonce: new Uint8Array(32).fill(9),
    wrapperNonce: new Uint8Array(32).fill(10)
  });
  return unwrapInitialReserveProposal(wrapped.wrapper, makerOrderSecret, {
    now,
    expectedOrderAddress: current.address,
    expectedOrderProjectionId: current.eventId,
    expectedOrderRevision: "0",
    expectedTermsHash: message.terms_hash
  });
}

class BookPort {
  current: OrderRecord | null = order();
  readonly loadBook = vi.fn(async (): Promise<LoadedOrderBook> => {
    const asks = this.current?.state.side === "sell"
      ? [structuredClone(this.current)]
      : [];
    const bids = this.current?.state.side === "buy"
      ? [structuredClone(this.current)]
      : [];
    return {
      book: {
        market,
        marketId: "market",
        asks,
        bids,
        ...(asks[0] ? { topAsk: asks[0] } : {}),
        ...(bids[0] ? { topBid: bids[0] } : {})
      },
      rejected: 0
    };
  });
}

class SessionRepository {
  readonly values = new Map<string, TradeSession>();
  readonly takerStarts = new Map<string, {
    intent: TakerStartIntent;
    sessionId: string;
  }>();
  readonly save = vi.fn(async (session: TradeSession, expected: number | null) => {
    if (expected !== null || this.values.has(session.sessionId)) {
      throw new Error("Trade session already exists");
    }
    this.values.set(session.sessionId, structuredClone(session));
  });
  readonly createTakerForRequest = vi.fn(async (
    intent: TakerStartIntent,
    session: TradeSession
  ): Promise<TradeSession> => {
    const existing = this.takerStarts.get(intent.requestId);
    if (existing !== undefined) {
      if (JSON.stringify(existing.intent) !== JSON.stringify(intent)) {
        throw new Error("Taker request ID conflicts with another start intent");
      }
      return structuredClone(this.values.get(existing.sessionId)!);
    }
    this.takerStarts.set(intent.requestId, {
      intent: structuredClone(intent),
      sessionId: session.sessionId
    });
    this.values.set(session.sessionId, structuredClone(session));
    return structuredClone(session);
  });
  readonly getTakerForRequest = vi.fn(async (
    intent: TakerStartIntent
  ): Promise<TradeSession | undefined> => {
    const existing = this.takerStarts.get(intent.requestId);
    if (existing === undefined) return undefined;
    if (JSON.stringify(existing.intent) !== JSON.stringify(intent)) {
      throw new Error("Taker request ID conflicts with another start intent");
    }
    return structuredClone(this.values.get(existing.sessionId)!);
  });
  readonly createMakerForOrder = vi.fn(async (
    session: TradeSession
  ): Promise<TradeSession> => {
    const same = this.values.get(session.sessionId);
    if (same !== undefined) return structuredClone(same);
    const competing = [...this.values.values()].find(
      (item) =>
        item.role === "maker" &&
        item.orderAddress === session.orderAddress &&
        item.phase !== "filled" &&
        item.phase !== "released"
    );
    if (competing !== undefined) {
      throw new Error("Order is already being taken by another trader");
    }
    this.values.set(session.sessionId, structuredClone(session));
    return structuredClone(session);
  });

  async list(): Promise<TradeSession[]> {
    return [...this.values.values()].map((value) => structuredClone(value));
  }

  async get(id: string): Promise<TradeSession | undefined> {
    const value = this.values.get(id);
    return value === undefined ? undefined : structuredClone(value);
  }
}

function factory(): TradeSessionFactoryPort {
  return {
    createTaker: (input) => createTakerSession(input, entropy()),
    createMaker: (input) => createMakerSession(input, entropy(3))
  };
}

interface Fixture {
  api: TradeApi;
  books: BookPort;
  sessions: SessionRepository;
  node: FakeZenonNode;
  reservations: FundsReservationRepository;
  localAddress: string;
  counterpartyAddress: string;
  chainIdentifier: ReturnType<typeof vi.fn>;
  frontierMomentum: ReturnType<typeof vi.fn>;
}

function options(setup: {
  overrides?: Partial<TradeApiOptions>;
  balances?: Array<{ tokenStandard: string; amount: string }>;
  chainId?: number;
  momentumTimestamp?: number;
} = {}): Fixture {
  const books = new BookPort();
  const sessions = new SessionRepository();
  const node = new FakeZenonNode({
    chainId: setup.chainId ?? 1,
    now: () => setup.momentumTimestamp ?? now
  });
  const localAddress = node.createAddress("local");
  const counterpartyAddress = node.createAddress("counterparty");
  for (const funding of setup.balances ?? [
    { tokenStandard: QSR_ZTS, amount: QUOTE_AMOUNT }
  ]) {
    node.fund(localAddress, funding.tokenStandard, funding.amount);
  }
  const reservations = new FundsReservationRepository(new MemoryStorageDriver());
  const chainIdentifier = vi.fn(() => node.chainIdentifier());
  const frontierMomentum = vi.fn(() => node.frontierMomentum());
  const coordinator = {
    list: vi.fn(async (): Promise<PublicTradeView[]> => []),
    get: vi.fn(async (): Promise<PublicTradeView | undefined> => undefined),
    advance: vi.fn(async (): Promise<PublicTradeView> => {
      throw new Error("not configured");
    })
  };
  const settings: TradeApiOptions = {
    coordinator,
    orders: books,
    chain: {
      chainIdentifier,
      frontierMomentum,
      getBalances: (address) => node.getBalances(address)
    },
    reservations,
    localAddress: () => localAddress,
    sessions,
    market,
    now: () => now,
    sessionFactory: factory(),
    ...setup.overrides
  };
  return {
    api: new TradeApi(settings),
    books,
    sessions,
    node,
    reservations,
    localAddress,
    counterpartyAddress,
    chainIdentifier,
    frontierMomentum
  };
}

describe("trade start API", () => {
  it("delegates list/get/advance through redacted coordinator views", async () => {
    const fixture = options();
    const session = await createTakerSession({
      order: order(),
      expectedOrderProjectionId: order().eventId,
      expectedOrderRevision: "0",
      market,
      fillBaseAmount: BASE_AMOUNT,
      clocks: { localNow: now, chainNow: now },
      localAddress: fixture.localAddress
    }, entropy());
    const view = publicTradeView(session);
    const { api } = options({
      overrides: {
        coordinator: {
          list: vi.fn(async () => [view]),
          get: vi.fn(async () => view),
          advance: vi.fn(async () => view)
        }
      }
    });

    await expect(api.listTrades()).resolves.toEqual([view]);
    await expect(api.getTrade(session.sessionId)).resolves.toEqual(view);
    await expect(api.advanceTrade(session.sessionId)).resolves.toEqual(view);
    expect(JSON.stringify(await api.getTrade(session.sessionId)))
      .not.toContain(session.privateState.nostrPrivateKey);
  });

  it("starts a taker session bound to the local address and momentum-anchored locktimes", async () => {
    let selectedMarket: SessionMarketSelection | undefined;
    const capturingFactory: TradeSessionFactoryPort = {
      ...factory(),
      createTaker: async (input) => {
        selectedMarket = input.market;
        return createTakerSession(input, entropy());
      }
    };
    const momentumTimestamp = now + 30;
    const fixture = options({
      overrides: { sessionFactory: capturingFactory },
      momentumTimestamp
    });
    const current = order();

    const view = await fixture.api.takeOrder({
      requestId,
      address: current.address,
      expectedProjectionId: current.eventId,
      expectedRevision: "0",
      fillBaseAmount: BASE_AMOUNT
    });

    expect(fixture.chainIdentifier).toHaveBeenCalledOnce();
    expect(selectedMarket).toEqual(market);
    expect(fixture.sessions.createTakerForRequest).toHaveBeenCalledWith(
      {
        requestId,
        address: current.address,
        expectedProjectionId: current.eventId,
        expectedRevision: "0",
        fillBaseAmount: BASE_AMOUNT
      },
      expect.objectContaining({ revision: 0, role: "taker" })
    );
    expect(view.terms).toMatchObject({
      chainId: "1",
      baseToken: ZNN_ZTS,
      baseAmount: BASE_AMOUNT,
      quoteToken: QSR_ZTS,
      quoteAmount: QUOTE_AMOUNT
    });
    // Anchored on the momentum clock, which leads the local clock here.
    expect(view.plan).toMatchObject({
      anchor: momentumTimestamp,
      shortLocktime: momentumTimestamp + 1_800,
      longLocktime: momentumTimestamp + 3_600
    });
    expect(fixture.sessions.values.get(sessionId)?.privateState.localAddress)
      .toBe(fixture.localAddress);
    expect(JSON.stringify(view)).not.toContain("privateState");
  });

  it("honours configured lock durations", async () => {
    const fixture = options({
      overrides: { shortLockSeconds: 900, longLockSeconds: 2_400 }
    });
    const current = order();

    const view = await fixture.api.takeOrder({
      requestId,
      address: current.address,
      expectedProjectionId: current.eventId,
      expectedRevision: "0",
      fillBaseAmount: BASE_AMOUNT
    });

    expect(view.plan).toMatchObject({
      anchor: now,
      shortLocktime: now + 900,
      longLocktime: now + 2_400
    });
  });

  it("starts a seller session against a buy-side bid and checks base funding", async () => {
    const fixture = options({
      balances: [{ tokenStandard: ZNN_ZTS, amount: BASE_AMOUNT }]
    });
    fixture.books.current = bidOrder();

    const view = await fixture.api.takeOrder({
      requestId: "99999999-9999-4999-8999-999999999999",
      address: fixture.books.current.address,
      expectedProjectionId: fixture.books.current.eventId,
      expectedRevision: "0",
      fillBaseAmount: BASE_AMOUNT
    });

    expect(view).toMatchObject({
      role: "taker",
      orderSide: "buy",
      terms: { baseAmount: BASE_AMOUNT, quoteAmount: QUOTE_AMOUNT }
    });
  });

  it("rejects a market whose chain the connected node does not serve", async () => {
    const fixture = options({ chainId: 7 });
    const current = order();

    await expect(fixture.api.takeOrder({
      requestId,
      address: current.address,
      expectedProjectionId: current.eventId,
      expectedRevision: "0",
      fillBaseAmount: BASE_AMOUNT
    })).rejects.toThrow(/different chain/i);
    expect(fixture.sessions.createTakerForRequest).not.toHaveBeenCalled();
  });

  it("rejects an order published for another chain before touching the node", async () => {
    const fixture = options();
    const current = order();
    fixture.books.current = order({
      state: { ...current.state, chain_id: "2" }
    });

    await expect(fixture.api.takeOrder({
      requestId,
      address: current.address,
      expectedProjectionId: current.eventId,
      expectedRevision: "0",
      fillBaseAmount: BASE_AMOUNT
    })).rejects.toThrow(/does not match the exact configured market/i);
    expect(fixture.chainIdentifier).not.toHaveBeenCalled();
  });

  it("rejects missing, stale, unverified and reserved orders before preflight", async () => {
    const cases: Array<[OrderRecord | null, {
      address: string;
      expectedProjectionId: string;
      expectedRevision: string;
    }]> = [
      [null, {
        address: order().address,
        expectedProjectionId: order().eventId,
        expectedRevision: "0"
      }],
      [order(), {
        address: order().address,
        expectedProjectionId: "99".repeat(32),
        expectedRevision: "0"
      }],
      [order({ verified: false }), {
        address: order().address,
        expectedProjectionId: order().eventId,
        expectedRevision: "0"
      }],
      [order({ state: { ...order().state, status: "canceled" } }), {
        address: order().address,
        expectedProjectionId: order().eventId,
        expectedRevision: "0"
      }]
    ];
    for (const [current, request] of cases) {
      const fixture = options();
      fixture.books.current = current;
      await expect(fixture.api.takeOrder({
        requestId,
        ...request,
        fillBaseAmount: BASE_AMOUNT
      })).rejects.toThrow();
      expect(fixture.chainIdentifier).not.toHaveBeenCalled();
      expect(fixture.sessions.save).not.toHaveBeenCalled();
    }
  });

  it("rejects an insufficient quote balance by token symbol", async () => {
    const fixture = options({
      balances: [{ tokenStandard: QSR_ZTS, amount: "19" }]
    });

    await expect(fixture.api.takeOrder({
      requestId,
      address: order().address,
      expectedProjectionId: order().eventId,
      expectedRevision: "0",
      fillBaseAmount: BASE_AMOUNT
    })).rejects.toThrow("Insufficient QSR balance for this trade");
    expect(fixture.sessions.createTakerForRequest).not.toHaveBeenCalled();
  });

  it("names the token standard when the account holds none of the funding token", async () => {
    const fixture = options({
      balances: [{ tokenStandard: ZNN_ZTS, amount: BASE_AMOUNT }]
    });

    await expect(fixture.api.takeOrder({
      requestId,
      address: order().address,
      expectedProjectionId: order().eventId,
      expectedRevision: "0",
      fillBaseAmount: BASE_AMOUNT
    })).rejects.toThrow(`Insufficient ${QSR_ZTS} balance for this trade`);
  });

  it("subtracts funds already reserved by other live sessions", async () => {
    const fixture = options({
      balances: [{ tokenStandard: QSR_ZTS, amount: "25" }]
    });
    const state = await fixture.reservations.load();
    await fixture.reservations.reserve(state.revision, {
      sessionId: "another-session",
      tokenStandard: QSR_ZTS,
      amount: "10",
      reservedAt: now - 5
    });

    await expect(fixture.api.takeOrder({
      requestId,
      address: order().address,
      expectedProjectionId: order().eventId,
      expectedRevision: "0",
      fillBaseAmount: BASE_AMOUNT
    })).rejects.toThrow("Insufficient QSR balance for this trade");
  });

  it("ignores this session's own reservation when re-checking funding", async () => {
    const fixture = options({
      balances: [{ tokenStandard: QSR_ZTS, amount: QUOTE_AMOUNT }]
    });
    const state = await fixture.reservations.load();
    await fixture.reservations.reserve(state.revision, {
      sessionId,
      tokenStandard: QSR_ZTS,
      amount: QUOTE_AMOUNT,
      reservedAt: now - 5
    });

    await expect(fixture.api.takeOrder({
      requestId,
      address: order().address,
      expectedProjectionId: order().eventId,
      expectedRevision: "0",
      fillBaseAmount: BASE_AMOUNT
    })).resolves.toMatchObject({ role: "taker" });
  });

  it("starts a maker session from a verified proposal after base balance preflight", async () => {
    const fixture = options({
      balances: [{ tokenStandard: ZNN_ZTS, amount: BASE_AMOUNT }]
    });
    const verified = await proposal(fixture.counterpartyAddress);

    const view = await fixture.api.acceptReserveProposal(verified);

    expect(fixture.chainIdentifier).toHaveBeenCalledOnce();
    expect(fixture.sessions.createMakerForOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId,
        reservationId,
        revision: 0,
        role: "maker"
      })
    );
    expect(view.terms).toMatchObject({
      baseToken: ZNN_ZTS,
      baseAmount: BASE_AMOUNT,
      quoteToken: QSR_ZTS,
      quoteAmount: QUOTE_AMOUNT
    });
    expect(JSON.stringify(view)).not.toContain(verified.wrapper.content);
    expect(JSON.stringify(view)).not.toContain("privateState");
  });

  it("returns the existing maker session for an exact proposal retry", async () => {
    const fixture = options({
      balances: [{ tokenStandard: ZNN_ZTS, amount: BASE_AMOUNT }]
    });
    const verified = await proposal(fixture.counterpartyAddress);

    const first = await fixture.api.acceptReserveProposal(verified);
    const retried = await fixture.api.acceptReserveProposal(verified);

    expect(retried).toEqual(first);
    expect(fixture.sessions.createMakerForOrder).toHaveBeenCalledOnce();
    expect(fixture.chainIdentifier).toHaveBeenCalledOnce();
  });

  it("allows only one taker to create a maker session for an AON order", async () => {
    // Both proposals are fully fundable, so the rejection has to come from the
    // durable single-maker-session guard rather than from the balance check.
    const fixture = options({
      balances: [{ tokenStandard: ZNN_ZTS, amount: "2000" }]
    });
    const first = await proposal(fixture.counterpartyAddress);
    const second = await proposal(fixture.counterpartyAddress, order(), {
      sessionId: "77".repeat(32),
      reservationId: "77777777-7777-4777-8777-777777777777",
      messageId: "88888888-8888-4888-8888-888888888888",
      entropyOffset: 12
    });

    await expect(fixture.api.acceptReserveProposal(first)).resolves.toBeDefined();
    await expect(fixture.api.acceptReserveProposal(second))
      .rejects.toThrow(/already being taken/i);

    expect(fixture.sessions.values).toHaveProperty("size", 1);
    expect([...fixture.sessions.values.keys()]).toEqual([sessionId]);
  });

  it("rejects unverified proposals and an insufficient maker base balance", async () => {
    const first = options({
      balances: [{ tokenStandard: ZNN_ZTS, amount: BASE_AMOUNT }]
    });
    const unverified = structuredClone(
      await proposal(first.counterpartyAddress)
    ) as VerifiedInitialReserveProposal;
    await expect(first.api.acceptReserveProposal(unverified))
      .rejects.toThrow(/verified initial reserve proposal/i);
    expect(first.chainIdentifier).not.toHaveBeenCalled();
    expect(first.sessions.save).not.toHaveBeenCalled();

    const second = options({
      balances: [{ tokenStandard: ZNN_ZTS, amount: "999" }]
    });
    await expect(second.api.acceptReserveProposal(
      await proposal(second.counterpartyAddress)
    )).rejects.toThrow("Insufficient ZNN balance for this trade");
    expect(second.sessions.createMakerForOrder).not.toHaveBeenCalled();
  });

  it("converges sequential and raced request retries despite fresh taker session IDs", async () => {
    const current = order();
    const request = {
      requestId,
      address: current.address,
      expectedProjectionId: current.eventId,
      expectedRevision: "0",
      fillBaseAmount: BASE_AMOUNT
    };
    let generated = 0;
    const generatedIds: string[] = [];
    const randomFactory: TradeSessionFactoryPort = {
      ...factory(),
      createTaker: async (input) => {
        generated += 1;
        const id = (generated + 15).toString(16).padStart(2, "0").repeat(32);
        generatedIds.push(id);
        return createTakerSession(input, {
          ...entropy(),
          sessionId: () => id
        });
      }
    };
    const exact = options({ overrides: { sessionFactory: randomFactory } });
    const first = await exact.api.takeOrder(request);
    await expect(exact.api.takeOrder(request)).resolves.toEqual(first);
    expect(generatedIds).toHaveLength(1);

    const racedRequest = {
      ...request,
      requestId: "99999999-9999-4999-8999-999999999999"
    };
    const [left, right] = await Promise.all([
      exact.api.takeOrder(racedRequest),
      exact.api.takeOrder(racedRequest)
    ]);
    expect(left).toEqual(right);

    exact.sessions.takerStarts.get(requestId)!.intent = {
      ...request,
      fillBaseAmount: "500"
    };
    await expect(exact.api.takeOrder(request))
      .rejects.toThrow(/request ID conflicts/i);
  });

  it("resolves a durable request binding before stale order and balance checks", async () => {
    const current = order();
    const request = {
      requestId,
      address: current.address,
      expectedProjectionId: current.eventId,
      expectedRevision: "0",
      fillBaseAmount: BASE_AMOUNT
    };
    const fixture = options();
    const first = await fixture.api.takeOrder(request);
    const bookCalls = fixture.books.loadBook.mock.calls.length;
    const chainCalls = fixture.chainIdentifier.mock.calls.length;

    fixture.books.current = order({
      eventId: "99".repeat(32),
      state: {
        ...current.state,
        status: "reserved",
        reserved_amount: BASE_AMOUNT,
        remaining_amount: "0"
      }
    });
    const state = await fixture.reservations.load();
    await fixture.reservations.reserve(state.revision, {
      sessionId: "drains-the-balance",
      tokenStandard: QSR_ZTS,
      amount: QUOTE_AMOUNT,
      reservedAt: now
    });

    await expect(fixture.api.takeOrder(request)).resolves.toEqual(first);
    expect(fixture.books.loadBook).toHaveBeenCalledTimes(bookCalls);
    expect(fixture.chainIdentifier).toHaveBeenCalledTimes(chainCalls);
  });

  it("rejects a non-canonical configured market and a non-Zenon local address", () => {
    const fixture = options();
    expect(() => new TradeApi({
      coordinator: {
        list: async () => [],
        get: async () => undefined,
        advance: async () => { throw new Error("no"); }
      },
      orders: fixture.books,
      chain: {
        chainIdentifier: async () => 1,
        frontierMomentum: () => fixture.node.frontierMomentum(),
        getBalances: async () => []
      },
      reservations: fixture.reservations,
      localAddress: () => fixture.localAddress,
      sessions: fixture.sessions,
      market: { chainId: "1", baseToken: ZNN_ZTS, quoteToken: ZNN_ZTS }
    })).toThrow(/canonical Zenon token pair/i);

    const badAddress = options({
      overrides: { localAddress: () => "not-an-address" }
    });
    return expect(badAddress.api.takeOrder({
      requestId,
      address: order().address,
      expectedProjectionId: order().eventId,
      expectedRevision: "0",
      fillBaseAmount: BASE_AMOUNT
    })).rejects.toThrow(/canonical Zenon address/i);
  });
});
