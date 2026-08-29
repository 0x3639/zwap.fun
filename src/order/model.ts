import { isTokenStandard } from "../zenon/validate.js";

export type OrderSide = "buy" | "sell";
export type ExecutionCondition = "all_or_none" | "partial";
export type OrderStatus =
  | "open"
  | "partially_filled"
  | "reserved"
  | "filled"
  | "canceled"
  | "expired";

export interface OfferedAsset {
  token: string;
}

export interface RequestedAsset {
  token: string;
}

export interface ReservationState {
  id: string;
  amount: string;
  accepted_at: number;
  expires_at: number;
  proposal_event_id: string;
  taker_commitment: string;
}

export interface OrderState {
  schema: "zwap/order/v1";
  order_id: string;
  revision: string;
  created_at: number;
  expires_at: number;
  side: OrderSide;
  chain_id: string;
  base_token: string;
  quote_token: string;
  offered: OfferedAsset;
  requested: RequestedAsset;
  original_amount: string;
  remaining_amount: string;
  reserved_amount: string;
  price: string;
  minimum_fill_amount: string;
  execution: ExecutionCondition;
  status: OrderStatus;
  reservation: ReservationState | null;
}

export interface CreateOrderInput {
  orderId: string;
  createdAt: number;
  expiresAt?: number;
  side: OrderSide;
  chainId: string;
  baseToken: string;
  quoteToken: string;
  amount: string;
  price: string;
  execution?: ExecutionCondition;
  minimumFillAmount?: string;
}

export interface ReserveOrderInput {
  reservationId: string;
  amount: string;
  acceptedAt: number;
  expiresAt: number;
  proposalEventId: string;
  takerCommitment: string;
}

export interface FillOrderInput {
  reservationId: string;
  amount: string;
}

export interface ReleaseOrderInput {
  reservationId: string;
  reason: "expired" | "abort";
  releasedAt: number;
  abortEventId?: string;
}

export function cancelOrder(state: OrderState): OrderState {
  assertMutable(state);
  if (state.reservation !== null) {
    throw new Error("Reserved orders must be released before cancellation");
  }
  return {
    ...state,
    revision: nextRevision(state),
    reserved_amount: "0",
    status: "canceled",
    reservation: null
  };
}

export function expireOrder(state: OrderState, expiredAt: number): OrderState {
  assertMutable(state);
  if (!Number.isSafeInteger(expiredAt) || expiredAt < state.expires_at) {
    throw new Error("Order is not expired");
  }
  if (state.reservation !== null) {
    throw new Error("Reserved orders must be released before expiry");
  }
  return {
    ...state,
    revision: nextRevision(state),
    reserved_amount: "0",
    status: "expired",
    reservation: null
  };
}

export interface ExactMarket {
  chainId: string;
  baseToken: string;
  quoteToken: string;
}

export interface OrderRecord {
  address: string;
  eventId: string;
  makerPubkey: string;
  verified: boolean;
  state: OrderState;
}

export interface OrderBook {
  market: ExactMarket;
  marketId: string;
  asks: OrderRecord[];
  bids: OrderRecord[];
  topAsk?: OrderRecord;
  topBid?: OrderRecord;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX_32 = /^[0-9a-f]{64}$/;
const CHAIN_ID = /^[1-9]\d*$/;

function canonicalChainId(value: string): string {
  if (!CHAIN_ID.test(value)) {
    throw new Error("Chain ID must be a canonical positive integer string");
  }
  return value;
}

function canonicalToken(value: string, label: string): string {
  if (!isTokenStandard(value)) {
    throw new Error(`${label} must be a valid Zenon token standard`);
  }
  return value;
}

function integer(value: string, label: string, allowZero = false): bigint {
  const pattern = allowZero ? /^(0|[1-9]\d*)$/ : /^[1-9]\d*$/;
  if (!pattern.test(value)) throw new Error(`${label} must be a canonical integer string`);
  return BigInt(value);
}

function canonicalPrice(value: string): string {
  return integer(value, "Price").toString();
}

/**
 * Convert base and price integers into whole quote minor units. `price` is
 * quote minor units per 10^8 base minor units. For positive BigInts, `/`
 * truncates the fractional remainder like Python's `//`.
 */
export function quoteAmountForSettlement(
  baseAmount: string,
  price: string
): string {
  const base = integer(baseAmount, "Base amount");
  const priceValue = BigInt(canonicalPrice(price));
  const quote = (base * priceValue) / 100_000_000n;
  if (quote === 0n) {
    throw new Error("Order amount and limit price must produce at least one quote unit");
  }
  return quote.toString();
}

export function createOrderState(input: CreateOrderInput): OrderState {
  if (input.side !== "buy" && input.side !== "sell") {
    throw new Error("Order side must be buy or sell");
  }
  if (!UUID_V4.test(input.orderId)) {
    throw new Error("Order ID must be a UUID v4");
  }
  const chainId = canonicalChainId(input.chainId);
  const baseToken = canonicalToken(input.baseToken, "Base token");
  const quoteToken = canonicalToken(input.quoteToken, "Quote token");
  if (baseToken === quoteToken) throw new Error("Base and quote tokens must differ");
  if (!Number.isSafeInteger(input.createdAt) || input.createdAt < 0) {
    throw new Error("Creation time must be a Unix timestamp");
  }

  const expiresAt = input.expiresAt ?? input.createdAt + 2_592_000;
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= input.createdAt) {
    throw new Error("Order expiry must be after creation");
  }
  const amount = integer(input.amount, "Order amount");
  const price = canonicalPrice(input.price);
  quoteAmountForSettlement(amount.toString(), price);

