import type {
  ExactMarket,
  OrderBook,
  OrderRecord
} from "../order/model.js";
import { beginButtonFeedback } from "./button-feedback.js";
import {
  formatHumanPrice,
  formatPriceDelta,
  renderTokenAmount,
  truncateHash
} from "./format.js";
import { icon } from "./icons.js";
import { defaultTokens, type TokenLookup } from "./tokens.js";

const COLLAPSED_ORDER_COUNT = 3;

export type OrderBookRenderState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; book: OrderBook };

export interface OrderBookRenderOptions {
  onTake?: (order: OrderRecord, fillBaseAmount: string, button: HTMLButtonElement) => void;
  onCancel?: (order: OrderRecord, button: HTMLButtonElement) => void;
  canCancel?: (order: OrderRecord) => boolean;
  /** Symbols and decimals observed on chain; falls back to ZNN/QSR. */
  tokens?: TokenLookup;
}

interface MarketView {
  market: ExactMarket;
  tokens: TokenLookup;
}

function element<K extends keyof HTMLElementTagNameMap>(
  name: K,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(name);
  if (text !== undefined) node.textContent = text;
  return node;
}

function quoteDecimals(view: MarketView): number {
  return view.tokens(view.market.quoteToken).decimals;
}

function priceLabel(view: MarketView): string {
  return `${view.tokens(view.market.quoteToken).symbol}/` +
    `${view.tokens(view.market.baseToken).symbol}`;
}

function priceCell(order: OrderRecord, view: MarketView): HTMLTableCellElement {
  const cell = element("td");
  const price = order.state.price;
  const displayed = element("data", formatHumanPrice(price, quoteDecimals(view)));
  displayed.className = "font-mono tabular-nums";
  displayed.dataset.price = "true";
  displayed.dataset.priceMinorUnits = price;
  displayed.setAttribute("value", price);
  displayed.title = `${formatHumanPrice(price, quoteDecimals(view))} ${priceLabel(view)}`;
  cell.append(displayed);
  return cell;
}

function infoLine(label: string, value: string, title?: string): HTMLElement {
  const line = element("p");
  const caption = element("span", label);
  caption.className = "text-ledger";
  const detail = element("strong", value);
  detail.className = "font-mono";
  if (title !== undefined) detail.title = title;
  line.append(caption, detail);
  return line;
}

function orderInfo(
  order: OrderRecord,
  onCancel?: (button: HTMLButtonElement) => void
): HTMLDetailsElement {
  const details = element("details");
  details.className = "order-info";
  details.dataset.orderInfo = "true";
  const summary = element("summary", "i");
  summary.setAttribute("aria-label", "Show order details");
  summary.title = "Show order details";
  const popup = element("div");
  popup.className = "order-info__popup nom-card";
  const expiry = new Date(order.state.expires_at * 1000).toISOString();
  const execution = order.state.execution === "all_or_none"
    ? "AON"
    : "Partial";
  popup.append(
    infoLine(
      "Execution",
      execution,
      order.state.execution === "all_or_none" ? "All or none (AON)" : "Partial fill"
    ),
    infoLine("Expires", expiry),
    infoLine("Chain", order.state.chain_id),
    infoLine("Order", truncateHash(order.state.order_id), order.state.order_id)
  );
  if (onCancel) {
    const cancel = element("button", "Cancel order");
    cancel.type = "button";
    cancel.className = "nom-btn nom-btn--sm nom-btn--outline order-info__cancel";
    cancel.dataset.cancelOrder = "true";
    cancel.addEventListener("click", () => onCancel(cancel));
    popup.append(cancel);
  }
  details.append(summary, popup);
  return details;
}

function validateTakeAmount(amount: HTMLInputElement, order: OrderRecord): void {
  amount.setCustomValidity("");
  if (!/^[1-9]\d*$/.test(amount.value)) {
    amount.setCustomValidity("Enter a positive whole-number amount.");
    return;
  }
  const fill = BigInt(amount.value);
  const remaining = BigInt(order.state.remaining_amount);
  const minimum = BigInt(order.state.minimum_fill_amount);
  if (fill > remaining) {
    amount.setCustomValidity("The fill cannot exceed the remaining amount.");
  } else if (
    order.state.execution === "all_or_none" &&
    fill !== remaining
  ) {
    amount.setCustomValidity("This all-or-none order requires the full remaining amount.");
  } else if (
    order.state.execution === "partial" &&
    fill < minimum
  ) {
    amount.setCustomValidity(`The minimum partial fill is ${minimum.toString()}.`);
  } else if (
    order.state.execution === "partial" &&
    remaining - fill > 0n &&
    remaining - fill < minimum
  ) {
    amount.setCustomValidity("This fill would leave less than the order minimum.");
  }
}

