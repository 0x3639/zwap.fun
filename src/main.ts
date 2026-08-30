import { Buffer } from "buffer";
(globalThis as { Buffer?: typeof Buffer }).Buffer ??= Buffer;

import { nip19 } from "nostr-tools";

import { OrderApi, type PublishOrderInput } from "./api/order-api.js";
import type { TradeApi, TakeOrderInput } from "./api/trade-api.js";
import { ZwapApi, type ZwapState } from "./api/zwap-api.js";
import {
  hasNativeWebLocks,
  withAccountLock,
  withOrderOutboxLock
} from "./browser/lock.js";
import { composeMakerIdentity } from "./browser/maker-identity-compose.js";
import { BrowserTradeController } from "./browser/trade-controller.js";
import { startInboxListeners } from "./browser/startup.js";
import {
  createBrowserTradeRuntime,
  type BrowserTradeRuntime
} from "./browser/trade-runtime.js";
import { browserConfig } from "./config.js";
import { fundingRequirement } from "./order/funding.js";
import type { OrderRecord } from "./order/model.js";
import { NostrOrderService } from "./order/service.js";
import { RelayClient } from "./nostr/relay.js";
import { OrderOutboxRepository } from "./storage/order-outbox.js";
import { IndexedDbStorageDriver } from "./storage/driver.js";
import { detectInjectedProvider } from "./zenon/injected-signer.js";
import { ChainMismatchError, SdkZenonNode } from "./zenon/sdk-node.js";
import { QSR_ZTS, ZNN_ZTS } from "./zenon/types.js";
import {
  renderAccountActions,
  type AccountActionHandlers
} from "./ui/account-actions.js";
import { renderDashboard, renderWalletSummary } from "./ui/dashboard.js";
import { formatTokenAmount } from "./ui/format.js";
import {
  describeSettlement,
  orderFormToPublishInput
} from "./ui/order-form.js";
import { renderOrderBook } from "./ui/orderbook.js";
import { renderPendingPublications } from "./ui/order-outbox.js";
import {
  renderWalletControl,
  type WalletControlHandlers
} from "./ui/wallet-control.js";
import { TakeRequestRegistry } from "./ui/take-request-registry.js";
import { applyTheme, mountThemeToggle } from "./ui/theme.js";
import { tokenDirectory, type TokenLookup } from "./ui/tokens.js";
import { renderTrades } from "./ui/trades.js";
import { withButtonFeedback } from "./ui/button-feedback.js";
import {
  renderActivityLog,
  type ActivityDetail,
  type ActivityEntry
} from "./ui/activity-log.js";
import type { PublicTradeView } from "./trade/session.js";

interface ZwapBrowserFacade {
  getState: ZwapApi["getState"];
  connectWallet: ZwapApi["connect"];
  disconnectWallet: () => Promise<void>;
  receivePending: ZwapApi["receivePending"];
  send: ZwapApi["send"];
  resetLocalData: (confirmation: string) => Promise<void>;
  getMakerPublicKeys: OrderApi["getMakerPublicKeys"];
  getOrderBook: OrderApi["getOrderBook"];
  publishOrder: OrderApi["publishOrder"];
  getPendingOrderPublications: OrderApi["getPendingOrderPublications"];
  retryOrderPublication: OrderApi["retryOrderPublication"];
  cancelOrder: OrderApi["cancelOrder"];
  listTrades: TradeApi["listTrades"];
  getTrade: TradeApi["getTrade"];
  takeOrder: TradeApi["takeOrder"];
  advanceTrade: TradeApi["advanceTrade"];
  runUntilSettled: BrowserTradeController["runUntilSettled"];
  enableMaker: BrowserTradeController["enableMaker"];
}

declare global {
  interface Window { zwap: ZwapBrowserFacade; }
}

function byId<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node as T;
}

const dashboard = byId("dashboard");
const walletSummary = byId("wallet-summary");
const accountActions = byId("account-actions");
const orderbook = byId("orderbook");
const pendingPublications = byId("pending-publications");
const trades = byId("trades");
const status = byId("status");
const orderSettlementHint = byId("order-settlement-hint");
const activity = byId<HTMLOListElement>("activity-log");
const walletControl = byId("wallet-control");

const activityEntries: ActivityEntry[] = [];
const tracedTradeMessages = new Set<string>();
const tracedTradeCheckpoints = new Set<string>();

