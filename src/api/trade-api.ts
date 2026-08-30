import type {
  ExactMarket,
  OrderRecord,
  OrderSide
} from "../order/model.js";
import type { LoadedOrderBook } from "../order/service.js";
import type { TakerStartIntent } from "../storage/trade-session.js";
import {
  reservedAmount,
  type FundsReservationRepository
} from "../zenon/funds-reservations.js";
import type { BalanceView, MomentumView } from "../zenon/types.js";
import { isTokenStandard, isZenonAddress } from "../zenon/validate.js";
import {
  assertVerifiedInitialReserveProposal,
  type VerifiedInitialReserveProposal
} from "../trade/messages.js";
import {
  createMakerSession,
  createTakerSession,
  type MakerSessionInput,
  type SessionMarketSelection,
  type TakerSessionInput
} from "../trade/session-factory.js";
import {
  publicTradeView,
  type PublicTradeView,
  type TradeSession
} from "../trade/session.js";

export interface TradeCoordinatorApiPort {
  list(): Promise<PublicTradeView[]>;
  get(sessionId: string): Promise<PublicTradeView | undefined>;
  advance(sessionId: string): Promise<PublicTradeView>;
}

export interface TradeOrderBookPort {
  loadBook(market: ExactMarket, now: number): Promise<LoadedOrderBook>;
}

/** The node reads a trade start needs: chain identity, clock and balances. */
export interface TradeChainPort {
  chainIdentifier(): Promise<number>;
  frontierMomentum(): Promise<MomentumView>;
  getBalances(address: string): Promise<BalanceView[]>;
}

export type { TakerStartIntent } from "../storage/trade-session.js";

export interface TradeStartRepository {
  prune(now: number): Promise<string[]>;
  list(): Promise<TradeSession[]>;
  get(sessionId: string): Promise<TradeSession | undefined>;
  save(session: TradeSession, expectedRevision: number | null): Promise<void>;
  /**
   * Atomically binds requestId and its exact immutable intent to one revision-0
   * session. An exact retry returns the already-bound session; a reused request
   * ID with different intent fails.
   */
  createTakerForRequest(
    intent: TakerStartIntent,
    session: TradeSession
  ): Promise<TradeSession>;
  getTakerForRequest(intent: TakerStartIntent): Promise<TradeSession | undefined>;
  /**
   * Atomically creates one active maker session for an order. Exact proposal
   * retries return the existing session; another taker cannot race it.
   */
  createMakerForOrder(session: TradeSession): Promise<TradeSession>;
}

export interface TradeSessionFactoryPort {
  createTaker(input: TakerSessionInput): Promise<TradeSession>;
  createMaker(input: MakerSessionInput): Promise<TradeSession>;
}

export interface TradeApiOptions {
  coordinator: TradeCoordinatorApiPort;
  orders: TradeOrderBookPort;
  chain: TradeChainPort;
  reservations: Pick<FundsReservationRepository, "load">;
  localAddress: () => string;
  sessions: TradeStartRepository;
  market: ExactMarket;
  now?: () => number;
  sessionFactory?: TradeSessionFactoryPort;
  shortLockSeconds?: number;
  longLockSeconds?: number;
}

export interface TakeOrderInput {
  requestId: string;
  address: string;
  expectedProjectionId: string;
  expectedRevision: string;
  fillBaseAmount: string;
}

const HEX_32 = /^[0-9a-f]{64}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const defaultSessionFactory: TradeSessionFactoryPort = {
  createTaker: (input) => createTakerSession(input),
  createMaker: (input) => createMakerSession(input)
};

function exactMarket(left: ExactMarket, right: ExactMarket): boolean {
  return left.chainId === right.chainId &&
    left.baseToken === right.baseToken &&
    left.quoteToken === right.quoteToken;
}

/** Which leg the maker must fund on chain for its own published side. */
function makerOfferedLeg(side: OrderSide): "base" | "quote" {
  return side === "sell" ? "base" : "quote";
}

/** Which leg the taker must fund on chain against that side. */
function takerFundingLeg(side: OrderSide): "base" | "quote" {
  return side === "sell" ? "quote" : "base";
}

export class TradeApi {
  private readonly coordinator: TradeCoordinatorApiPort;
  private readonly orders: TradeOrderBookPort;
  private readonly chain: TradeChainPort;
  private readonly reservations: Pick<FundsReservationRepository, "load">;
  private readonly localAddress: () => string;
  private readonly sessions: TradeStartRepository;
  private readonly market: ExactMarket;
  private readonly now: () => number;
  private readonly sessionFactory: TradeSessionFactoryPort;
  private readonly shortLockSeconds: number | undefined;
  private readonly longLockSeconds: number | undefined;