function orderRow(
  order: OrderRecord,
  view: MarketView,
  best: "ask" | "bid" | undefined,
  options: OrderBookRenderOptions
): HTMLTableRowElement {
  const base = view.tokens(view.market.baseToken);
  const row = element("tr");
  row.className = `order-row order-row--${order.state.side === "sell" ? "ask" : "bid"}`;
  row.dataset.orderId = order.state.order_id;
  const side = order.state.side === "sell" ? "Ask" : "Bid";
  row.setAttribute("aria-label", best ? `Best ${side.toLowerCase()}` : side);
  if (best !== undefined) row.dataset.best = best;
  row.append(priceCell(order, view));

  const remaining = element("td");
  const remainingAmount = renderTokenAmount(
    order.state.remaining_amount,
    base.decimals,
    base.symbol
  );
  remainingAmount.dataset.remaining = order.state.remaining_amount;
  remaining.append(remainingAmount);
  row.append(remaining);

  const action = element("td");
  action.className = "order-action";
  const controls = element("div");
  controls.className = "order-action__controls";
  const amount = element("input");
  amount.type = "text";
  amount.className = "nom-input";
  amount.dataset.numeric = "true";
  amount.inputMode = "numeric";
  amount.pattern = "[0-9]+";
  amount.value = order.state.remaining_amount;
  amount.dataset.takeAmount = "true";
  amount.title = `Base amount in ${base.symbol} minor units (10^${base.decimals} per ${base.symbol})`;
  amount.setAttribute(
    "aria-label",
    `Base amount to ${order.state.side === "sell" ? "buy" : "sell"} in ${base.symbol} minor units`
  );
  const take = element(
    "button",
    order.state.side === "sell" ? "Buy" : "Sell"
  );
  take.type = "button";
  take.className = "nom-btn nom-btn--sm nom-btn--outline";
  take.dataset.takeOrder = "true";
  take.setAttribute(
    "aria-label",
    `${order.state.side === "sell" ? "Buy from ask" : "Sell into bid"}`
  );
  take.disabled = !order.verified || options.onTake === undefined;
  if (options.onTake) take.addEventListener("click", () => {
    validateTakeAmount(amount, order);
    if (!amount.reportValidity()) return;
    beginButtonFeedback(take, "Settling…");
    options.onTake?.(order, amount.value, take);
  });
  controls.append(amount, take);
  controls.append(orderInfo(
    order,
    options.canCancel?.(order) && options.onCancel
      ? (cancel) => options.onCancel?.(order, cancel)
      : undefined
  ));
  action.append(controls);
  row.append(action);
  return row;
}

function summaryValue(
  name: string,
  order: OrderRecord | undefined,
  view: MarketView
): HTMLElement {
  const value = element("dd");
  value.className = "font-mono tabular-nums";
  value.dataset.summary = name;
  if (order === undefined) {
    value.textContent = "—";
    return value;
  }
  const price = order.state.price;
  value.textContent = `${formatHumanPrice(price, quoteDecimals(view))} ${priceLabel(view)}`;
  value.dataset.priceMinorUnits = price;
  return value;
}

function renderSummary(book: OrderBook, view: MarketView): HTMLElement {
  const summary = element("dl");
  summary.className = "orderbook-summary";

  const spreadValue = element("dd", "—");
  spreadValue.className = "font-mono tabular-nums";
  spreadValue.dataset.summary = "spread";
  if (book.topAsk && book.topBid) {
    const spread = BigInt(book.topAsk.state.price) - BigInt(book.topBid.state.price);
    spreadValue.textContent =
      `${formatPriceDelta(spread, quoteDecimals(view))} ${priceLabel(view)}`;
    spreadValue.dataset.spreadMinorUnits = spread.toString();
  }
  const entries: Array<[string, HTMLElement]> = [
    ["Best ask", summaryValue("best-ask", book.topAsk, view)],
    ["Spread", spreadValue],
    ["Best bid", summaryValue("best-bid", book.topBid, view)]
  ];
  for (const [label, value] of entries) {
    const item = element("div");
    const term = element("dt", label);
    term.className = "text-ledger";
    item.append(term, value);
    summary.append(item);
  }
  return summary;
}