// Paint the theme before anything else touches the DOM so the first frame is
// already in the user's chosen mode rather than flashing the default.
applyTheme(document.documentElement);
mountThemeToggle(byId<HTMLButtonElement>("theme-toggle"), document.documentElement);

let blockedReason: string | undefined;

function showStatus(message: string, error: boolean): void {
  status.textContent = message;
  status.classList.toggle("error", error);
  status.classList.add("visible");
}

/**
 * A permanent banner. The page still renders — the order book and the local
 * trade journal are readable without a node — but nothing that signs or reads
 * chain state can run, so the message must not be scrolled away by a later
 * transient report.
 */
function blockTrading(message: string): void {
  blockedReason = message;
  showStatus(message, true);
  document.documentElement.dataset.zwapChain = "unavailable";
  // Erasing this browser's zwap data stays reachable: it needs no node, and a
  // user who cannot reach one must still be able to get out.
  for (const node of document.querySelectorAll<HTMLButtonElement>(
    "#order-form button[type=submit], #refresh"
  )) {
    node.disabled = true;
  }
  disableRetryActions();
}

/**
 * Retry is wired on every outbox paint whether or not a node is reachable, so
 * it has to be disabled after the fact. Take and Cancel need no equivalent:
 * `refreshOrderBook` stops passing their handlers while blocked, so the
 * buttons are never rendered — which also leaves the show-more toggle usable.
 */
function disableRetryActions(): void {
  for (const node of document.querySelectorAll<HTMLButtonElement>(
    "#pending-publications button"
  )) {
    node.disabled = true;
    node.title = blockedReason ?? "";
  }
}

function clearStatus(): void {
  if (blockedReason !== undefined) return;
  status.classList.remove("visible");
}

function report(message: string, error = false): void {
  if (blockedReason !== undefined) {
    // The banner owns `#status` while trading is blocked, but a swallowed
    // error is worse than a crowded status bar: keep it findable.
    console.warn(`[zwap] suppressed while blocked: ${message}`);
    trace(error ? "Error" : "Activity", message, [
      { label: "suppressed by", value: blockedReason }
    ]);
    return;
  }
  showStatus(message, error);
  window.setTimeout(clearStatus, 5000);
}

function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

const config = browserConfig();
/** One storage namespace per browser origin. The literal is the pre-existing default profile name, kept so nothing already stored is orphaned. */
const STORAGE_NAME = "zwap-wallet-default";
const driver = new IndexedDbStorageDriver(STORAGE_NAME);
const locked = <T>(action: () => Promise<T>): Promise<T> =>
  withAccountLock("default", action);
const outboxLocked = <T>(action: () => Promise<T>): Promise<T> =>
  withOrderOutboxLock("default", action);
// Order signing keys are encrypted at rest under their own lock: the encrypted
// driver re-acquires it on every read and write while the facade may already
// hold the account lock. See `composeMakerIdentity`.
const makerIdentity = composeMakerIdentity(driver, "default");
const relayClient = new RelayClient();
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
  blockTrading(
    error instanceof ChainMismatchError
      ? `${error.message}. Point VITE_ZENON_NODE_WS at a chain ${config.chainId} node and reload.`
      : `Cannot reach the Zenon node at ${config.nodeUrl}: ${messageOf(error)}`
  );
}

function requireWallet(): ZwapApi {
  if (walletApi === undefined) {
    throw new Error(blockedReason ?? "The Zenon node is unavailable");
  }
  return walletApi;
}

let tradeControllerPromise: Promise<BrowserTradeController> | undefined;

function log(message: string): void {
  trace("Activity", message);
}

function trace(label: string, title: string, details: ActivityDetail[] = []): void {
  activityEntries.unshift({ at: Date.now(), label, title, details });
  activityEntries.splice(100);
  renderActivityLog(activity, activityEntries);
}

function shortIdentifier(value: string): ActivityDetail {
  return { label: "id", value: `${value.slice(0, 8)}…`, title: value };
}

function publicNpub(label: string, pubkey: string): ActivityDetail {
  const npub = nip19.npubEncode(pubkey);
  return { label, value: `${npub.slice(0, 12)}…${npub.slice(-8)}`, title: npub };
}

