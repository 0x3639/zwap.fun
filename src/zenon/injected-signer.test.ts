import { afterEach, describe, expect, it, vi } from "vitest";

import {
  detectInjectedProvider,
  InjectedProviderError,
  InjectedZenonSigner,
  PROVIDER_ANNOUNCE_EVENT,
  PROVIDER_REQUEST_EVENT,
  type ZenonProvider,
  type ZenonProviderInfo
} from "./injected-signer.js";
import { ZNN_ZTS } from "./types.js";

const ADDRESS = "z1qzal6c5s9rjnnxd2z7dvdhjxpmmj4fmw56a0mz";
const OTHER = "z1qr4pexnnfaexqqz8nscjjcsajy5hdqfkgadvwx";
const HASH = "ab".repeat(32);

const INFO: ZenonProviderInfo = {
  uuid: "5a1b2c3d-0000-4000-8000-000000000001",
  name: "Syrius Extension",
  icon: "data:image/svg+xml;base64,PHN2Zy8+",
  rdns: "network.zenon.syrius"
};

type Responder = (method: string, params?: unknown[]) => unknown;

interface FakeProvider extends ZenonProvider {
  calls: Array<{ method: string; params?: unknown[] }>;
  emit(event: string, payload: unknown): void;
}

function fakeProvider(respond: Responder, options: { withEvents?: boolean } = {}): FakeProvider {
  const calls: Array<{ method: string; params?: unknown[] }> = [];
  const listeners = new Map<string, Array<(payload: unknown) => void>>();
  const provider: FakeProvider = {
    calls,
    async request(args) {
      calls.push(args.params === undefined
        ? { method: args.method }
        : { method: args.method, params: args.params });
      return respond(args.method, args.params);
    },
    emit(event, payload) {
      for (const handler of listeners.get(event) ?? []) handler(payload);
    }
  };
  if (options.withEvents !== false) {
    provider.on = (event, handler) => {
      const bucket = listeners.get(event) ?? [];
      bucket.push(handler);
      listeners.set(event, bucket);
    };
    provider.removeListener = (event, handler) => {
      listeners.set(event, (listeners.get(event) ?? []).filter((one) => one !== handler));
    };
  }
  return provider;
}

/** A wallet that answers everything the happy path needs. */
function walletProvider(overrides: Partial<Record<string, unknown>> = {}): FakeProvider {
  return fakeProvider((method) => {
    if (method in overrides) return overrides[method];
    switch (method) {
      case "zenon_chainId": return 1;
      case "zenon_requestAccounts": return [ADDRESS];
      case "zenon_accounts": return [ADDRESS];
      case "zenon_sendBlock": return { hash: HASH };
      default: throw new Error(`unexpected method ${method}`);
    }
  });
}

type TestWindow = Window & { zenon?: ZenonProvider };

const cleanups: Array<() => void> = [];

function announceOnRequest(win: TestWindow, detail: unknown, delayMs = 0): void {
  const onRequest = (): void => {
    const dispatch = (): void => {
      win.dispatchEvent(new CustomEvent(PROVIDER_ANNOUNCE_EVENT, { detail }));
    };
    if (delayMs === 0) dispatch();
    else setTimeout(dispatch, delayMs);
  };
  win.addEventListener(PROVIDER_REQUEST_EVENT, onRequest);
  cleanups.push(() => win.removeEventListener(PROVIDER_REQUEST_EVENT, onRequest));
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  delete (window as TestWindow).zenon;
});

describe("detectInjectedProvider", () => {
  it("resolves the provider a wallet announces in answer to the request event", async () => {
    const win = window as TestWindow;
    const provider = walletProvider();
    announceOnRequest(win, { info: INFO, provider });

    const detected = await detectInjectedProvider(win, 50);

    expect(detected?.provider).toBe(provider);
    expect(detected?.info).toEqual(INFO);
  });

  it("accepts an announcement that lands after the request event", async () => {
    const win = window as TestWindow;
    const provider = walletProvider();
    announceOnRequest(win, { info: INFO, provider }, 5);

    const detected = await detectInjectedProvider(win, 200);

    expect(detected?.provider).toBe(provider);
  });

  it("keeps the provider but drops malformed announcement info", async () => {
    const win = window as TestWindow;
    const provider = walletProvider();
    announceOnRequest(win, { info: { name: "Nameless" }, provider });

    const detected = await detectInjectedProvider(win, 50);

    expect(detected?.provider).toBe(provider);
    expect(detected?.info).toBeNull();
  });

  it("falls back to window.zenon when nothing announces", async () => {
    const win = window as TestWindow;
    const provider = walletProvider();
    win.zenon = provider;

    const detected = await detectInjectedProvider(win, 50);

    expect(detected?.provider).toBe(provider);
    expect(detected?.info).toBeNull();
  });

  it("resolves null once the detection window closes with no wallet", async () => {
    const detected = await detectInjectedProvider(window as TestWindow, 10);

    expect(detected).toBeNull();
  });

  it("stops listening for announcements once it has settled", async () => {
    const win = window as TestWindow;
    const provider = walletProvider();
    announceOnRequest(win, { info: INFO, provider });
    const added = vi.spyOn(win, "addEventListener");
    const removed = vi.spyOn(win, "removeEventListener");
    cleanups.push(() => { added.mockRestore(); removed.mockRestore(); });

    await detectInjectedProvider(win, 50);

    expect(added).toHaveBeenCalledWith(PROVIDER_ANNOUNCE_EVENT, expect.any(Function));
    expect(removed).toHaveBeenCalledWith(PROVIDER_ANNOUNCE_EVENT, expect.any(Function));
  });
});

