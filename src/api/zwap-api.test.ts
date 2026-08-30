// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { loadConfig, type ZwapConfig } from "../config.js";
import { FakeZenonNode } from "../zenon/fake-node.js";
import {
  InjectedProviderError,
  PROVIDER_ERROR,
  type DetectedProvider,
  type ZenonProvider
} from "../zenon/injected-signer.js";
import { ZNN_ZTS } from "../zenon/types.js";
import { ZwapApi } from "./zwap-api.js";

const NOW = 1_800_000_000;

function config(overrides: Partial<ZwapConfig> = {}): ZwapConfig {
  return { ...loadConfig({}), ...overrides };
}

interface FakeProvider extends ZenonProvider {
  handlers: Map<string, Array<(payload: unknown) => void>>;
  emit(event: string, payload: unknown): void;
}

/** A provider that answers chainId/requestAccounts and forwards sends to the fake node. */
function fakeProvider(node: FakeZenonNode, address: string, chainId = 1): FakeProvider {
  const handlers = new Map<string, Array<(payload: unknown) => void>>();
  const signer = node.signer(address);
  return {
    handlers,
    emit(event, payload) {
      for (const handler of handlers.get(event) ?? []) handler(payload);
    },
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    async request({ method, params }) {
      switch (method) {
        case "zenon_chainId": return chainId;
        case "zenon_requestAccounts": return [address];
        case "zenon_sendBlock": {
          const [{ template }] = params as [{ template: Parameters<typeof signer.send>[0] }];
          const receipt = await signer.send(template);
          return { hash: receipt.blockHash };
        }
        default: throw new InjectedProviderError(PROVIDER_ERROR.unsupportedMethod, method);
      }
    }
  };
}

function detected(provider: ZenonProvider, name = "NoM Wallet"): DetectedProvider {
  return { info: { uuid: "u", name, icon: "data:,", rdns: "org.example" }, provider };
}

function harness(providerOverride?: DetectedProvider | null) {
  const node = new FakeZenonNode({ chainId: 1, now: () => NOW });
  const address = node.createAddress("wallet");
  const provider = fakeProvider(node, address);
  const api = new ZwapApi({
    node,
    config: config(),
    provider: providerOverride === undefined ? detected(provider) : providerOverride
  });
  return { node, address, provider, api, funder: node.createAddress("funder") };
}

describe("ZwapApi", () => {
  it("is absent with no provider and exposes no account", async () => {
    const { api } = harness(null);
    expect(api.status()).toBe("absent");
    expect(api.account()).toBeNull();
    expect(await api.getState()).toEqual({
      wallet: "absent",
      providerName: null,
      address: null,
      network: "zenon-mainnet",
      chainId: 1,
      balances: [],
      unreceived: 0,
      plasma: null
    });
  });

  it("is detected before connect and names the provider", async () => {
    const { api } = harness();
    expect(api.status()).toBe("detected");
    const state = await api.getState();
    expect(state.wallet).toBe("detected");
    expect(state.providerName).toBe("NoM Wallet");
    expect(state.address).toBeNull();
  });

  it("connects, reads balances, and receives pending blocks", async () => {
    const { api, node, address, funder } = harness();
    node.fund(funder, ZNN_ZTS, String(10n * 10n ** 8n));
    await node.signer(funder).send({ kind: "send", toAddress: address, tokenStandard: ZNN_ZTS, amount: String(10n ** 8n) });

    const connected = await api.connect();
    expect(connected.wallet).toBe("connected");
    expect(connected.address).toBe(address);
    expect(connected.unreceived).toBe(1);
    expect(api.account()?.address()).toBe(address);

    const received = await api.receivePending();
    expect(received.unreceived).toBe(0);
    expect(received.balances.find((b) => b.tokenStandard === ZNN_ZTS)?.balance).toBe(String(10n ** 8n));
  });

  it("maps a user rejection to the spec's message and stays detected", async () => {
    const { api, provider } = harness();
    provider.request = async () => {
      throw { code: 4001, message: "User rejected" };
    };
    await expect(api.connect()).rejects.toThrow("Wallet connection refused");
    expect(api.status()).toBe("detected");
    expect(api.account()).toBeNull();
  });

  it("maps a chain mismatch to the spec's message", async () => {
    const node = new FakeZenonNode({ chainId: 1, now: () => NOW });
    const address = node.createAddress("wallet");
    const api = new ZwapApi({ node, config: config(), provider: detected(fakeProvider(node, address, 73404)) });
    await expect(api.connect()).rejects.toThrow("Wallet is on chain 73404; zwap needs chain 1");
    expect(api.status()).toBe("detected");
  });

  it("prefixes other provider errors with Wallet:", async () => {
    const { api, provider } = harness();
    provider.request = async () => {
      throw { code: 4100, message: "Wallet is locked" };
    };
    await expect(api.connect()).rejects.toThrow("Wallet: Wallet is locked");
  });

  it("refuses to connect when absent", async () => {
    const { api } = harness(null);
    await expect(api.connect()).rejects.toThrow("No browser wallet is available");
  });

  it("refuses sends and receives while not connected", async () => {
    const { api, funder } = harness();
    await expect(api.receivePending()).rejects.toThrow("Connect your wallet before trading");
    await expect(api.send(funder, ZNN_ZTS, "1")).rejects.toThrow("Connect your wallet before trading");
  });

  it("disconnects back to detected and drops the account", async () => {
    const { api } = harness();
    await api.connect();
    api.disconnect();
    expect(api.status()).toBe("detected");
    expect(api.account()).toBeNull();
    expect((await api.getState()).address).toBeNull();
  });

  it("treats accountsChanged: [] as a disconnect and forwards other changes", async () => {
    const { api, provider, address } = harness();
    const seen = vi.fn();
    api.onAccountsChanged(seen);
    await api.connect();

    provider.emit("accountsChanged", []);
    expect(api.status()).toBe("detected");
    expect(seen).toHaveBeenCalledWith([]);

    await api.connect();
    provider.emit("accountsChanged", [address]);
    expect(seen).toHaveBeenLastCalledWith([address]);
  });

  it("shares one signer between account() and send()", async () => {
    const { api, node, address, funder } = harness();
    node.fund(address, ZNN_ZTS, "5");
    await api.connect();
    const receipt = await api.send(funder, ZNN_ZTS, "5");
    expect(receipt.blockHash).toMatch(/^[0-9a-f]{64}$/);
    // A fully drained balance drops out of the fake node's listing entirely
    // (it only reports positive balances), so "spent to zero" shows up here
    // as the token no longer appearing rather than as a zero-value entry.
    expect((await api.getState()).balances.find((b) => b.tokenStandard === ZNN_ZTS)).toBeUndefined();
  });
});