function tradeTrace(trade: PublicTradeView): void {
  const checkpointKey = `${trade.sessionId}:${trade.revision}:${trade.phase}`;
  if (!tracedTradeCheckpoints.has(checkpointKey)) {
    tracedTradeCheckpoints.add(checkpointKey);
    trace("Protocol", "Trade state accepted", [
      { label: "role", value: trade.role },
      { label: "phase", value: trade.phase },
      shortIdentifier(trade.sessionId),
      shortIdentifier(trade.reservationId),
      { label: "order address", value: `${trade.orderAddress.slice(0, 22)}…`, title: trade.orderAddress },
      shortIdentifier(trade.offeredProjectionId),
      ...(trade.protocol.localNostrPubkey === null
        ? []
        : [publicNpub("local npub", trade.protocol.localNostrPubkey)]),
      publicNpub("order npub", trade.protocol.orderAuthorityPubkey),
      ...(trade.protocol.counterpartyNostrPubkey === null
        ? []
        : [publicNpub("counterparty", trade.protocol.counterpartyNostrPubkey)])
    ]);
  }

  const inboxKey = `${trade.sessionId}:${trade.protocol.inbox.registrationEventId}:${trade.protocol.inbox.status}`;
  if (!tracedTradeCheckpoints.has(inboxKey) && trade.protocol.inbox.status !== "unregistered") {
    tracedTradeCheckpoints.add(inboxKey);
    trace("Inbox", "Private inbox updated", [
      { label: "status", value: trade.protocol.inbox.status },
      ...(trade.protocol.inbox.registrationEventId === null
        ? []
        : [shortIdentifier(trade.protocol.inbox.registrationEventId)]),
      { label: "relays", value: String(trade.protocol.inbox.relayCount) },
      { label: "acks", value: String(trade.protocol.inbox.acknowledgements) },
      ...(trade.protocol.localNostrPubkey === null
        ? []
        : [publicNpub("recipient", trade.protocol.localNostrPubkey)])
    ]);
  }

  for (const message of trade.protocol.messages) {
    const messageKey = `${trade.sessionId}:${message.messageId}`;
    if (tracedTradeMessages.has(messageKey)) continue;
    tracedTradeMessages.add(messageKey);
    trace("DM", `${message.type ?? "Private message"} accepted`, [
      { label: "sequence", value: message.sequence },
      shortIdentifier(message.messageId),
      shortIdentifier(message.rumorId),
      shortIdentifier(message.transcriptHash),
      ...(message.authorPubkey === undefined ? [] : [publicNpub("from", message.authorPubkey)]),
      ...(message.recipientPubkey === undefined ? [] : [publicNpub("to", message.recipientPubkey)])
    ]);
  }
}

const TOKEN_SYMBOLS: Record<string, string> = {
  [ZNN_ZTS]: "ZNN",
  [QSR_ZTS]: "QSR"
};

/**
 * Symbols and decimals from the last wallet read, so the order book and the
 * trade cards label amounts with what the chain actually reported rather than
 * a hard-coded table. Falls back to ZNN/QSR before the first read lands.
 */
let tokens: TokenLookup = tokenDirectory();

function unavailable(): string {
  return blockedReason ?? "The Zenon node is unavailable";
}

/**
 * One paint for the whole wallet surface: the strip above the order book, the
 * account panel, and the ledger. Every one of them reads the same snapshot, so
 * they can never disagree about the balance.
 */
async function refresh(state?: ZwapState): Promise<ZwapState> {
  if (walletApi === undefined) {
    walletSummary.textContent = unavailable();
    dashboard.textContent = unavailable();
    accountActions.textContent = unavailable();
    renderWalletControl(walletControl, {
      wallet: "absent",
      providerName: null,
      address: null,
      network: config.network,
      chainId: config.chainId,
      balances: [],
      unreceived: 0,
      plasma: null
    }, walletHandlers);
    throw new Error(unavailable());
  }
  const next = state ?? await requireWallet().getState();
  tokens = tokenDirectory(next.balances);
  renderWalletSummary(walletSummary, next);
  renderDashboard(dashboard, next);
  renderAccountActions(accountActions, next, accountHandlers);
  renderWalletControl(walletControl, next, walletHandlers);
  setWalletGating(next.wallet === "connected");
  return next;
}

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

