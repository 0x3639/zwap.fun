import { describe, expect, it, vi } from "vitest";

import type { ZwapState } from "../api/zwap-api.js";
import { renderAccountActions, type AccountActionHandlers } from "./account-actions.js";

const ZNN_ZTS = "zts1znnxxxxxxxxxxxxx9z4ulx";
const QSR_ZTS = "zts1qsrxxxxxxxxxxxxxmrhjll";
const ADDRESS = "z1qzal6c5s9rjnnxd2z7dvdhjxpmmj4fmw56a0mz";

function handlers(overrides: Partial<AccountActionHandlers> = {}): AccountActionHandlers {
  return {
    onCreate: vi.fn(),
    onImport: vi.fn(),
    onReceive: vi.fn(),
    onFuse: vi.fn(),
    onReveal: vi.fn(),
    onCopyAddress: vi.fn(),
    ...overrides
  };
}

function state(overrides: Partial<ZwapState> = {}): ZwapState {
  return {
    address: ADDRESS,
    network: "zenon-mainnet",
    chainId: 1,
    balances: [
      { tokenStandard: ZNN_ZTS, symbol: "ZNN", decimals: 8, balance: "1234500000" },
      { tokenStandard: QSR_ZTS, symbol: "QSR", decimals: 8, balance: "80000000000" }
    ],
    unreceived: 0,
    plasma: { currentPlasma: 21000, maxPlasma: 21000, qsrFused: "80000000000" },
    powRequired: false,
    plasmaBotAvailable: true,
    ...overrides
  };
}

describe("account panel without a wallet", () => {
  const empty = state({ address: null, balances: [], plasma: null });

  it("offers wallet creation as the single plasma-filled primary action", () => {
    const root = document.createElement("section");

    renderAccountActions(root, empty, handlers());

    const create = root.querySelector<HTMLButtonElement>("[data-account-create]");
    expect(create?.textContent).toContain("Create wallet");
    expect(create?.className).toContain("nom-btn");
    expect(create?.className).toContain("nom-btn--primary");
    expect(root.querySelectorAll(".nom-btn--primary")).toHaveLength(1);
  });

  it("offers a seed import form whose submit is an outline action", () => {
    const root = document.createElement("section");
    const onImport = vi.fn();

    renderAccountActions(root, empty, handlers({ onImport }));
    const form = root.querySelector<HTMLFormElement>("[data-account-import]");
    const input = form?.querySelector<HTMLTextAreaElement>("[name=mnemonic]");
    const submit = form?.querySelector<HTMLButtonElement>("button[type=submit]");
    expect(submit?.className).toContain("nom-btn--outline");
    expect(submit?.className).not.toContain("nom-btn--primary");

    input!.value = "  legal winner thank year wave sausage worth useful legal winner thank yellow  ";
    form?.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));

    expect(onImport).toHaveBeenCalledWith(
      "legal winner thank year wave sausage worth useful legal winner thank yellow",
      expect.any(HTMLButtonElement)
    );
  });

  it("shows no address, balances, plasma or seed reveal", () => {
    const root = document.createElement("section");

    renderAccountActions(root, empty, handlers());

    expect(root.querySelector("[data-account-address]")).toBeNull();
    expect(root.querySelector("[data-account-receive]")).toBeNull();
    expect(root.querySelector("[data-account-fuse]")).toBeNull();
    expect(root.querySelector("[data-account-reveal]")).toBeNull();
  });
});

