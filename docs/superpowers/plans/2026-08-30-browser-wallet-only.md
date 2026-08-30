# Browser-Wallet-Only Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** zwap signs Zenon blocks only through a browser-extension wallet; the in-page keystore, plasma bot, PoW worker and `?wallet=` profiles are removed, and the wallet control lives in the masthead.

**Architecture:** `ZwapApi` becomes the owner of a three-state wallet machine (`absent → detected → connected`) over `DetectedProvider` / `InjectedZenonSigner`, exposing one `ZenonAccount` when connected. A new pure-render `wallet-control.ts` paints the masthead control from `ZwapState`. `main.ts` keeps its shape but drops every keystore branch. Nostr signing (per-order keys in `MakerIdentity`, per-session keys in the trade runtime) is untouched — the extension is only ever asked for `zenon_requestAccounts` and `zenon_sendBlock`.

**Tech Stack:** TypeScript (strict, ESM, `.js` import suffixes), Vite, Vitest + jsdom, `znn-typescript-sdk` 1.0.5, `nostr-tools`, design-system CSS classes (`nom-btn`, `nom-badge`, `nom-card`, `nom-iconbtn`).

**Spec:** `docs/superpowers/specs/2026-08-30-browser-wallet-only-design.md`

## Global Constraints

- Every task ends with `npm run lint && npx tsc --noEmit && npx vitest run && npm run build` green (the live integration test is skipped without env vars — that is fine).
- Storage name stays exactly `zwap-wallet-default` so existing IndexedDB data is preserved.
- Lock names keep the literal `default` segment they have today (`zwap-account-default-write`, etc.) for the same reason — see Task 4.
- No `Thanks`/performative text in commits; commit messages end with the repo's `Co-Authored-By` / `Claude-Session` trailers.
- Do not touch `src/trade/**`, `src/nostr/**`, `src/storage/**` except where a task names a file.
- Error copy is verbatim from the spec: "Wallet connection refused", "Wallet is on chain N; zwap needs chain M", "Connect your wallet before trading", "Connect your wallet first".

---

## File map

| Path | Task | Change |
| --- | --- | --- |
| `src/api/zwap-api.ts`, `src/api/zwap-api.test.ts` | 1 | rewrite over the provider |
| `src/ui/wallet-control.ts`, `src/ui/wallet-control.test.ts` | 2 | new masthead control |
| `src/styles.css`, `index.html` (masthead) | 2 | slot + popover styles |
| `src/ui/account-actions.ts` + test, `src/ui/dashboard.ts` + test | 3 | account card only |
| `src/main.ts`, `index.html` (custody, agent strip, copy), `src/shell.test.ts` | 3 | rewire |
| `src/browser/lock.ts`, `src/browser/trade-runtime.ts`, `src/browser/maker-identity-compose.ts` | 4 | drop the `profile` parameter |
| deletions listed in Task 4 | 4 | remove keystore / plasma / PoW / profile |
| `test/helpers/sdk-signer.ts` (+ test), `src/zenon/live.integration.test.ts`, `tsconfig.json` | 4 | Node-side signer helper |
| `src/config.ts` + test, `.env*`, `Dockerfile`, `public/_headers`, `deploy/nginx.conf`, `index.html` CSP, `vite.config.ts` | 4 | config + CSP |
| `docs/guides/*.md`, `docs/adr/0006-*.md`, `README.md` if it mentions seeds | 5 | docs |

---

### Task 1: `ZwapApi` over the injected provider

**Files:**
- Modify: `src/api/zwap-api.ts` (full rewrite)
- Modify: `src/api/zwap-api.test.ts` (full rewrite)

**Interfaces:**
- Consumes: `DetectedProvider`, `ZenonProvider`, `InjectedZenonSigner.connect(provider, chainId)`, `InjectedProviderError`, `PROVIDER_ERROR` from `src/zenon/injected-signer.ts`; `ZenonAccount` from `src/zenon/account.ts`; `ZenonNodePort` from `src/zenon/types.ts`.
- Produces (used by Tasks 2–3):

```ts
export type WalletStatus = "absent" | "detected" | "connected";
export interface ZwapState {
  wallet: WalletStatus;
  providerName: string | null;
  address: string | null;
  network: string;
  chainId: number;
  balances: BalanceView[];
  unreceived: number;
  plasma: PlasmaView | null;
}
export interface ZwapApiDependencies {
  node: ZenonNodePort;
  config: ZwapConfig;
  provider: DetectedProvider | null;
  /** Test seam; the browser passes nothing and gets InjectedZenonSigner.connect. */
  connectSigner?: (provider: ZenonProvider, chainId: number) => Promise<ZenonSigner & { onAccountsChanged(h: (a: string[]) => void): void }>;
}
export class ZwapApi {
  constructor(deps: ZwapApiDependencies);
  status(): WalletStatus;
  account(): ZenonAccount | null;
  getState(): Promise<ZwapState>;
  connect(): Promise<ZwapState>;
  disconnect(): void;
  receivePending(): Promise<ZwapState>;
  send(toAddress: string, tokenStandard: string, amount: string): Promise<SendReceipt>;
  onAccountsChanged(handler: (accounts: string[]) => void): void;
}
```

- [ ] **Step 1: Write the failing tests**

Replace `src/api/zwap-api.test.ts` with:

