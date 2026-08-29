import { describe, expect, it } from "vitest";

import type { ZwapState } from "../api/zwap-api.js";
import { renderDashboard, renderWalletSummary } from "./dashboard.js";

const ZNN_ZTS = "zts1znnxxxxxxxxxxxxx9z4ulx";
const QSR_ZTS = "zts1qsrxxxxxxxxxxxxxmrhjll";
const ADDRESS = "z1qzal6c5s9rjnnxd2z7dvdhjxpmmj4fmw56a0mz";

function state(overrides: Partial<ZwapState> = {}): ZwapState {
  return {
    address: ADDRESS,
    network: "zenon-mainnet",
    chainId: 1,
    balances: [
      { tokenStandard: ZNN_ZTS, symbol: "ZNN", decimals: 8, balance: "1200000000" },
      { tokenStandard: QSR_ZTS, symbol: "QSR", decimals: 8, balance: "50000000000" }
    ],
    unreceived: 0,
    plasma: { currentPlasma: 21000, maxPlasma: 21000, qsrFused: "50000000000" },
    powRequired: false,
    plasmaBotAvailable: true,
    ...overrides
  };
}

describe("wallet summary strip", () => {
  it("renders the truncated address and every held balance", () => {
    const root = document.createElement("section");

    renderWalletSummary(root, state());

    expect(root.getAttribute("aria-live")).toBe("polite");
    expect(root.querySelector("[data-wallet-address]")?.textContent).toBe("z1qzal…a0mz");
    expect(root.querySelector("[data-wallet-address]")?.getAttribute("title")).toBe(ADDRESS);
    expect(root.querySelectorAll("[data-balance-token]")).toHaveLength(2);
    expect(root.querySelector(`[data-balance-token="${ZNN_ZTS}"]`)?.textContent)
      .toContain("12.00000000");
    expect(root.querySelector(`[data-balance-token="${QSR_ZTS}"]`)?.textContent)
      .toContain("500.00000000");
  });

  it("says there is no wallet rather than inventing a zero balance", () => {
    const root = document.createElement("section");

    renderWalletSummary(root, state({ address: null, balances: [], plasma: null }));

    expect(root.querySelectorAll("[data-balance-token]")).toHaveLength(0);
    expect(root.textContent).toContain("No wallet in this browser profile yet");
  });

  it("says the address is empty rather than hiding it", () => {
    const root = document.createElement("section");

    renderWalletSummary(root, state({ balances: [] }));

    expect(root.querySelector("[data-wallet-address]")?.textContent).toBe("z1qzal…a0mz");
    expect(root.textContent).toContain("No balances yet");
  });
});

describe("wallet dashboard", () => {
  it("renders network, chain, plasma and unreceived blocks as exact data", () => {
    const root = document.createElement("section");

    renderDashboard(root, state({ unreceived: 2 }));

    expect(root.getAttribute("aria-live")).toBe("polite");
    expect(root.querySelector('[data-wallet-stat="network"]')?.textContent)
      .toContain("zenon-mainnet");
    expect(root.querySelector('[data-wallet-stat="chain"]')?.textContent).toContain("1");
    expect(root.querySelector('[data-wallet-stat="plasma"]')?.textContent)
      .toContain("21,000");
    expect(root.querySelector('[data-wallet-stat="unreceived"]')?.textContent)
      .toContain("2");
  });

  it("renders one balance card per held token at full precision", () => {
    const root = document.createElement("section");

    renderDashboard(root, state());

    const cards = [...root.querySelectorAll<HTMLElement>("[data-balance-token]")];
    expect(cards.map((card) => card.dataset.balanceToken)).toEqual([ZNN_ZTS, QSR_ZTS]);
    expect(cards[0]?.textContent).toContain("12.00000000");
    expect(cards[0]?.querySelector(".font-mono")).not.toBeNull();
    expect(cards[0]?.getAttribute("title")).toBe(ZNN_ZTS);
  });

  it("reports proof-of-work sends as a warning, never an error", () => {
    const root = document.createElement("section");

    renderDashboard(root, state({ powRequired: true }));

    const badge = root.querySelector<HTMLElement>("[data-wallet-pow]");
    expect(badge?.className).toContain("nom-badge--warning");
    expect(badge?.className).not.toContain("destructive");
    expect(badge?.textContent).toContain("Proof of work");
  });

  it("renders an honest empty state without a wallet", () => {
    const root = document.createElement("section");

    renderDashboard(root, state({ address: null, balances: [], plasma: null }));

    expect(root.textContent).toContain("No wallet in this browser profile yet");
    expect(root.querySelectorAll("[data-balance-token]")).toHaveLength(0);
  });

  it("carries no emoji", () => {
    const root = document.createElement("section");

    renderDashboard(root, state({ powRequired: true }));

    expect(root.textContent ?? "").not.toMatch(/\p{Extended_Pictographic}/u);
  });
});
