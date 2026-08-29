import { describe, expect, it } from "vitest";
import { isAmount, isHex32, isTokenStandard, isZenonAddress } from "./validate.js";
import { QSR_ZTS, ZNN_ZTS, HTLC_ADDRESS } from "./types.js";

describe("validate", () => {
  it("accepts known addresses and token standards", () => {
    expect(isZenonAddress(HTLC_ADDRESS)).toBe(true);
    expect(isZenonAddress("z1qzal6c5s9rjnnxd2z7dvdhjxpmmj4fmw56a0mz")).toBe(true);
    expect(isZenonAddress("z1short")).toBe(false);
    expect(isTokenStandard(ZNN_ZTS)).toBe(true);
    expect(isTokenStandard(QSR_ZTS)).toBe(true);
    expect(isTokenStandard("zts1nope")).toBe(false);
  });
  it("checks hex32 and amounts", () => {
    expect(isHex32("a".repeat(64))).toBe(true);
    expect(isHex32("A".repeat(64))).toBe(false);
    expect(isAmount("100000000")).toBe(true);
    expect(isAmount("0")).toBe(false);
    expect(isAmount("01")).toBe(false);
  });
});