async function refreshOrderBook(): Promise<void> {
  renderOrderBook(orderbook, { status: "loading" });
  try {
    const [result, identities] = await Promise.all([
      orderApi.getOrderBook(),
      orderApi.getMakerPublicKeys()
    ]);
    renderOrderBook(
      orderbook,
      { status: "ready", book: result.book },
      blockedReason === undefined && walletApi?.status() === "connected"
        ? {
          tokens,
          onTake: takeOrderFromBook,
          onCancel: cancelOrderFromBook,
          canCancel: (order) => identities.includes(order.makerPubkey)
        }
        // Read-only without a node or a wallet: taking and canceling both sign.
        : { tokens }
    );
  } catch (error) {
    renderOrderBook(orderbook, { status: "error", message: messageOf(error) });
    throw error;
  }
}

function tradeController(): Promise<BrowserTradeController> {
  if (createTradeRuntime === undefined) {
    return Promise.reject(new Error(blockedReason ?? "The Zenon node is unavailable"));
  }
  tradeControllerPromise ??= createTradeRuntime().then((runtime) => new BrowserTradeController({
    api: runtime.api,
    sessions: runtime.sessions,
    transport: runtime.transport,
    inboxPort: runtime.inboxPort,
    inboxRelay: runtime.inboxRelay,
    makerIdentity,
    onChange: (trade) => {
      void refreshTrades();
      if (trade.phase === "filled") void refresh();
    },
    onMakerAccepted: (trade) => {
      tradeTrace(trade);
      report("Incoming order accepted automatically");
    },
    onError: (message) => report(message, true),
    onMakerError: (message) => {
      trace("Nostr", "Maker inbox error", [
        { label: "error", value: message }
      ]);
      report(message, true);
    }
  }));
  return tradeControllerPromise;
}

async function refreshTrades(): Promise<void> {
  const controller = await tradeController();
  const current = await controller.resume();
  current.forEach(tradeTrace);
  renderTrades(trades, current, { tokens });
}

/**
 * The exact chain balance an order must already hold before it is published:
 * the base leg for a sell, the settlement quote amount for a buy.
 */
async function assertOrderFunding(input: PublishOrderInput): Promise<void> {
  const requirement = fundingRequirement({
    side: input.side,
    amount: input.amount,
    price: input.price
  });
  const token = requirement.token === "base" ? ZNN_ZTS : QSR_ZTS;
  const state = await requireWallet().getState();
  const held = state.balances.find((balance) => balance.tokenStandard === token);
  if (held === undefined || BigInt(held.balance) < BigInt(requirement.amount)) {
    // Say it in the units the form speaks, not the integers underneath.
    const info = tokens(token);
    const symbol = held?.symbol ?? TOKEN_SYMBOLS[token] ?? info.symbol;
    const decimals = held?.decimals ?? info.decimals;
    throw new Error(
      `This order needs ${formatTokenAmount(requirement.amount, decimals, symbol)} ` +
      `on chain; this wallet holds ` +
      `${formatTokenAmount(held?.balance ?? "0", decimals, symbol)}`
    );
  }
}

async function publishOrderWithFunding(input: PublishOrderInput) {
  await assertOrderFunding(input);
  const publication = await orderApi.publishOrder(input);
  // Publishing creates the order's fresh maker key. Keep the shared page's
  // maker side live without requiring a reload or a role-specific page.
  try {
    await syncMakerInboxes();
  } catch (error) {
    // A relay/listener refresh must not turn an already-published order into
    // a failed API result. The visible listener status remains actionable.
    report(messageOf(error), true);
  }
  return publication;
}

const takeRequests = new TakeRequestRegistry();

function takeOrderFromBook(
  order: OrderRecord,
  fillBaseAmount: string,
  button?: HTMLButtonElement
): void {
  const retryKey = `${order.address}:${order.eventId}:${fillBaseAmount}`;
  const requestId = takeRequests.reserve(retryKey);
  const task = async (): Promise<void> => {
    const trade = await zwap.takeOrder({
      requestId,
      address: order.address,
      expectedProjectionId: order.eventId,
      expectedRevision: order.state.revision,
      fillBaseAmount
    });
    tradeTrace(trade);
    report("Order taken; settling automatically");
    const result = await zwap.runUntilSettled(trade.sessionId);
    // Only now: a failed attempt keeps its reservation so the retry reuses the
    // same idempotency key instead of opening a second session for this fill.
    takeRequests.settle(retryKey);
    await Promise.all([refreshTrades(), refresh()]);
    report(`Swap filled after ${result.checkpoints.length} verified actions`);
    void refreshOrderBook().catch(() => {
      report("Swap filled; order book refresh will retry automatically");
    });
  };
  const request = button
    ? withButtonFeedback(button, "Settling…", task)
    : task();
  void request.catch((error: unknown) => report(messageOf(error), true));
}

