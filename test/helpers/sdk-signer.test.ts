// @vitest-environment node
import { describe, expect, it } from "vitest";
import { KeyStore, Zenon, HTLC_ADDRESS as SDK_HTLC } from "znn-typescript-sdk";
import { SdkSigner, toSdkTemplate } from "./sdk-signer.js";
import { ZNN_ZTS } from "../../src/zenon/types.js";

const TEST_MNEMONIC = KeyStore.newRandom().mnemonic; // throwaway, never funded

describe("toSdkTemplate", () => {
  it("maps an htlc_create to a call on the HTLC contract carrying the locked amount", () => {
    const zenon = Zenon.getInstance();
    const t = toSdkTemplate({
      kind: "htlc_create", tokenStandard: ZNN_ZTS, amount: "100000000",
      hashLocked: "z1qzal6c5s9rjnnxd2z7dvdhjxpmmj4fmw56a0mz", expirationTime: 1_700_000_000,
      hashType: 1, keyMaxSize: 32, hashLock: "ab".repeat(32)
    }, zenon);
    expect(t.toAddress.toString()).toBe(SDK_HTLC.toString());
    expect(t.tokenStandard.toString()).toBe(ZNN_ZTS);
    expect(String(t.amount)).toBe("100000000");
    expect(t.data.length).toBeGreaterThan(4);
  });
  it("maps unlock, reclaim, receive and send", () => {
    const zenon = Zenon.getInstance();
    expect(toSdkTemplate({ kind: "htlc_unlock", id: "00".repeat(32), preimage: "11".repeat(32) }, zenon).toAddress.toString()).toBe(SDK_HTLC.toString());
    expect(toSdkTemplate({ kind: "htlc_reclaim", id: "00".repeat(32) }, zenon).toAddress.toString()).toBe(SDK_HTLC.toString());
    expect(toSdkTemplate({ kind: "receive", fromBlockHash: "22".repeat(32) }, zenon).fromBlockHash.toString()).toBe("22".repeat(32));
    const s = toSdkTemplate({ kind: "send", toAddress: "z1qzal6c5s9rjnnxd2z7dvdhjxpmmj4fmw56a0mz", tokenStandard: ZNN_ZTS, amount: "5" }, zenon);
    expect(String(s.amount)).toBe("5");
  });
});

describe("SdkSigner", () => {
  it("serializes sends and returns the published hash", async () => {
    const keyPair = KeyStore.fromMnemonic(TEST_MNEMONIC).getKeyPair(0);
    const order: number[] = [];
    let counter = 0;
    const fakeZenon = {
      send: async (template: { hash: { toString(): string } }) => {
        const id = counter++;
        await new Promise((r) => setTimeout(r, id === 0 ? 20 : 0));
        // Record *completion* order: invocation order is [0, 1] with or
        // without the queue, but the slow first send only completes first
        // when the second is held behind it.
        order.push(id);
        return { ...template, hash: { toString: () => `${id}`.padStart(64, "0") } } as never;
      }
    };
    const signer = new SdkSigner(fakeZenon as never, keyPair);
    expect(signer.address()).toBe(keyPair.address.toString());
    const [a, b] = await Promise.all([
      signer.send({ kind: "receive", fromBlockHash: "aa".repeat(32) }),
      signer.send({ kind: "receive", fromBlockHash: "bb".repeat(32) })
    ]);
    expect(a.blockHash).toBe("0".repeat(63) + "0");
    expect(b.blockHash).toBe("0".repeat(63) + "1");
    expect(order).toEqual([0, 1]);
  });
});
