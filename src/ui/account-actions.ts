import type { ZwapState } from "../api/zwap-api.js";
import type { PlasmaTier } from "../zenon/plasma-bot.js";
import { renderTokenAmount, truncateAddress } from "./format.js";
import { icon } from "./icons.js";

export interface AccountActionHandlers {
  onCreate: (button: HTMLButtonElement) => void;
  onImport: (mnemonic: string, button: HTMLButtonElement) => void;
  onReceive: (button: HTMLButtonElement) => void;
  onFuse: (tier: PlasmaTier, button: HTMLButtonElement) => void;
  onReveal: (button: HTMLButtonElement) => void;
  onCopyAddress: (address: string, button: HTMLButtonElement) => void;
}

const PLASMA_TIERS: ReadonlyArray<{ tier: PlasmaTier; label: string }> = [
  { tier: "low", label: "Low · 10 QSR" },
  { tier: "medium", label: "Medium · 50 QSR" },
  { tier: "high", label: "High · 120 QSR" }
];

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

function button(
  label: string,
  variant: "primary" | "outline",
  glyph?: Parameters<typeof icon>[0]
): HTMLButtonElement {
  const node = element("button");
  node.type = "button";
  node.className = `nom-btn nom-btn--sm nom-btn--${variant}`;
  if (glyph !== undefined) node.append(icon(glyph));
  const text = element("span", label);
  text.dataset.buttonLabel = "true";
  node.append(text);
  return node;
}

function group(...children: HTMLElement[]): HTMLDivElement {
  const node = element("div");
  node.className = "account-panel__row";
  node.append(...children);
  return node;
}

function renderNoWallet(
  root: HTMLElement,
  handlers: AccountActionHandlers
): void {
  root.append(eyebrow("Account"));
  const lede = element(
    "p",
    "No wallet in this browser profile yet. A new seed is generated locally and never leaves this device."
  );
  lede.className = "account-panel__lede";
  root.append(lede);

  // The one plasma-filled action in this section: creating the wallet is the
  // only thing a visitor without one can meaningfully do.
  const create = button("Create wallet", "primary", "plus");
  create.dataset.accountCreate = "true";
  create.addEventListener("click", () => handlers.onCreate(create));
  root.append(group(create));

  const form = element("form");
  form.className = "account-panel__import";
  form.dataset.accountImport = "true";
  const label = element("label", "Import an existing seed");
  label.className = "text-ledger";
  label.htmlFor = "account-import-mnemonic";
  const input = element("textarea");
  input.id = "account-import-mnemonic";
  input.name = "mnemonic";
  input.rows = 2;
  input.className = "nom-input account-panel__mnemonic font-mono";
  input.placeholder = "twelve or twenty-four BIP39 words";
  input.required = true;
  const submit = button("Import", "outline");
  submit.type = "submit";
  form.append(label, input, submit);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    handlers.onImport(input.value.trim(), submit);
  });
  root.append(form);
}

function renderAddress(
  address: string,
  handlers: AccountActionHandlers
): HTMLElement {
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
  const list = element("ul");
  list.className = "account-panel__balances";
  if (state.balances.length === 0) {
    const empty = element("p", "No balances on this address yet.");
    empty.className = "account-panel__note";
    return empty;
  }
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

function renderWallet(
  root: HTMLElement,
  address: string,
  state: ZwapState,
  handlers: AccountActionHandlers
): void {
  root.append(eyebrow("Account"));
  root.append(renderAddress(address, handlers));
  root.append(renderBalances(state));
  root.append(renderPlasma(state));

  if (state.powRequired) {
    // Factual, not alarmist: warning, never the crimson destructive role.
    const warning = element("span");
    warning.className = "nom-badge nom-badge--warning";
    warning.dataset.accountPow = "true";
    warning.append(icon("shield"), element("span", "Proof of work required to send"));
    root.append(warning);
  }

  const receive = button(
    `Receive ${state.unreceived.toLocaleString("en-US")} pending`,
    "outline",
    "receive"
  );
  receive.dataset.accountReceive = "true";
  receive.disabled = state.unreceived === 0;
  receive.addEventListener("click", () => handlers.onReceive(receive));

  const reveal = button("Reveal seed", "outline", "key");
  reveal.dataset.accountReveal = "true";
  reveal.addEventListener("click", () => handlers.onReveal(reveal));

  const actions = group(receive);

  if (state.plasmaBotAvailable) {
    const select = element("select");
    select.className = "nom-input account-panel__tier";
    select.dataset.accountTier = "true";
    select.setAttribute("aria-label", "Plasma fusion tier");
    for (const option of PLASMA_TIERS) {
      const node = element("option", option.label);
      node.value = option.tier;
      select.append(node);
    }
    // Plasma is what unblocks feeless sending, so it holds the section's one
    // plasma-gradient action whenever the bot is reachable.
    const fuse = button("Fuse plasma", "primary", "zap");
    fuse.dataset.accountFuse = "true";
    fuse.addEventListener("click", () => {
      const tier = select.value;
      if (tier !== "low" && tier !== "medium" && tier !== "high") return;
      handlers.onFuse(tier, fuse);
    });
    actions.append(select, fuse);
  }

  actions.append(reveal);
  root.append(actions);
}

/**
 * The Zenon custody panel: one self-custodial address, what it holds, what it
 * can receive, and the two escape hatches (fuse, reveal). Exactly one action
 * per state carries the plasma gradient.
 */
export function renderAccountActions(
  root: HTMLElement,
  state: ZwapState,
  handlers: AccountActionHandlers
): void {
  root.replaceChildren();
  root.classList.add("account-panel");
  root.setAttribute("aria-live", "polite");
  if (state.address === null) {
    renderNoWallet(root, handlers);
    return;
  }
  renderWallet(root, state.address, state, handlers);
}
