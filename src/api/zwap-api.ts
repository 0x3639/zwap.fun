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
  /**
   * Deliberately never reset. `InjectedZenonSigner.onAccountsChanged`
   * subscribes on the provider object, which is stable across reconnects, so
   * one subscription serves every signer this class builds; clearing this on
   * `disconnect()` would double-subscribe on the next connect and deliver
   * every account change twice.
   */
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
        // as an empty list: the page has no signer any more. It is forwarded
        // either way — `disconnect()` is idempotent and the page still wants
        // to log it. A non-empty list, though, only concerns a page that is
        // still connected: the subscription outlives `disconnect()`, and
        // handlers reload on an account switch, so forwarding one while
        // disconnected would reload a page the user has already stepped away
        // from.
        if (accounts.length === 0) {
          this.disconnect();
        } else if (this.current === null) {
          return;
        }
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

  async send(toAddress: string, tokenStandard: string, amount: string): Promise<SendReceipt> {
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
