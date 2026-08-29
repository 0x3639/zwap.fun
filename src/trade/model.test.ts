import { describe, expect, it } from "vitest";

import {
  advanceTrade,
  canAdvanceTrade,
  createSettlementPlan,
  settlementAmounts,
  PERSISTED_PHASE_STEPS,
  type TradePhase
} from "./model.js";

describe("Zwap settlement model", () => {
  it("derives asymmetric deadlines from the slower of the local and chain clocks", () => {
    expect(createSettlementPlan({
      localNow: 1_700_000_000,
      chainNow: 1_700_000_012,
      orderExpiresAt: 1_700_700_000
    })).toEqual({
      anchor: 1_700_000_012,
      shortLocktime: 1_700_001_812,
      makerClaimCutoff: 1_700_001_692,
      longLocktime: 1_700_003_612,
      takerClaimCutoff: 1_700_003_492,
      reservationExpiresAt: 1_700_004_212,
      refundGuardSeconds: 60
    });
  });

  it("fails closed on unsafe clocks or an order that expires too soon", () => {
    expect(() => createSettlementPlan({
      localNow: 100,
      chainNow: 221,
      orderExpiresAt: 10_000
    })).toThrow("clock differs");

    expect(() => createSettlementPlan({
      localNow: 100,
      chainNow: 100,
      orderExpiresAt: 4_299
    })).toThrow("order expires before");

    // Regression: the plan only required `long > short`, while both the wire
    // profile and the durable validator require the whole reservation grace
    // between them.
    expect(() => createSettlementPlan({
      localNow: 1_700_000_000,
      chainNow: 1_700_000_000,
      orderExpiresAt: 1_700_700_000,
      shortLockSeconds: 1_800,
      longLockSeconds: 2_100
    })).toThrow("at least 600 seconds");
    expect(createSettlementPlan({
      localNow: 1_700_000_000,
      chainNow: 1_700_000_000,
      orderExpiresAt: 1_700_700_000,
      shortLockSeconds: 1_800,
      longLockSeconds: 2_400
    }).reservationExpiresAt).toBe(1_700_000_000 + 2_400 + 600);
  });

  it("computes truncated integer quote amounts without floating point", () => {
    expect(settlementAmounts({
      remainingBaseAmount: "20",
      fillBaseAmount: "20",
      price: "5000000",
      execution: "all_or_none",
      minimumFillAmount: "20"
    })).toEqual({ base: "20", quote: "1" });

    expect(() => settlementAmounts({
      remainingBaseAmount: "20",
      fillBaseAmount: "19",
      price: "5000000",
      execution: "all_or_none",
      minimumFillAmount: "20"
    })).toThrow("all-or-none");

    expect(settlementAmounts({
      remainingBaseAmount: "20",
      fillBaseAmount: "10",
      price: "15000000",
      execution: "partial",
      minimumFillAmount: "5"
    })).toEqual({ base: "10", quote: "1" });

    expect(settlementAmounts({
      remainingBaseAmount: "200",
      fillBaseAmount: "200",
      price: "4950000",
      execution: "all_or_none",
      minimumFillAmount: "200"
    })).toEqual({ base: "200", quote: "9" });
  });

  it("allows only the persisted happy-path sequence", () => {
    const sequence: Array<[TradePhase, Parameters<typeof advanceTrade>[1], TradePhase]> = [
      ["negotiating", "reserve_confirmed", "reserved"],
      ["reserved", "base_lock_validated", "base_locked"],
      ["base_locked", "quote_lock_validated", "quote_locked"],
      ["quote_locked", "quote_spent_with_preimage", "quote_claimed"],
      ["quote_claimed", "base_spent", "base_claimed"],
      ["base_claimed", "fill_confirmed", "filled"]
    ];

    for (const [from, event, to] of sequence) {
      expect(advanceTrade(from, event)).toBe(to);
    }
  });

  it("does not treat messages, pending proofs, or timeouts as settlement", () => {
    expect(() => advanceTrade("quote_locked", "claim_notice_received" as never))
      .toThrow("Invalid trade transition");
    expect(() => advanceTrade("quote_locked", "base_spent"))
      .toThrow("Invalid trade transition");
    expect(() => advanceTrade("base_claimed", "release_confirmed"))
      .toThrow("Invalid trade transition");
  });

  it("enters explicit recovery without releasing locked value", () => {
    expect(advanceTrade("reserved", "abort_confirmed")).toBe("released");
    expect(advanceTrade("base_locked", "base_refund_pending")).toBe("waiting_base_refund");
    expect(advanceTrade("quote_locked", "quote_refund_pending")).toBe("waiting_quote_refund");
    expect(advanceTrade("waiting_quote_refund", "quote_refund_confirmed")).toBe("released");
    expect(advanceTrade("waiting_base_refund", "base_refund_confirmed")).toBe("released");
    expect(advanceTrade("waiting_base_refund", "release_confirmed")).toBe("released");
    expect(advanceTrade("quote_locked", "contradiction_detected")).toBe("frozen");
  });

  it("keeps the refund ladder reachable from every phase recovery can start in", () => {
    // Regression: `enter_recovery` used to emit rungs the durable validator
    // rejected, so an abandoned maker holding a live base HTLC could never
    // reclaim it.
    for (const phase of [
      "negotiating", "reserved", "base_locked", "quote_locked",
      "quote_claimed", "base_claimed", "frozen"
    ] as TradePhase[]) {
      expect(advanceTrade(phase, "base_refund_pending")).toBe("waiting_base_refund");
      expect(PERSISTED_PHASE_STEPS.has(`${phase}:waiting_base_refund`)).toBe(true);
    }
    for (const phase of [
      "base_locked", "quote_locked", "quote_claimed", "base_claimed", "frozen"
    ] as TradePhase[]) {
      expect(advanceTrade(phase, "quote_refund_pending")).toBe("waiting_quote_refund");
      expect(PERSISTED_PHASE_STEPS.has(`${phase}:waiting_quote_refund`)).toBe(true);
    }
    for (const phase of ["waiting_base_refund", "frozen"] as TradePhase[]) {
      expect(PERSISTED_PHASE_STEPS.has(`${phase}:released`)).toBe(true);
    }
    expect(PERSISTED_PHASE_STEPS.has("waiting_quote_refund:released")).toBe(true);
    expect(canAdvanceTrade("filled", "base_refund_pending")).toBe(false);
    expect(canAdvanceTrade("released", "base_refund_pending")).toBe(false);
  });
});