```ts
// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { loadConfig, type ZwapConfig } from "../config.js";
import { FakeZenonNode } from "../zenon/fake-node.js";
import {
  InjectedProviderError,
  PROVIDER_ERROR,
  type DetectedProvider,
  type ZenonProvider
} from "../zenon/injected-signer.js";
import { ZNN_ZTS } from "../zenon/types.js";
import { ZwapApi } from "./zwap-api.js";

const NOW = 1_800_000_000;

function config(overrides: Partial<ZwapConfig> = {}): ZwapConfig {
  return { ...loadConfig({}), ...overrides };
}

interface FakeProvider extends ZenonProvider {
  handlers: Map<string, Array<(payload: unknown) => void>>;
  emit(event: string, payload: unknown): void;
}

/** A provider that answers chainId/requestAccounts and forwards sends to the fake node. */
function fakeProvider(node: FakeZenonNode, address: string, chainId = 1): FakeProvider {
  const handlers = new Map<string, Array<(payload: unknown) => void>>();
  const signer = node.signer(address);
  return {
    handlers,
    emit(event, payload) {
      for (const handler of handlers.get(event) ?? []) handler(payload);
    },
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    async request({ method, params }) {
      switch (method) {
        case "zenon_chainId": return chainId;
        case "zenon_requestAccounts": return [address];
        case "zenon_sendBlock": {
          const [{ template }] = params as [{ template: Parameters<typeof signer.send>[0] }];
          const receipt = await signer.send(template);
          return { hash: receipt.blockHash };
        }
        default: throw new InjectedProviderError(PROVIDER_ERROR.unsupportedMethod, method);
      }
    }
  };
}

function detected(provider: ZenonProvider, name = "NoM Wallet"): DetectedProvider {
  return { info: { uuid: "u", name, icon: "data:,", rdns: "org.example" }, provider };
}

function harness(providerOverride?: DetectedProvider | null) {
  const node = new FakeZenonNode({ chainId: 1, now: () => NOW });
  const address = node.createAddress("wallet");
  const provider = fakeProvider(node, address);
  const api = new ZwapApi({
    node,
    config: config(),
    provider: providerOverride === undefined ? detected(provider) : providerOverride
  });
  return { node, address, provider, api, funder: node.createAddress("funder") };
}

describe("ZwapApi", () => {
  it("is absent with no provider and exposes no account", async () => {
    const { api } = harness(null);
    expect(api.status()).toBe("absent");
    expect(api.account()).toBeNull();
    expect(await api.getState()).toEqual({
      wallet: "absent",
      providerName: null,
      address: null,
      network: "zenon-mainnet",
      chainId: 1,
      balances: [],
      unreceived: 0,
      plasma: null
    });
  });

  it("is detected before connect and names the provider", async () => {
    const { api } = harness();
    expect(api.status()).toBe("detected");
    const state = await api.getState();
    expect(state.wallet).toBe("detected");
    expect(state.providerName).toBe("NoM Wallet");
    expect(state.address).toBeNull();
  });

  it("connects, reads balances, and receives pending blocks", async () => {
    const { api, node, address, funder } = harness();
    node.fund(funder, ZNN_ZTS, 10n * 10n ** 8n);
    await node.signer(funder).send({ kind: "send", toAddress: address, tokenStandard: ZNN_ZTS, amount: String(10n ** 8n) });

    const connected = await api.connect();
    expect(connected.wallet).toBe("connected");
    expect(connected.address).toBe(address);
    expect(connected.unreceived).toBe(1);
    expect(api.account()?.address()).toBe(address);

    const received = await api.receivePending();
    expect(received.unreceived).toBe(0);
    expect(received.balances.find((b) => b.tokenStandard === ZNN_ZTS)?.balance).toBe(String(10n ** 8n));
  });

  it("maps a user rejection to the spec's message and stays detected", async () => {
    const { api, provider } = harness();
    provider.request = async () => {
      throw { code: 4001, message: "User rejected" };
    };
    await expect(api.connect()).rejects.toThrow("Wallet connection refused");
    expect(api.status()).toBe("detected");
    expect(api.account()).toBeNull();
  });

  it("maps a chain mismatch to the spec's message", async () => {
    const node = new FakeZenonNode({ chainId: 1, now: () => NOW });
    const address = node.createAddress("wallet");
    const api = new ZwapApi({ node, config: config(), provider: detected(fakeProvider(node, address, 73404)) });
    await expect(api.connect()).rejects.toThrow("Wallet is on chain 73404; zwap needs chain 1");
    expect(api.status()).toBe("detected");
  });

  it("prefixes other provider errors with Wallet:", async () => {
    const { api, provider } = harness();
    provider.request = async () => {
      throw { code: 4100, message: "Wallet is locked" };
    };
    await expect(api.connect()).rejects.toThrow("Wallet: Wallet is locked");
  });

  it("refuses to connect when absent", async () => {
    const { api } = harness(null);
    await expect(api.connect()).rejects.toThrow("No browser wallet is available");
  });

  it("refuses sends and receives while not connected", async () => {
    const { api, funder } = harness();
    await expect(api.receivePending()).rejects.toThrow("Connect your wallet before trading");
    await expect(api.send(funder, ZNN_ZTS, "1")).rejects.toThrow("Connect your wallet before trading");
  });

  it("disconnects back to detected and drops the account", async () => {
    const { api } = harness();
    await api.connect();
    api.disconnect();
    expect(api.status()).toBe("detected");
    expect(api.account()).toBeNull();
    expect((await api.getState()).address).toBeNull();
  });

  it("treats accountsChanged: [] as a disconnect and forwards other changes", async () => {
    const { api, provider, address } = harness();
    const seen = vi.fn();
    api.onAccountsChanged(seen);
    await api.connect();

    provider.emit("accountsChanged", []);
    expect(api.status()).toBe("detected");
    expect(seen).toHaveBeenCalledWith([]);

    await api.connect();
    provider.emit("accountsChanged", [address]);
    expect(seen).toHaveBeenLastCalledWith([address]);
  });

  it("shares one signer between account() and send()", async () => {
    const { api, node, address, funder } = harness();
    node.fund(address, ZNN_ZTS, 5n);
    await api.connect();
    const receipt = await api.send(funder, ZNN_ZTS, "5");
    expect(receipt.blockHash).toMatch(/^[0-9a-f]{64}$/);
    expect((await api.getState()).balances.find((b) => b.tokenStandard === ZNN_ZTS)?.balance).toBe("0");
  });
});
```

If `FakeZenonNode` lacks `fund`, `createAddress`, or `signer(address)`, read `src/zenon/fake-node.ts` and use the equivalents it does have (the old `zwap-api.test.ts` used `node.createAddress("funder")` and `node.signer(...)`; check the old file in git history for the funding call it used: `git show HEAD:src/api/zwap-api.test.ts | grep -n fund`).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/api/zwap-api.test.ts`
Expected: FAIL — `provider` is not a known dependency / `status` is not a function.

- [ ] **Step 3: Rewrite `src/api/zwap-api.ts`**

```ts
import type { ZwapConfig } from "../config.js";
import { ZenonAccount } from "../zenon/account.js";
import {
  InjectedProviderError,
  InjectedZenonSigner,
  PROVIDER_ERROR,
  type DetectedProvider,
  type ZenonProvider
} from "../zenon/injected-signer.js";
import type {
  BalanceView,
  PlasmaView,
  SendReceipt,
  ZenonNodePort,
  ZenonSigner
} from "../zenon/types.js";

export type WalletStatus = "absent" | "detected" | "connected";

/** Everything the page paints from, in one round trip. */
export interface ZwapState {
  wallet: WalletStatus;
  /** The extension's announced name, once one has announced itself. */
  providerName: string | null;
  address: string | null;
  network: string;
  chainId: number;
  balances: BalanceView[];
  unreceived: number;
  plasma: PlasmaView | null;
}

/** What `connect()` needs from a signer: the `ZenonSigner` plus account-change events. */
export interface ConnectedSigner extends ZenonSigner {
  onAccountsChanged(handler: (accounts: string[]) => void): void;
}

export interface ZwapApiDependencies {
  node: ZenonNodePort;
  config: ZwapConfig;
  /** The wallet discovery result; `null` when no extension announced itself. */
  provider: DetectedProvider | null;
  /** Test seam. The browser leaves it unset and gets `InjectedZenonSigner.connect`. */
  connectSigner?: (provider: ZenonProvider, chainId: number) => Promise<ConnectedSigner>;
}

