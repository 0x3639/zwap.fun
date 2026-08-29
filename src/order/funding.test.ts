import { describe, expect, it } from "vitest";

import { fundingRequirement } from "./funding.js";

describe("order funding requirement", () => {
  it("requires the exact base token amount for a sell order", () => {
    expect(fundingRequirement({ side: "sell", amount: "2000", price: "350000000" }))
      .toEqual({ token: "base", amount: "2000" });
  });

  it("requires the truncated settlement quote amount for a buy order", () => {
    expect(fundingRequirement({ side: "buy", amount: "2000", price: "350000000" }))
      .toEqual({ token: "quote", amount: "7000" });
    expect(fundingRequirement({ side: "buy", amount: "2000", price: "4960000" }))
      .toEqual({ token: "quote", amount: "99" });
  });

  it("rejects a non-canonical amount", () => {
    expect(() => fundingRequirement({ side: "sell", amount: "0", price: "350000000" }))
      .toThrow("canonical integer string");
    expect(() => fundingRequirement({ side: "sell", amount: "01", price: "350000000" }))
      .toThrow("canonical integer string");
  });

  it("rejects an amount and price that produce a zero quote", () => {
    expect(() => fundingRequirement({ side: "buy", amount: "1", price: "1" }))
      .toThrow("at least one quote unit");
  });
});