describe("InjectedZenonSigner.connect", () => {
  it("asks for the chain and the accounts, then holds the first address", async () => {
    const provider = walletProvider();

    const signer = await InjectedZenonSigner.connect(provider, 1);

    expect(signer.address()).toBe(ADDRESS);
    expect(provider.calls.map((call) => call.method))
      .toEqual(["zenon_chainId", "zenon_requestAccounts"]);
  });

  it("refuses a wallet on another chain with 4901 and never asks for accounts", async () => {
    const provider = walletProvider({ zenon_chainId: 73_404 });

    const error = await InjectedZenonSigner.connect(provider, 1).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(InjectedProviderError);
    expect((error as InjectedProviderError).code).toBe(4901);
    expect(provider.calls.map((call) => call.method)).toEqual(["zenon_chainId"]);
  });

  it("refuses an empty account list with 4100", async () => {
    const error = await InjectedZenonSigner
      .connect(walletProvider({ zenon_requestAccounts: [] }), 1)
      .catch((e: unknown) => e);

    expect((error as InjectedProviderError).code).toBe(4100);
  });

  it("refuses an account that is not a canonical Zenon address with 4100", async () => {
    const error = await InjectedZenonSigner
      .connect(walletProvider({ zenon_requestAccounts: ["0xdeadbeef"] }), 1)
      .catch((e: unknown) => e);

    expect((error as InjectedProviderError).code).toBe(4100);
  });

  it("passes a rejected connection through with the wallet's own error code", async () => {
    const provider = fakeProvider((method) => {
      if (method === "zenon_chainId") return 1;
      throw { code: 4001, message: "User rejected the request" };
    });

    const error = await InjectedZenonSigner.connect(provider, 1).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(InjectedProviderError);
    expect((error as InjectedProviderError).code).toBe(4001);
    expect((error as InjectedProviderError).message).toContain("User rejected");
  });
});

