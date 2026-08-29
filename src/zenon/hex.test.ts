import { describe, expect, it } from "vitest";
import { bytesToHex, hexToBytes, sha256Hex, sha256Text, randomBytes } from "./hex.js";

describe("hex", () => {
  it("round-trips", () => {
    expect(bytesToHex(hexToBytes("00ff10"))).toBe("00ff10");
  });
  it("rejects odd or invalid hex", () => {
    expect(() => hexToBytes("abc")).toThrow();
    expect(() => hexToBytes("zz")).toThrow();
  });
  it("hashes", async () => {
    expect(await sha256Text("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(await sha256Hex(new Uint8Array([0x61, 0x62, 0x63]))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  it("random bytes have the requested length and differ", () => {
    expect(randomBytes(32)).toHaveLength(32);
    expect(bytesToHex(randomBytes(32))).not.toBe(bytesToHex(randomBytes(32)));
  });
});