const NOT_CONNECTED = "Connect your wallet before trading";

/**
 * The wallet-facing half of zwap over a browser-extension wallet. zwap holds
 * no key: the extension owns the seed and signs every account block. This
 * class owns the three-state wallet machine (absent / detected / connected)
 * and hands out the one `ZenonAccount` the trade runtime must share, because
 * the signer serializes its own sends and two signers over one address would
 * race each other's account-chain height.
 */
export class ZwapApi {
  private readonly node: ZenonNodePort;
  private readonly config: ZwapConfig;
  private readonly provider: DetectedProvider | null;
  private readonly connectSigner: (provider: ZenonProvider, chainId: number) => Promise<ConnectedSigner>;
  private readonly accountHandlers: Array<(accounts: string[]) => void> = [];
  private current: ZenonAccount | null = null;
  private connecting: Promise<ZwapState> | undefined;
  private listening = false;

  constructor(dependencies: ZwapApiDependencies) {
    this.node = dependencies.node;
    this.config = dependencies.config;
    this.provider = dependencies.provider;
    this.connectSigner = dependencies.connectSigner
      ?? ((provider, chainId) => InjectedZenonSigner.connect(provider, chainId));
  }

  status(): WalletStatus {
    if (this.provider === null) return "absent";
    return this.current === null ? "detected" : "connected";
  }

  account(): ZenonAccount | null {
    return this.current;
  }

  async getState(): Promise<ZwapState> {
    const base = {
      wallet: this.status(),
      providerName: this.provider?.info?.name ?? (this.provider === null ? null : "Browser extension"),
      network: this.config.network,
      chainId: this.config.chainId
    };
    const account = this.current;
    if (account === null) {
      return { ...base, address: null, balances: [], unreceived: 0, plasma: null };
    }
    const snapshot = await account.snapshot();
    return {
      ...base,
      address: snapshot.address,
      balances: snapshot.balances,
      unreceived: snapshot.unreceived,
      plasma: snapshot.plasma
    };
  }

  /** Single-flight: two clicks share one connect window rather than opening two. */
  connect(): Promise<ZwapState> {
    this.connecting ??= this.doConnect().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  private async doConnect(): Promise<ZwapState> {
    const detected = this.provider;
    if (detected === null) throw new Error("No browser wallet is available");
    if (this.current !== null) return this.getState();
    let signer: ConnectedSigner;
    try {
      signer = await this.connectSigner(detected.provider, this.config.chainId);
    } catch (error) {
      throw describeConnectError(error, this.config.chainId);
    }
    this.current = new ZenonAccount({ node: this.node, signer });
    if (!this.listening) {
      this.listening = true;
      signer.onAccountsChanged((accounts) => {
        // A revoked site grant, or a wallet that locked the site out, arrives
        // as an empty list: the page has no signer any more.
        if (accounts.length === 0) this.disconnect();
        for (const handler of this.accountHandlers) handler(accounts);
      });
    }
    return this.getState();
  }

  disconnect(): void {
    this.current = null;
  }

  async receivePending(): Promise<ZwapState> {
    await this.require().receiveAll();
    return this.getState();
  }

  send(toAddress: string, tokenStandard: string, amount: string): Promise<SendReceipt> {
    return this.require().send(toAddress, tokenStandard, amount);
  }

  onAccountsChanged(handler: (accounts: string[]) => void): void {
    this.accountHandlers.push(handler);
  }

  private require(): ZenonAccount {
    const account = this.current;
    if (account === null) throw new Error(NOT_CONNECTED);
    return account;
  }
}

/**
 * The spec's three user-facing connect failures. Anything else keeps the
 * provider's own words, prefixed so the log says who said them.
 */
function describeConnectError(error: unknown, expectedChainId: number): Error {
  if (error instanceof InjectedProviderError) {
    if (error.code === PROVIDER_ERROR.userRejected) {
      return new Error("Wallet connection refused");
    }
    if (error.code === PROVIDER_ERROR.chainMismatch) {
      const reported = /chain (\S+?);/.exec(error.message)?.[1] ?? "unknown";
      return new Error(`Wallet is on chain ${reported}; zwap needs chain ${expectedChainId}`);
    }
    return new Error(`Wallet: ${error.message}`);
  }
  return new Error(`Wallet: ${error instanceof Error ? error.message : String(error)}`);
}
```

Note on the `accountsChanged` listener: `InjectedZenonSigner.onAccountsChanged` registers on the provider, and the provider object outlives disconnect/reconnect, so the listener is installed once (`listening`) and the disconnect check happens inside it. The regex on the 4901 message reads the chain the signer reported ("The extension wallet is on chain 73404; zwap is on chain 1") — keep that message in `injected-signer.ts` unchanged.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/api/zwap-api.test.ts`
Expected: PASS (11 tests). `npx tsc --noEmit` will now fail in `main.ts`, `account-actions.ts`, `dashboard.ts`, `shell.test.ts` — that is expected until Task 3; do not run the full suite yet.

- [ ] **Step 5: Commit**

```bash
git add src/api/zwap-api.ts src/api/zwap-api.test.ts
git commit -m "feat(api): ZwapApi over the injected provider"
```

---

### Task 2: Masthead wallet control

**Files:**
- Create: `src/ui/wallet-control.ts`
- Create: `src/ui/wallet-control.test.ts`
- Modify: `index.html:20-28` (masthead)
- Modify: `src/styles.css:77-86` and `:757-758` (masthead styles)

**Interfaces:**
- Consumes: `ZwapState` from Task 1; `truncateAddress` from `src/ui/format.ts`; `icon("shield" | "copy")` from `src/ui/icons.ts`; `withButtonFeedback` is *not* used here (the caller wraps `onConnect`).
- Produces:

```ts
export const INSTALL_URL = "https://github.com/0x3639/nom-wallet"; // update when the store listing exists
export interface WalletControlHandlers {
  onConnect(button: HTMLButtonElement): void;
  onDisconnect(): void;
  onCopy(address: string): void;
}
export function renderWalletControl(root: HTMLElement, state: ZwapState, handlers: WalletControlHandlers): void;
```

- [ ] **Step 1: Write the failing tests**

`src/ui/wallet-control.test.ts`:

```ts
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
    expect(pill?.textContent).toContain("z1qrmm…7fns");
    expect(pill?.getAttribute("aria-haspopup")).toBe("menu");
    expect(pill?.getAttribute("aria-expanded")).toBe("false");
    expect(root.querySelector("[role=menu]")?.hidden).toBe(true);
  });

  it("opens the menu with the full address, copy and disconnect", () => {
    const h = handlers();
    renderWalletControl(root, state({ wallet: "connected", address: ADDRESS }), h);
    root.querySelector<HTMLButtonElement>("button[data-wallet-pill]")?.click();
    const menu = root.querySelector<HTMLElement>("[role=menu]");
    expect(menu?.hidden).toBe(false);
    expect(menu?.textContent).toContain(ADDRESS);

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

  it("keeps the menu open across a re-render with the same address", () => {
    const h = handlers();
    renderWalletControl(root, state({ wallet: "connected", address: ADDRESS }), h);
    root.querySelector<HTMLButtonElement>("button[data-wallet-pill]")?.click();
    renderWalletControl(root, state({ wallet: "connected", address: ADDRESS, unreceived: 2 }), h);
    expect(root.querySelector<HTMLElement>("[role=menu]")?.hidden).toBe(false);

    renderWalletControl(root, state(), h);
    expect(root.querySelector("[role=menu]")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/ui/wallet-control.test.ts`
Expected: FAIL — cannot resolve `./wallet-control.js`.

- [ ] **Step 3: Write `src/ui/wallet-control.ts`**

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/ui/wallet-control.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Masthead slot and styles**

In `index.html` replace line 26 (`<p id="profile-label" …>`) with:

```html
      <div id="wallet-control" class="masthead__wallet"></div>
```

In `src/styles.css` replace the `.masthead__profile { … }` block (lines 78-85) with:

```css
.masthead__wallet { margin: 0 0 0 auto; position: relative; flex: none; }
.wallet-control { position: relative; display: flex; align-items: center; }
.wallet-control__pill { max-width: 220px; }
.wallet-control__menu {
  position: absolute;
  top: calc(100% + var(--space-2));
  right: 0;
  min-width: 280px;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  z-index: 30;
}
.wallet-control__address {
  margin: 0;
  font-size: var(--text-xs);
  word-break: break-all;
  color: var(--muted-foreground);
}
```

and in the responsive block (line ~758) replace `.masthead__profile { margin-left: 0; order: 3; width: 100%; }` with `.masthead__wallet { margin-left: auto; }`.

- [ ] **Step 6: Commit**

```bash
git add src/ui/wallet-control.ts src/ui/wallet-control.test.ts index.html src/styles.css
git commit -m "feat(ui): masthead wallet control"
```

---

### Task 3: Rewire the page over the new API

**Files:**
- Modify: `src/main.ts` (imports, composition root lines 199-330, `refresh`/`walletState` 420-461, facade 672-745, handlers 820-892, wiring 931-1050)
- Modify: `src/ui/account-actions.ts` (full rewrite), `src/ui/account-actions.test.ts` (full rewrite)
- Modify: `src/ui/dashboard.ts` (`NO_WALLET` copy, drop `powRequired` badge), `src/ui/dashboard.test.ts`
- Modify: `index.html` (custody section 138-157, agent strip 172-180, copy at lines 40, 165, 340)
- Modify: `src/shell.test.ts`

**Interfaces:**
- Consumes: `ZwapApi`, `ZwapState` (Task 1); `renderWalletControl` (Task 2).
- Produces: `window.zwap` facade below; `#reset-local-data` button; `data-requires-wallet` attribute convention.

```ts
interface ZwapBrowserFacade {
  getState: ZwapApi["getState"];
  connectWallet: ZwapApi["connect"];
  disconnectWallet: () => Promise<void>;
  receivePending: ZwapApi["receivePending"];
  send: ZwapApi["send"];
  resetLocalData: (confirmation: string) => Promise<void>;   // "RESET ZWAP DATA"
  getMakerPublicKeys; getOrderBook; publishOrder; getPendingOrderPublications;
  retryOrderPublication; cancelOrder; listTrades; getTrade; takeOrder;
  advanceTrade; runUntilSettled; enableMaker;                 // unchanged
}
```

- [ ] **Step 1: Rewrite the account panel tests**

Replace `src/ui/account-actions.test.ts` with:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ZwapState } from "../api/zwap-api.js";
import { renderAccountActions, type AccountActionHandlers } from "./account-actions.js";
import { ZNN_ZTS } from "../zenon/types.js";

