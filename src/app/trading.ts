import type { OrderApi, PublishOrderInput } from "../api/order-api.js";
import type { ZwapApi } from "../api/zwap-api.js";
import type { BrowserTradeController } from "../browser/trade-controller.js";
import type { RelayClient } from "../nostr/relay.js";
import { fundingRequirement } from "../order/funding.js";
import type { OrderRecord } from "../order/model.js";
import type { PublicTradeView } from "../trade/session.js";
import { withButtonFeedback } from "../ui/button-feedback.js";
import { formatTokenAmount } from "../ui/format.js";
import { renderOrderBook } from "../ui/orderbook.js";
import { renderPendingPublications } from "../ui/order-outbox.js";
import { TakeRequestRegistry } from "../ui/take-request-registry.js";
import type { TokenLookup } from "../ui/tokens.js";
import { renderTrades } from "../ui/trades.js";
import { QSR_ZTS, ZNN_ZTS } from "../zenon/types.js";
import { mountOrderForm } from "./order-form.js";
import {
  messageOf,
  publicNpub,
  shortIdentifier,
  type StatusSurface
} from "./status.js";

const TOKEN_SYMBOLS: Record<string, string> = {
  [ZNN_ZTS]: "ZNN",
  [QSR_ZTS]: "QSR"
};

export interface TradingElements {
  orderbook: HTMLElement;
  pendingPublications: HTMLElement;
  trades: HTMLElement;
  orderSettlementHint: HTMLElement;
  orderForm: HTMLFormElement;
  refreshOrderbookButton: HTMLButtonElement;
  refreshTradesButton: HTMLButtonElement;
}

export interface TradingSurfaceInput {
  elements: TradingElements;
  status: StatusSurface;
  orderApi: OrderApi;
  relayClient: RelayClient;
  walletApi: () => ZwapApi | undefined;
  requireWallet: () => ZwapApi;
  refresh: () => Promise<unknown>;
  tokens: () => TokenLookup;
  tradeController: () => Promise<BrowserTradeController>;
  syncMakerInboxes: () => Promise<void>;
}

export interface TradingSurface {
  refreshOrderBook: () => Promise<void>;
  refreshTrades: () => Promise<void>;
  refreshPendingPublications: () => Promise<void>;
  publishOrderWithFunding: OrderApi["publishOrder"];
  tradeTrace: (trade: PublicTradeView) => void;
  clearTradeTraces: () => void;
  repaintWalletDependentSurfaces: (connected: boolean) => void;
}