function renderSideTable(
  label: "Asks" | "Bids",
  orders: OrderRecord[],
  best: OrderRecord | undefined,
  view: MarketView,
  options: OrderBookRenderOptions
): HTMLElement {
  const section = element("section");
  section.className = `orderbook-side orderbook-side--${label.toLowerCase()}`;
  const table = element("table");
  table.className = "orderbook-table";
  table.append(element("caption", label));
  const head = element("thead");
  const headers = element("tr");
  for (const headerLabel of [
    `Limit (${priceLabel(view)})`,
    "Left",
    "Trade"
  ]) {
    const header = element("th", headerLabel);
    header.className = "text-ledger";
    header.scope = "col";
    headers.append(header);
  }
  head.append(headers);
  table.append(head);

  const body = element("tbody");
  body.className = `orderbook-${label.toLowerCase()}`;
  body.setAttribute("aria-label", label);
  const overflowRows: HTMLTableRowElement[] = [];
  orders.forEach((order, index) => {
    const row = orderRow(
      order,
      view,
      order.address === best?.address ? label === "Asks" ? "ask" : "bid" : undefined,
      options
    );
    if (index >= COLLAPSED_ORDER_COUNT) {
      row.hidden = true;
      overflowRows.push(row);
    }
    body.append(row);
  });
  table.append(body);

  const scroller = element("div");
  scroller.className = "table-scroll";
  scroller.append(table);
  section.append(scroller);
  if (overflowRows.length > 0) {
    const footer = element("footer");
    footer.className = "orderbook-side__footer";
    const count = element(
      "small",
      `${COLLAPSED_ORDER_COUNT} / ${orders.length} shown`
    );
    count.className = "text-ledger";
    const toggle = element(
      "button",
      "See more"
    );
    toggle.type = "button";
    toggle.className = "nom-btn nom-btn--sm nom-btn--ghost orderbook-toggle";
    toggle.dataset.orderbookToggle = label.toLowerCase();
    toggle.setAttribute("aria-expanded", "false");
    toggle.addEventListener("click", () => {
      const expanded = toggle.getAttribute("aria-expanded") === "true";
      for (const row of overflowRows) row.hidden = expanded;
      toggle.setAttribute("aria-expanded", String(!expanded));
      toggle.textContent = expanded
        ? "See more"
        : "See less";
      count.textContent = expanded
        ? `${COLLAPSED_ORDER_COUNT} / ${orders.length} shown`
        : `${orders.length} / ${orders.length} shown`;
    });
    footer.append(count, toggle);
    section.append(footer);
  }
  return section;
}

function renderReady(
  root: HTMLElement,
  book: OrderBook,
  options: OrderBookRenderOptions
): void {
  const view: MarketView = { market: book.market, tokens: options.tokens ?? defaultTokens };
  if (book.asks.length === 0 && book.bids.length === 0) {
    const empty = element("div");
    empty.className = "empty-state nom-card";
    empty.append(element("h3", `No open ${priceLabel(view)} orders`));
    empty.append(element("p", "The book will update when verified makers publish orders."));
    root.append(empty);
    return;
  }

  const frame = element("div");
  frame.className = "orderbook-frame nom-card";
  const marketStrip = element("aside");
  marketStrip.className = "orderbook-market-strip";
  marketStrip.dataset.bookMidpoint = "true";
  marketStrip.setAttribute("aria-label", "Inside market");
  marketStrip.append(renderSummary(book, view));
  const columns = element("div");
  columns.className = "orderbook-columns";
  columns.append(
    renderSideTable("Asks", book.asks, book.topAsk, view, options),
    renderSideTable("Bids", book.bids, book.topBid, view, options)
  );
  frame.append(marketStrip, columns);
  root.append(frame);
}

export function renderOrderBook(
  root: HTMLElement,
  state: OrderBookRenderState,
  options: OrderBookRenderOptions = {}
): void {
  root.replaceChildren();
  root.setAttribute("aria-live", "polite");
  root.removeAttribute("role");
  root.setAttribute("aria-busy", state.status === "loading" ? "true" : "false");

  if (state.status === "loading") {
    const loading = element("p");
    loading.className = "orderbook-loading";
    const spinner = icon("refresh");
    spinner.classList.add("nom-spin");
    loading.append(spinner, element("span", "Loading order book…"));
    root.append(loading);
    return;
  }
  if (state.status === "error") {
    root.setAttribute("role", "alert");
    root.setAttribute("aria-live", "assertive");
    const failure = element("p", state.message);
    failure.className = "orderbook-error";
    root.append(failure);
    return;
  }
  renderReady(root, state.book, options);
}