const ADDRESS = "z1qrmm5cxzc8m0uwn2yz2lz4knwvdn0vkg9nnh7fns";

function state(overrides: Partial<ZwapState> = {}): ZwapState {
  return {
    wallet: "connected", providerName: "NoM Wallet", address: ADDRESS,
    network: "zenon-mainnet", chainId: 1, balances: [], unreceived: 0, plasma: null,
    ...overrides
  };
}

function handlers(): AccountActionHandlers {
  return { onReceive: vi.fn(), onCopyAddress: vi.fn() };
}

describe("renderAccountActions", () => {
  let root: HTMLElement;
  beforeEach(() => { root = document.createElement("div"); });

  it("asks the visitor to connect while no wallet is connected", () => {
    renderAccountActions(root, state({ wallet: "detected", address: null }), handlers());
    expect(root.textContent).toContain("Connect your wallet to see balances and trade");
    expect(root.querySelector("[data-account-receive]")).toBeNull();
  });

  it("says the same when no wallet is installed", () => {
    renderAccountActions(root, state({ wallet: "absent", providerName: null, address: null }), handlers());
    expect(root.textContent).toContain("Connect your wallet to see balances and trade");
  });

  it("renders the address, balances, plasma and receive when connected", () => {
    const h = handlers();
    renderAccountActions(root, state({
      balances: [{ tokenStandard: ZNN_ZTS, symbol: "ZNN", decimals: 8, balance: "150000000" }],
      plasma: { currentPlasma: 252_000, maxPlasma: 252_000 },
      unreceived: 2
    }), h);
    expect(root.querySelector("[data-account-address]")?.textContent).toBe("z1qrmm…7fns");
    expect(root.querySelector("[data-balance-token]")?.textContent).toContain("ZNN");
    expect(root.querySelector("[data-account-plasma]")?.textContent).toBe("Plasma 252,000 / 252,000");
    const receive = root.querySelector<HTMLButtonElement>("[data-account-receive]");
    expect(receive?.textContent).toContain("Receive 2 pending");
    expect(receive?.disabled).toBe(false);
    receive?.click();
    expect(h.onReceive).toHaveBeenCalledWith(receive);

    root.querySelector<HTMLButtonElement>("[data-account-copy]")?.click();
    expect(h.onCopyAddress).toHaveBeenCalledWith(ADDRESS, expect.any(HTMLButtonElement));
  });

  it("disables receive with nothing pending", () => {
    renderAccountActions(root, state(), handlers());
    expect(root.querySelector<HTMLButtonElement>("[data-account-receive]")?.disabled).toBe(true);
  });

  it("never renders keystore controls", () => {
    renderAccountActions(root, state(), handlers());
    for (const attr of ["account-create", "account-import", "account-reveal", "account-fuse", "account-connect", "account-extension"]) {
      expect(root.querySelector(`[data-${attr}]`)).toBeNull();
    }
  });
});
```

Check the `BalanceView` / `PlasmaView` field names in `src/zenon/types.ts` and adjust the fixture if they differ.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/ui/account-actions.test.ts`
Expected: FAIL (handlers shape / copy mismatch).