function retryPendingPublication(orderId: string, button?: HTMLButtonElement): void {
  const task = () => zwap.retryOrderPublication(orderId);
  const request = button
    ? withButtonFeedback(button, "Retrying…", task)
    : task();
  void request
    .then(async (publication) => {
      await Promise.all([
        refreshOrderBook(),
        refreshPendingPublications(),
        syncMakerInboxes()
      ]);
      log(`Republished exact order projection ${publication.orderId.slice(0, 8)}…`);
      report("Pending signed projection received a relay acknowledgement");
    })
    .catch(async (error: unknown) => {
      await refreshPendingPublications();
      report(messageOf(error), true);
    });
}

function cancelOrderFromBook(order: OrderRecord, button?: HTMLButtonElement): void {
  const task = () => zwap.cancelOrder({
    address: order.address,
    expectedProjectionId: order.eventId,
    expectedRevision: order.state.revision
  });
  const request = button
    ? withButtonFeedback(button, "Canceling…", task)
    : task();
  void request.then(async () => {
    await Promise.all([
      refreshOrderBook(),
      refreshPendingPublications(),
      syncMakerInboxes()
    ]);
    log(`Canceled order ${order.state.order_id.slice(0, 8)}…`);
    report("Canceled order projection received a relay acknowledgement");
  }).catch((error: unknown) => report(messageOf(error), true));
}

async function refreshPendingPublications(): Promise<void> {
  renderPendingPublications(
    pendingPublications,
    await orderApi.getPendingOrderPublications(),
    retryPendingPublication,
    relayClient.relays.length
  );
  if (blockedReason !== undefined) {
    disableRetryActions();
    return;
  }
  if (walletApi?.status() !== "connected") {
    // Retry republishes a signed projection, so it waits for the wallet too.
    for (const node of document.querySelectorAll<HTMLButtonElement>(
      "#pending-publications button"
    )) {
      node.disabled = true;
      node.title = "Connect your wallet first";
    }
  }
}

/**
 * Drops everything that outlived the connected wallet. The trade runtime holds
 * the extension's signer and the maker listener runs off that runtime, so both
 * must go the moment the page stops signing for that address.
 */
async function teardownWallet(): Promise<void> {
  walletApi?.disconnect();
  const controller = tradeControllerPromise;
  tradeControllerPromise = undefined;
  resetTradeRuntime?.();
  if (controller !== undefined) {
    await controller.then((live) => live.stop()).catch(() => undefined);
  }
  tracedTradeMessages.clear();
  tracedTradeCheckpoints.clear();
}

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
  getMakerPublicKeys: orderApi.getMakerPublicKeys.bind(orderApi),
  getOrderBook: orderApi.getOrderBook.bind(orderApi),
  publishOrder: publishOrderWithFunding,
  getPendingOrderPublications: orderApi.getPendingOrderPublications.bind(orderApi),
  retryOrderPublication: orderApi.retryOrderPublication.bind(orderApi),
  cancelOrder: orderApi.cancelOrder.bind(orderApi),
  listTrades: async () => (await tradeController()).listTrades(),
  getTrade: async (sessionId) => (await tradeController()).getTrade(sessionId),
  takeOrder: async (input: TakeOrderInput) => (await tradeController()).takeOrder(input),
  advanceTrade: async (sessionId) => (await tradeController()).advanceTrade(sessionId),
  runUntilSettled: async (sessionId) =>
    (await tradeController()).runUntilSettled(sessionId),
  enableMaker: async () => (await tradeController()).enableMaker()
};
window.zwap = zwap;

if (!hasNativeWebLocks()) {
  log("Web Locks API unavailable. Using single-tab mode; keep zwap in one tab. Use HTTPS and a browser with Web Locks for multi-tab workflows.");
  report("Web Locks unavailable: single-tab mode enabled. Do not open zwap in another tab.");
}

let makerInboxStartPromise: Promise<void> | undefined;
let makerInboxResyncQueued = false;
let makerInboxRetryAttempt = 0;
let makerInboxRetryTimer: ReturnType<typeof globalThis.setTimeout> | undefined;

