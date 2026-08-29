import { describe, expect, it } from "vitest";
import { vi } from "vitest";

import {
  buildOrderBook,
  createOrderState,
  type ExactMarket,
  type OrderRecord
} from "../order/model.js";
import { QSR_ZTS, ZNN_ZTS } from "../zenon/types.js";
import { withButtonFeedback } from "./button-feedback.js";
import { renderOrderBook } from "./orderbook.js";

const market: ExactMarket = {
  chainId: "1",
  baseToken: ZNN_ZTS,
  quoteToken: QSR_ZTS
};
const askHigh = "11111111-1111-4111-8111-111111111111";
const bidLow = "22222222-2222-4222-8222-222222222222";
const askLow = "33333333-3333-4333-8333-333333333333";
const bidHigh = "44444444-4444-4444-8444-444444444444";

function record(
  orderId: string,
  side: "buy" | "sell",
  price: string,
  amount = "2000000000"
): OrderRecord {
  return {
    address: `30078:maker:${orderId}`,
    eventId: `${orderId}-head`,
    makerPubkey: `maker-${orderId}`,
    verified: true,
    state: createOrderState({
      orderId,
      createdAt: 1_700_000_000,
      expiresAt: 1_800_000_000,
      side,
      chainId: "1",
      baseToken: ZNN_ZTS,
      quoteToken: QSR_ZTS,
      amount,
      price
    })
  };
}