export function createTradingSurface(input: TradingSurfaceInput): TradingSurface {
  const { elements, status, orderApi, relayClient, tokens } = input;
  const {
    orderbook, pendingPublications, trades, orderSettlementHint, orderForm
  } = elements;
  const { report, trace, log } = status;

  const tracedTradeMessages = new Set<string>();
  const tracedTradeCheckpoints = new Set<string>();
  const takeRequests = new TakeRequestRegistry();

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

  function clearTradeTraces(): void {
    tracedTradeMessages.clear();
    tracedTradeCheckpoints.clear();
  }

  /**
   * Take and Cancel are wired during the order-book paint and Retry during the
   * outbox paint, so neither follows `setWalletGating` — the wallet coming or
   * going has to repaint them, or a stale Take stays clickable after a
   * disconnect. Fire and forget: a failed repaint reports itself and must never
   * fail the wallet paint that triggered it.
   */
  function repaintWalletDependentSurfaces(connected: boolean): void {
    const reportFailure = (error: unknown): void => report(messageOf(error), true);
    void refreshOrderBook().catch(reportFailure);
    void refreshPendingPublications().catch(reportFailure);
    void refreshTrades().catch(reportFailure);
    // The maker listener runs off the trade runtime, so it can only start once
    // there is a signer for it.
    if (connected) void input.syncMakerInboxes().catch(reportFailure);
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
        status.blockedReason() === undefined && input.walletApi()?.status() === "connected"
          ? {
            tokens: tokens(),
            onTake: takeOrderFromBook,
            onCancel: cancelOrderFromBook,
            canCancel: (order) => identities.includes(order.makerPubkey)
          }
          // Read-only without a node or a wallet: taking and canceling both sign.
          : { tokens: tokens() }
      );
    } catch (error) {
      renderOrderBook(orderbook, { status: "error", message: messageOf(error) });
      throw error;
    }
  }

  /**
   * The journal is keyed to the address that signed those sessions, and the
   * trade runtime cannot even be built without a signer or a node. Say why
   * quietly rather than letting the runtime throw a red toast onto a page that
   * has no wallet connected — or no node to connect one to.
   */
  function renderTradesEmptyState(heading: string, note: string): void {
    trades.replaceChildren();
    trades.setAttribute("aria-live", "polite");
    const empty = document.createElement("div");
    empty.className = "empty-state nom-card";
    const title = document.createElement("h3");
    title.textContent = heading;
    const body = document.createElement("p");
    body.textContent = note;
    empty.append(title, body);
    trades.append(empty);
  }

  async function refreshTrades(): Promise<void> {
    const api = input.walletApi();
    if (api === undefined) {
      // No node, so no connect card: pointing at a connect button that cannot
      // work would blame the user for the node's outage.
      renderTradesEmptyState(
        "Zenon node unavailable",
        "Swap sessions need the node; see the banner above."
      );
      return;
    }
    if (api.status() !== "connected") {
      renderTradesEmptyState(
        "Connect your wallet to see your swaps",
        "Open swaps belong to the address that signed them."
      );
      return;
    }
    const controller = await input.tradeController();
    const current = await controller.resume();
    current.forEach(tradeTrace);
    renderTrades(trades, current, { tokens: tokens() });
  }

  /**
   * The exact chain balance an order must already hold before it is published:
   * the base leg for a sell, the settlement quote amount for a buy.
   */
  async function assertOrderFunding(order: PublishOrderInput): Promise<void> {
    const requirement = fundingRequirement({
      side: order.side,
      amount: order.amount,
      price: order.price
    });
    const token = requirement.token === "base" ? ZNN_ZTS : QSR_ZTS;
    const state = await input.requireWallet().getState();
    if (state.wallet !== "connected") {
      // Without a wallet the balances are empty by definition; "holds 0 ZNN"
      // would name the wrong problem.
      throw new Error("Connect your wallet before posting an order");
    }
    const held = state.balances.find((balance) => balance.tokenStandard === token);
    if (held === undefined || BigInt(held.balance) < BigInt(requirement.amount)) {
      // Say it in the units the form speaks, not the integers underneath.
      const info = tokens()(token);
      const symbol = held?.symbol ?? TOKEN_SYMBOLS[token] ?? info.symbol;
      const decimals = held?.decimals ?? info.decimals;
      throw new Error(
        `This order needs ${formatTokenAmount(requirement.amount, decimals, symbol)} ` +
        `on chain; this wallet holds ` +
        `${formatTokenAmount(held?.balance ?? "0", decimals, symbol)}`
      );
    }
  }

  const publishOrderWithFunding: OrderApi["publishOrder"] = async (order) => {
    await assertOrderFunding(order);
    const publication = await orderApi.publishOrder(order);
    // Publishing creates the order's fresh maker key. Keep the shared page's
    // maker side live without requiring a reload or a role-specific page.
    try {
      await input.syncMakerInboxes();
    } catch (error) {
      // A relay/listener refresh must not turn an already-published order into
      // a failed API result. The visible listener status remains actionable.
      report(messageOf(error), true);
    }
    return publication;
  };

  function takeOrderFromBook(
    order: OrderRecord,
    fillBaseAmount: string,
    button?: HTMLButtonElement
  ): void {
    const retryKey = `${order.address}:${order.eventId}:${fillBaseAmount}`;
    const requestId = takeRequests.reserve(retryKey);
    const task = async (): Promise<void> => {
      const trade = await (await input.tradeController()).takeOrder({
        requestId,
        address: order.address,
        expectedProjectionId: order.eventId,
        expectedRevision: order.state.revision,
        fillBaseAmount
      });
      tradeTrace(trade);
      report("Order taken; settling automatically");
      const result = await (await input.tradeController()).runUntilSettled(trade.sessionId);
      // Only now: a failed attempt keeps its reservation so the retry reuses the
      // same idempotency key instead of opening a second session for this fill.
      takeRequests.settle(retryKey);
      await Promise.all([refreshTrades(), input.refresh()]);
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
    const task = () => orderApi.retryOrderPublication(orderId);
    const request = button
      ? withButtonFeedback(button, "Retrying…", task)
      : task();
    void request
      .then(async (publication) => {
        await Promise.all([
          refreshOrderBook(),
          refreshPendingPublications(),
          input.syncMakerInboxes()
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
    const task = () => orderApi.cancelOrder({
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
        input.syncMakerInboxes()
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
    if (status.blockedReason() !== undefined) {
      status.disableRetryActions();
      return;
    }
    if (input.walletApi()?.status() !== "connected") {
      // Retry republishes a signed projection, so it waits for the wallet too.
      for (const node of document.querySelectorAll<HTMLButtonElement>(
        "#pending-publications button"
      )) {
        node.disabled = true;
        node.title = "Connect your wallet first";
      }
    }
  }

  const { refreshOrderbookButton, refreshTradesButton } = elements;
  refreshOrderbookButton.addEventListener("click", () => {
    void withButtonFeedback(refreshOrderbookButton, "Refreshing…", () => refreshOrderBook())
      .then(() => report("Order book refreshed from public relays"))
      .catch((error: unknown) => report(messageOf(error), true));
  });
  refreshTradesButton.addEventListener("click", () => {
    void withButtonFeedback(refreshTradesButton, "Checking…", () => refreshTrades())
      .then(() => report("Swap sessions refreshed from local state"))
      .catch((error: unknown) => report(messageOf(error), true));
  });

  mountOrderForm({
    elements: { orderForm, orderSettlementHint },
    status,
    tokens,
    publishOrder: publishOrderWithFunding,
    refreshOrderBook,
    refreshPendingPublications
  });

  return {
    refreshOrderBook,
    refreshTrades,
    refreshPendingPublications,
    publishOrderWithFunding,
    tradeTrace,
    clearTradeTraces,
    repaintWalletDependentSurfaces
  };
}