async function syncMakerInboxes(): Promise<void> {
  const publicKeys = await zwap.getMakerPublicKeys();
  if (publicKeys.length === 0) {
    return;
  }
  await startMakerInbox();
}

function startMakerInbox(): Promise<void> {
  if (makerInboxStartPromise !== undefined) {
    makerInboxResyncQueued = true;
    const current = makerInboxStartPromise;
    return current.then(() => {
      if (!makerInboxResyncQueued) return;
      makerInboxResyncQueued = false;
      return startMakerInbox();
    });
  }
  makerInboxStartPromise = zwap.enableMaker()
    .then(({ makerPubkey, inboxRelay }) => {
      makerInboxRetryAttempt = 0;
      if (makerInboxRetryTimer !== undefined) {
        globalThis.clearTimeout(makerInboxRetryTimer);
        makerInboxRetryTimer = undefined;
      }
      if (!makerPubkey) {
        return;
      }
      trace("Nostr", "Maker listener ready", [
        { label: "meaning", value: "public order authority for maker inbox discovery" },
        publicNpub("order npub", makerPubkey),
        { label: "relay", value: new URL(inboxRelay).host }
      ]);
      report("Maker listener is authenticated and listening");
    })
    .catch((error: unknown) => {
      const retryDelay = Math.min(
        10_000,
        500 * (2 ** Math.min(makerInboxRetryAttempt, 4))
      );
      makerInboxRetryAttempt += 1;
      trace("Nostr", "Maker listener reconnecting", [
        { label: "error", value: messageOf(error) },
        { label: "retry", value: `${retryDelay} ms` }
      ]);
      report("Maker listener unavailable; retrying automatically");
      if (makerInboxRetryTimer === undefined) {
        makerInboxRetryTimer = globalThis.setTimeout(() => {
          makerInboxRetryTimer = undefined;
          void syncMakerInboxes();
        }, retryDelay);
      }
    })
    .finally(() => {
      makerInboxStartPromise = undefined;
    });
  return makerInboxStartPromise;
}

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

function runAgentSettlement(sessionId: string): void {
  const root = document.documentElement;
  if (!/^[0-9a-f]{64}$/.test(sessionId)) {
    root.dataset.zwapRunStatus = "error";
    root.dataset.zwapRunError = "Agent run requires a lowercase hex session ID";
    return;
  }
  if (root.dataset.zwapRunStatus === "running") return;
  root.dataset.zwapRunStatus = "running";
  delete root.dataset.zwapRunResult;
  delete root.dataset.zwapRunError;
  void zwap.runUntilSettled(sessionId)
    .then(async (result) => {
      root.dataset.zwapRunResult = JSON.stringify(result);
      root.dataset.zwapRunStatus = "filled";
      await refreshTrades();
    })
    .catch((error: unknown) => {
      root.dataset.zwapRunError = messageOf(error);
      root.dataset.zwapRunStatus = "error";
    });
}

document.addEventListener("zwap:run-until-settled", () => {
  runAgentSettlement(document.documentElement.dataset.zwapRunSession ?? "");
});

const requestedAgentRun = new URL(window.location.href).searchParams
  .get("runUntilSettled");
if (requestedAgentRun !== null) runAgentSettlement(requestedAgentRun);

// The masthead badge is the page's honesty about which chain it is signing on.
const networkBadge = byId("network-badge");
networkBadge.textContent = config.chainId === 1
  ? "MAINNET · REAL FUNDS"
  : `TESTNET · CHAIN ${config.chainId}`;
networkBadge.classList.toggle("nom-badge--warning", config.chainId === 1);
networkBadge.classList.toggle("nom-badge--outline", config.chainId !== 1);