- [ ] **Step 3: Rewrite `src/ui/account-actions.ts`**

```ts
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
```

- [ ] **Step 4: Dashboard copy**

In `src/ui/dashboard.ts`: change `NO_WALLET` to `"No wallet connected."`; in `renderWalletSummary` the not-connected note becomes `"No wallet connected. Use Connect wallet in the header."`; in `renderDashboard` the empty-state paragraph becomes `"Connect your browser wallet to see balances and plasma."`; delete the `if (state.powRequired) { … }` block and the now-unused `icon` import. Update `src/ui/dashboard.test.ts` fixtures to the new `ZwapState` shape (`wallet`, `providerName` instead of `powRequired`, `plasmaBotAvailable`, `walletSource`) and any assertion on the old copy / the PoW badge. Run `npx vitest run src/ui/dashboard.test.ts` — PASS.

- [ ] **Step 5: `index.html` body changes**

1. Line 40: `<p><strong>Self-custody.</strong> Your seed lives only in this browser profile. Nobody can recover it for you.</p>` → `<p><strong>Self-custody.</strong> Your keys stay in your browser wallet. zwap never sees a seed.</p>`
2. Replace the whole custody `<section class="panel" aria-labelledby="custody-title">` (lines 139-157) with:

```html
        <section class="panel" aria-labelledby="local-data-title">
          <p class="text-ledger">05 / Local data</p>
          <h2 id="local-data-title">Trade journal and order keys</h2>
          <p>
            Open swaps, pending order publications, and the per-order Nostr keys that sign
            your listings live only in this browser. Erasing them abandons any swap in progress.
          </p>
          <details>
            <summary>Danger zone</summary>
            <div class="danger-zone">
              <button id="reset-local-data" class="nom-btn nom-btn--destructive" type="button">
                <span data-button-label="true">Erase local data and restart</span>
              </button>
            </div>
          </details>
        </section>
```

3. Line 165 hint: `Seeds, preimages, and private keys stay out of this log.` → `Preimages and private keys stay out of this log.`
4. Agent strip (lines 172-180): replace the API line with
   `zwap.getState() · zwap.connectWallet() · zwap.receivePending() · zwap.publishOrder(input) · zwap.getOrderBook() · zwap.takeOrder(input) · zwap.runUntilSettled(sessionId) · zwap.listTrades() · zwap.disconnectWallet()` and the sentence "without ever exposing a seed, a preimage, or a private key" → "without ever exposing a preimage or a private key".
5. Line 340: `Zenon is feeless. Sends need plasma from fused QSR, or a proof of work this page computes locally in a worker.` → `Zenon is feeless. Your wallet extension covers each block with fused plasma or a proof of work and shows which in its confirmation.`

- [ ] **Step 6: Rewire `src/main.ts`**

Apply these edits in order (line numbers refer to the file before edits; re-read the region before each edit).

a. Imports: remove `KeyPair`, `composeKeystore`, `guardKeystoreActions`/`WalletSource`, `profileFromLocation`/`resetProfileSequence`/`storageNameForProfile`, `ZenonAccount` (no longer constructed here), `InjectedZenonSigner`, `KeystoreSigner`, `PlasmaTier`, `showSeedDialog`, `ZenonSigner`. Add `import { renderWalletControl } from "./ui/wallet-control.js";`.

b. `ZwapBrowserFacade`: remove `createWallet`, `importWallet`, `fusePlasma`, `revealMnemonic`, `clearWallet`, `resetProfile`; add `connectWallet: ZwapApi["connect"]; disconnectWallet: () => Promise<void>; resetLocalData: (confirmation: string) => Promise<void>;`.

c. Element handles (after `activity`): add `const walletControl = byId("wallet-control");`.

d. `blockTrading`: keep; extend the selector to `"#order-form button[type=submit], #refresh, #reset-local-data"` is **not** wanted — reset must stay reachable. Leave the selector as is.

e. Replace lines 199-211 (`const profile = …` through `const makerIdentity = …`) with:

```ts
/** One storage namespace per browser origin. The literal is the pre-existing default profile name, kept so nothing already stored is orphaned. */
const STORAGE_NAME = "zwap-wallet-default";
const driver = new IndexedDbStorageDriver(STORAGE_NAME);
const locked = <T>(action: () => Promise<T>): Promise<T> => withAccountLock(action);
const outboxLocked = <T>(action: () => Promise<T>): Promise<T> => withOrderOutboxLock(action);
// Order signing keys are encrypted at rest under their own lock: the encrypted
// driver re-acquires it on every read and write while the facade may already
// hold the account lock. See `composeMakerIdentity`.
const makerIdentity = composeMakerIdentity(driver);
```

(`withAccountLock(action)` / `withOrderOutboxLock(action)` / `composeMakerIdentity(driver)` lose their `profile` argument in Task 4. Until then pass `"default"` as the first argument — Task 4 removes it. Same for `createBrowserTradeRuntime({ profile: "default", … })`.)

f. Replace lines 224-320 (the `walletSigner` comment block through the end of the `try/catch`) with:

```ts
let walletApi: ZwapApi | undefined;
let createTradeRuntime: (() => Promise<BrowserTradeRuntime>) | undefined;
let resetTradeRuntime: (() => void) | undefined;

try {
  const node = await SdkZenonNode.connect({
    nodeUrl: config.nodeUrl,
    chainId: config.chainId
  });
  // Discovery is a 300 ms race at worst and resolves `null` on a page with no
  // extension, which renders the install offer instead of the connect button.
  const provider = await detectInjectedProvider(window).catch(() => null);
  const api = new ZwapApi({ node, config, provider });
  walletApi = api;
  api.onAccountsChanged((accounts) => {
    if (accounts.length === 0) {
      // The site grant was revoked or the wallet locked this site out.
      void teardownWallet().then(() => refresh()).then(() => {
        trace("Account", "Wallet disconnected");
        report("Wallet disconnected", true);
      });
      return;
    }
    // The account the extension signs with is the whole identity of every
    // open session. When the user switches it, restart rather than half-migrate.
    window.location.reload();
  });
  let runtimePromise: Promise<BrowserTradeRuntime> | undefined;
  resetTradeRuntime = () => { runtimePromise = undefined; };
  createTradeRuntime = async () => {
    const account = api.account();
    if (account === null) throw new Error("Connect your wallet before trading");
    runtimePromise ??= createBrowserTradeRuntime({
      profile: "default",
      driver,
      node,
      signer: account.signer,
      config,
      makerIdentity,
      orderApi,
      orderService,
      orderOutbox
    });
    return runtimePromise;
  };
} catch (error) {
  blockTrading(/* unchanged */);
}
```

