import { describe, expect, it } from "vitest";

import { ZenonAccount } from "./account.js";
import { FakeZenonNode } from "./fake-node.js";
import { QSR_ZTS, ZNN_ZTS } from "./types.js";

const NOW = 1_800_000_000;

function harness(): {
  node: FakeZenonNode;
  address: string;
  account: ZenonAccount;
  funder: string;
} {
  const node = new FakeZenonNode({ chainId: 1, now: () => NOW });
  const address = node.createAddress("owner");
  const funder = node.createAddress("funder");
  const account = new ZenonAccount({
    node,
    signer: node.signer(address),
    now: () => NOW
  });
  return { node, address, account, funder };
}

describe("ZenonAccount", () => {
  it("exposes the signer address and the injected clock", () => {
    const { account, address } = harness();
    expect(account.address()).toBe(address);
    expect(account.currentTime()).toBe(NOW);
  });

  it("snapshots balances, unreceived count and plasma", async () => {
    const { node, address, account, funder } = harness();
    node.fund(address, ZNN_ZTS, "1000");
    node.fund(funder, QSR_ZTS, "77");
    await node.signer(funder).send({
      kind: "send",
      toAddress: address,
      tokenStandard: QSR_ZTS,
      amount: "77"
    });

    const snapshot = await account.snapshot();

    expect(snapshot.address).toBe(address);
    expect(snapshot.balances).toEqual([
      { tokenStandard: ZNN_ZTS, symbol: "ZNN", decimals: 8, balance: "1000" }
    ]);
    expect(snapshot.unreceived).toBe(1);
    expect(snapshot.plasma).toEqual({
      currentPlasma: 210_000,
      maxPlasma: 210_000,
      qsrFused: "10000000000"
    });
  });

  it("reports the drained plasma the node reports", async () => {
    const { node, address, account } = harness();
    node.setPow(address, true);

    const snapshot = await account.snapshot();

    expect(snapshot.plasma.currentPlasma).toBe(0);
  });

  it("receives every pending block sequentially and credits the balance", async () => {
    const { node, address, account, funder } = harness();
    node.fund(funder, ZNN_ZTS, "30");
    node.fund(funder, QSR_ZTS, "5");
    const sender = node.signer(funder);
    await sender.send({
      kind: "send",
      toAddress: address,
      tokenStandard: ZNN_ZTS,
      amount: "30"
    });
    await sender.send({
      kind: "send",
      toAddress: address,
      tokenStandard: QSR_ZTS,
      amount: "5"
    });
    const pending = await node.listUnreceived(address);
    const order: string[] = [];
    const observing = new ZenonAccount({
      node,
      signer: {
        address: () => address,
        send: async (template) => {
          if (template.kind === "receive") order.push(template.fromBlockHash);
          return node.signer(address).send(template);
        }
      },
      now: () => NOW
    });

    await expect(observing.receiveAll()).resolves.toBe(2);

    expect(order).toEqual(pending.map((block) => block.hash));
    expect(await node.getBalances(address)).toEqual([
      { tokenStandard: ZNN_ZTS, symbol: "ZNN", decimals: 8, balance: "30" },
      { tokenStandard: QSR_ZTS, symbol: "QSR", decimals: 8, balance: "5" }
    ]);
    await expect(node.listUnreceived(address)).resolves.toEqual([]);
    await expect(account.receiveAll()).resolves.toBe(0);
  });

  it("honours the receive limit", async () => {
    const { node, address, account, funder } = harness();
    node.fund(funder, ZNN_ZTS, "3");
    for (let index = 0; index < 3; index += 1) {
      await node.signer(funder).send({
        kind: "send",
        toAddress: address,
        tokenStandard: ZNN_ZTS,
        amount: "1"
      });
    }

    await expect(account.receiveAll(2)).resolves.toBe(2);

    expect(await node.listUnreceived(address)).toHaveLength(1);
  });

  it("rejects an invalid receive limit", async () => {
    const { account } = harness();
    await expect(account.receiveAll(0)).rejects.toThrow(/receive limit/i);
    await expect(account.receiveAll(1.5)).rejects.toThrow(/receive limit/i);
  });

  it("sends a token amount through the signer", async () => {
    const { node, address, account, funder } = harness();
    node.fund(address, ZNN_ZTS, "100");

    const receipt = await account.send(funder, ZNN_ZTS, "40");

    expect(receipt.blockHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await node.getBalances(address)).toEqual([
      { tokenStandard: ZNN_ZTS, symbol: "ZNN", decimals: 8, balance: "60" }
    ]);
    expect(await node.listUnreceived(funder)).toHaveLength(1);
  });

  it("rejects a malformed send amount", async () => {
    const { account, funder } = harness();
    await expect(account.send(funder, ZNN_ZTS, "0")).rejects.toThrow(/amount/i);
    await expect(account.send(funder, ZNN_ZTS, "-1")).rejects.toThrow(/amount/i);
  });

  it("rejects a send to a non-Zenon address or an unknown token standard", async () => {
    const { account, funder } = harness();
    await expect(account.send("not-an-address", ZNN_ZTS, "1"))
      .rejects.toThrow(/address/i);
    await expect(account.send(funder, "not-a-zts", "1"))
      .rejects.toThrow(/token standard/i);
  });
});
