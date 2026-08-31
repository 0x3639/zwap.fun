import { Buffer } from "buffer";
(globalThis as { Buffer?: typeof Buffer }).Buffer ??= Buffer;

import { OrderApi } from "./api/order-api.js";
import { ZwapApi } from "./api/zwap-api.js";
import { installZwapFacade } from "./app/facade.js";
import { createMakerInboxSurface } from "./app/maker-inbox.js";
import { createStatusSurface, messageOf } from "./app/status.js";
import { createTradingSurface } from "./app/trading.js";
import { createWalletSurface } from "./app/wallet.js";
import {
  hasNativeWebLocks,
  withAccountLock,
  withOrderOutboxLock
} from "./browser/lock.js";
import { composeMakerIdentity } from "./browser/maker-identity-compose.js";
import { BrowserTradeController } from "./browser/trade-controller.js";
import { startInboxListeners } from "./browser/startup.js";
import type {
  BrowserTradeRuntime
} from "./browser/trade-runtime.js";
import { browserConfig } from "./config.js";
import { NostrOrderService } from "./order/service.js";
import { RelayClient } from "./nostr/relay.js";
import { OrderOutboxRepository } from "./storage/order-outbox.js";
import { IndexedDbStorageDriver } from "./storage/driver.js";
import { detectInjectedProvider } from "./zenon/injected-signer.js";
import { applyTheme, mountThemeToggle } from "./ui/theme.js";
import { tokenDirectory, type TokenLookup } from "./ui/tokens.js";

function byId<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node as T;
}

// Paint the theme before anything else touches the DOM so the first frame is
// already in the user's chosen mode rather than flashing the default.
applyTheme(document.documentElement);
mountThemeToggle(byId<HTMLButtonElement>("theme-toggle"), document.documentElement);

const status = createStatusSurface({
  status: byId("status"),
  activity: byId<HTMLOListElement>("activity-log")
});

const config = browserConfig();
/** One storage namespace per browser origin. The literal is the pre-existing default profile name, kept so nothing already stored is orphaned. */
const STORAGE_NAME = "zwap-wallet-default";
const driver = new IndexedDbStorageDriver(STORAGE_NAME);
const locked = <T>(action: () => Promise<T>): Promise<T> =>
  withAccountLock(action);
const outboxLocked = <T>(action: () => Promise<T>): Promise<T> =>
  withOrderOutboxLock(action);
// Order signing keys are encrypted at rest under their own lock: the encrypted
// driver re-acquires it on every read and write while the facade may already
// hold the account lock. See `composeMakerIdentity`.
const makerIdentity = composeMakerIdentity(driver);
// The configured discovery relays, not the library defaults - VITE_NOSTR_RELAYS
// must actually steer the public order book.
const relayClient = new RelayClient({ relays: config.discoveryRelays });
const orderService = new NostrOrderService(makerIdentity, relayClient);
const orderOutbox = new OrderOutboxRepository(driver, outboxLocked);
const orderApi = new OrderApi(
  makerIdentity,
  orderService,
  () => Math.floor(Date.now() / 1000),
  () => crypto.randomUUID(),
  orderOutbox
);

let walletApi: ZwapApi | undefined;
let createTradeRuntime: (() => Promise<BrowserTradeRuntime>) | undefined;
let resetTradeRuntime: (() => void) | undefined;
let tradeControllerPromise: Promise<BrowserTradeController> | undefined;

/**
 * Symbols and decimals from the last wallet read, so the order book and the
 * trade cards label amounts with what the chain actually reported rather than
 * a hard-coded table. Falls back to ZNN/QSR before the first read lands.
 */
let tokens: TokenLookup = tokenDirectory();

/**
 * One controller per connected wallet, built lazily off the trade runtime and
 * memoised: every facade call and every surface has to observe the same live
 * sessions and the same maker listener.
 */
function tradeController(): Promise<BrowserTradeController> {
  if (createTradeRuntime === undefined) {
    return Promise.reject(new Error(status.blockedReason() ?? "The Zenon node is unavailable"));
  }
  tradeControllerPromise ??= createTradeRuntime().then((runtime) => new BrowserTradeController({
    api: runtime.api,
    sessions: runtime.sessions,
    transport: runtime.transport,
    inboxPort: runtime.inboxPort,
    inboxRelay: runtime.inboxRelay,
    makerIdentity,
    onChange: (trade) => {
      void trading.refreshTrades();
      if (trade.phase === "filled") void wallet.refresh();
    },
    onMakerAccepted: (trade) => {
      trading.tradeTrace(trade);
      status.report("Incoming order accepted automatically");
    },
    onError: (message) => status.report(message, true),
    onMakerError: (message) => {
      status.trace("Nostr", "Maker inbox error", [
        { label: "error", value: message }
      ]);
      status.report(message, true);
    }
  }));
  return tradeControllerPromise;
}

/** Stops the live controller and drops both it and the runtime behind it. */
async function resetTradeController(): Promise<void> {
  const controller = tradeControllerPromise;
  tradeControllerPromise = undefined;
  resetTradeRuntime?.();
  if (controller !== undefined) {
    await controller.then((live) => live.stop()).catch(() => undefined);
  }
}

// Discovery is a 300 ms race at worst and resolves `null` on a page with no
// extension, which renders the install offer instead of the connect button.
// It runs above the node connect on purpose: an unreachable node must not be
// reported as a missing wallet, so the masthead can still say which extension
// is installed while the banner explains why nothing can be signed.
const detectedProvider = await detectInjectedProvider(window).catch(() => null);

