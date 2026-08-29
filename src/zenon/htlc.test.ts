// @vitest-environment node
import { describe, expect, it } from "vitest";
import { fakeUnlockDecoder, findUnlockPreimage, htlcValidationCommitment, sdkUnlockDecoder, validateHtlcInfo, type ExpectedZenonLock } from "./htlc.js";
import { encodeFakeUnlockData } from "./fake-node.js";
import { HTLC_ADDRESS, ZNN_ZTS, type AccountBlockView, type HtlcInfoView } from "./types.js";
import { createHtlcMaterial } from "./htlc-material.js";
import { Hash, Zenon } from "znn-typescript-sdk";

const A = "z1qzal6c5s9rjnnxd2z7dvdhjxpmmj4fmw56a0mz";
const B = "z1qqw6sypygz8sq4tzy4c8u7tlmqf5dh9kupt2wgv";

function expected(over: Partial<ExpectedZenonLock> = {}): ExpectedZenonLock {
  return {
    leg: "base", chainId: "1", tokenStandard: ZNN_ZTS, amount: "100", hashLock: "ab".repeat(32), hashType: 1, keyMaxSize: 32,
    hashLockedAddress: B, timeLockedAddress: A, expirationTime: 2000,
    binding: { protocolVersion: "1", network: "zenon-mainnet", orderId: "o", sessionId: "s", reservationId: "r", transcriptHash: "cd".repeat(32) },
    ...over
  };
}
function info(over: Partial<HtlcInfoView> = {}): HtlcInfoView {
  return { id: "ef".repeat(32), timeLocked: A, hashLocked: B, tokenStandard: ZNN_ZTS, amount: "100", expirationTime: 2000, hashType: 1, keyMaxSize: 32, hashLock: "ab".repeat(32), ...over };
}

describe("validateHtlcInfo", () => {
  it("accepts a matching HTLC", () => { expect(() => validateHtlcInfo(info(), expected())).not.toThrow(); });
  it.each([
    ["htlc-token", { tokenStandard: "zts1qsrxxxxxxxxxxxxxmrhjll" }],
    ["htlc-amount", { amount: "99" }],
    ["htlc-hashlock", { hashLock: "00".repeat(32) }],
    ["htlc-hashtype", { hashType: 0 }],
    ["htlc-keymaxsize", { keyMaxSize: 16 }],
    ["htlc-hashlocked", { hashLocked: A }],
    ["htlc-timelocked", { timeLocked: B }],
    ["htlc-expiration", { expirationTime: 1999 }]
  ] as const)("rejects %s", (code, over) => {
    expect(() => validateHtlcInfo(info(over), expected())).toThrow(expect.objectContaining({ code }));
  });
  it("commits to the whole view", async () => {
    expect(await htlcValidationCommitment(info())).toMatch(/^[0-9a-f]{64}$/);
    expect(await htlcValidationCommitment(info())).not.toBe(await htlcValidationCommitment(info({ amount: "1" })));
  });
});

describe("findUnlockPreimage", () => {
  it("finds a fake-encoded unlock and verifies it", async () => {
    const m = await createHtlcMaterial();
    const id = "11".repeat(32);
    const blocks: AccountBlockView[] = [
      { hash: "a".repeat(64), height: 2, blockType: 2, address: B, toAddress: A, amount: "1", tokenStandard: ZNN_ZTS, fromBlockHash: "0".repeat(64), data: "", confirmations: 1, momentumTimestamp: 1 },
      { hash: "b".repeat(64), height: 1, blockType: 2, address: B, toAddress: HTLC_ADDRESS, amount: "0", tokenStandard: ZNN_ZTS, fromBlockHash: "0".repeat(64), data: encodeFakeUnlockData(id, m.preimage), confirmations: 1, momentumTimestamp: 1 }
    ];
    expect(await findUnlockPreimage(blocks, id, m.hash, fakeUnlockDecoder)).toEqual({ preimage: m.preimage, blockHash: "b".repeat(64) });
    expect(await findUnlockPreimage(blocks, id, "00".repeat(32), fakeUnlockDecoder)).toBeNull();
    expect(await findUnlockPreimage(blocks, "22".repeat(32), m.hash, fakeUnlockDecoder)).toBeNull();
  });
  it("decodes a real ABI-encoded unlock", async () => {
    const m = await createHtlcMaterial();
    const id = "33".repeat(32);
    const t = Zenon.getInstance().embedded.htlc.unlock(
      Hash.parse(id), Buffer.from(m.preimage, "hex")
    );
    const block: AccountBlockView = { hash: "c".repeat(64), height: 1, blockType: 2, address: B, toAddress: HTLC_ADDRESS, amount: "0", tokenStandard: ZNN_ZTS, fromBlockHash: "0".repeat(64), data: Buffer.from(t.data).toString("hex"), confirmations: 1, momentumTimestamp: 1 };
    expect(await findUnlockPreimage([block], id, m.hash, sdkUnlockDecoder)).toEqual({ preimage: m.preimage, blockHash: "c".repeat(64) });
  });
});
