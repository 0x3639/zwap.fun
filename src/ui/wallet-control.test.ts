import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ZwapState } from "../api/zwap-api.js";
import { INSTALL_URL, renderWalletControl, type WalletControlHandlers } from "./wallet-control.js";

const ADDRESS = "z1qrmm5cxzc8m0uwn2yz2lz4knwvdn0vkg9nnh7fns";

function state(overrides: Partial<ZwapState> = {}): ZwapState {
  return {
    wallet: "detected",
    providerName: "NoM Wallet",
    address: null,
    network: "zenon-mainnet",
    chainId: 1,
    balances: [],
    unreceived: 0,
    plasma: null,
    ...overrides
  };
}

function handlers(): WalletControlHandlers {
  return { onConnect: vi.fn(), onDisconnect: vi.fn(), onCopy: vi.fn() };
}

describe("renderWalletControl", () => {
  let root: HTMLElement;
  beforeEach(() => {
    document.body.replaceChildren();
    root = document.createElement("div");
    document.body.append(root);
  });

  it("offers the install link when no wallet announced itself", () => {
    renderWalletControl(root, state({ wallet: "absent", providerName: null }), handlers());
    const link = root.querySelector<HTMLAnchorElement>("a[data-wallet-install]");
    expect(link?.textContent).toContain("Install NoM Wallet");
    expect(link?.href).toBe(INSTALL_URL);
    expect(link?.target).toBe("_blank");
    expect(link?.rel).toContain("noopener");
  });

  it("offers connect when a wallet is detected and forwards the click", () => {
    const h = handlers();
    renderWalletControl(root, state(), h);
    const button = root.querySelector<HTMLButtonElement>("button[data-wallet-connect]");
    expect(button?.textContent).toContain("Connect wallet");
    expect(button?.title).toBe("NoM Wallet");
    button?.click();
    expect(h.onConnect).toHaveBeenCalledWith(button);
  });

  it("shows the truncated address as a menu button when connected", () => {
    renderWalletControl(root, state({ wallet: "connected", address: ADDRESS }), handlers());
    const pill = root.querySelector<HTMLButtonElement>("button[data-wallet-pill]");
    expect(pill?.textContent).toContain("z1qrmm…nh7fns");
    expect(pill?.title).toBe(ADDRESS);
    expect(pill?.getAttribute("aria-haspopup")).toBe("menu");
    expect(pill?.getAttribute("aria-expanded")).toBe("false");
    expect(root.querySelector<HTMLElement>("[role=menu]")?.hidden).toBe(true);
  });

  it("opens the menu with the truncated address, copy and disconnect", () => {
    const h = handlers();
    renderWalletControl(root, state({ wallet: "connected", address: ADDRESS }), h);
    root.querySelector<HTMLButtonElement>("button[data-wallet-pill]")?.click();
    const menu = root.querySelector<HTMLElement>("[role=menu]");
    expect(menu?.hidden).toBe(false);
    // Truncated so the popover stays narrow; the full string is the title, and
    // Copy address still hands over every character.
    expect(menu?.textContent).toContain("z1qrmm…nh7fns");
    expect(menu?.textContent).not.toContain(ADDRESS);
    expect(menu?.querySelector<HTMLElement>(".wallet-control__address")?.title).toBe(ADDRESS);

    menu?.querySelector<HTMLButtonElement>("button[data-wallet-copy]")?.click();
    expect(h.onCopy).toHaveBeenCalledWith(ADDRESS);
    expect(menu?.hidden).toBe(true);

    root.querySelector<HTMLButtonElement>("button[data-wallet-pill]")?.click();
    menu?.querySelector<HTMLButtonElement>("button[data-wallet-disconnect]")?.click();
    expect(h.onDisconnect).toHaveBeenCalled();
  });

  it("closes the menu on Escape and on an outside click", () => {
    renderWalletControl(root, state({ wallet: "connected", address: ADDRESS }), handlers());
    const pill = root.querySelector<HTMLButtonElement>("button[data-wallet-pill]")!;
    const menu = root.querySelector<HTMLElement>("[role=menu]")!;

    pill.click();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(menu.hidden).toBe(true);
    expect(pill.getAttribute("aria-expanded")).toBe("false");

    pill.click();
    document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(menu.hidden).toBe(true);
  });

  it("moves focus into the menu on open and back to the pill on Escape", () => {
    renderWalletControl(root, state({ wallet: "connected", address: ADDRESS }), handlers());
    const pill = root.querySelector<HTMLButtonElement>("button[data-wallet-pill]")!;

    pill.click();
    expect(document.activeElement)
      .toBe(root.querySelector("button[data-wallet-copy]"));

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(root.querySelector<HTMLElement>("[role=menu]")?.hidden).toBe(true);
    expect(document.activeElement).toBe(pill);
  });

  it("cleans itself up when the root leaves the DOM while the menu is open", () => {
    renderWalletControl(root, state({ wallet: "connected", address: ADDRESS }), handlers());
    root.querySelector<HTMLButtonElement>("button[data-wallet-pill]")!.click();
    const menu = root.querySelector<HTMLElement>("[role=menu]")!;
    expect(menu.hidden).toBe(false);

    root.remove();
    // The next document event finds the root detached and tears down.
    document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(menu.hidden).toBe(true);
  });

  it("keeps the menu open across a re-render with the same address", () => {
    const h = handlers();
    renderWalletControl(root, state({ wallet: "connected", address: ADDRESS }), h);
    root.querySelector<HTMLButtonElement>("button[data-wallet-pill]")?.click();
    renderWalletControl(root, state({ wallet: "connected", address: ADDRESS, unreceived: 2 }), h);
    expect(root.querySelector<HTMLElement>("[role=menu]")?.hidden).toBe(false);

    renderWalletControl(root, state(), h);
    expect(root.querySelector("[role=menu]")).toBeNull();
  });

  it("drives visibility from the hidden attribute, not a class, when opened and closed", () => {
    renderWalletControl(root, state({ wallet: "connected", address: ADDRESS }), handlers());
    const pill = root.querySelector<HTMLButtonElement>("button[data-wallet-pill]")!;
    const menu = root.querySelector<HTMLElement>("[role=menu]")!;

    expect(menu.hidden).toBe(true);
    expect(menu.hasAttribute("hidden")).toBe(true);

    pill.click();
    expect(menu.hidden).toBe(false);
    expect(menu.hasAttribute("hidden")).toBe(false);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(menu.hidden).toBe(true);
    expect(menu.hasAttribute("hidden")).toBe(true);
  });

  it("does not share open state between two roots with the same address", () => {
    const rootB = document.createElement("div");
    document.body.append(rootB);

    renderWalletControl(root, state({ wallet: "connected", address: ADDRESS }), handlers());
    root.querySelector<HTMLButtonElement>("button[data-wallet-pill]")?.click();
    expect(root.querySelector<HTMLElement>("[role=menu]")?.hidden).toBe(false);

    renderWalletControl(rootB, state({ wallet: "connected", address: ADDRESS }), handlers());
    expect(rootB.querySelector<HTMLElement>("[role=menu]")?.hidden).toBe(true);
  });
});