`ZenonAccount` must expose its signer for this: in `src/zenon/account.ts` add `readonly signer: ZenonSigner;` assigned in the constructor from `deps.signer` (check the field name already used internally and reuse it — if the class already keeps `private readonly signer`, change it to `readonly`).

g. `refresh` (lines 423-437): add `renderWalletControl(walletControl, next, walletHandlers);` after `renderAccountActions`, and add `setWalletGating(next.wallet === "connected");` (defined below). In the `walletApi === undefined` branch also call `renderWalletControl(walletControl, { wallet: "absent", providerName: null, address: null, network: config.network, chainId: config.chainId, balances: [], unreceived: 0, plasma: null }, walletHandlers);`.

h. Delete `walletState()` (lines 444-461); every caller uses `requireWallet().getState()`.

i. Add after `refresh`:

```ts
/**
 * Everything that signs is gated on the connected wallet. Retry buttons are
 * re-rendered on every outbox paint, so they are gated where they are painted
 * (`refreshPendingPublications`); the static buttons are gated here.
 */
function setWalletGating(connected: boolean): void {
  document.documentElement.dataset.zwapWallet = connected ? "connected" : "disconnected";
  for (const node of document.querySelectorAll<HTMLButtonElement>(
    "#order-form button[type=submit], [data-requires-wallet]"
  )) {
    if (blockedReason !== undefined) continue;
    node.disabled = !connected;
    node.title = connected ? "" : "Connect your wallet first";
  }
}
```

In `refreshOrderBook`, pass the take/cancel handlers only when `walletApi?.status() === "connected"` (mirror how it already omits them while `blockedReason` is set). In `refreshPendingPublications`, after rendering, if not connected set `disabled = true` and `title = "Connect your wallet first"` on `#pending-publications button` exactly as `disableRetryActions` does for the blocked case.

j. `teardownWallet` (lines 659-670): remove `walletSigner = undefined;`; add `walletApi?.disconnect();` as the first line.

k. Delete `walletSource()` and the `keystoreOnly` block (lines 672-696). Replace the facade fields:

```ts
const zwap: ZwapBrowserFacade = {
  getState: () => requireWallet().getState(),
  connectWallet: () => requireWallet().connect(),
  disconnectWallet: async () => { await teardownWallet(); await refresh(); },
  receivePending: () => locked(() => requireWallet().receivePending()),
  send: (toAddress, tokenStandard, amount) =>
    locked(() => requireWallet().send(toAddress, tokenStandard, amount)),
  resetLocalData: async (confirmation) => {
    if (confirmation !== "RESET ZWAP DATA") {
      throw new Error("Type RESET ZWAP DATA to erase this browser's zwap data");
    }
    // Teardown first: the runtime and the maker listener hold the database
    // this is about to delete. Runs outside the account lock, which `stop()`
    // takes itself.
    await teardownWallet();
    await locked(() => driver.resetDatabase());
  },
  /* the order/trade fields are unchanged */
};
```

l. Delete the `powWorkerFailure` report block (lines 747-750). Change the Web Locks messages to drop "wallet profile": `"Web Locks API unavailable. Using single-tab mode; keep zwap in one tab. …"` / `"Web Locks unavailable: single-tab mode enabled. Do not open zwap in another tab."`.

m. Delete `revealSeed` and `hideKeystoreCustody` (lines 820-838). Replace `accountHandlers` (lines 840-892) with:

```ts
const accountHandlers: AccountActionHandlers = {
  onReceive: (button: HTMLButtonElement) => {
    void withButtonFeedback(button, "Receiving…", () => zwap.receivePending())
      .then((state) => refresh(state))
      .then(() => report("Pending blocks received"))
      .catch((error: unknown) => report(messageOf(error), true));
  },
  onCopyAddress: (address: string, button: HTMLButtonElement) => {
    void withButtonFeedback(button, "…", () => navigator.clipboard.writeText(address))
      .then(() => report("Address copied"))
      .catch((error: unknown) => report(messageOf(error), true));
  }
};

const walletHandlers: WalletControlHandlers = {
  onConnect: (button: HTMLButtonElement) => {
    void withButtonFeedback(button, "Connecting…", () => zwap.connectWallet())
      .then((state) => refresh(state))
      .then((state) => {
        trace("Account", "Browser wallet connected", [
          { label: "wallet", value: state.providerName ?? "extension" },
          { label: "address", value: `${(state.address ?? "").slice(0, 8)}…` }
        ]);
        report("Wallet connected");
        void refreshTrades();
      })
      .catch((error: unknown) => report(messageOf(error), true));
  },
  onDisconnect: () => {
    void zwap.disconnectWallet()
      .then(() => { trace("Account", "Wallet disconnected"); report("Wallet disconnected"); })
      .catch((error: unknown) => report(messageOf(error), true));
  },
  onCopy: (address: string) => {
    void navigator.clipboard.writeText(address)
      .then(() => report("Address copied"))
      .catch((error: unknown) => report(messageOf(error), true));
  }
};
```

Import `WalletControlHandlers` from `./ui/wallet-control.js`.

n. Lines 931-933 (`byId("profile-label")…`): delete. Lines 942-943 (`backupButton`): delete. Lines 1031-1046 (`clearWalletButton`, `resetProfileButton`): replace with:

```ts
const resetLocalDataButton = byId<HTMLButtonElement>("reset-local-data");
resetLocalDataButton.addEventListener("click", () => {
  void withButtonFeedback(resetLocalDataButton, "Erasing…", () => zwap.resetLocalData("RESET ZWAP DATA"))
    .then(() => window.location.reload())
    .catch((error: unknown) => report(messageOf(error), true));
});
```

o. `log("Opened the shared maker/taker workspace")` → `log("Opened zwap")`.

p. Mark the static buttons that sign: in `index.html` add `data-requires-wallet` to `#refresh` (Refresh balances) — nothing else static signs; Take/Cancel/Retry are handled in step i.

- [ ] **Step 7: Update `src/shell.test.ts`**

Change the fixture state to the Task 1 shape (`wallet: "connected"`, `providerName: "NoM Wallet"`, no `walletSource`/`powRequired`/`plasmaBotAvailable`). In the required-ids list replace `"profile-label"` with `"wallet-control"`, and `"backup", "clear-wallet", "reset-profile"` with `"reset-local-data"`. Run `npx vitest run src/shell.test.ts` — PASS.

- [ ] **Step 8: Typecheck and run everything**