describe("account panel with a wallet", () => {
  it("renders the address truncated and mono with the full value on hover", () => {
    const root = document.createElement("section");

    renderAccountActions(root, state(), handlers());

    const address = root.querySelector<HTMLElement>("[data-account-address]");
    expect(address?.textContent).toBe("z1qzal…a0mz");
    expect(address?.title).toBe(ADDRESS);
    expect(address?.className).toContain("font-mono");
  });

  it("copies the full address, never the truncation", () => {
    const root = document.createElement("section");
    const onCopyAddress = vi.fn();

    renderAccountActions(root, state(), handlers({ onCopyAddress }));
    root.querySelector<HTMLButtonElement>("[data-account-copy]")?.click();

    expect(onCopyAddress).toHaveBeenCalledWith(ADDRESS, expect.any(HTMLButtonElement));
  });

  it("lists every held balance at full token precision", () => {
    const root = document.createElement("section");

    renderAccountActions(root, state(), handlers());

    const rows = [...root.querySelectorAll<HTMLElement>("[data-balance-token]")];
    expect(rows.map((row) => row.dataset.balanceToken)).toEqual([ZNN_ZTS, QSR_ZTS]);
    expect(rows[0]?.textContent).toContain("12.34500000");
    expect(rows[0]?.textContent).toContain("ZNN");
    expect(rows[1]?.textContent).toContain("800.00000000");
  });

  it("says so honestly when the address holds nothing", () => {
    const root = document.createElement("section");

    renderAccountActions(root, state({ balances: [] }), handlers());

    expect(root.querySelectorAll("[data-balance-token]")).toHaveLength(0);
    expect(root.textContent).toContain("No balances on this address yet");
  });

  it("disables the receive action when nothing is pending", () => {
    const root = document.createElement("section");

    renderAccountActions(root, state({ unreceived: 0 }), handlers());

    const receive = root.querySelector<HTMLButtonElement>("[data-account-receive]");
    expect(receive?.disabled).toBe(true);
    expect(receive?.textContent).toContain("Receive 0 pending");
  });

  it("enables the receive action and counts the pending blocks", () => {
    const root = document.createElement("section");
    const onReceive = vi.fn();

    renderAccountActions(root, state({ unreceived: 3 }), handlers({ onReceive }));
    const receive = root.querySelector<HTMLButtonElement>("[data-account-receive]");
    expect(receive?.disabled).toBe(false);
    expect(receive?.textContent).toContain("Receive 3 pending");

    receive?.click();
    expect(onReceive).toHaveBeenCalledWith(expect.any(HTMLButtonElement));
  });

  it("fuses the selected plasma tier as the single primary action", () => {
    const root = document.createElement("section");
    const onFuse = vi.fn();

    renderAccountActions(root, state(), handlers({ onFuse }));
    const select = root.querySelector<HTMLSelectElement>("[data-account-tier]");
    const fuse = root.querySelector<HTMLButtonElement>("[data-account-fuse]");
    expect([...(select?.options ?? [])].map((option) => option.value))
      .toEqual(["low", "medium", "high"]);
    expect(fuse?.className).toContain("nom-btn--primary");
    expect(root.querySelectorAll(".nom-btn--primary")).toHaveLength(1);

    select!.value = "high";
    fuse?.click();
    expect(onFuse).toHaveBeenCalledWith("high", expect.any(HTMLButtonElement));
  });

  it("hides plasma fusing entirely when no plasma bot is configured", () => {
    const root = document.createElement("section");

    renderAccountActions(root, state({ plasmaBotAvailable: false }), handlers());

    expect(root.querySelector("[data-account-fuse]")).toBeNull();
    expect(root.querySelector("[data-account-tier]")).toBeNull();
    expect(root.querySelectorAll(".nom-btn--primary")).toHaveLength(0);
  });

  it("reports the plasma the address actually has", () => {
    const root = document.createElement("section");

    renderAccountActions(
      root,
      state({ plasma: { currentPlasma: 4200, maxPlasma: 21000, qsrFused: "1000000000" } }),
      handlers()
    );

    const plasma = root.querySelector<HTMLElement>("[data-account-plasma]");
    expect(plasma?.textContent).toContain("4,200");
    expect(plasma?.textContent).toContain("21,000");
  });

  it("warns that sends need proof of work while plasma is missing", () => {
    const root = document.createElement("section");

    renderAccountActions(root, state({ powRequired: true }), handlers());

    const warning = root.querySelector<HTMLElement>("[data-account-pow]");
    expect(warning?.textContent).toContain("Proof of work");
    expect(warning?.className).toContain("nom-badge--warning");
  });

  it("stays quiet about proof of work when plasma covers sends", () => {
    const root = document.createElement("section");

    renderAccountActions(root, state({ powRequired: false }), handlers());

    expect(root.querySelector("[data-account-pow]")).toBeNull();
  });

  it("offers an outline seed reveal", () => {
    const root = document.createElement("section");
    const onReveal = vi.fn();

    renderAccountActions(root, state(), handlers({ onReveal }));
    const reveal = root.querySelector<HTMLButtonElement>("[data-account-reveal]");
    expect(reveal?.textContent).toContain("Reveal seed");
    expect(reveal?.className).toContain("nom-btn--outline");

    reveal?.click();
    expect(onReveal).toHaveBeenCalledWith(expect.any(HTMLButtonElement));
  });

  it("repaints from scratch rather than appending a second panel", () => {
    const root = document.createElement("section");

    renderAccountActions(root, state(), handlers());
    renderAccountActions(root, state(), handlers());

    expect(root.querySelectorAll("[data-account-address]")).toHaveLength(1);
  });

  it("carries no emoji", () => {
    const root = document.createElement("section");

    renderAccountActions(root, state({ powRequired: true, unreceived: 2 }), handlers());

    expect(root.textContent ?? "").not.toMatch(/\p{Extended_Pictographic}/u);
  });
});
