import { describe, expect, it } from "vitest";
import { createHtlcMaterial, verifyHtlcMaterial } from "./htlc-material.js";

describe("htlc material", () => {
  it("creates a 32-byte preimage and its sha256", async () => {
    const m = await createHtlcMaterial();
    expect(m.preimage).toMatch(/^[0-9a-f]{64}$/);
    expect(m.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await verifyHtlcMaterial(m.preimage, m.hash)).toBe(true);
    expect(await verifyHtlcMaterial(m.preimage, "0".repeat(64))).toBe(false);
  });
});
