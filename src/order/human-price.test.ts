import { describe, expect, it } from "vitest";

import { humanPriceToPrice, priceToHumanPrice } from "./human-price.js";

describe("human price conversion", () => {
  it("converts a decimal quote-per-base price into an integer price", () => {
    expect(humanPriceToPrice("3.5", 8)).toBe("350000000");
    expect(humanPriceToPrice("0.00000001", 8)).toBe("1");
    expect(humanPriceToPrice("1", 8)).toBe("100000000");
  });

  it("converts an integer price back into a decimal quote-per-base price", () => {
    expect(priceToHumanPrice("350000000", 8)).toBe("3.5");
    expect(priceToHumanPrice("1", 8)).toBe("0.00000001");
    expect(priceToHumanPrice("100000000", 8)).toBe("1");
  });

  it("rounds a human price with more fractional precision than the quote decimals support", () => {
    expect(humanPriceToPrice("3.5", 0)).toBe("4");
    expect(humanPriceToPrice("3.4", 0)).toBe("3");
  });

  it("rejects scientific notation, negative values, and over-precise fractions", () => {
    expect(() => humanPriceToPrice("1e3", 8)).toThrow("Human price must");
    expect(() => humanPriceToPrice("-1", 8)).toThrow("Human price must");
    expect(() => humanPriceToPrice("1.123456789", 8)).toThrow("Human price must");
    expect(() => humanPriceToPrice("0", 8)).toThrow("greater than zero");
    expect(() => humanPriceToPrice("0.00000000", 8)).toThrow("greater than zero");
  });

  it("rejects a non-canonical price string", () => {
    expect(() => priceToHumanPrice("0", 8)).toThrow("Price must");
    expect(() => priceToHumanPrice("01", 8)).toThrow("Price must");
    expect(() => priceToHumanPrice("-1", 8)).toThrow("Price must");
  });
});