Run: `npx tsc --noEmit && npx vitest run`
Expected: tsc clean; every suite passes except the keystore/plasma/seed/profile/wallet-guard suites, which still compile against their (still present) modules and should still pass — if any of them now fails because `main.ts` no longer exports something, that suite is deleted in Task 4; note it and move on only if the failure is *only* in a file Task 4 deletes.

- [ ] **Step 9: Manual smoke in the dev server**

`npm run dev`, open http://localhost:5173 in a Chrome profile with the NoM Wallet extension: masthead shows "Connect wallet"; click → extension window → approve → pill shows the address, account card fills, "Sign and post order" becomes enabled. Open the pill menu → Disconnect → card returns to "Connect your wallet…", post button disabled. In a profile without the extension: masthead shows "Install NoM Wallet".

- [ ] **Step 10: Commit**

```bash
git add src/main.ts src/ui/account-actions.ts src/ui/account-actions.test.ts src/ui/dashboard.ts src/ui/dashboard.test.ts src/zenon/account.ts index.html src/shell.test.ts
git commit -m "feat: sign only through the browser wallet; wallet control in the masthead"
```

---

### Task 4: Delete the keystore, plasma bot, PoW worker and profiles

**Files:**
- Delete: `src/zenon/keystore-repository.ts` + `.test.ts`, `src/zenon/keystore-signer.ts` + `.test.ts`, `src/zenon/plasma-bot.ts` + `.test.ts`, `src/browser/keystore-compose.ts` + `.test.ts`, `src/browser/wallet-source-guard.ts` + `.test.ts`, `src/browser/profile.ts` + `.test.ts` (if present), `src/ui/seed-dialog.ts` + `.test.ts`, `vite-pow-plugin.ts`, `public/pow.js`, `public/pow.wasm` (if committed).
- Create: `test/helpers/sdk-signer.ts`, `test/helpers/sdk-signer.test.ts`
- Modify: `src/browser/lock.ts`, `src/browser/maker-identity-compose.ts` (+ test), `src/browser/trade-runtime.ts` (+ tests that build it), `src/browser/trade-controller.ts` if it takes `profile`, `src/main.ts` (drop the `"default"` arguments), `src/zenon/live.integration.test.ts`, `src/config.ts` + `src/config.test.ts`, `.env.example`, `.env.testnet`, `.env` (local, untracked — remove `VITE_INJECTED_WALLET` and `VITE_PLASMA_BOT_URL` there too), `Dockerfile`, `.dockerignore` (drop nothing), `public/_headers`, `deploy/nginx.conf`, `index.html` CSP meta, `vite.config.ts`, `tsconfig.json`, `package.json` (no script changes expected), `src/storage/driver.ts:82` message.

**Interfaces:**
- Produces: `withAccountLock(action, locks?)`, `withMakerIdentityLock(action, locks?)`, `withMakerIdentityWriteLock(action, locks?)`, `withOrderOutboxLock(action, locks?)`, `withTradeSessionLock(sessionId, action, locks?)`, `withTradeSessionStorageLock(action, locks?)`; `composeMakerIdentity(driver)`; `CreateBrowserTradeRuntimeInput` without `profile`; `SdkSigner` in `test/helpers/sdk-signer.ts` with the same `ZenonSigner` shape as the old `KeystoreSigner` minus `installPowWorker`.

- [ ] **Step 1: Move the Node-side signer into a test helper**

Create `test/helpers/sdk-signer.ts` with the contents of `src/zenon/keystore-signer.ts` minus `installPowWorker`, `PowHooks`, and the `isPowWorkerSupported` import; rename the class to `SdkSigner` and keep `toSdkTemplate` exported. Import paths become `../../src/zenon/types.js`. Add the doc comment:

```ts
/**
 * Test-only: signs with an SDK key pair from a mnemonic, for the live
 * integration test and scripts. No PoW provider is installed — the addresses
 * these run against must hold fused plasma. App code never imports this.
 */
```

Move `src/zenon/keystore-signer.test.ts` to `test/helpers/sdk-signer.test.ts`, updating imports and the class name, and keep both its `toSdkTemplate` cases and the serialization case. In `src/zenon/live.integration.test.ts` replace the `KeystoreSigner` import with `import { SdkSigner } from "../../test/helpers/sdk-signer.js";` and the two constructor calls. In `tsconfig.json` `include`, replace `"tests"` with `"test"` (check whether a `tests/` dir exists first: `ls tests test`) and remove `"vite-pow-plugin.ts"`.

Run: `npx vitest run test/helpers` — PASS.

- [ ] **Step 2: Drop the `profile` parameter from the locks**

In `src/browser/lock.ts`: delete `withKeystoreLock` and `withKeystoreWriteLock`. For every remaining exported function remove the `profile: string` parameter and the profile validation, and hard-code the literal `default` segment so lock names are byte-identical to today, e.g.

```ts
export async function withAccountLock<T>(
  action: () => Promise<T>,
  locks: LockPort | undefined = hasNativeWebLocks() ? navigator.locks : undefined
): Promise<T> {
  return requestLock("zwap-account-default-write", action, locks);
}
```

Names: `zwap-account-default-write`, `zwap-maker-identity-default`, `zwap-maker-identity-default-write`, `zwap-order-outbox-default-write`, `zwap-trade-default-${sessionId}-write` (keep the session-id regex check), `zwap-trade-default-storage-write`. Update `src/browser/lock.test.ts` if one exists (`ls src/browser/lock.test.ts`).

Update callers: `src/browser/maker-identity-compose.ts` (`composeMakerIdentity(driver)`), `src/browser/trade-runtime.ts` (remove `profile` from `CreateBrowserTradeRuntimeInput` and the three lock calls), `src/browser/trade-controller.ts` if it forwards `profile`, their tests, and `src/main.ts` (remove the `"default"` arguments and `profile: "default"`).

Run: `npx tsc --noEmit` — clean except for the files being deleted next.

- [ ] **Step 3: Delete the modules and their tests**

```bash
git rm src/zenon/keystore-repository.ts src/zenon/keystore-repository.test.ts \
  src/zenon/keystore-signer.ts src/zenon/keystore-signer.test.ts \
  src/zenon/plasma-bot.ts src/zenon/plasma-bot.test.ts \
  src/browser/keystore-compose.ts src/browser/keystore-compose.test.ts \
  src/browser/wallet-source-guard.ts src/browser/wallet-source-guard.test.ts \
  src/ui/seed-dialog.ts src/ui/seed-dialog.test.ts vite-pow-plugin.ts
ls src/browser/profile.ts src/browser/profile.test.ts public/pow.js public/pow.wasm 2>/dev/null   # git rm any that exist
grep -rn "seed-dialog\|keystore\|plasma-bot\|profile\.js\|wallet-source-guard" src scripts --include='*.ts' -l
```

