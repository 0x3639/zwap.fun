import { describe, expect, it } from "vitest";

import {
  humanAmountToMinor,
  humanPriceToPrice,
  minorToHumanAmount,
  priceToHumanPrice
} from "./human-price.js";

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

describe("human amount conversion", () => {
  it("converts a decimal token amount into exact minor units", () => {
    expect(humanAmountToMinor("20", 8)).toBe("2000000000");
    expect(humanAmountToMinor("0.00000001", 8)).toBe("1");
    expect(humanAmountToMinor("1.5", 8)).toBe("150000000");
    expect(humanAmountToMinor("20.00000000", 8)).toBe("2000000000");
    expect(humanAmountToMinor("7", 0)).toBe("7");
  });

  it("converts minor units back into a trimmed decimal amount", () => {
    expect(minorToHumanAmount("2000000000", 8)).toBe("20");
    expect(minorToHumanAmount("1", 8)).toBe("0.00000001");
    expect(minorToHumanAmount("150000000", 8)).toBe("1.5");
    expect(minorToHumanAmount("0", 8)).toBe("0");
    expect(minorToHumanAmount("7", 0)).toBe("7");
  });

  it("round-trips exactly beyond Number.MAX_SAFE_INTEGER", () => {
    const minor = "9007199254740993";
    expect(humanAmountToMinor(minorToHumanAmount(minor, 8), 8)).toBe(minor);
  });

  it("never rounds: an amount finer than the token supports is an error", () => {
    expect(() => humanAmountToMinor("1.123456789", 8)).toThrow("Amount must");
    expect(() => humanAmountToMinor("0.5", 0)).toThrow("Amount must");
  });

  it("rejects scientific notation, negatives, blanks, and zero", () => {
    expect(() => humanAmountToMinor("1e3", 8)).toThrow("Amount must");
    expect(() => humanAmountToMinor("-1", 8)).toThrow("Amount must");
    expect(() => humanAmountToMinor("", 8)).toThrow("Amount must");
    expect(() => humanAmountToMinor(" 20 ", 8)).toThrow("Amount must");
    expect(() => humanAmountToMinor("0", 8)).toThrow("greater than zero");
    expect(() => humanAmountToMinor("0.00000000", 8)).toThrow("greater than zero");
  });

  it("rejects a non-canonical minor-unit string", () => {
    expect(() => minorToHumanAmount("01", 8)).toThrow("Minor amount must");
    expect(() => minorToHumanAmount("-1", 8)).toThrow("Minor amount must");
    expect(() => minorToHumanAmount("1.5", 8)).toThrow("Minor amount must");
  });
});