  constructor(options: TradeApiOptions) {
    this.coordinator = options.coordinator;
    this.orders = options.orders;
    this.chain = options.chain;
    this.reservations = options.reservations;
    this.localAddress = options.localAddress;
    this.sessions = options.sessions;
    if (
      !/^[1-9]\d*$/.test(options.market.chainId) ||
      !isTokenStandard(options.market.baseToken) ||
      !isTokenStandard(options.market.quoteToken) ||
      options.market.baseToken === options.market.quoteToken
    ) {
      throw new Error("Trade API market must be a canonical Zenon token pair");
    }
    this.market = {
      chainId: options.market.chainId,
      baseToken: options.market.baseToken,
      quoteToken: options.market.quoteToken
    };
    this.now = options.now ?? (() => Math.floor(Date.now() / 1_000));
    this.sessionFactory = options.sessionFactory ?? defaultSessionFactory;
    this.shortLockSeconds = options.shortLockSeconds;
    this.longLockSeconds = options.longLockSeconds;
  }

  /** Reclaims finished sessions past their retention window. Best-effort. */
  async pruneTerminalSessions(): Promise<string[]> {
    return this.sessions.prune(this.now());
  }

  async listTrades(): Promise<PublicTradeView[]> {
    return structuredClone(await this.coordinator.list());
  }

  async getTrade(sessionId: string): Promise<PublicTradeView | undefined> {
    const view = await this.coordinator.get(sessionId);
    return view === undefined ? undefined : structuredClone(view);
  }

  async advanceTrade(sessionId: string): Promise<PublicTradeView> {
    return structuredClone(await this.coordinator.advance(sessionId));
  }

  async takeOrder(input: TakeOrderInput): Promise<PublicTradeView> {
    if (!UUID_V4.test(input.requestId)) {
      throw new Error("Taker start request ID must be a lowercase UUIDv4");
    }
    const intent = {
      requestId: input.requestId,
      address: input.address,
      expectedProjectionId: input.expectedProjectionId,
      expectedRevision: input.expectedRevision,
      fillBaseAmount: input.fillBaseAmount
    };
    const existing = await this.sessions.getTakerForRequest(intent);
    if (existing !== undefined) {
      this.assertBoundTaker(existing, intent);
      return publicTradeView(existing);
    }
    const currentTime = this.currentTime();
    const order = await this.loadExactOrder(
      input.address,
      input.expectedProjectionId,
      input.expectedRevision,
      currentTime
    );
    const selectedMarket = await this.preflightMarket(order);
    const session = await this.sessionFactory.createTaker({
      order,
      expectedOrderProjectionId: input.expectedProjectionId,
      expectedOrderRevision: input.expectedRevision,
      market: selectedMarket,
      fillBaseAmount: input.fillBaseAmount,
      clocks: await this.clocks(currentTime),
      localAddress: this.settlementAddress()
    });
    await this.assertFunded(session, takerFundingLeg(order.state.side));
    const persisted = await this.sessions.createTakerForRequest(intent, session);
    this.assertBoundTaker(persisted, intent);
    return publicTradeView(persisted);
  }

  async acceptReserveProposal(
    proposal: VerifiedInitialReserveProposal
  ): Promise<PublicTradeView> {
    assertVerifiedInitialReserveProposal(proposal);
    const existing = await this.sessions.get(proposal.message.session_id);
    if (existing !== undefined) {
      this.assertBoundMaker(existing, proposal);
      return publicTradeView(existing);
    }
    const currentTime = this.currentTime();
    const order = await this.loadExactOrder(
      proposal.message.order_address,
      proposal.message.order_projection_id,
      proposal.message.order_revision,
      currentTime
    );
    const selectedMarket = await this.preflightMarket(order);
    const session = await this.sessionFactory.createMaker({
      order,
      proposal,
      market: selectedMarket,
      clocks: await this.clocks(currentTime),
      localAddress: this.settlementAddress()
    });
    await this.assertFunded(session, makerOfferedLeg(order.state.side));
    const persisted = await this.sessions.createMakerForOrder(session);
    this.assertBoundMaker(persisted, proposal);
    return publicTradeView(persisted);
  }