The final grep must print nothing except `src/zenon/injected-signer.ts` (its doc comment mentions the keystore — rewrite that sentence to "adapts it to the `ZenonSigner` the trade runtime consumes"). Also fix `src/storage/driver.ts:82` → `"IndexedDB reset is blocked by another open zwap tab"`. Remove `seed-dialog`/`account-panel__import`/`account-panel__mnemonic`/`account-panel__tier`/`danger-zone` styles from `src/styles.css` only if nothing references them (`grep -n` each class in `index.html` and `src/ui`); `danger-zone` stays (Task 3 uses it).

- [ ] **Step 4: Config, CSP, build**

`src/config.ts`: remove `plasmaBotUrl` (and its parsing) and `injectedWallet` from `ZwapConfig` and `loadConfig`. Update `src/config.test.ts` (delete the plasma-bot-URL and injected-wallet cases).

`vite.config.ts`: remove the `copyPowFiles` import and plugin entry, and the `worker: { format: "es" }` line.

CSP — in `index.html` meta, `public/_headers`, and the three `add_header` lines in `deploy/nginx.conf`: change `script-src 'self' 'wasm-unsafe-eval'` → `script-src 'self'`, delete `worker-src 'self' blob:;`, delete `https://plazma.bot `. Delete the `/pow.wasm` and `/pow.js` blocks from `public/_headers`.

`Dockerfile`: delete the `ARG VITE_PLASMA_BOT_URL` line and the `VITE_PLASMA_BOT_URL=$VITE_PLASMA_BOT_URL \` line. `.env.example`: delete the `VITE_PLASMA_BOT_URL` line and the `VITE_INJECTED_WALLET` comment + line. `.env.testnet`: delete `VITE_PLASMA_BOT_URL=`. Local `.env`: delete `VITE_INJECTED_WALLET=1`.

- [ ] **Step 5: Full verification**

Run: `npm run lint && npx tsc --noEmit && npx vitest run && npm run build`
Expected: all green; `dist/` contains no `pow.js` / `pow.wasm` (`ls dist`). Then `npm run dev` and repeat the Task 3 Step 9 smoke: connect, post-order button enabled, disconnect.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: remove the in-page keystore, plasma bot, PoW worker and wallet profiles"
```

---

### Task 5: Documentation

**Files:**
- Modify: `docs/guides/wallet.md` (rewrite), `docs/guides/manual-swap.md`, `docs/guides/agent-api.md`, `docs/guides/deploy-cloudflare.md`, `docs/guides/deploy-docker.md`, `docs/guides/live-test.md`, `docs/adr/0006-zenon-htlc-settlement.md`, `README.md` (if it mentions seeds/plasma bot: `grep -n "seed\|plasma bot\|VITE_PLASMA_BOT_URL\|VITE_INJECTED_WALLET\|?wallet=" README.md docs -r`).

- [ ] **Step 1: `docs/guides/wallet.md`**

Rewrite with these sections, in this order, each 3–8 lines: *Install* (NoM Wallet extension, `INSTALL_URL`, discovery via `zenon:announceProvider`); *Connect* (header button, the extension's connect window, chain check — "Wallet is on chain N; zwap needs chain M" on mismatch, "Wallet connection refused" on reject); *What zwap asks the wallet for* (`zenon_requestAccounts`, `zenon_sendBlock` for HTLC create/unlock/reclaim, receive, send; the extension decides plasma vs PoW); *Nostr keys are not the wallet's* (per-order and per-session keys are generated in the page and encrypted in IndexedDB — link ADR 0002); *Disconnect and account switch* (menu → Disconnect; revoke in the extension → "Wallet disconnected"; switching account reloads); *Local data* (what "Erase local data and restart" removes; the address-keying limitation from the spec, verbatim); keep the existing bullets about the node chain check, receive-pending, and the ADR 0006 trust boundary.

- [ ] **Step 2: `docs/guides/manual-swap.md`**

Steps 1–2 ("Create the maker wallet" / "Create the taker wallet") become one step: "Connect a funded extension account on each tab" — two browser profiles (or two extensions) each with an account holding the amounts from the prerequisites; keep the 20 ZNN / 70 QSR amounts. Delete step 4 "Fuse plasma (or accept proof-of-work)" and renumber; add one sentence where it was: "Each signing step opens the extension's confirmation, which shows whether it spends plasma or computes a proof of work." Replace every "Create wallet", "Reveal seed", "Fuse plasma" reference and the `?wallet=` profile mentions (`grep -n "wallet=" docs/guides/manual-swap.md`).

- [ ] **Step 3: Other docs**

- `agent-api.md`: replace the wallet methods with `connectWallet`, `disconnectWallet`, `receivePending`, `send`, `resetLocalData("RESET ZWAP DATA")`; delete `createWallet`/`importWallet`/`fusePlasma`/`revealMnemonic`/`clearWallet`/`resetProfile`.
- `deploy-cloudflare.md` / `deploy-docker.md`: delete `VITE_PLASMA_BOT_URL` from the variable tables and build-arg examples; delete the "no plasma bot on testnet" parentheticals.
- `live-test.md`: reference `test/helpers/sdk-signer.ts` where it mentions `KeystoreSigner`; note the addresses need fused plasma.
- ADR 0006: add a dated note under the title: "2026-08-30: the in-page keystore was removed; settlement blocks are signed by a browser-extension wallet through `src/zenon/injected-signer.ts` (see `docs/proposals/zenon-injected-provider.md`). Nostr signing is unchanged."
- ADR 0002 historical note: change "signs Zenon account blocks through `zenon/keystore-signer.ts`" to "…through the browser-extension wallet (`zenon/injected-signer.ts`)".

- [ ] **Step 4: Verify and commit**

Run: `grep -rn "keystore\|KeystoreSigner\|Reveal seed\|plasma bot\|VITE_PLASMA_BOT_URL\|VITE_INJECTED_WALLET\|?wallet=" docs README.md | grep -v "docs/superpowers\|docs/proposals\|docs/adr/0002\|docs/adr/0006"`
Expected: no output.

```bash
git add docs README.md
git commit -m "docs: browser-wallet-only guides and ADR notes"
```

---

## Self-review

- **Spec coverage:** wallet model + API (T1); masthead control incl. popover, copy, disconnect, install link (T2); page body, gating, reset-local-data, error copy (T3); deletions, config, CSP, locks, storage name, test helper (T4); docs incl. the address-keying limitation (T5). `accountsChanged: []` → disconnect (T1 + T3 f). Chain-mismatch/reject messages (T1).
- **Types:** `ZwapState`/`ZwapApi` names are identical across T1–T3; `WalletControlHandlers` matches between T2 and T3 m; `ZenonAccount.signer` is introduced in T3 f and used only there; lock signatures in T4 match the T3 e note about the interim `"default"` argument.
- **Open item carried from the spec:** `INSTALL_URL` points at a placeholder repository URL until the store listing exists.