const refreshButton = byId<HTMLButtonElement>("refresh");
refreshButton.addEventListener("click", () => {
  void withButtonFeedback(refreshButton, "Refreshing…", () => refresh())
    .then(() => report("Wallet state refreshed"))
    .catch((error: unknown) => report(messageOf(error), true));
});
const refreshOrderbookButton = byId<HTMLButtonElement>("refresh-orderbook");
refreshOrderbookButton.addEventListener("click", () => {
  void withButtonFeedback(refreshOrderbookButton, "Refreshing…", () => refreshOrderBook())
    .then(() => report("Order book refreshed from public relays"))
    .catch((error: unknown) => report(messageOf(error), true));
});
const refreshTradesButton = byId<HTMLButtonElement>("refresh-trades");
refreshTradesButton.addEventListener("click", () => {
  void withButtonFeedback(refreshTradesButton, "Checking…", () => refreshTrades())
    .then(() => report("Swap sessions refreshed from local state"))
    .catch((error: unknown) => report(messageOf(error), true));
});
const orderForm = byId<HTMLFormElement>("order-form");
function requiredOrderInput(name: string): HTMLInputElement {
  const input = orderForm.querySelector<HTMLInputElement>(`input[name="${name}"]`);
  if (input === null) throw new Error(`Missing order input ${name}`);
  return input;
}
const orderAmountInput = requiredOrderInput("amount");
const orderPriceInput = requiredOrderInput("price");
const orderSubmitButton = orderForm.querySelector<HTMLButtonElement>("button[type=submit]");
if (orderSubmitButton === null) throw new Error("Missing order submit button");

const defaultOrderSettlementHint = orderSettlementHint.textContent ?? "";

function updateOrderSettlementHint(): void {
  orderAmountInput.setCustomValidity("");
  // `null` while the form is mid-edit: the default copy is honest, a stale
  // number would not be. Native patterns and the submit handler own the error.
  orderSettlementHint.textContent =
    describeSettlement(orderAmountInput.value.trim(), orderPriceInput.value.trim(), tokens) ??
    defaultOrderSettlementHint;
}

orderAmountInput.addEventListener("input", () => updateOrderSettlementHint());
orderPriceInput.addEventListener("input", () => updateOrderSettlementHint());
orderAmountInput.addEventListener("change", () => updateOrderSettlementHint());
orderPriceInput.addEventListener("change", () => updateOrderSettlementHint());
orderAmountInput.addEventListener("invalid", () => {
  if (orderAmountInput.validationMessage.length > 0) {
    report(orderAmountInput.validationMessage, true);
  }
});
updateOrderSettlementHint();

orderForm.addEventListener("submit", (event) => {
  event.preventDefault();
  updateOrderSettlementHint();
  const form = new FormData(event.currentTarget as HTMLFormElement);
  void withButtonFeedback(orderSubmitButton, "Posting…", async () => {
    // One pure conversion from what was typed to what gets signed; the same
    // token decimals drive it and the settlement hint above.
    const input: PublishOrderInput = orderFormToPublishInput(
      {
        side: String(form.get("side")),
        amount: String(form.get("amount")),
        price: String(form.get("price")),
        hours: String(form.get("hours"))
      },
      tokens,
      Math.floor(Date.now() / 1000)
    );
    const side = input.side;
    const publication = await zwap.publishOrder(input);
    const acknowledgements = publication.receipts.filter((receipt) => receipt.ok).length;
    trace("Order", "Public order published", [
      { label: "side", value: side },
      shortIdentifier(publication.orderId),
      shortIdentifier(publication.projectionId),
      { label: "revision", value: publication.revision },
      publicNpub("order npub", publication.makerPubkey),
      { label: "relay acks", value: String(acknowledgements) }
    ]);
    await Promise.all([refreshOrderBook(), refreshPendingPublications()]);
    report(`Order published with ${acknowledgements} relay acknowledgements`);
  }).catch(async (error: unknown) => {
    await refreshPendingPublications();
    report(messageOf(error), true);
  });
});

const resetLocalDataButton = byId<HTMLButtonElement>("reset-local-data");
resetLocalDataButton.addEventListener("click", () => {
  void withButtonFeedback(resetLocalDataButton, "Erasing…", () => zwap.resetLocalData("RESET ZWAP DATA"))
    .then(() => window.location.reload())
    .catch((error: unknown) => report(messageOf(error), true));
});

// Each start-up read stands on its own: without a node the order book and the
// pending outbox still render, and only the wallet panel reports the outage.
for (const start of [
  () => refresh(),
  () => refreshOrderBook(),
  () => refreshPendingPublications(),
  () => startInboxListeners({
    startSessions: refreshTrades,
    startMaker: syncMakerInboxes
  })
]) {
  void start().catch((error: unknown) => report(messageOf(error), true));
}
log("Opened zwap");

window.addEventListener("pagehide", () => {
  void tradeControllerPromise?.then((controller) => controller.stop()).catch(() => undefined);
  relayClient.dispose();
}, { once: true });
