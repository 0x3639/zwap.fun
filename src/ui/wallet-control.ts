import type { ZwapState } from "../api/zwap-api.js";
import { truncateAddress } from "./format.js";
import { icon } from "./icons.js";

/** Where "Install NoM Wallet" sends a visitor. Update when the store listing exists. */
export const INSTALL_URL = "https://github.com/0x3639/nom-wallet";

export interface WalletControlHandlers {
  onConnect(button: HTMLButtonElement): void;
  onDisconnect(): void;
  onCopy(address: string): void;
}

function element<K extends keyof HTMLElementTagNameMap>(
  name: K,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(name);
  if (text !== undefined) node.textContent = text;
  return node;
}

function labelled(button: HTMLButtonElement, label: string): HTMLButtonElement {
  const text = element("span", label);
  text.dataset.buttonLabel = "true";
  button.append(text);
  return button;
}

/**
 * Popover open/closed is the one piece of state the render keeps between
 * paints, and only while the address it was opened for is still the one on
 * screen: a refresh that only changed balances must not slam the menu shut.
 */
let openFor: string | null = null;
let teardownGlobalListeners: (() => void) | undefined;

function closeMenu(root: HTMLElement): void {
  openFor = null;
  const menu = root.querySelector<HTMLElement>("[role=menu]");
  const pill = root.querySelector<HTMLButtonElement>("button[data-wallet-pill]");
  if (menu) menu.hidden = true;
  pill?.setAttribute("aria-expanded", "false");
  teardownGlobalListeners?.();
  teardownGlobalListeners = undefined;
}

function openMenu(root: HTMLElement, address: string): void {
  openFor = address;
  const menu = root.querySelector<HTMLElement>("[role=menu]");
  const pill = root.querySelector<HTMLButtonElement>("button[data-wallet-pill]");
  if (menu) menu.hidden = false;
  pill?.setAttribute("aria-expanded", "true");
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") closeMenu(root);
  };
  const onPointer = (event: Event): void => {
    if (!root.contains(event.target as Node)) closeMenu(root);
  };
  document.addEventListener("keydown", onKey);
  document.addEventListener("pointerdown", onPointer);
  teardownGlobalListeners = () => {
    document.removeEventListener("keydown", onKey);
    document.removeEventListener("pointerdown", onPointer);
  };
}

function renderAbsent(root: HTMLElement): void {
  const link = element("a");
  link.className = "nom-btn nom-btn--sm nom-btn--outline";
  link.dataset.walletInstall = "true";
  link.href = INSTALL_URL;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.append(icon("shield"), element("span", "Install NoM Wallet"));
  root.append(link);
}

function renderDetected(root: HTMLElement, state: ZwapState, handlers: WalletControlHandlers): void {
  const button = element("button");
  button.type = "button";
  button.className = "nom-btn nom-btn--sm nom-btn--primary";
  button.dataset.walletConnect = "true";
  button.title = state.providerName ?? "Browser extension";
  button.append(icon("shield"));
  labelled(button, "Connect wallet");
  button.addEventListener("click", () => handlers.onConnect(button));
  root.append(button);
}

function renderConnected(root: HTMLElement, address: string, handlers: WalletControlHandlers): void {
  const pill = element("button");
  pill.type = "button";
  pill.className = "nom-btn nom-btn--sm nom-btn--outline wallet-control__pill font-mono";
  pill.dataset.walletPill = "true";
  pill.setAttribute("aria-haspopup", "menu");
  pill.setAttribute("aria-expanded", "false");
  pill.title = address;
  pill.append(icon("shield"));
  labelled(pill, truncateAddress(address));

  const menu = element("div");
  menu.className = "wallet-control__menu nom-card";
  menu.setAttribute("role", "menu");
  menu.hidden = true;

  const full = element("p", address);
  full.className = "wallet-control__address font-mono";

  const copy = element("button");
  copy.type = "button";
  copy.className = "nom-btn nom-btn--sm nom-btn--ghost";
  copy.dataset.walletCopy = "true";
  copy.setAttribute("role", "menuitem");
  copy.append(icon("copy"));
  labelled(copy, "Copy address");
  copy.addEventListener("click", () => {
    closeMenu(root);
    handlers.onCopy(address);
  });

  const disconnect = element("button");
  disconnect.type = "button";
  disconnect.className = "nom-btn nom-btn--sm nom-btn--ghost";
  disconnect.dataset.walletDisconnect = "true";
  disconnect.setAttribute("role", "menuitem");
  labelled(disconnect, "Disconnect");
  disconnect.addEventListener("click", () => {
    closeMenu(root);
    handlers.onDisconnect();
  });

  menu.append(full, copy, disconnect);
  pill.addEventListener("click", () => {
    if (menu.hidden) openMenu(root, address); else closeMenu(root);
  });
  root.append(pill, menu);
}

/**
 * The masthead wallet control: install, connect, or the connected address
 * with its menu. Pure render — call it again with the next state.
 */
export function renderWalletControl(
  root: HTMLElement,
  state: ZwapState,
  handlers: WalletControlHandlers
): void {
  const reopen = state.wallet === "connected" && state.address !== null && openFor === state.address;
  teardownGlobalListeners?.();
  teardownGlobalListeners = undefined;
  openFor = null;
  root.replaceChildren();
  root.classList.add("wallet-control");
  if (state.wallet === "absent" || state.providerName === null) {
    renderAbsent(root);
    return;
  }
  if (state.wallet === "detected" || state.address === null) {
    renderDetected(root, state, handlers);
    return;
  }
  renderConnected(root, state.address, handlers);
  if (reopen) openMenu(root, state.address);
}
