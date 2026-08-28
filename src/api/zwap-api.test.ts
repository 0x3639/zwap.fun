// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { KeyPair } from "znn-typescript-sdk";

import { loadConfig, type ZwapConfig } from "../config.js";
import { MemoryStorageDriver } from "../storage/driver.js";
import { ZenonAccount } from "../zenon/account.js";
import { FakeZenonNode } from "../zenon/fake-node.js";
import { KeystoreRepository } from "../zenon/keystore-repository.js";
import { ZNN_ZTS } from "../zenon/types.js";
import { ZwapApi } from "./zwap-api.js";

const NOW = 1_800_000_000;
const ADDRESS = /^z1[02-9ac-hj-np-z]{38}$/;

function config(overrides: Partial<ZwapConfig> = {}): ZwapConfig {
  return { ...loadConfig({}), ...overrides };
}

function respond(status: number, body: unknown): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  })) as unknown as typeof fetch;
}

interface Harness {
  node: FakeZenonNode;
  keystore: KeystoreRepository;
  api: ZwapApi;
  funder: string;
}

/**
 * The browser wires `createAccount` to a `KeystoreSigner`, which needs the
 * PoW worker and a live node. Here the factory reads only the address off the
 * real key pair and signs through the fake node instead.
 */
function harness(overrides: Partial<ZwapConfig> = {}): Harness {
  const node = new FakeZenonNode({ chainId: 1, now: () => NOW });
  const keystore = new KeystoreRepository(new MemoryStorageDriver());
  const api = new ZwapApi({
    keystore,
    node,
    config: config(overrides),
    createAccount: (keyPair: KeyPair) => new ZenonAccount({
      node,
      signer: node.signer(keyPair.address.toString()),
      now: () => NOW
    })
  });
  return { node, keystore, api, funder: node.createAddress("funder") };
}

describe("ZwapApi", () => {
  it("reports an empty wallet before a keystore exists", async () => {
    const { api } = harness();

    expect(await api.getState()).toEqual({
      address: null,
      network: "zenon-mainnet",
      chainId: 1,
      balances: [],
      unreceived: 0,
      plasma: null,
      powRequired: false,
      plasmaBotAvailable: true
    });
    expect(api.account()).toBeNull();
  });

  it("creates a wallet with an address and no balances", async () => {
    const { api } = harness();

    const state = await api.createWallet();

    expect(state.address).toMatch(ADDRESS);
    expect(state.balances).toEqual([]);
    expect(state.unreceived).toBe(0);
    expect(state.plasma).toEqual({
      currentPlasma: 210_000,
      maxPlasma: 210_000,
      qsrFused: "10000000000"
    });
    expect(state.powRequired).toBe(false);
    expect(api.account()?.address()).toBe(state.address);
  });

  it("refuses to create a second wallet over an existing one", async () => {
    const { api } = harness();
    await api.createWallet();

    await expect(api.createWallet()).rejects.toThrow(/already exists/);
  });

  it("imports a wallet and reveals exactly the words it was given", async () => {
    const first = harness();
    const created = await first.api.createWallet();
    const mnemonic = await first.api.revealMnemonic("REVEAL SEED");

    const second = harness();
    const imported = await second.api.importWallet(mnemonic);

    expect(imported.address).toBe(created.address);
    expect(await second.api.revealMnemonic("REVEAL SEED")).toBe(mnemonic);
    await expect(second.api.revealMnemonic("nope")).rejects.toThrow(/REVEAL SEED/);
  });

  it("rejects a mnemonic that is not a valid seed phrase", async () => {
    const { api } = harness();

    await expect(api.importWallet("not a real seed phrase")).rejects
      .toThrow(/BIP-39/);
    expect((await api.getState()).address).toBeNull();
  });

  it("receives pending blocks into the balance", async () => {
    const { api, node, funder } = harness();
    const state = await api.createWallet();
    node.fund(funder, ZNN_ZTS, "5");
    await node.signer(funder).send({
      kind: "send",
      toAddress: state.address!,
      tokenStandard: ZNN_ZTS,
      amount: "5"
    });

    expect((await api.getState()).unreceived).toBe(1);

    const received = await api.receivePending();

    expect(received.unreceived).toBe(0);
    expect(received.balances).toEqual([
      { tokenStandard: ZNN_ZTS, symbol: "ZNN", decimals: 8, balance: "5" }
    ]);
  });

  it("sends a plain transfer through the account signer", async () => {
    const { api, node, funder } = harness();
    const state = await api.createWallet();
    node.fund(state.address!, ZNN_ZTS, "9");

    const receipt = await api.send(funder, ZNN_ZTS, "4");

    expect(receipt.blockHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await node.getBalances(state.address!)).toEqual([
      { tokenStandard: ZNN_ZTS, symbol: "ZNN", decimals: 8, balance: "5" }
    ]);
  });

  it("refuses wallet actions before a wallet exists", async () => {
    const { api, funder } = harness();

    await expect(api.receivePending()).rejects.toThrow(/no wallet/i);
    await expect(api.send(funder, ZNN_ZTS, "1")).rejects.toThrow(/no wallet/i);
  });

  it("reports the plasma bot as unavailable when the network has none", async () => {
    const { api } = harness({ plasmaBotUrl: null });
    await api.createWallet();

    expect((await api.getState()).plasmaBotAvailable).toBe(false);
    await expect(api.fusePlasma("low")).rejects
      .toThrow("Plasma bot is not configured for this network");
  });

  it("fuses plasma for the wallet address through the configured bot", async () => {
    const fetchImpl = respond(200, {
      success: true,
      txHash: "ab".repeat(32),
      amount: 20,
      tier: "low"
    });
    const node = new FakeZenonNode({ chainId: 1, now: () => NOW });
    const keystore = new KeystoreRepository(new MemoryStorageDriver());
    const api = new ZwapApi({
      keystore,
      node,
      config: config({ plasmaBotUrl: "https://plasma.example" }),
      createAccount: (keyPair: KeyPair) => new ZenonAccount({
        node,
        signer: node.signer(keyPair.address.toString())
      }),
      fetchImpl
    });
    const state = await api.createWallet();

    await expect(api.fusePlasma("low")).resolves
      .toEqual({ txHash: "ab".repeat(32), amount: 20, tier: "low" });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://plasma.example/api/agent/fuse",
      expect.objectContaining({
        body: JSON.stringify({ address: state.address, tier: "low" })
      })
    );
  });

  it("flags proof of work when the address has no plasma", async () => {
    const { api, node } = harness();
    const state = await api.createWallet();
    node.setPow(state.address!, true);

    expect((await api.getState()).powRequired).toBe(true);
  });

  it("clears the wallet only on the exact confirmation", async () => {
    const { api } = harness();
    await api.createWallet();

    await expect(api.clearWallet("nope")).rejects.toThrow(/DELETE WALLET/);
    expect((await api.getState()).address).not.toBeNull();

    await api.clearWallet("DELETE WALLET");

    expect(api.account()).toBeNull();
    expect((await api.getState()).address).toBeNull();
  });

  it("derives the page key pair exactly once for concurrent readers", async () => {
    const { api, keystore } = harness();
    await keystore.create();
    const load = vi.spyOn(keystore, "loadKeyPair");

    const [left, right] = await Promise.all([api.getState(), api.getState()]);

    expect(left.address).toBe(right.address);
    expect(load).toHaveBeenCalledTimes(1);
  });
});
