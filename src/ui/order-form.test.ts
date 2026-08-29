import { describe, expect, it } from "vitest";

import { QSR_ZTS, ZNN_ZTS } from "../zenon/types.js";
import {
  DEFAULT_ORDER_HOURS,
  MAX_ORDER_HOURS,
  MIN_ORDER_HOURS,
  describeSettlement,
  orderFormToPublishInput
} from "./order-form.js";
import { tokenDirectory } from "./tokens.js";

const tokens = tokenDirectory();
const NOW = 1_700_000_000;

function fields(overrides: Record<string, string> = {}): Record<string, string> {
  return { side: "sell", amount: "20", price: "10.5", hours: "24", ...overrides };
}

describe("order form to publish input", () => {
  it("converts human ZNN and QSR-per-ZNN into the exact integers that get signed", () => {
    const input = orderFormToPublishInput(fields(), tokens, NOW);

    expect(input).toEqual({
      side: "sell",
      amount: "2000000000",
      price: "1050000000",
      expiresAt: NOW + 24 * 3600,
      execution: "all_or_none"
    });
  });

  it("carries the buy side through untouched", () => {
    expect(orderFormToPublishInput(fields({ side: "buy" }), tokens, NOW).side).toBe("buy");
  });

  it("converts the finest representable amount without rounding", () => {
    expect(orderFormToPublishInput(fields({ amount: "0.00000001" }), tokens, NOW).amount)
      .toBe("1");
  });

  it("uses each token's own decimals rather than a constant", () => {
    const coarse = tokenDirectory([
      { tokenStandard: ZNN_ZTS, symbol: "ZNN", decimals: 2, balance: "0" },
      { tokenStandard: QSR_ZTS, symbol: "QSR", decimals: 3, balance: "0" }
    ]);

    const input = orderFormToPublishInput(fields({ amount: "1.25", price: "2.5" }), coarse, NOW);

    expect(input.amount).toBe("125");
    expect(input.price).toBe("2500");
  });

  it.each([
    [String(MIN_ORDER_HOURS), NOW + MIN_ORDER_HOURS * 3600],
    [String(MAX_ORDER_HOURS), NOW + MAX_ORDER_HOURS * 3600],
    [String(DEFAULT_ORDER_HOURS), NOW + DEFAULT_ORDER_HOURS * 3600]
  ])("accepts %s hours of lifetime", (hours, expiresAt) => {
    expect(orderFormToPublishInput(fields({ hours }), tokens, NOW).expiresAt).toBe(expiresAt);
  });

  it.each(["1", "0", "721", "-4", "1.5", "", "abc"])(
    "rejects %s as an order lifetime",
    (hours) => {
      expect(() => orderFormToPublishInput(fields({ hours }), tokens, NOW))
        .toThrow(/2–720 hours/);
    }
  );

  it("rejects an unknown side", () => {
    expect(() => orderFormToPublishInput(fields({ side: "hold" }), tokens, NOW))
      .toThrow(/order side/i);
  });

  it("refuses an amount finer than the token, rather than rounding it away", () => {
    expect(() => orderFormToPublishInput(fields({ amount: "1.123456789" }), tokens, NOW))
      .toThrow(/Amount must/);
  });

  it("refuses a zero or negative amount", () => {
    expect(() => orderFormToPublishInput(fields({ amount: "0" }), tokens, NOW))
      .toThrow(/greater than zero/);
    expect(() => orderFormToPublishInput(fields({ amount: "-1" }), tokens, NOW))
      .toThrow(/Amount must/);
  });
});

describe("settlement description", () => {
  it("states the human trade and the exact minor units that will be signed", () => {
    const hint = describeSettlement("20", "10.5", tokens);

    expect(hint).toContain("20 ZNN");
    expect(hint).toContain("2,000,000,000 minor units");
    expect(hint).toContain("210.00000000 QSR");
    expect(hint).toContain("21,000,000,000 minor units");
  });

  it("returns null rather than a wrong number while the form is mid-edit", () => {
    expect(describeSettlement("", "10.5", tokens)).toBeNull();
    expect(describeSettlement("20", "", tokens)).toBeNull();
    expect(describeSettlement("20", "0.000000001", tokens)).toBeNull();
  });
});