const wallet = createWalletSurface({
  elements: {
    dashboard: byId("dashboard"),
    walletSummary: byId("wallet-summary"),
    accountActions: byId("account-actions"),
    walletControl: byId("wallet-control"),
    refreshButton: byId<HTMLButtonElement>("refresh")
  },
  status,
  config,
  detectedProvider,
  walletApi: () => walletApi,
  locked,
  setTokens: (next) => { tokens = next; },
  resetTradeController,
  clearTradeTraces: () => trading.clearTradeTraces(),
  repaintWalletDependentSurfaces: (connected) =>
    trading.repaintWalletDependentSurfaces(connected)
});

// Dynamic on purpose: the SDK resolves to one opaque 1.3 MB pre-webpacked
// bundle (plus a 620 KB argon2 chunk) that no bundler can tree-shake. Loading
// it through import() keeps it out of the entry chunk, so the static page and
// the Nostr order book are interactive while the chain SDK streams in.
const { ChainMismatchError, SdkZenonNode } = await import("./zenon/sdk-node.js");

try {
  const node = await SdkZenonNode.connect({
    nodeUrl: config.nodeUrl,
    chainId: config.chainId
  });
  const api = new ZwapApi({ node, config, provider: detectedProvider });
  walletApi = api;
  api.onAccountsChanged((accounts) => wallet.accountsChanged(accounts));
  let runtimePromise: Promise<BrowserTradeRuntime> | undefined;
  resetTradeRuntime = () => { runtimePromise = undefined; };
  createTradeRuntime = async () => {
    const account = api.account();
    if (account === null) throw new Error("Connect your wallet before trading");
    // Same rationale as the sdk-node import above: the runtime statically
    // drags the HTLC contract codec and with it the whole SDK bundle.
    const { createBrowserTradeRuntime } = await import("./browser/trade-runtime.js");
    runtimePromise ??= createBrowserTradeRuntime({
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
  status.blockTrading(
    error instanceof ChainMismatchError
      ? `${error.message}. Point VITE_ZENON_NODE_WS at a chain ${config.chainId} node and reload.`
      : `Cannot reach the Zenon node at ${config.nodeUrl}: ${messageOf(error)}`
  );
}

const makerInbox = createMakerInboxSurface({
  status,
  orderApi,
  walletApi: () => walletApi,
  tradeController
});

const trading = createTradingSurface({
  elements: {
    orderbook: byId("orderbook"),
    pendingPublications: byId("pending-publications"),
    trades: byId("trades"),
    orderSettlementHint: byId("order-settlement-hint"),
    orderForm: byId<HTMLFormElement>("order-form"),
    refreshOrderbookButton: byId<HTMLButtonElement>("refresh-orderbook"),
    refreshTradesButton: byId<HTMLButtonElement>("refresh-trades")
  },
  status,
  orderApi,
  relayClient,
  walletApi: () => walletApi,
  requireWallet: wallet.requireWallet,
  refresh: () => wallet.refresh(),
  tokens: () => tokens,
  tradeController,
  syncMakerInboxes: makerInbox.syncMakerInboxes
});

if (!hasNativeWebLocks()) {
  status.log("Web Locks API unavailable. Using single-tab mode; keep zwap in one tab. Use HTTPS and a browser with Web Locks for multi-tab workflows.");
  status.report("Web Locks unavailable: single-tab mode enabled. Do not open zwap in another tab.");
}

installZwapFacade({
  elements: {
    resetLocalDataButton: byId<HTMLButtonElement>("reset-local-data"),
    resetLocalDataConfirmation: byId<HTMLInputElement>("reset-local-data-confirmation")
  },
  status,
  orderApi,
  driver,
  locked,
  tradeController,
  wallet: {
    getState: wallet.getState,
    connectWallet: wallet.connectWallet,
    disconnectWallet: wallet.disconnectWallet,
    receivePending: wallet.receivePending,
    send: wallet.send,
    teardownWallet: wallet.teardownWallet
  },
  trading: {
    publishOrderWithFunding: trading.publishOrderWithFunding,
    refreshTrades: trading.refreshTrades
  }
});

// The masthead badge is the page's honesty about which chain it is signing on.
const networkBadge = byId("network-badge");
networkBadge.textContent = config.chainId === 1
  ? "MAINNET · REAL FUNDS"
  : `TESTNET · CHAIN ${config.chainId}`;
networkBadge.classList.toggle("nom-badge--warning", config.chainId === 1);
networkBadge.classList.toggle("nom-badge--outline", config.chainId !== 1);

// Each start-up read stands on its own: without a node the order book and the
// pending outbox still render, and only the wallet panel reports the outage.
for (const start of [
  () => wallet.refresh(),
  () => trading.refreshOrderBook(),
  () => trading.refreshPendingPublications(),
  () => startInboxListeners({
    startSessions: trading.refreshTrades,
    startMaker: makerInbox.syncMakerInboxes
  })
]) {
  void start().catch((error: unknown) => status.report(messageOf(error), true));
}
status.log("Opened zwap");

window.addEventListener("pagehide", () => {
  void tradeControllerPromise?.then((controller) => controller.stop()).catch(() => undefined);
  relayClient.dispose();
}, { once: true });