  const execution = input.execution ?? "all_or_none";
  if (execution !== "all_or_none" && execution !== "partial") {
    throw new Error("Execution condition must be all_or_none or partial");
  }
  const minimum = input.minimumFillAmount ?? (execution === "all_or_none" ? input.amount : "");
  const minimumValue = integer(minimum, "Minimum fill amount");
  if (minimumValue > amount) throw new Error("Minimum fill cannot exceed order amount");
  if (execution === "all_or_none" && minimumValue !== amount) {
    throw new Error("All-or-none minimum fill must equal the order amount");
  }

  return {
    schema: "zwap/order/v1",
    order_id: input.orderId,
    revision: "0",
    created_at: input.createdAt,
    expires_at: expiresAt,
    side: input.side,
    chain_id: chainId,
    base_token: baseToken,
    quote_token: quoteToken,
    offered: { token: input.side === "sell" ? baseToken : quoteToken },
    requested: { token: input.side === "sell" ? quoteToken : baseToken },
    original_amount: amount.toString(),
    remaining_amount: amount.toString(),
    reserved_amount: "0",
    price,
    minimum_fill_amount: minimumValue.toString(),
    execution,
    status: "open",
    reservation: null
  };
}

function nextRevision(state: OrderState): string {
  if (!/^(0|[1-9]\d*)$/.test(state.revision)) throw new Error("Order revision is invalid");
  return (BigInt(state.revision) + 1n).toString();
}

function assertMutable(state: OrderState): void {
  if (["filled", "canceled", "expired"].includes(state.status)) {
    throw new Error("Terminal orders cannot change");
  }
}

function validateFillShape(state: OrderState, amount: bigint, remaining: bigint): void {
  const minimum = integer(state.minimum_fill_amount, "Minimum fill amount");
  if (amount > remaining) throw new Error("Amount exceeds the remaining order amount");
  if (state.execution === "all_or_none" && amount !== remaining) {
    throw new Error("All-or-none execution must reserve and fill the entire remainder");
  }
  if (state.execution === "partial") {
    const remainder = remaining - amount;
    if (amount < minimum && amount !== remaining) {
      throw new Error("Fill amount is below the order minimum");
    }
    if (remainder > 0n && remainder < minimum) {
      throw new Error("Fill would leave dust below the order minimum");
    }
  }
  quoteAmountForSettlement(amount.toString(), state.price);
}

export function reserveOrder(state: OrderState, input: ReserveOrderInput): OrderState {
  assertMutable(state);
  if (state.reservation !== null || state.reserved_amount !== "0" || state.status === "reserved") {
    throw new Error("Order already has a live reservation");
  }
  if (!UUID_V4.test(input.reservationId)) throw new Error("Reservation ID must be a UUID v4");
  if (!HEX_32.test(input.proposalEventId)) throw new Error("Proposal event ID must be lowercase hex");
  if (!HEX_32.test(input.takerCommitment)) throw new Error("Taker commitment must be lowercase hex");
  if (!Number.isSafeInteger(input.acceptedAt) || input.acceptedAt < state.created_at) {
    throw new Error("Reservation acceptance time is invalid");
  }
  if (
    !Number.isSafeInteger(input.expiresAt) ||
    input.expiresAt <= input.acceptedAt ||
    input.expiresAt > state.expires_at
  ) {
    throw new Error("Reservation expiry is invalid");
  }
  const amount = integer(input.amount, "Reservation amount");
  const remaining = integer(state.remaining_amount, "Remaining amount");
  validateFillShape(state, amount, remaining);

  return {
    ...state,
    revision: nextRevision(state),
    reserved_amount: amount.toString(),
    status: "reserved",
    reservation: {
      id: input.reservationId,
      amount: amount.toString(),
      accepted_at: input.acceptedAt,
      expires_at: input.expiresAt,
      proposal_event_id: input.proposalEventId,
      taker_commitment: input.takerCommitment
    }
  };
}

