import { quoteAmountForSettlement } from "../order/model.js";

export interface SettlementPlan {
  anchor: number;
  shortLocktime: number;
  makerClaimCutoff: number;
  longLocktime: number;
  takerClaimCutoff: number;
  reservationExpiresAt: number;
  refundGuardSeconds: 60;
}

export const SHORT_LOCK_SECONDS = 1800;
export const LONG_LOCK_SECONDS = 3600;
export const RESERVATION_GRACE_SECONDS = 600;
export const CLAIM_CUTOFF_MARGIN = 120;
export const MAX_CLOCK_SKEW_SECONDS = 120;

export interface SettlementPlanInput {
  localNow: number;
  chainNow: number;
  orderExpiresAt: number;
  shortLockSeconds?: number;
  longLockSeconds?: number;
}

function unixTime(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a Unix timestamp`);
  }
  return value;
}

export function createSettlementPlan(input: SettlementPlanInput): SettlementPlan {
  const local = unixTime(input.localNow, "Local clock");
  const chain = unixTime(input.chainNow, "Chain clock");
  const orderExpiresAt = unixTime(input.orderExpiresAt, "Order expiry");
  if (Math.abs(chain - local) > MAX_CLOCK_SKEW_SECONDS) {
    throw new Error(`Chain clock differs from the local clock by more than ${MAX_CLOCK_SKEW_SECONDS} seconds`);
  }
  const short = input.shortLockSeconds ?? SHORT_LOCK_SECONDS;
  const long = input.longLockSeconds ?? LONG_LOCK_SECONDS;
  if (long <= short) throw new Error("Long locktime must exceed the short locktime");
  const anchor = Math.max(local, chain);
  const reservationExpiresAt = anchor + long + RESERVATION_GRACE_SECONDS;
  if (orderExpiresAt < reservationExpiresAt) {
    throw new Error("The order expires before the settlement recovery window");
  }
  return {
    anchor,
    shortLocktime: anchor + short,
    makerClaimCutoff: anchor + short - CLAIM_CUTOFF_MARGIN,
    longLocktime: anchor + long,
    takerClaimCutoff: anchor + long - CLAIM_CUTOFF_MARGIN,
    reservationExpiresAt,
    refundGuardSeconds: 60
  };
}

function positiveInteger(value: string, label: string): bigint {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`${label} must be a canonical positive integer`);
  }
  return BigInt(value);
}

export interface SettlementAmountInput {
  remainingBaseAmount: string;
  fillBaseAmount: string;
  price: string;
  execution: "all_or_none" | "partial";
  minimumFillAmount: string;
}

export function settlementAmounts(input: SettlementAmountInput): { base: string; quote: string } {
  const remaining = positiveInteger(input.remainingBaseAmount, "Remaining base amount");
  const fill = positiveInteger(input.fillBaseAmount, "Fill base amount");
  const minimum = positiveInteger(input.minimumFillAmount, "Minimum fill amount");
  positiveInteger(input.price, "Price");

  if (fill > remaining) throw new Error("Fill amount exceeds the remaining order amount");
  if (input.execution === "all_or_none" && fill !== remaining) {
    throw new Error("An all-or-none order must fill its entire remaining amount");
  }
  if (input.execution === "partial" && fill < minimum) {
    throw new Error("Partial fill amount is below the order minimum");
  }
  if (input.execution !== "all_or_none" && input.execution !== "partial") {
    throw new Error("Unknown execution condition");
  }

  return {
    base: fill.toString(),
    quote: quoteAmountForSettlement(fill.toString(), input.price)
  };
}

export type TradePhase =
  | "negotiating"
  | "reserved"
  | "base_locked"
  | "quote_locked"
  | "quote_claimed"
  | "base_claimed"
  | "filled"
  | "waiting_quote_refund"
  | "waiting_base_refund"
  | "released"
  | "frozen";

export type TradeEvent =
  | "reserve_confirmed"
  | "base_lock_validated"
  | "quote_lock_validated"
  | "quote_spent_with_preimage"
  | "base_spent"
  | "fill_confirmed"
  | "abort_confirmed"
  /** This side owes the base rung of the refund ladder. */
  | "base_refund_pending"
  /** This side owes the quote rung of the refund ladder. */
  | "quote_refund_pending"
  | "quote_refund_confirmed"
  | "base_refund_confirmed"
  | "release_confirmed"
  | "contradiction_detected";

/**
 * Phases a side can be sitting in when it discovers it has to reclaim its own
 * leg. `enter_recovery` is the only effect that steps onto a rung, and it can
 * fire from any phase the choreography reached before the deadline passed -
 * including `frozen`, because a contradiction freezes a session whose HTLC is
 * still on chain and that value still has to come back.
 */
const BASE_RUNG_SOURCES: readonly TradePhase[] = [
  "negotiating",
  "reserved",
  "base_locked",
  "quote_locked",
  "quote_claimed",
  "base_claimed",
  "waiting_quote_refund",
  "frozen"
];

const QUOTE_RUNG_SOURCES: readonly TradePhase[] = [
  "base_locked",
  "quote_locked",
  "quote_claimed",
  "base_claimed",
  "frozen"
];

const transitions = new Map<string, TradePhase>([
  ["negotiating:reserve_confirmed", "reserved"],
  ["reserved:base_lock_validated", "base_locked"],
  // The maker publishes its base lock inside `reserve_accept`, so a maker can
  // jump straight from negotiating to a locked base leg.
  ["negotiating:base_lock_validated", "base_locked"],
  ["base_locked:quote_lock_validated", "quote_locked"],
  ["quote_locked:quote_spent_with_preimage", "quote_claimed"],
  ["quote_claimed:base_spent", "base_claimed"],
  ["base_claimed:fill_confirmed", "filled"],
  // `settling` covers both claims without a message in between, so the fill is
  // committed straight out of a locked quote leg.
  ["quote_locked:fill_confirmed", "filled"],
  ["reserved:abort_confirmed", "released"],
  ...BASE_RUNG_SOURCES.map((phase): [string, TradePhase] =>
    [`${phase}:base_refund_pending`, "waiting_base_refund"]),
  ...QUOTE_RUNG_SOURCES.map((phase): [string, TradePhase] =>
    [`${phase}:quote_refund_pending`, "waiting_quote_refund"]),
  // Each side holds exactly one leg, so its own refund ends its ladder.
  ["waiting_quote_refund:quote_refund_confirmed", "released"],
  ["waiting_base_refund:base_refund_confirmed", "released"],
  ["frozen:quote_refund_confirmed", "released"],
  ["frozen:base_refund_confirmed", "released"],
  // The maker's release projection is the last durable step of its ladder.
  ["waiting_base_refund:release_confirmed", "released"],
  ["frozen:release_confirmed", "released"]
]);

/**
 * Every `from:to` phase pair the effects layer may persist. The durable
 * validator reads this so the state machine and the storage checkpoint rule can
 * never drift apart; `frozen` is reachable from anywhere and is checked
 * separately.
 */
export const PERSISTED_PHASE_STEPS: ReadonlySet<string> = new Set(
  [...transitions].map(([key, to]) => `${key.slice(0, key.indexOf(":"))}:${to}`)
);

export function canAdvanceTrade(phase: TradePhase, event: TradeEvent): boolean {
  return transitions.has(`${phase}:${event}`);
}

export function advanceTrade(phase: TradePhase, event: TradeEvent): TradePhase {
  if (event === "contradiction_detected" && phase !== "filled" && phase !== "released") {
    return "frozen";
  }
  const next = transitions.get(`${phase}:${event}`);
  if (!next) throw new Error(`Invalid trade transition: ${phase} + ${event}`);
  return next;
}
