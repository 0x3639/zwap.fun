import type { ZwapState } from "../api/zwap-api.js";
import { renderTokenAmount, truncateAddress } from "./format.js";
import { icon } from "./icons.js";

const NO_WALLET = "No wallet in this browser profile yet.";

function element<K extends keyof HTMLElementTagNameMap>(
  name: K,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(name);
  if (text !== undefined) node.textContent = text;
  return node;
}

function note(text: string): HTMLParagraphElement {
  const node = element("p", text);
  node.className = "wallet-note";
  return node;
}

function addressLine(address: string): HTMLElement {
  const wrapper = element("div");
  wrapper.className = "nom-address wallet-summary__address";
  const eyebrow = element("span", "Address");
  eyebrow.className = "text-ledger";
  const value = element("span", truncateAddress(address));
  value.className = "font-mono";
  value.dataset.walletAddress = "true";
  value.title = address;
  wrapper.append(eyebrow, value);
  return wrapper;
}

/** The compact strip above the order book: who you are and what you hold. */
export function renderWalletSummary(root: HTMLElement, state: ZwapState): void {
  root.replaceChildren();
  root.className = "wallet-summary";
  root.setAttribute("aria-live", "polite");

  if (state.address === null) {
    root.append(note(`${NO_WALLET} Create or import one in the Account panel.`));
    return;
  }

  root.append(addressLine(state.address));

  if (state.balances.length === 0) {
    root.append(note("No balances yet on this address."));
    return;
  }

  const balances = element("div");
  balances.className = "wallet-summary__balances";
  for (const balance of state.balances) {
    const cell = element("article");
    cell.className = "wallet-summary__balance";
    cell.dataset.balanceToken = balance.tokenStandard;
    cell.title = balance.tokenStandard;
    const label = element("span", balance.symbol);
    label.className = "text-ledger";
    cell.append(label, renderTokenAmount(balance.balance, balance.decimals, balance.symbol));
    balances.append(cell);
  }
  root.append(balances);
}

function stat(name: string, label: string, value: string): HTMLElement {
  const cell = element("div");
  cell.className = "wallet-stat";
  cell.dataset.walletStat = name;
  const caption = element("span", label);
  caption.className = "text-ledger";
  const figure = element("strong", value);
  figure.className = "font-mono tabular-nums";
  cell.append(caption, figure);
  return cell;
}

/** The full ledger panel: chain context, plasma, and every held balance. */
export function renderDashboard(root: HTMLElement, state: ZwapState): void {
  root.replaceChildren();
  root.setAttribute("aria-live", "polite");

  if (state.address === null) {
    const empty = element("div");
    empty.className = "empty-state nom-card";
    empty.append(element("h3", NO_WALLET));
    empty.append(element(
      "p",
      "Create a wallet or import a seed in the Account panel to see balances and plasma."
    ));
    root.append(empty);
    return;
  }

  const stats = element("div");
  stats.className = "wallet-stats nom-card";
  stats.append(
    stat("network", "Network", state.network),
    stat("chain", "Chain", String(state.chainId)),
    stat(
      "plasma",
      "Plasma",
      state.plasma === null
        ? "unknown"
        : `${state.plasma.currentPlasma.toLocaleString("en-US")}` +
          ` / ${state.plasma.maxPlasma.toLocaleString("en-US")}`
    ),
    stat("unreceived", "Unreceived", state.unreceived.toLocaleString("en-US"))
  );
  root.append(stats);

  if (state.powRequired) {
    const badge = element("span");
    badge.className = "nom-badge nom-badge--warning";
    badge.dataset.walletPow = "true";
    badge.append(icon("shield"), element("span", "Proof of work required to send"));
    root.append(badge);
  }

  if (state.balances.length === 0) {
    root.append(note("No balances yet on this address."));
    return;
  }

  const grid = element("div");
  grid.className = "balance-grid";
  for (const balance of state.balances) {
    const card = element("article");
    card.className = "balance-card nom-card";
    card.dataset.balanceToken = balance.tokenStandard;
    card.title = balance.tokenStandard;
    const symbol = element("span", balance.symbol);
    symbol.className = "text-ledger";
    const amount = renderTokenAmount(balance.balance, balance.decimals, balance.symbol);
    amount.classList.add("balance-card__amount");
    const zts = element("small", balance.tokenStandard);
    zts.className = "font-mono balance-card__zts";
    card.append(symbol, amount, zts);
    grid.append(card);
  }
  root.append(grid);
}