describe("order-book presentation", () => {
  it("renders a compact market strip above asks and bids and identifies the inside market", async () => {
    const book = await buildOrderBook([
      record(askHigh, "sell", "1200000000"),
      record(bidLow, "buy", "800000000"),
      record(askLow, "sell", "1050000000"),
      record(bidHigh, "buy", "950000000")
    ], market, 1_700_000_100);
    const root = document.createElement("section");

    renderOrderBook(root, { status: "ready", book });

    expect(root.getAttribute("aria-live")).toBe("polite");
    expect([...root.querySelectorAll("caption")].map((caption) => caption.textContent))
      .toEqual(["Asks", "Bids"]);
    expect(
      [...root.querySelectorAll<HTMLElement>("[data-order-id], [data-book-midpoint]")]
        .map((node) => node.dataset.orderId ?? "midpoint")
    ).toEqual(["midpoint", askLow, askHigh, bidHigh, bidLow]);

    expect(root.querySelector(`[data-order-id="${askLow}"]`)?.getAttribute("data-best"))
      .toBe("ask");
    expect(root.querySelector(`[data-order-id="${bidHigh}"]`)?.getAttribute("data-best"))
      .toBe("bid");
    expect(root.querySelector('[data-summary="best-ask"]')?.textContent)
      .toBe("10.5 QSR/ZNN");
    expect(root.querySelector('[data-summary="best-bid"]')?.textContent)
      .toBe("9.5 QSR/ZNN");
    expect(root.querySelector('[data-summary="spread"]')?.textContent)
      .toBe("1 QSR/ZNN");
    expect(root.querySelector('[data-summary="spread"]')?.getAttribute("data-spread-minor-units"))
      .toBe("100000000");
    expect(root.querySelector(`[data-order-id="${askLow}"] [data-price]`)
      ?.getAttribute("data-price-minor-units")).toBe("1050000000");
    expect(root.querySelectorAll("[data-order-info]")).toHaveLength(4);
    expect(root.querySelector(`[data-order-id="${askLow}"] [data-order-info]`)?.textContent)
      .toContain("AON");

    expect(root.querySelectorAll(".orderbook-side")).toHaveLength(2);
    expect(root.querySelector(`[data-order-id="${askLow}"]`)?.getAttribute("aria-label"))
      .toBe("Best ask");
    expect(root.querySelector(`[data-order-id="${bidHigh}"]`)?.getAttribute("aria-label"))
      .toBe("Best bid");
  });

  it("labels prices and remaining size in the market's own token symbols", async () => {
    const book = await buildOrderBook(
      [record(askLow, "sell", "350000000", "2000000000")],
      market,
      1_700_000_100
    );
    const root = document.createElement("section");

    renderOrderBook(root, { status: "ready", book });

    expect([...root.querySelectorAll("th")].map((header) => header.textContent))
      .toContain("Limit (QSR/ZNN)");
    const remaining = root.querySelector<HTMLElement>(
      `[data-order-id="${askLow}"] [data-remaining]`
    );
    expect(remaining?.textContent).toBe("20.00000000 ZNN");
    expect(remaining?.className).toContain("font-mono");
    expect(remaining?.querySelector(".dim")?.textContent).toBe("00000000");
    expect(root.querySelector(`[data-order-id="${askLow}"] [data-price]`)?.textContent)
      .toBe("3.5");
  });

  it("offers an explicit take action with the exact verified order record", async () => {
    const best = record(askLow, "sell", "500000000", "2000000000");
    const book = await buildOrderBook([best], market, 1_700_000_100);
    const root = document.createElement("section");
    // The real handler wraps the take in `withButtonFeedback`; mirror that so
    // this covers the actual busy-state contract rather than a stand-in.
    const take = vi.fn((
      _order: OrderRecord,
      _minor: string,
      button: HTMLButtonElement
    ) => {
      void withButtonFeedback(button, "Settling…", () => new Promise<void>(() => {}));
    });

    renderOrderBook(root, { status: "ready", book }, { onTake: take });
    const button = root.querySelector<HTMLButtonElement>(`[data-order-id="${askLow}"] [data-take-order]`);
    const amount = root.querySelector<HTMLInputElement>(
      `[data-order-id="${askLow}"] [data-take-amount]`
    );
    button?.click();

    expect(button?.textContent).toBe("Settling…");
    expect(button?.disabled).toBe(true);
    // The person reads and types ZNN; the callback receives minor units.
    expect(amount?.value).toBe("20");
    expect(amount?.inputMode).toBe("decimal");
    expect(take).toHaveBeenCalledWith(best, "2000000000", expect.any(HTMLButtonElement));
  });

  it("echoes the exact minor-unit figure the click will sign", async () => {
    const best = record(askLow, "sell", "500000000", "2000000000");
    const book = await buildOrderBook([best], market, 1_700_000_100);
    const root = document.createElement("section");

    renderOrderBook(root, { status: "ready", book }, { onTake: vi.fn() });
    const row = root.querySelector<HTMLElement>(`[data-order-id="${askLow}"]`)!;
    const amount = row.querySelector<HTMLInputElement>("[data-take-amount]")!;
    const echo = row.querySelector<HTMLElement>("[data-take-echo]")!;

    expect(echo.textContent).toBe("20 ZNN = 2,000,000,000 minor units");

    amount.value = "1.5";
    amount.dispatchEvent(new Event("input"));
    expect(echo.textContent).toBe("1.5 ZNN = 150,000,000 minor units");

    amount.value = "nonsense";
    amount.dispatchEvent(new Event("input"));
    expect(echo.textContent).toBe("—");
  });

  it("offers bid taking and exposes cancellation only for owned orders", async () => {
    const ask = record(askLow, "sell", "500000000", "2000000000");
    const bid = record(bidHigh, "buy", "500000000", "2000000000");
    const book = await buildOrderBook([ask, bid], market, 1_700_000_100);
    const root = document.createElement("section");
    const cancel = vi.fn();

    renderOrderBook(root, { status: "ready", book }, {
      onTake: vi.fn(),
      onCancel: cancel,
      canCancel: (order) => order.eventId === ask.eventId
    });

    const bidTake = root.querySelector<HTMLButtonElement>(
      `[data-order-id="${bidHigh}"] [data-take-order]`
    );
    expect(bidTake?.textContent).toBe("Sell");
    bidTake?.click();
    expect(root.querySelector(`[data-order-id="${bidHigh}"] [data-take-amount]`)
      ?.getAttribute("aria-label")).toMatch(/sell/i);
    const cancelButton = root.querySelector<HTMLButtonElement>(
      `[data-order-id="${askLow}"] [data-cancel-order]`
    );
    cancelButton?.click();
    expect(cancel).toHaveBeenCalledWith(ask, expect.any(HTMLButtonElement));
    expect(root.querySelector(`[data-order-id="${bidHigh}"] [data-cancel-order]`))
      .toBeNull();
  });

  it("shows the best three orders per side and toggles the rest", async () => {
    const orders = [
      record("11111111-1111-4111-8111-111111111111", "sell", "500000000"),
      record("22222222-2222-4222-8222-222222222222", "sell", "510000000"),
      record("33333333-3333-4333-8333-333333333333", "sell", "520000000"),
      record("44444444-4444-4444-8444-444444444444", "sell", "530000000"),
      record("55555555-5555-4555-8555-555555555555", "sell", "540000000")
    ];
    const book = await buildOrderBook(orders, market, 1_700_000_100);
    const root = document.createElement("section");

    renderOrderBook(root, { status: "ready", book });

    const rows = [...root.querySelectorAll<HTMLTableRowElement>(
      ".orderbook-asks [data-order-id]"
    )];
    const toggle = root.querySelector<HTMLButtonElement>(
      '[data-orderbook-toggle="asks"]'
    )!;
    expect(rows).toHaveLength(5);
    expect(rows.map((row) => row.hidden)).toEqual([false, false, false, true, true]);
    expect(toggle.textContent).toBe("See more");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    toggle.click();
    expect(rows.every((row) => !row.hidden)).toBe(true);
    expect(toggle.textContent).toBe("See less");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    toggle.click();
    expect(rows.map((row) => row.hidden)).toEqual([false, false, false, true, true]);
  });

  it("validates all-or-none and partial fills in minor units after converting", async () => {
    const allOrNone = record(askLow, "sell", "500000000", "2000000000");
    const partial = record(
      "77777777-7777-4777-8777-777777777777",
      "sell",
      "500000000",
      "10000000000"
    );
    partial.state.execution = "partial";
    partial.state.minimum_fill_amount = "1000000000";
    const book = await buildOrderBook([allOrNone, partial], market, 1_700_000_100);
    const root = document.createElement("section");
    const take = vi.fn();
    renderOrderBook(root, { status: "ready", book }, { onTake: take });

    const aonRow = root.querySelector<HTMLElement>(`[data-order-id="${askLow}"]`)!;
    const aonAmount = aonRow.querySelector<HTMLInputElement>("[data-take-amount]")!;
    aonAmount.value = "19";
    aonRow.querySelector<HTMLButtonElement>("[data-take-order]")!.click();
    expect(take).not.toHaveBeenCalled();
    expect(aonAmount.validationMessage).toMatch(/all-or-none/i);

    const partialRow = root.querySelector<HTMLElement>(
      '[data-order-id="77777777-7777-4777-8777-777777777777"]'
    )!;
    const partialAmount = partialRow.querySelector<HTMLInputElement>("[data-take-amount]")!;
    // The minimum is reported back in the units the field speaks.
    partialAmount.value = "9";
    partialRow.querySelector<HTMLButtonElement>("[data-take-order]")!.click();
    expect(take).not.toHaveBeenCalled();
    expect(partialAmount.validationMessage).toMatch(/minimum partial fill is 10\./i);

    partialAmount.value = "25";
    partialRow.querySelector<HTMLButtonElement>("[data-take-order]")!.click();
    expect(take).toHaveBeenCalledWith(partial, "2500000000", expect.any(HTMLButtonElement));
  });

  it("refuses a fill finer than the token rather than rounding it away", async () => {
    const partial = record(askLow, "sell", "500000000", "10000000000");
    partial.state.execution = "partial";
    partial.state.minimum_fill_amount = "1";
    const book = await buildOrderBook([partial], market, 1_700_000_100);
    const root = document.createElement("section");
    const take = vi.fn();
    renderOrderBook(root, { status: "ready", book }, { onTake: take });

    const row = root.querySelector<HTMLElement>(`[data-order-id="${askLow}"]`)!;
    const amount = row.querySelector<HTMLInputElement>("[data-take-amount]")!;
    amount.value = "1.123456789";
    row.querySelector<HTMLButtonElement>("[data-take-order]")!.click();

    expect(take).not.toHaveBeenCalled();
    expect(amount.validationMessage).toMatch(/fractional digits/i);
  });

  it("preserves integer prices above Number.MAX_SAFE_INTEGER", async () => {
    const book = await buildOrderBook([
      record("55555555-5555-4555-8555-555555555555", "sell", "9007199254740993"),
      record("66666666-6666-4666-8666-666666666666", "buy", "9007199254740992")
    ], market, 1_700_000_100);
    const root = document.createElement("section");

    renderOrderBook(root, { status: "ready", book });

    expect(root.querySelector('[data-summary="spread"]')?.getAttribute("data-spread-minor-units"))
      .toBe("1");
    expect(root.querySelector('[data-order-id="55555555-5555-4555-8555-555555555555"] [data-price]')
      ?.getAttribute("data-price-minor-units")).toBe("9007199254740993");
    expect(root.querySelector('[data-order-id="55555555-5555-4555-8555-555555555555"] [data-price]')
      ?.textContent).toBe("90,071,992.54740993");
  });

  it("renders a crossed book's negative spread rather than throwing", async () => {
    const book = await buildOrderBook([
      record(askLow, "sell", "900000000"),
      record(bidHigh, "buy", "1000000000")
    ], market, 1_700_000_100);
    const root = document.createElement("section");

    renderOrderBook(root, { status: "ready", book });

    expect(root.querySelector('[data-summary="spread"]')?.textContent)
      .toBe("−1 QSR/ZNN");
  });

  it("renders honest loading, error, and empty states", async () => {
    const root = document.createElement("section");

    renderOrderBook(root, { status: "loading" });
    expect(root.getAttribute("aria-busy")).toBe("true");
    expect(root.textContent).toContain("Loading order book");

    renderOrderBook(root, { status: "error", message: "Relay timed out" });
    expect(root.getAttribute("role")).toBe("alert");
    expect(root.textContent).toContain("Relay timed out");

    const book = await buildOrderBook([], market, 1_700_000_100);
    renderOrderBook(root, { status: "ready", book });
    expect(root.getAttribute("aria-busy")).toBe("false");
    expect(root.getAttribute("role")).toBeNull();
    expect(root.textContent).toContain("No open QSR/ZNN orders");
    expect(root.querySelector("table")).toBeNull();
  });

  it("carries no emoji", async () => {
    const book = await buildOrderBook([record(askLow, "sell", "500000000")], market, 1_700_000_100);
    const root = document.createElement("section");

    renderOrderBook(root, { status: "ready", book });

    expect(root.textContent ?? "").not.toMatch(/\p{Extended_Pictographic}/u);
  });
});
