import { describe, expect, it } from "vitest";

import {
  formatPrice,
  formatTokenAmount,
  renderTokenAmount,
  truncateAddress,
  truncateHash
} from "./format.js";

describe("token amount formatting", () => {
  it.each([
    ["100000000", 8, "ZNN", "1.00000000 ZNN"],
    ["123456789", 8, "ZNN", "1.23456789 ZNN"],
    ["1234500000000", 8, "QSR", "12,345.00000000 QSR"],
    ["1", 8, "ZNN", "0.00000001 ZNN"],
    ["0", 8, "ZNN", "0.00000000 ZNN"],
    ["42", 0, "ZTS", "42 ZTS"]
  ])(
    "renders %s minor units at %i decimals with full precision",
    (amount, decimals, symbol, expected) => {
      expect(formatTokenAmount(amount, decimals, symbol)).toBe(expected);
    }
  );

  it("groups and keeps exact precision above Number.MAX_SAFE_INTEGER", () => {
    expect(formatTokenAmount("9007199254740993", 8, "ZNN")).toBe(
      "90,071,992.54740993 ZNN"
    );
  });

  it("rejects anything that is not a canonical minor-unit integer", () => {
    expect(() => formatTokenAmount("1.5", 8, "ZNN")).toThrow(/integer/i);
    expect(() => formatTokenAmount("-1", 8, "ZNN")).toThrow(/integer/i);
  });
});

describe("token amount DOM rendering", () => {
  it("dims only the insignificant trailing zeros and keeps the value mono", () => {
    const node = renderTokenAmount("100000000", 8, "ZNN");

    expect(node.classList.contains("font-mono")).toBe(true);
    expect(node.classList.contains("tabular-nums")).toBe(true);
    expect(node.textContent).toBe("1.00000000 ZNN");
    expect(node.querySelector(".dim")?.textContent).toBe("00000000");
  });

  it("dims nothing when every fractional digit is significant", () => {
    const node = renderTokenAmount("123456789", 8, "ZNN");

    expect(node.textContent).toBe("1.23456789 ZNN");
    expect(node.querySelector(".dim")).toBeNull();
  });

  it("dims the trailing zero run only", () => {
    const node = renderTokenAmount("120500000", 8, "ZNN");

    expect(node.textContent).toBe("1.20500000 ZNN");
    expect(node.querySelector(".dim")?.textContent).toBe("00000");
  });
});

describe("address and hash truncation", () => {
  it("truncates a Zenon address as start…end", () => {
    expect(truncateAddress("z1qzal6c5s9rjnnxd2z7dvdhjxpmmj4fmw56a0mz")).toBe("z1qzal…a0mz");
  });

  it("leaves an already-short value alone", () => {
    expect(truncateAddress("z1qzal")).toBe("z1qzal");
  });

  it("widens the trailing run on request without moving the default", () => {
    const address = "z1qzal6c5s9rjnnxd2z7dvdhjxpmmj4fmw56a0mz";
    expect(truncateAddress(address, 6)).toBe("z1qzal…56a0mz");
    // The guard scales with the tail: nothing is saved by eliding 13 characters into 13.
    expect(truncateAddress("z1qzal6c5s9rj", 6)).toBe("z1qzal6c5s9rj");
    expect(truncateAddress("z1qzal6c5s9rjn", 6)).toBe("z1qzal…5s9rjn");
  });

  it("truncates hashes and HTLC ids with a longer head", () => {
    expect(truncateHash("0".repeat(56) + "abcdef12")).toBe("00000000…abcdef12");
  });
});

describe("price formatting", () => {
  it("renders the exact human price as quote per base", () => {
    expect(formatPrice("350000000", 8, "QSR", "ZNN")).toBe("3.5 QSR/ZNN");
  });

  it("keeps whole prices whole", () => {
    expect(formatPrice("1000000000", 8, "QSR", "ZNN")).toBe("10 QSR/ZNN");
  });
});