describe("InjectedZenonSigner.send", () => {
  it("rechecks the wallet chain inside the serialized send and refuses a switched network", async () => {
    let chain: unknown = 1;
    const provider = walletProvider({});
    const originalRequest = provider.request.bind(provider);
    provider.request = async (args) => {
      if (args.method === "zenon_chainId") {
        provider.calls.push({ method: args.method });
        return chain;
      }
      return originalRequest(args);
    };
    const signer = await InjectedZenonSigner.connect(provider, 1);
    chain = 3;

    const error = await signer
      .send({ kind: "receive", fromBlockHash: "aa".repeat(32) })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(InjectedProviderError);
    expect((error as InjectedProviderError).code).toBe(4901);
    expect(provider.calls.filter(({ method }) => method === "zenon_sendBlock")).toHaveLength(0);
  });

  it("rechecks the active account inside the serialized send and refuses a switched account", async () => {
    const provider = walletProvider({ zenon_accounts: [OTHER] });
    const signer = await InjectedZenonSigner.connect(provider, 1);

    const error = await signer
      .send({ kind: "receive", fromBlockHash: "aa".repeat(32) })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(InjectedProviderError);
    expect((error as InjectedProviderError).code).toBe(4100);
    expect(provider.calls.filter(({ method }) => method === "zenon_sendBlock")).toHaveLength(0);
  });

  it("verifies chain and account before every zenon_sendBlock", async () => {
    const provider = walletProvider();
    const signer = await InjectedZenonSigner.connect(provider, 1);

    await signer.send({ kind: "receive", fromBlockHash: "aa".repeat(32) });

    const methods = provider.calls.map(({ method }) => method);
    const sendIndex = methods.lastIndexOf("zenon_sendBlock");
    expect(methods.slice(0, sendIndex)).toContain("zenon_accounts");
    expect(methods.slice(2, sendIndex)).toContain("zenon_chainId");
  });

  it("hands the template to zenon_sendBlock and returns the published hash", async () => {
    const provider = walletProvider();
    const signer = await InjectedZenonSigner.connect(provider, 1);

    const receipt = await signer.send({
      kind: "htlc_create",
      tokenStandard: ZNN_ZTS,
      amount: "100000000",
      hashLocked: OTHER,
      expirationTime: 1_700_000_000,
      hashType: 1,
      keyMaxSize: 32,
      hashLock: "cd".repeat(32)
    });

    expect(receipt.blockHash).toBe(HASH);
    const send = provider.calls.at(-1);
    expect(send?.method).toBe("zenon_sendBlock");
    expect(send?.params).toEqual([{ template: { kind: "htlc_create", tokenStandard: ZNN_ZTS, amount: "100000000", hashLocked: OTHER, expirationTime: 1_700_000_000, hashType: 1, keyMaxSize: 32, hashLock: "cd".repeat(32) } }]);
  });

  it("rethrows a wallet rejection as an InjectedProviderError carrying its code", async () => {
    const provider = fakeProvider((method) => {
      if (method === "zenon_chainId") return 1;
      if (method === "zenon_requestAccounts") return [ADDRESS];
      if (method === "zenon_accounts") return [ADDRESS];
      throw { code: 4001, message: "User rejected the block", data: { rpcCode: -32000 } };
    });
    const signer = await InjectedZenonSigner.connect(provider, 1);

    const error = await signer
      .send({ kind: "receive", fromBlockHash: "11".repeat(32) })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(InjectedProviderError);
    expect((error as InjectedProviderError).code).toBe(4001);
    expect((error as InjectedProviderError).data).toEqual({ rpcCode: -32000 });
  });

  it("treats a wallet answer without a block hash as an internal error", async () => {
    const provider = walletProvider({ zenon_sendBlock: { hash: "not-a-hash" } });
    const signer = await InjectedZenonSigner.connect(provider, 1);

    const error = await signer
      .send({ kind: "receive", fromBlockHash: "11".repeat(32) })
      .catch((e: unknown) => e);

    expect((error as InjectedProviderError).code).toBe(-32603);
  });

  it("serializes sends so two blocks never race the same account chain", async () => {
    const order: number[] = [];
    let counter = 0;
    const provider = fakeProvider(async (method) => {
      if (method === "zenon_chainId") return 1;
      if (method === "zenon_requestAccounts") return [ADDRESS];
      if (method === "zenon_accounts") return [ADDRESS];
      const id = counter++;
      order.push(id);
      await new Promise((resolve) => setTimeout(resolve, id === 0 ? 20 : 0));
      return { hash: `${id}`.padStart(64, "0") };
    });
    const signer = await InjectedZenonSigner.connect(provider, 1);

    const [first, second] = await Promise.all([
      signer.send({ kind: "receive", fromBlockHash: "aa".repeat(32) }),
      signer.send({ kind: "receive", fromBlockHash: "bb".repeat(32) })
    ]);

    expect(order).toEqual([0, 1]);
    expect(first.blockHash).toBe("0".repeat(64));
    expect(second.blockHash).toBe(`${"0".repeat(63)}1`);
  });

  it("keeps serializing after a failed send", async () => {
    let attempt = 0;
    const provider = fakeProvider((method) => {
      if (method === "zenon_chainId") return 1;
      if (method === "zenon_requestAccounts") return [ADDRESS];
      if (method === "zenon_accounts") return [ADDRESS];
      attempt += 1;
      if (attempt === 1) throw { code: 4001, message: "rejected" };
      return { hash: HASH };
    });
    const signer = await InjectedZenonSigner.connect(provider, 1);

    const failed = signer.send({ kind: "receive", fromBlockHash: "aa".repeat(32) });
    const after = signer.send({ kind: "receive", fromBlockHash: "bb".repeat(32) });

    await expect(failed).rejects.toBeInstanceOf(InjectedProviderError);
    await expect(after).resolves.toEqual({ blockHash: HASH });
  });
});

describe("InjectedZenonSigner.onAccountsChanged", () => {
  it("propagates the wallet's account switch", async () => {
    const provider = walletProvider();
    const signer = await InjectedZenonSigner.connect(provider, 1);
    const handler = vi.fn();

    signer.onAccountsChanged(handler);
    provider.emit("accountsChanged", [OTHER]);

    expect(handler).toHaveBeenCalledWith([OTHER]);
  });

  it("ignores a payload that is not a list of addresses", async () => {
    const provider = walletProvider();
    const signer = await InjectedZenonSigner.connect(provider, 1);
    const handler = vi.fn();

    signer.onAccountsChanged(handler);
    provider.emit("accountsChanged", "z1nope");

    expect(handler).not.toHaveBeenCalled();
  });

  it("stays silent on a provider that emits no events", async () => {
    const provider = fakeProvider((method) => {
      if (method === "zenon_chainId") return 1;
      return [ADDRESS];
    }, { withEvents: false });
    const signer = await InjectedZenonSigner.connect(provider, 1);

    expect(() => signer.onAccountsChanged(vi.fn())).not.toThrow();
  });
});
