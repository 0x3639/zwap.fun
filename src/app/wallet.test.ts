import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ZwapApi, ZwapState } from "../api/zwap-api.js";
import type { StatusSurface } from "./status.js";
import { createWalletSurface, type WalletSurfaceInput } from "./wallet.js";

const CONNECTED: ZwapState = {
  wallet: "connected",
  providerName: "NoM Wallet",
  address: "z1qzal6c5s9rjnnxd2z7dvdhjxpmmj4fmw56a0mz",
  network: "zenon-mainnet",
  chainId: 1,
  balances: [],
  unreceived: 0,
  plasma: null
};
const DETECTED: ZwapState = {
  ...CONNECTED,
  wallet: "detected",
  address: null
};

function element(id: string): HTMLElement {
  const node = document.createElement("div");
  node.id = id;
  document.body.append(node);
  return node;
}

describe("the wallet surface's gating and repaint edge-trigger", () => {
  let submit: HTMLButtonElement;
  let gated: HTMLButtonElement;
  let repaint: ReturnType<typeof vi.fn<(connected: boolean) => void>>;
  let state: ZwapState;
  let surface: ReturnType<typeof createWalletSurface>;

  beforeEach(() => {
    document.body.replaceChildren();
    const form = document.createElement("form");
    form.id = "order-form";
    submit = document.createElement("button");
    submit.type = "submit";
    form.append(submit);
    document.body.append(form);
    gated = document.createElement("button");
    gated.dataset.requiresWallet = "true";
    gated.title = "Refresh balances";
    document.body.append(gated);

    state = CONNECTED;
    repaint = vi.fn<(connected: boolean) => void>();
    const api = {
      getState: async () => state,
      connect: async () => state,
      disconnect: () => undefined,
      receivePending: async () => state,
      send: async () => ({ blockHash: "00".repeat(32) })
    } as unknown as ZwapApi;
    const input: WalletSurfaceInput = {
      elements: {
        dashboard: element("dashboard"),
        walletSummary: element("wallet-summary"),
        accountActions: element("account-actions"),
        walletControl: element("wallet-control"),
        refreshButton: document.createElement("button")
      },
      status: {
        blockedReason: () => undefined,
        report: vi.fn(),
        trace: vi.fn(),
        log: vi.fn()
      } as unknown as StatusSurface,
      config: { network: "zenon-mainnet", chainId: 1 } as WalletSurfaceInput["config"],
      detectedProvider: null,
      walletApi: () => api,
      locked: (action) => action(),
      setTokens: vi.fn(),
      resetTradeController: vi.fn(async () => undefined),
      clearTradeTraces: vi.fn(),
      repaintWalletDependentSurfaces: repaint
    };
    surface = createWalletSurface(input);
  });

  it("disables the signing surfaces while disconnected, with the connect hint", async () => {
    state = DETECTED;
    await surface.refresh();

    expect(submit.disabled).toBe(true);
    expect(submit.title).toBe("Connect your wallet first");
    expect(gated.disabled).toBe(true);
    expect(gated.title).toBe("Connect your wallet first");
  });

  it("restores the authored title when the wallet connects", async () => {
    state = DETECTED;
    await surface.refresh();
    state = CONNECTED;
    await surface.refresh();

    expect(gated.disabled).toBe(false);
    // Not clobbered to "": the button's own tooltip survives a gate cycle.
    expect(gated.title).toBe("Refresh balances");
    expect(submit.title).toBe("");
  });

  it("repaints the dependent surfaces only when connectedness flips", async () => {
    state = DETECTED;
    await surface.refresh();
    expect(repaint).not.toHaveBeenCalled();

    state = CONNECTED;
    await surface.refresh();
    expect(repaint).toHaveBeenCalledExactlyOnceWith(true);

    await surface.refresh();
    expect(repaint).toHaveBeenCalledTimes(1);

    state = DETECTED;
    await surface.refresh();
    expect(repaint).toHaveBeenLastCalledWith(false);
    expect(repaint).toHaveBeenCalledTimes(2);
  });
});
