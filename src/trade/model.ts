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
  | "waiting_base_claim"
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
  | "settlement_cutoff_reached"
  | "quote_refund_confirmed"
  | "base_refund_confirmed"
  | "release_confirmed"
  | "contradiction_detected";

const transitions = new Map<string, TradePhase>([
  ["negotiating:reserve_confirmed", "reserved"],
  ["reserved:base_lock_validated", "base_locked"],
  ["base_locked:quote_lock_validated", "quote_locked"],
  ["quote_locked:quote_spent_with_preimage", "quote_claimed"],
  ["quote_claimed:base_spent", "base_claimed"],
  ["waiting_base_claim:base_spent", "base_claimed"],
  ["base_claimed:fill_confirmed", "filled"],
  ["reserved:abort_confirmed", "released"],
  ["base_locked:settlement_cutoff_reached", "waiting_base_refund"],
  ["quote_locked:settlement_cutoff_reached", "waiting_quote_refund"],
  ["quote_claimed:settlement_cutoff_reached", "waiting_base_claim"],
  ["waiting_quote_refund:quote_refund_confirmed", "waiting_base_refund"],
  ["waiting_base_refund:base_refund_confirmed", "released"]
]);

export function advanceTrade(phase: TradePhase, event: TradeEvent): TradePhase {
  if (event === "contradiction_detected" && phase !== "filled" && phase !== "released") {
    return "frozen";
  }
  const next = transitions.get(`${phase}:${event}`);
  if (!next) throw new Error(`Invalid trade transition: ${phase} + ${event}`);
  return next;
}
