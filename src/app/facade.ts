import type { OrderApi } from "../api/order-api.js";
import type { TakeOrderInput, TradeApi } from "../api/trade-api.js";
import type { ZwapApi } from "../api/zwap-api.js";
import type { BrowserTradeController } from "../browser/trade-controller.js";
import { withButtonFeedback } from "../ui/button-feedback.js";
import { messageOf, type StatusSurface } from "./status.js";

export interface ZwapBrowserFacade {
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

/** The exact phrase that unlocks the danger zone, typed by hand or passed by an agent. */
export const RESET_LOCAL_DATA_CONFIRMATION = "RESET ZWAP DATA";

export interface FacadeElements {
  resetLocalDataButton: HTMLButtonElement;
  resetLocalDataConfirmation: HTMLInputElement;
}

export interface FacadeInput {
  elements: FacadeElements;
  status: StatusSurface;
  orderApi: OrderApi;
  driver: { resetDatabase: () => Promise<void> };
  locked: <T>(action: () => Promise<T>) => Promise<T>;
  tradeController: () => Promise<BrowserTradeController>;
  wallet: {
    getState: ZwapApi["getState"];
    connectWallet: ZwapApi["connect"];
    disconnectWallet: () => Promise<void>;
    receivePending: ZwapApi["receivePending"];
    send: ZwapApi["send"];
    teardownWallet: () => Promise<void>;
  };
  trading: {
    publishOrderWithFunding: OrderApi["publishOrder"];
    refreshTrades: () => Promise<void>;
  };
}

/**
 * `window.zwap` is the whole agent-facing surface. Everything on it is already
 * implemented by the surface that owns it; this module only assembles them,
 * plus the two operations that belong to nothing else: erasing this browser's
 * data and driving a settlement head-lessly.
 */
export function installZwapFacade(input: FacadeInput): ZwapBrowserFacade {
  const { elements, status, orderApi, driver, locked, wallet, trading } = input;
  const { report } = status;

  const zwap: ZwapBrowserFacade = {
    getState: wallet.getState,
    connectWallet: wallet.connectWallet,
    disconnectWallet: wallet.disconnectWallet,
    receivePending: wallet.receivePending,
    send: wallet.send,
    resetLocalData: async (confirmation) => {
      if (confirmation !== RESET_LOCAL_DATA_CONFIRMATION) {
        throw new Error("Type RESET ZWAP DATA to erase this browser's zwap data");
      }
      // Teardown first: the runtime and the maker listener hold the database
      // this is about to delete. Runs outside the account lock, which `stop()`
      // takes itself.
      await wallet.teardownWallet();
      await locked(() => driver.resetDatabase());
    },
    getMakerPublicKeys: orderApi.getMakerPublicKeys.bind(orderApi),
    getOrderBook: orderApi.getOrderBook.bind(orderApi),
    publishOrder: trading.publishOrderWithFunding,
    getPendingOrderPublications: orderApi.getPendingOrderPublications.bind(orderApi),
    retryOrderPublication: orderApi.retryOrderPublication.bind(orderApi),
    cancelOrder: orderApi.cancelOrder.bind(orderApi),
    listTrades: async () => (await input.tradeController()).listTrades(),
    getTrade: async (sessionId) => (await input.tradeController()).getTrade(sessionId),
    takeOrder: async (order: TakeOrderInput) => (await input.tradeController()).takeOrder(order),
    advanceTrade: async (sessionId) => (await input.tradeController()).advanceTrade(sessionId),
    runUntilSettled: async (sessionId) =>
      (await input.tradeController()).runUntilSettled(sessionId),
    enableMaker: async () => (await input.tradeController()).enableMaker()
  };
  window.zwap = zwap;

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
        await trading.refreshTrades();
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

  const { resetLocalDataButton, resetLocalDataConfirmation } = elements;
  /**
   * The disabled button is the affordance, not the gate: the typed phrase is
   * passed through to `resetLocalData`, which refuses anything else, so the real
   * check is the one an agent calling `window.zwap` also has to pass.
   * `endButtonFeedback` re-enables unconditionally, so re-gate after every run.
   */
  function syncResetLocalDataGate(): void {
    resetLocalDataButton.disabled =
      resetLocalDataConfirmation.value.trim() !== RESET_LOCAL_DATA_CONFIRMATION;
  }
  resetLocalDataConfirmation.addEventListener("input", syncResetLocalDataGate);
  resetLocalDataButton.addEventListener("click", () => {
    void withButtonFeedback(
      resetLocalDataButton,
      "Erasing…",
      () => zwap.resetLocalData(resetLocalDataConfirmation.value.trim())
    )
      .then(() => window.location.reload())
      .catch((error: unknown) => {
        syncResetLocalDataGate();
        report(messageOf(error), true);
      });
  });

  return zwap;
}
