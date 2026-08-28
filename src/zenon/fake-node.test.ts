import { describe, expect, it } from "vitest";
import { FakeZenonNode } from "./fake-node.js";
import { ZNN_ZTS, QSR_ZTS } from "./types.js";
import { createHtlcMaterial } from "./htlc-material.js";
import { isZenonAddress } from "./validate.js";

async function setup() {
  let now = 1_000_000;
  const node = new FakeZenonNode({ chainId: 1, now: () => now });
  const alice = node.createAddress("alice");
  const bob = node.createAddress("bob");
  node.fund(alice, ZNN_ZTS, "500000000");
  node.fund(bob, QSR_ZTS, "2000000000");
  return { node, alice, bob, tick: (s: number) => { now += s; } };
}

describe("FakeZenonNode", () => {
  it("reports chain id, momentum, balances", async () => {
    const { node, alice } = await setup();
    expect(await node.chainIdentifier()).toBe(1);
    expect((await node.frontierMomentum()).timestamp).toBe(1_000_000);
    expect(await node.getBalances(alice)).toEqual([{ tokenStandard: ZNN_ZTS, symbol: "ZNN", decimals: 8, balance: "500000000" }]);
  });

  it("creates, unlocks and delivers an HTLC", async () => {
    const { node, alice, bob } = await setup();
    const m = await createHtlcMaterial();
    const { blockHash } = await node.signer(alice).send({
      kind: "htlc_create", tokenStandard: ZNN_ZTS, amount: "100000000", hashLocked: bob,
      expirationTime: 1_000_000 + 3600, hashType: 1, keyMaxSize: 32, hashLock: m.hash
    });
    const info = await node.getHtlc(blockHash);
    expect(info).toMatchObject({ id: blockHash, timeLocked: alice, hashLocked: bob, amount: "100000000", hashLock: m.hash });
    expect((await node.getBalances(alice))[0]?.balance).toBe("400000000");

    await node.signer(bob).send({ kind: "htlc_unlock", id: blockHash, preimage: m.preimage });
    expect(await node.getHtlc(blockHash)).toBeNull();
    const unreceived = await node.listUnreceived(bob);
    expect(unreceived).toHaveLength(1);
    await node.signer(bob).send({ kind: "receive", fromBlockHash: unreceived[0]!.hash });
    expect((await node.getBalances(bob)).find((b) => b.tokenStandard === ZNN_ZTS)?.balance).toBe("100000000");
    const bobBlocks = await node.listAccountBlocks(bob, 0, 10);
    expect(bobBlocks.some((b) => b.data.length > 0)).toBe(true);
  });

  it("rejects a wrong preimage, an expired unlock, and an early reclaim", async () => {
    const { node, alice, bob, tick } = await setup();
    const m = await createHtlcMaterial();
    const { blockHash } = await node.signer(alice).send({
      kind: "htlc_create", tokenStandard: ZNN_ZTS, amount: "1", hashLocked: bob,
      expirationTime: 1_000_000 + 60, hashType: 1, keyMaxSize: 32, hashLock: m.hash
    });
    await expect(node.signer(bob).send({ kind: "htlc_unlock", id: blockHash, preimage: "00".repeat(32) })).rejects.toThrow(/preimage/);
    await expect(node.signer(alice).send({ kind: "htlc_reclaim", id: blockHash })).rejects.toThrow(/expir/);
    tick(61);
    await expect(node.signer(bob).send({ kind: "htlc_unlock", id: blockHash, preimage: m.preimage })).rejects.toThrow(/expir/);
    await expect(node.signer(bob).send({ kind: "htlc_reclaim", id: blockHash })).rejects.toThrow(/timeLocked/);
    await node.signer(alice).send({ kind: "htlc_reclaim", id: blockHash });
    expect(await node.getHtlc(blockHash)).toBeNull();
    expect(await node.listUnreceived(alice)).toHaveLength(1);
  });

  it("rejects overspending and injected failures", async () => {
    const { node, alice, bob } = await setup();
    await expect(node.signer(alice).send({ kind: "send", toAddress: bob, tokenStandard: ZNN_ZTS, amount: "999999999999" })).rejects.toThrow(/balance/);
    node.failNext("send", new Error("node down"));
    await expect(node.signer(alice).send({ kind: "send", toAddress: bob, tokenStandard: ZNN_ZTS, amount: "1" })).rejects.toThrow("node down");
    await node.signer(alice).send({ kind: "send", toAddress: bob, tokenStandard: ZNN_ZTS, amount: "1" });
  });
});

describe("fake node addresses", () => {
  it("issues distinct valid Zenon addresses for every call", () => {
    const node = new FakeZenonNode();
    const addresses = Array.from({ length: 50 }, () => node.createAddress());

    expect(new Set(addresses).size).toBe(50);
    for (const address of addresses) expect(isZenonAddress(address)).toBe(true);
  });

  it("keeps labelled addresses distinct and deterministic per instance", () => {
    const first = new FakeZenonNode();
    const second = new FakeZenonNode();
    const labels = ["maker", "taker", "counterparty", "maker"];

    const left = labels.map((label) => first.createAddress(label));
    const right = labels.map((label) => second.createAddress(label));

    expect(left).toEqual(right);
    expect(new Set(left).size).toBe(labels.length);
  });
});
