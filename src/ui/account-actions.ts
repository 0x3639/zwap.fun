import type { ZwapState } from "../api/zwap-api.js";
import { renderTokenAmount, truncateAddress } from "./format.js";
import { icon } from "./icons.js";

export interface AccountActionHandlers {
  onReceive: (button: HTMLButtonElement) => void;
  onCopyAddress: (address: string, button: HTMLButtonElement) => void;
}

function element<K extends keyof HTMLElementTagNameMap>(
  name: K,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(name);
  if (text !== undefined) node.textContent = text;
  return node;
}

function eyebrow(text: string): HTMLParagraphElement {
  const node = element("p", text);
  node.className = "text-ledger account-panel__eyebrow";
  return node;
}

function button(label: string, glyph?: Parameters<typeof icon>[0]): HTMLButtonElement {
  const node = element("button");
  node.type = "button";
  node.className = "nom-btn nom-btn--sm nom-btn--outline";
  if (glyph !== undefined) node.append(icon(glyph));
  const text = element("span", label);
  text.dataset.buttonLabel = "true";
  node.append(text);
  return node;
}

function renderAddress(address: string, handlers: AccountActionHandlers): HTMLElement {
  const wrapper = element("div");
  wrapper.className = "nom-address account-panel__address";
  const value = element("span", truncateAddress(address));
  value.className = "font-mono";
  value.dataset.accountAddress = "true";
  value.title = address;
  const copy = element("button");
  copy.type = "button";
  copy.className = "nom-iconbtn";
  copy.dataset.accountCopy = "true";
  copy.setAttribute("aria-label", "Copy the full address");
  copy.title = "Copy the full address";
  copy.append(icon("copy"));
  copy.addEventListener("click", () => handlers.onCopyAddress(address, copy));
  wrapper.append(value, copy);
  return wrapper;
}

function renderBalances(state: ZwapState): HTMLElement {
  if (state.balances.length === 0) {
    const empty = element("p", "No balances on this address yet.");
    empty.className = "account-panel__note";
    return empty;
  }
  const list = element("ul");
  list.className = "account-panel__balances";
  for (const balance of state.balances) {
    const item = element("li");
    item.dataset.balanceToken = balance.tokenStandard;
    const symbol = element("span", balance.symbol);
    symbol.className = "text-ledger";
    symbol.title = balance.tokenStandard;
    item.append(symbol, renderTokenAmount(balance.balance, balance.decimals, balance.symbol));
    list.append(item);
  }
  return list;
}

function renderPlasma(state: ZwapState): HTMLElement {
  const node = element("p");
  node.className = "account-panel__note font-mono tabular-nums";
  node.dataset.accountPlasma = "true";
  node.textContent = state.plasma === null
    ? "Plasma unknown"
    : `Plasma ${state.plasma.currentPlasma.toLocaleString("en-US")}` +
      ` / ${state.plasma.maxPlasma.toLocaleString("en-US")}`;
  return node;
}

/**
 * The account card: the connected extension address, what it holds, and the
 * one action the page still drives by hand (receive). Plasma and proof of
 * work are the extension's business — it decides and confirms them itself.
 */
export function renderAccountActions(
  root: HTMLElement,
  state: ZwapState,
  handlers: AccountActionHandlers
): void {
  root.replaceChildren();
  root.classList.add("account-panel");
  root.setAttribute("aria-live", "polite");
  root.append(eyebrow("Account"));
  if (state.wallet !== "connected" || state.address === null) {
    const lede = element("p", "Connect your wallet to see balances and trade.");
    lede.className = "account-panel__lede";
    root.append(lede);
    return;
  }
  root.append(renderAddress(state.address, handlers));
  root.append(renderBalances(state));
  root.append(renderPlasma(state));
  const receive = button(`Receive ${state.unreceived.toLocaleString("en-US")} pending`, "receive");
  receive.dataset.accountReceive = "true";
  receive.disabled = state.unreceived === 0;
  receive.addEventListener("click", () => handlers.onReceive(receive));
  const row = element("div");
  row.className = "account-panel__row";
  row.append(receive);
  root.append(row);
}
