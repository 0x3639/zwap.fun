import { describe, expect, it } from "vitest";

import html from "../index.html?raw";
import type { ZwapState } from "./api/zwap-api.js";
import { renderAccountActions } from "./ui/account-actions.js";
import { renderDashboard, renderWalletSummary } from "./ui/dashboard.js";
import { renderOrderBook } from "./ui/orderbook.js";
import { renderTrades } from "./ui/trades.js";
import { applyTheme, mountThemeToggle } from "./ui/theme.js";
import { buildOrderBook } from "./order/model.js";
import { QSR_ZTS, ZNN_ZTS } from "./zenon/types.js";

const state: ZwapState = {
  address: "z1qzal6c5s9rjnnxd2z7dvdhjxpmmj4fmw56a0mz",
  network: "zenon-mainnet",
  chainId: 1,
  balances: [{ tokenStandard: ZNN_ZTS, symbol: "ZNN", decimals: 8, balance: "1200000000" }],
  unreceived: 1,
  plasma: { currentPlasma: 21000, maxPlasma: 21000, qsrFused: "1" },
  powRequired: false,
  plasmaBotAvailable: true
};

describe("the deployed shell and the renderers agree", () => {
  it("paints every panel into the real markup", async () => {
    document.documentElement.innerHTML = html
      .replace(/^[\s\S]*?<html[^>]*>/, "")
      .replace(/<\/html>\s*$/, "");
    const byId = (id: string): HTMLElement => {
      const node = document.getElementById(id);
      if (!node) throw new Error(`Missing #${id}`);
      return node;
    };
    for (const id of [
      "dashboard", "wallet-summary", "account-actions", "orderbook",
      "pending-publications", "trades", "status", "order-settlement-hint",
      "activity-log", "profile-label", "refresh", "refresh-orderbook",
      "refresh-trades", "order-form", "backup", "clear-wallet", "reset-profile",
      "network-badge", "theme-toggle"
    ]) byId(id);

    const noop = (): void => undefined;
    renderWalletSummary(byId("wallet-summary"), state);
    renderDashboard(byId("dashboard"), state);
    renderAccountActions(byId("account-actions"), state, {
      onCreate: noop, onImport: noop, onReceive: noop,
      onFuse: noop, onReveal: noop, onCopyAddress: noop
    });
    renderTrades(byId("trades"), []);
    const book = await buildOrderBook([], { chainId: "1", baseToken: ZNN_ZTS, quoteToken: QSR_ZTS }, 1);
    renderOrderBook(byId("orderbook"), { status: "ready", book });

    applyTheme(document.documentElement);
    mountThemeToggle(byId("theme-toggle") as HTMLButtonElement, document.documentElement);
    const before = document.documentElement.classList.contains("dark");
    (byId("theme-toggle") as HTMLButtonElement).click();
    expect(document.documentElement.classList.contains("dark")).toBe(!before);

    expect(byId("wallet-summary").textContent).toContain("12.00000000");
    expect(byId("account-actions").textContent).toContain("Receive 1 pending");
    expect(byId("orderbook").textContent).toContain("No open QSR/ZNN orders");
    expect(document.body.textContent ?? "").not.toMatch(/\p{Extended_Pictographic}/u);

    const form = byId("order-form") as HTMLFormElement;
    expect(form.querySelector('[name="price"]')).not.toBeNull();
    expect(form.querySelector('[name="hours"]')?.getAttribute("min")).toBe("2");
    expect(form.querySelector('[name="amount"]')).not.toBeNull();
  });
});