  private currentTime(): number {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("Trade API clock must be a non-negative Unix timestamp");
    }
    return value;
  }

  private settlementAddress(): string {
    const address = this.localAddress();
    if (!isZenonAddress(address)) {
      throw new Error("Trade API settlement address is not a canonical Zenon address");
    }
    return address;
  }

  /**
   * The settlement plan is anchored on the momentum clock, not the browser's:
   * every locktime the counterparty will check is a chain timestamp.
   */
  private async clocks(localNow: number): Promise<{
    localNow: number;
    chainNow: number;
    shortLockSeconds?: number;
    longLockSeconds?: number;
  }> {
    const momentum = await this.chain.frontierMomentum();
    if (!Number.isSafeInteger(momentum.timestamp) || momentum.timestamp < 0) {
      throw new Error("Frontier momentum timestamp is not a Unix timestamp");
    }
    return {
      localNow,
      chainNow: momentum.timestamp,
      ...(this.shortLockSeconds === undefined
        ? {}
        : { shortLockSeconds: this.shortLockSeconds }),
      ...(this.longLockSeconds === undefined
        ? {}
        : { longLockSeconds: this.longLockSeconds })
    };
  }

  /**
   * Refuses to start a trade the account cannot actually settle. Funds already
   * committed to other live sessions are subtracted before the comparison, so
   * two concurrent trades cannot both claim the same balance.
   */
  private async assertFunded(
    session: TradeSession,
    leg: "base" | "quote"
  ): Promise<void> {
    const tokenStandard = leg === "base"
      ? session.terms.baseToken
      : session.terms.quoteToken;
    const targetAmount = BigInt(
      leg === "base" ? session.terms.baseAmount : session.terms.quoteAmount
    );
    const balances = await this.chain.getBalances(session.privateState.localAddress);
    const entry = balances.find((item) => item.tokenStandard === tokenStandard);
    const available = BigInt(entry?.balance ?? "0") -
      reservedAmount(await this.reservations.load(), tokenStandard, session.sessionId);
    if (available < targetAmount) {
      throw new Error(
        `Insufficient ${entry?.symbol ?? tokenStandard} balance for this trade`
      );
    }
  }

  private assertBoundTaker(
    persisted: TradeSession,
    intent: TakerStartIntent
  ): void {
    if (
      persisted.role !== "taker" ||
      persisted.orderAddress !== intent.address ||
      persisted.offeredProjectionId !== intent.expectedProjectionId ||
      persisted.offeredProjectionRevision !== intent.expectedRevision ||
      persisted.terms.baseAmount !== intent.fillBaseAmount ||
      persisted.terms.chainId !== this.market.chainId ||
      persisted.terms.baseToken !== this.market.baseToken ||
      persisted.terms.quoteToken !== this.market.quoteToken
    ) {
      throw new Error("Durable taker request binding returned a conflicting session");
    }
  }

  private assertBoundMaker(
    session: TradeSession,
    proposal: VerifiedInitialReserveProposal
  ): void {
    const accepted = session.privateState.transcript.accepted[0];
    if (
      session.role !== "maker" ||
      session.sessionId !== proposal.message.session_id ||
      session.reservationId !== proposal.message.reservation_id ||
      session.orderAddress !== proposal.message.order_address ||
      session.offeredProjectionId !== proposal.message.order_projection_id ||
      session.offeredProjectionRevision !== proposal.message.order_revision ||
      session.evidence.makerPubkey !== proposal.message.maker_order_pubkey ||
      session.evidence.reservation.proposalSealId !== proposal.seal.id ||
      accepted?.messageId !== proposal.message.message_id ||
      accepted.rumorId !== proposal.rumor.id ||
      accepted.transcriptHash !== proposal.transcriptHash ||
      accepted.authorPubkey !== proposal.message.author_pubkey ||
      accepted.recipientPubkey !== proposal.message.recipient_pubkey
    ) {
      throw new Error("Maker proposal is bound to a conflicting trade session");
    }
  }

  private async loadExactOrder(
    address: string,
    expectedProjectionId: string,
    expectedRevision: string,
    now: number
  ): Promise<OrderRecord> {
    if (
      !address ||
      !HEX_32.test(expectedProjectionId) ||
      !/^(0|[1-9]\d*)$/.test(expectedRevision)
    ) {
      throw new Error("Trade order projection binding is invalid");
    }
    const loaded = await this.orders.loadBook(this.market, now);
    if (!exactMarket(loaded.book.market, this.market)) {
      throw new Error("Loaded order book does not match the exact trade market");
    }
    const matching = [...loaded.book.asks, ...loaded.book.bids]
      .filter((record) => record.address === address);
    if (matching.length !== 1) {
      throw new Error("Exact current order was not found in the verified order book");
    }
    const record = matching[0]!;
    if (!record.verified) throw new Error("Trade order is not verified");
    if (
      record.eventId !== expectedProjectionId ||
      record.state.revision !== expectedRevision
    ) {
      throw new Error("Trade order projection is stale");
    }
    const state = record.state;
    const exactAssets = state.side === "sell"
      ? state.offered.token === this.market.baseToken &&
        state.requested.token === this.market.quoteToken
      : state.side === "buy" &&
        state.offered.token === this.market.quoteToken &&
        state.requested.token === this.market.baseToken;
    if (
      (state.side !== "sell" && state.side !== "buy") ||
      state.status !== "open" ||
      state.reservation !== null ||
      state.chain_id !== this.market.chainId ||
      state.base_token !== this.market.baseToken ||
      state.quote_token !== this.market.quoteToken ||
      !exactAssets
    ) {
      throw new Error("Trade order does not match the exact configured market");
    }
    return structuredClone(record);
  }

  /**
   * Confirms the order and the node agree on which chain this trade settles on
   * before any session key or HTLC material exists. A chain-ID mismatch here is
   * the browser pointing at a different network than the order was published
   * for, which no later check would catch as cheaply.
   */
  private async preflightMarket(
    order: OrderRecord
  ): Promise<SessionMarketSelection> {
    if (order.state.chain_id !== this.market.chainId) {
      throw new Error("Trade order chain does not match the configured market");
    }
    const chainId = await this.chain.chainIdentifier();
    if (String(chainId) !== this.market.chainId) {
      throw new Error("Connected Zenon node is on a different chain than this market");
    }
    return {
      chainId: this.market.chainId,
      baseToken: this.market.baseToken,
      quoteToken: this.market.quoteToken
    };
  }
}
