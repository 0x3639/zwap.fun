import type { ZwapApi, ZwapState } from "../api/zwap-api.js";
import type { ZwapConfig } from "../config.js";
import type { DetectedProvider } from "../zenon/injected-signer.js";
import {
  renderAccountActions,
  type AccountActionHandlers
} from "../ui/account-actions.js";
import { withButtonFeedback } from "../ui/button-feedback.js";
import { renderDashboard, renderWalletSummary } from "../ui/dashboard.js";
import { tokenDirectory, type TokenLookup } from "../ui/tokens.js";
import {
  renderWalletControl,
  type WalletControlHandlers
} from "../ui/wallet-control.js";
import { messageOf, type StatusSurface } from "./status.js";

export interface WalletElements {
  dashboard: HTMLElement;
  walletSummary: HTMLElement;
  accountActions: HTMLElement;
  walletControl: HTMLElement;
  refreshButton: HTMLButtonElement;
}

export interface WalletSurfaceInput {
  elements: WalletElements;
  status: StatusSurface;
  config: ZwapConfig;
  detectedProvider: DetectedProvider | null;
  /** The live wallet API, or `undefined` while the node is unreachable. */
  walletApi: () => ZwapApi | undefined;
  locked: <T>(action: () => Promise<T>) => Promise<T>;
  setTokens: (tokens: TokenLookup) => void;
  /** Drops the memoised trade controller and runtime, stopping the live one. */
  resetTradeController: () => Promise<void>;
  clearTradeTraces: () => void;
  repaintWalletDependentSurfaces: (connected: boolean) => void;
}

export interface WalletSurface {
  refresh: (state?: ZwapState) => Promise<ZwapState>;
  requireWallet: () => ZwapApi;
  teardownWallet: () => Promise<void>;
  accountsChanged: (accounts: readonly unknown[]) => void;
  connectWallet: ZwapApi["connect"];
  disconnectWallet: () => Promise<void>;
  getState: ZwapApi["getState"];
  receivePending: ZwapApi["receivePending"];
  send: ZwapApi["send"];
}

export function createWalletSurface(input: WalletSurfaceInput): WalletSurface {
  const { elements, status, config, detectedProvider } = input;
  const { dashboard, walletSummary, accountActions, walletControl } = elements;
  const { unavailable, report, trace } = status;

  function requireWallet(): ZwapApi {
    const api = input.walletApi();
    if (api === undefined) {
      throw new Error(status.blockedReason() ?? "The Zenon node is unavailable");
    }
    return api;
  }

  /**
   * One paint for the whole wallet surface: the strip above the order book, the
   * account panel, and the ledger. Every one of them reads the same snapshot, so
   * they can never disagree about the balance.
   */
  async function refresh(state?: ZwapState): Promise<ZwapState> {
    if (input.walletApi() === undefined) {
      walletSummary.textContent = unavailable();
      dashboard.textContent = unavailable();
      accountActions.textContent = unavailable();
      // The wallet is whatever discovery found: without a node it cannot be
      // connected, but calling an installed extension "absent" would send the
      // user off to install one they already have. Connect stays wired and
      // fails with the banner's reason through `requireWallet`.
      renderWalletControl(walletControl, {
        wallet: detectedProvider === null ? "absent" : "detected",
        providerName: detectedProvider === null
          ? null
          : detectedProvider.info?.name ?? "Browser extension",
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
    input.setTokens(tokenDirectory(next.balances));
    renderWalletSummary(walletSummary, next);
    renderDashboard(dashboard, next);
    renderAccountActions(accountActions, next, accountHandlers);
    renderWalletControl(walletControl, next, walletHandlers);
    const connected = next.wallet === "connected";
    setWalletGating(connected);
    if (connected !== paintedWalletConnected) {
      paintedWalletConnected = connected;
      input.repaintWalletDependentSurfaces(connected);
    }
    return next;
  }

  /**
   * The page boots disconnected, and the start-up loop paints these surfaces
   * itself, so the first paint must not double the work.
   */
  let paintedWalletConnected = false;

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
      if (status.blockedReason() !== undefined) continue;
      node.disabled = !connected;
      node.title = connected ? "" : "Connect your wallet first";
    }
  }

  /**
   * Drops everything that outlived the connected wallet. The trade runtime holds
   * the extension's signer and the maker listener runs off that runtime, so both
   * must go the moment the page stops signing for that address.
   */
  async function teardownWallet(): Promise<void> {
    input.walletApi()?.disconnect();
    await input.resetTradeController();
    input.clearTradeTraces();
  }

  const connectWallet: ZwapApi["connect"] = () => requireWallet().connect();
  const disconnectWallet = async (): Promise<void> => {
    await teardownWallet();
    await refresh();
  };
  const receivePending: ZwapApi["receivePending"] = () =>
    input.locked(() => requireWallet().receivePending());
  const send: ZwapApi["send"] = (toAddress, tokenStandard, amount) =>
    input.locked(() => requireWallet().send(toAddress, tokenStandard, amount));

  const accountHandlers: AccountActionHandlers = {
    onReceive: (button: HTMLButtonElement) => {
      void withButtonFeedback(button, "Receiving…", () => receivePending())
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
      void withButtonFeedback(button, "Connecting…", () => connectWallet())
        .then((state) => refresh(state))
        .then((state) => {
          trace("Account", "Browser wallet connected", [
            { label: "wallet", value: state.providerName ?? "extension" },
            { label: "address", value: `${(state.address ?? "").slice(0, 8)}…` }
          ]);
          report("Wallet connected");
        })
        .catch((error: unknown) => report(messageOf(error), true));
    },
    onDisconnect: () => {
      void disconnectWallet()
        .then(() => { trace("Account", "Wallet disconnected"); report("Wallet disconnected"); })
        .catch((error: unknown) => report(messageOf(error), true));
    },
    onCopy: (address: string) => {
      void navigator.clipboard.writeText(address)
        .then(() => report("Address copied"))
        .catch((error: unknown) => report(messageOf(error), true));
    }
  };

  function accountsChanged(accounts: readonly unknown[]): void {
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
  }

  const { refreshButton } = elements;
  refreshButton.addEventListener("click", () => {
    void withButtonFeedback(refreshButton, "Refreshing…", () => refresh())
      .then(() => report("Wallet state refreshed"))
      .catch((error: unknown) => report(messageOf(error), true));
  });

  return {
    refresh,
    requireWallet,
    teardownWallet,
    accountsChanged,
    connectWallet,
    disconnectWallet,
    getState: () => requireWallet().getState(),
    receivePending,
    send
  };
}
