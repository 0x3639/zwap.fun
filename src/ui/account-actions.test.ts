import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ZwapState } from "../api/zwap-api.js";
import { renderAccountActions, type AccountActionHandlers } from "./account-actions.js";
import { ZNN_ZTS } from "../zenon/types.js";

const ADDRESS = "z1qrmm5cxzc8m0uwn2yz2lz4knwvdn0vkg9nnh7fns";

function state(overrides: Partial<ZwapState> = {}): ZwapState {
  return {
    wallet: "connected", providerName: "NoM Wallet", address: ADDRESS,
    network: "zenon-mainnet", chainId: 1, balances: [], unreceived: 0, plasma: null,
    ...overrides
  };
}

function handlers(): AccountActionHandlers {
  return { onReceive: vi.fn(), onCopyAddress: vi.fn() };
}

describe("renderAccountActions", () => {
  let root: HTMLElement;
  beforeEach(() => { root = document.createElement("div"); });

  it("asks the visitor to connect while no wallet is connected", () => {
    renderAccountActions(root, state({ wallet: "detected", address: null }), handlers());
    expect(root.textContent).toContain("Connect your wallet to see balances and trade");
    expect(root.querySelector("[data-account-receive]")).toBeNull();
  });

  it("says the same when no wallet is installed", () => {
    renderAccountActions(root, state({ wallet: "absent", providerName: null, address: null }), handlers());
    expect(root.textContent).toContain("Connect your wallet to see balances and trade");
  });

  it("renders the address, balances, plasma and receive when connected", () => {
    const h = handlers();
    renderAccountActions(root, state({
      balances: [{ tokenStandard: ZNN_ZTS, symbol: "ZNN", decimals: 8, balance: "150000000" }],
      plasma: { currentPlasma: 252_000, maxPlasma: 252_000, qsrFused: "0" },
      unreceived: 2
    }), h);
    expect(root.querySelector("[data-account-address]")?.textContent).toBe("z1qrmm…7fns");
    expect(root.querySelector("[data-balance-token]")?.textContent).toContain("ZNN");
    expect(root.querySelector("[data-account-plasma]")?.textContent).toBe("Plasma 252,000 / 252,000");
    const receive = root.querySelector<HTMLButtonElement>("[data-account-receive]");
    expect(receive?.textContent).toContain("Receive 2 pending");
    expect(receive?.disabled).toBe(false);
    receive?.click();
    expect(h.onReceive).toHaveBeenCalledWith(receive);

    root.querySelector<HTMLButtonElement>("[data-account-copy]")?.click();
    expect(h.onCopyAddress).toHaveBeenCalledWith(ADDRESS, expect.any(HTMLButtonElement));
  });

  it("disables receive with nothing pending", () => {
    renderAccountActions(root, state(), handlers());
    expect(root.querySelector<HTMLButtonElement>("[data-account-receive]")?.disabled).toBe(true);
  });

  it("never renders keystore controls", () => {
    renderAccountActions(root, state(), handlers());
    for (const attr of ["account-create", "account-import", "account-reveal", "account-fuse", "account-connect", "account-extension"]) {
      expect(root.querySelector(`[data-${attr}]`)).toBeNull();
    }
  });
});
