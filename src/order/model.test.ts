import { describe, expect, it } from "vitest";

import { QSR_ZTS, ZNN_ZTS } from "../zenon/types.js";
import {
  buildOrderBook,
  cancelOrder,
  createOrderState,
  eligibleMarketIds,
  expireOrder,
  fillOrder,
  marketId,
  quoteAmountForSettlement,
  releaseOrder,
  reserveOrder,
  type OrderRecord
} from "./model.js";

const chainId = "1";
const askOne = "11111111-1111-4111-8111-111111111111";
const bidOne = "22222222-2222-4222-8222-222222222222";
const znnQsrMarketId = "317ca90facdb549a0b53369c43be80dfc7df831b408e52354726f46667d371ee";

describe("Zwap order model", () => {
  it("creates a canonical ask with explicit 30-day expiry and one eligible market", async () => {
    const state = createOrderState({
      orderId: askOne,
      createdAt: 1_700_000_000,
      side: "sell",
      chainId,
      baseToken: ZNN_ZTS,
      quoteToken: QSR_ZTS,
      amount: "2000",
      price: "350000000"
    });

    expect(state.expires_at).toBe(1_702_592_000);
    expect(state.execution).toBe("all_or_none");
    expect(state.minimum_fill_amount).toBe("2000");
    expect(state.offered).toEqual({ token: ZNN_ZTS });
    expect(state.requested).toEqual({ token: QSR_ZTS });
    await expect(eligibleMarketIds(state)).resolves.toEqual([znnQsrMarketId]);
    await expect(marketId({ chainId, baseToken: ZNN_ZTS, quoteToken: QSR_ZTS }))
      .resolves.toBe(znnQsrMarketId);
  });

  it("models a bid, reversing offered and requested tokens", async () => {
    const state = createOrderState({
      orderId: bidOne,
      createdAt: 1_700_000_000,
      side: "buy",
      chainId,
      baseToken: ZNN_ZTS,
      quoteToken: QSR_ZTS,
      amount: "2000",
      price: "295000000",
      execution: "partial",
      minimumFillAmount: "1000"
    });

    expect(state.offered).toEqual({ token: QSR_ZTS });
    expect(state.requested).toEqual({ token: ZNN_ZTS });
    await expect(eligibleMarketIds(state)).resolves.toEqual([znnQsrMarketId]);
  });

  it("preserves exact base amounts, truncates the quote, and rejects zero quotes", () => {
    const exactBase = createOrderState({
      orderId: "99999999-9999-4999-8999-999999999999",
      createdAt: 1,
      side: "sell",
      chainId,
      baseToken: ZNN_ZTS,
      quoteToken: QSR_ZTS,
      amount: "200",
      price: "350000000"
    });
    expect(exactBase.original_amount).toBe("200");
    expect(exactBase.remaining_amount).toBe("200");
    expect(quoteAmountForSettlement("200", exactBase.price)).toBe("700");

    expect(() => createOrderState({
      orderId: "33333333-3333-4333-8333-333333333333",
      createdAt: 1,
      side: "buy",
      chainId,
      baseToken: ZNN_ZTS,
      quoteToken: QSR_ZTS,
      amount: "1",
      price: "50000000"
    })).toThrow("at least one quote unit");

    const truncated = createOrderState({
      orderId: "77777777-7777-4777-8777-777777777777",
      createdAt: 1,
      side: "sell",
      chainId,
      baseToken: ZNN_ZTS,
      quoteToken: QSR_ZTS,
      amount: "2000",
      price: "4960000"
    });
    expect(truncated.original_amount).toBe("2000");
    expect(quoteAmountForSettlement("2000", truncated.price)).toBe("99");
  });

  it("rejects non-UUID IDs, invalid chain IDs, invalid tokens, and runtime enum bypasses", () => {
    const valid = {
      orderId: "11111111-1111-4111-8111-111111111111",
      createdAt: 1,
      side: "sell" as const,
      chainId,
      baseToken: ZNN_ZTS,
      quoteToken: QSR_ZTS,
      amount: "2",
      price: "50000000"
    };

    expect(() => createOrderState({ ...valid, orderId: "decorated-id" }))
      .toThrow("Order ID must be a UUID");
    expect(() => createOrderState({ ...valid, side: "market" as "sell" }))
      .toThrow("Order side");
    expect(() => createOrderState({ ...valid, chainId: "0" }))
      .toThrow("Chain ID");
    expect(() => createOrderState({ ...valid, chainId: "01" }))
      .toThrow("Chain ID");
    expect(() => createOrderState({ ...valid, baseToken: "not-a-token" }))
      .toThrow("Base token");
    expect(() => createOrderState({ ...valid, quoteToken: "not-a-token" }))
      .toThrow("Quote token");
    expect(() => createOrderState({ ...valid, quoteToken: ZNN_ZTS }))
      .toThrow("Base and quote tokens must differ");
    expect(() => createOrderState({
      ...valid,
      execution: "immediate" as "partial",
      minimumFillAmount: "1"
    })).toThrow("Execution condition");
  });

  it("sorts an issuer-agnostic book and makes the top bid and ask explicit", async () => {
    const askHigh = "55555555-5555-4555-8555-555555555555";
    const bidLow = "66666666-6666-4666-8666-666666666666";
    const askLow = "77777777-7777-4777-8777-777777777777";
    const bidHigh = "88888888-8888-4888-8888-888888888888";
    const record = (orderId: string, side: "buy" | "sell", numerator: string): OrderRecord => ({
      address: `30078:maker:${orderId}`,
      eventId: `${orderId}-head`,
      makerPubkey: `maker-${orderId}`,
      verified: true,
      state: createOrderState({
        orderId,
        createdAt: 1_700_000_000,
        expiresAt: 1_800_000_000,
        side,
        chainId,
        baseToken: ZNN_ZTS,
        quoteToken: QSR_ZTS,
        amount: "2000",
        price: (BigInt(numerator) * 50_000n).toString()
      })
    });
    const market = { chainId, baseToken: ZNN_ZTS, quoteToken: QSR_ZTS };
    const records = [
      record(askHigh, "sell", "102"),
      record(bidLow, "buy", "98"),
      record(askLow, "sell", "101"),
      record(bidHigh, "buy", "99")
    ];

    const book = await buildOrderBook(records, market, 1_700_000_100);

    expect(book.asks.map((order) => order.state.order_id)).toEqual([askLow, askHigh]);
    expect(book.bids.map((order) => order.state.order_id)).toEqual([bidHigh, bidLow]);
    expect(book.topAsk?.state.order_id).toBe(askLow);
    expect(book.topBid?.state.order_id).toBe(bidHigh);
    await expect(marketId(market)).resolves.toBe(znnQsrMarketId);
  });

  it("reserves an exact all-or-none amount without reducing the remaining amount", () => {
    const initial = createOrderState({
      orderId: askOne,
      createdAt: 1_700_000_000,
      expiresAt: 1_700_010_000,
      side: "sell",
      chainId,
      baseToken: ZNN_ZTS,
      quoteToken: QSR_ZTS,
      amount: "20",
      price: "500000000"
    });

    const reserved = reserveOrder(initial, {
      reservationId: "99999999-9999-4999-8999-999999999999",
      amount: "20",
      acceptedAt: 1_700_000_100,
      expiresAt: 1_700_001_900,
      proposalEventId: "a".repeat(64),
      takerCommitment: "b".repeat(64)
    });

    expect(reserved).toMatchObject({
      revision: "1",
      remaining_amount: "20",
      reserved_amount: "20",
      status: "reserved",
      reservation: {
        id: "99999999-9999-4999-8999-999999999999",
        amount: "20",
        accepted_at: 1_700_000_100,
        expires_at: 1_700_001_900
      }
    });
    expect(() => reserveOrder(reserved, {
      reservationId: "88888888-8888-4888-8888-888888888888",
      amount: "20",
      acceptedAt: 1_700_000_101,
      expiresAt: 1_700_001_901,
      proposalEventId: "c".repeat(64),
      takerCommitment: "d".repeat(64)
    })).toThrow("live reservation");
  });

  it("fills only the matching reservation and reaches a terminal zero balance", () => {
    const initial = createOrderState({
      orderId: askOne,
      createdAt: 1_700_000_000,
      expiresAt: 1_700_010_000,
      side: "sell",
      chainId,
      baseToken: ZNN_ZTS,
      quoteToken: QSR_ZTS,
      amount: "20",
      price: "500000000"
    });
    const reserved = reserveOrder(initial, {
      reservationId: "99999999-9999-4999-8999-999999999999",
      amount: "20",
      acceptedAt: 1_700_000_100,
      expiresAt: 1_700_001_900,
      proposalEventId: "a".repeat(64),
      takerCommitment: "b".repeat(64)
    });

    expect(() => fillOrder(reserved, {
      reservationId: "88888888-8888-4888-8888-888888888888",
      amount: "20"
    })).toThrow("reservation ID");

    expect(fillOrder(reserved, {
      reservationId: "99999999-9999-4999-8999-999999999999",
      amount: "20"
    })).toMatchObject({
      revision: "2",
      remaining_amount: "0",
      reserved_amount: "0",
      reservation: null,
      status: "filled"
    });
  });

  it("releases only the matching reservation after expiry or a signed abort", () => {
    const initial = createOrderState({
      orderId: askOne,
      createdAt: 1_700_000_000,
      expiresAt: 1_700_010_000,
      side: "sell",
      chainId,
      baseToken: ZNN_ZTS,
      quoteToken: QSR_ZTS,
      amount: "20",
      price: "500000000"
    });
    const reserved = reserveOrder(initial, {
      reservationId: "99999999-9999-4999-8999-999999999999",
      amount: "20",
      acceptedAt: 1_700_000_100,
      expiresAt: 1_700_001_900,
      proposalEventId: "a".repeat(64),
      takerCommitment: "b".repeat(64)
    });

    expect(() => releaseOrder(reserved, {
      reservationId: reserved.reservation!.id,
      reason: "expired",
      releasedAt: 1_700_001_899
    })).toThrow(/not expired/i);

    expect(releaseOrder(reserved, {
      reservationId: reserved.reservation!.id,
      reason: "expired",
      releasedAt: 1_700_001_900
    })).toMatchObject({
      revision: "2",
      remaining_amount: "20",
      reserved_amount: "0",
      reservation: null,
      status: "open"
    });

    expect(releaseOrder(reserved, {
      reservationId: reserved.reservation!.id,
      reason: "withdrawn",
      releasedAt: reserved.reservation!.accepted_at + 1
    }).reservation).toBeNull();
    expect(() => releaseOrder(reserved, {
      reservationId: reserved.reservation!.id,
      reason: "withdrawn",
      releasedAt: reserved.reservation!.accepted_at + 1,
      abortEventId: "ab".repeat(32)
    })).toThrow(/withdrawn release cannot reference an abort event/i);
    expect(releaseOrder(reserved, {
      reservationId: reserved.reservation!.id,
      reason: "abort",
      releasedAt: 1_700_000_200,
      abortEventId: "c".repeat(64)
    })).toMatchObject({ revision: "2", status: "open", reservation: null });
    expect(() => releaseOrder(reserved, {
      reservationId: reserved.reservation!.id,
      reason: "abort",
      releasedAt: 1_700_000_200
    })).toThrow(/abort event/i);
  });

  it("cancels or expires only an unreserved projection", () => {
    const initial = createOrderState({
      orderId: askOne,
      createdAt: 1_700_000_000,
      expiresAt: 1_700_001_000,
      side: "sell",
      chainId,
      baseToken: ZNN_ZTS,
      quoteToken: QSR_ZTS,
      amount: "20",
      price: "500000000"
    });
    const reserved = reserveOrder(initial, {
      reservationId: "99999999-9999-4999-8999-999999999999",
      amount: "20",
      acceptedAt: 1_700_000_100,
      expiresAt: 1_700_000_900,
      proposalEventId: "a".repeat(64),
      takerCommitment: "b".repeat(64)
    });

    expect(cancelOrder(initial)).toMatchObject({ revision: "1", status: "canceled" });
    expect(expireOrder(initial, 1_700_001_000))
      .toMatchObject({ revision: "1", status: "expired" });
    expect(() => cancelOrder(reserved)).toThrow(/released/i);
    expect(() => expireOrder(reserved, 1_700_001_000)).toThrow(/released/i);
  });
  it("hides an order whose reservation has lapsed but was never released", async () => {
    // `reserveOrder` refuses any order that still carries a reservation, expiry
    // or not. Advertising it as available only produces a take that throws.
    const orderId = "12345678-1234-4234-8234-123456789abc";
    const open = createOrderState({
      orderId,
      createdAt: 1_700_000_000,
      expiresAt: 1_800_000_000,
      side: "sell",
      chainId,
      baseToken: ZNN_ZTS,
      quoteToken: QSR_ZTS,
      amount: "20",
      price: "500000000"
    });
    const reserved = reserveOrder(open, {
      reservationId: "99999999-9999-4999-8999-999999999999",
      amount: "20",
      acceptedAt: 1_700_000_100,
      expiresAt: 1_700_001_900,
      proposalEventId: "a".repeat(64),
      takerCommitment: "b".repeat(64)
    });
    const record: OrderRecord = {
      address: `30078:maker:${orderId}`,
      eventId: `${orderId}-head`,
      makerPubkey: `maker-${orderId}`,
      verified: true,
      state: reserved
    };
    const market = { chainId, baseToken: ZNN_ZTS, quoteToken: QSR_ZTS };

    const afterExpiry = await buildOrderBook([record], market, 1_700_002_000);
    const beforeExpiry = await buildOrderBook([record], market, 1_700_000_200);

    expect(afterExpiry.asks).toEqual([]);
    expect(beforeExpiry.asks).toEqual([]);
    expect(() => reserveOrder(reserved, {
      reservationId: "88888888-8888-4888-8888-888888888888",
      amount: "20",
      acceptedAt: 1_700_002_000,
      expiresAt: 1_700_003_800,
      proposalEventId: "c".repeat(64),
      takerCommitment: "d".repeat(64)
    })).toThrow("live reservation");
  });
});
