import { describe, expect, it } from "vitest";

import html from "../index.html?raw";
import type { ZwapState } from "./api/zwap-api.js";
import { renderAccountActions } from "./ui/account-actions.js";
import { renderDashboard, renderWalletSummary } from "./ui/dashboard.js";
import { renderOrderBook } from "./ui/orderbook.js";
import { renderTrades } from "./ui/trades.js";
import { applyTheme, mountThemeToggle } from "./ui/theme.js";
import { buildOrderBook } from "./order/model.js";
import { DEFAULT_ORDER_HOURS, orderFormToPublishInput } from "./ui/order-form.js";
import { tokenDirectory } from "./ui/tokens.js";
import { QSR_ZTS, ZNN_ZTS } from "./zenon/types.js";

const state: ZwapState = {
  wallet: "connected",
  providerName: "NoM Wallet",
  address: "z1qzal6c5s9rjnnxd2z7dvdhjxpmmj4fmw56a0mz",
  network: "zenon-mainnet",
  chainId: 1,
  balances: [{ tokenStandard: ZNN_ZTS, symbol: "ZNN", decimals: 8, balance: "1200000000" }],
  unreceived: 1,
  plasma: { currentPlasma: 21000, maxPlasma: 21000, qsrFused: "1" }
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
      "activity-log", "wallet-control", "refresh", "refresh-orderbook",
      "refresh-trades", "order-form", "reset-local-data",
      "reset-local-data-confirmation",
      "network-badge", "theme-toggle"
    ]) byId(id);

    const noop = (): void => undefined;
    renderWalletSummary(byId("wallet-summary"), state);
    renderDashboard(byId("dashboard"), state);
    renderAccountActions(byId("account-actions"), state, {
      onReceive: noop, onCopyAddress: noop
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
    // The amount field speaks whole ZNN, not minor units.
    const amount = form.querySelector<HTMLInputElement>('[name="amount"]');
    expect(amount?.value).toBe("20");
    expect(amount?.getAttribute("inputmode")).toBe("decimal");
    expect(form.querySelector("label")?.parentElement?.textContent)
      .not.toContain("minor units");
  });

  it("maps the shipped form defaults to the integers that get signed", () => {
    document.documentElement.innerHTML = html
      .replace(/^[\s\S]*?<html[^>]*>/, "")
      .replace(/<\/html>\s*$/, "");
    const form = document.getElementById("order-form") as HTMLFormElement;
    const value = (name: string): string =>
      form.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${name}"]`)?.value ?? "";

    const input = orderFormToPublishInput(
      {
        side: value("side"),
        amount: value("amount"),
        price: value("price"),
        hours: value("hours")
      },
      tokenDirectory(),
      1_700_000_000
    );

    expect(input).toEqual({
      side: "sell",
      amount: "2000000000",
      price: "1050000000",
      expiresAt: 1_700_000_000 + DEFAULT_ORDER_HOURS * 3600,
      execution: "all_or_none"
    });
  });

  it("boots the theme before the module bundle so dark mode never flashes", () => {
    const head = html.slice(0, html.indexOf("</head>"));
    expect(head).toContain('<script src="./boot.js"></script>');
    expect(head.indexOf("boot.js")).toBeLessThan(html.indexOf("/src/main.ts"));
  });
});