export function fillOrder(state: OrderState, input: FillOrderInput): OrderState {
  assertMutable(state);
  const reservation = state.reservation;
  if (!reservation || state.status !== "reserved") throw new Error("Fill requires a live reservation");
  if (input.reservationId !== reservation.id) throw new Error("Fill reservation ID does not match");
  const amount = integer(input.amount, "Fill amount");
  const reserved = integer(state.reserved_amount, "Reserved amount");
  const remaining = integer(state.remaining_amount, "Remaining amount");
  if (amount !== reserved || input.amount !== reservation.amount) {
    throw new Error("Fill amount must equal the reserved amount");
  }
  validateFillShape(state, amount, remaining);
  const nextRemaining = remaining - amount;

  return {
    ...state,
    revision: nextRevision(state),
    remaining_amount: nextRemaining.toString(),
    reserved_amount: "0",
    status: nextRemaining === 0n ? "filled" : "partially_filled",
    reservation: null
  };
}

export function releaseOrder(state: OrderState, input: ReleaseOrderInput): OrderState {
  assertMutable(state);
  const reservation = state.reservation;
  if (!reservation || state.status !== "reserved") {
    throw new Error("Release requires a live reservation");
  }
  if (input.reservationId !== reservation.id) {
    throw new Error("Release reservation ID does not match");
  }
  if (!Number.isSafeInteger(input.releasedAt) || input.releasedAt < reservation.accepted_at) {
    throw new Error("Reservation release time is invalid");
  }
  if (input.reason === "expired") {
    if (input.releasedAt < reservation.expires_at) {
      throw new Error("Reservation is not expired");
    }
    if (input.abortEventId !== undefined) {
      throw new Error("Expired release cannot reference an abort event");
    }
  } else if (input.reason === "abort") {
    if (!input.abortEventId || !HEX_32.test(input.abortEventId)) {
      throw new Error("Abort release requires a signed abort event ID");
    }
  } else {
    throw new Error("Reservation release reason is invalid");
  }
  const status = state.remaining_amount === state.original_amount
    ? "open"
    : "partially_filled";
  return {
    ...state,
    revision: nextRevision(state),
    reserved_amount: "0",
    status,
    reservation: null
  };
}

function marketPreimage(market: ExactMarket): string {
  return [
    "zwap-market-v1",
    canonicalChainId(market.chainId),
    canonicalToken(market.baseToken, "Base token"),
    canonicalToken(market.quoteToken, "Quote token")
  ].join("\n");
}

export async function marketId(market: ExactMarket): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(marketPreimage(market))
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function eligibleMarketIds(state: OrderState): Promise<string[]> {
  return [await marketId({
    chainId: state.chain_id,
    baseToken: state.base_token,
    quoteToken: state.quote_token
  })];
}

/**
 * How much of this order a taker could actually reserve right now.
 *
 * A lapsed reservation still counts as live here: `reserveOrder` refuses any
 * order carrying one until it has been explicitly released, so surfacing the
 * remaining amount would only advertise a take that is certain to throw.
 */
function effectiveAvailable(state: OrderState): bigint {
  const remaining = integer(state.remaining_amount, "Remaining amount", true);
  if (state.reservation !== null) return 0n;
  return remaining;
}

function comparePrice(left: OrderRecord, right: OrderRecord): number {
  const leftPrice = BigInt(left.state.price);
  const rightPrice = BigInt(right.state.price);
  return leftPrice < rightPrice ? -1 : leftPrice > rightPrice ? 1 : 0;
}

export async function buildOrderBook(
  records: OrderRecord[],
  market: ExactMarket,
  now: number
): Promise<OrderBook> {
  const selectedMarketId = await marketId(market);
  const eligible: OrderRecord[] = [];
  for (const record of records) {
    if (!record.verified) continue;
    if (["filled", "canceled", "expired"].includes(record.state.status)) continue;
    if (now >= record.state.expires_at) continue;
    if (effectiveAvailable(record.state) <= 0n) continue;
    if (!(await eligibleMarketIds(record.state)).includes(selectedMarketId)) continue;
    eligible.push(record);
  }

  const tie = (left: OrderRecord, right: OrderRecord): number =>
    left.address.localeCompare(right.address);
  const asks = eligible
    .filter((record) => record.state.side === "sell")
    .sort((left, right) => comparePrice(left, right) || tie(left, right));
  const bids = eligible
    .filter((record) => record.state.side === "buy")
    .sort((left, right) => -comparePrice(left, right) || tie(left, right));

  return {
    market,
    marketId: selectedMarketId,
    asks,
    bids,
    ...(asks[0] ? { topAsk: asks[0] } : {}),
    ...(bids[0] ? { topBid: bids[0] } : {})
  };
}
