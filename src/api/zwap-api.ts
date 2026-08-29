import type { KeyPair } from "znn-typescript-sdk";

import type { ZwapConfig } from "../config.js";
import type { ZenonAccount } from "../zenon/account.js";
import type { KeystoreRepository } from "../zenon/keystore-repository.js";
import {
  fusePlasma,
  type FuseResult,
  type PlasmaTier
} from "../zenon/plasma-bot.js";
import type {
  BalanceView,
  PlasmaView,
  SendReceipt,
  ZenonNodePort
} from "../zenon/types.js";

/** Everything the wallet panel renders, in one round trip. */
export interface ZwapState {
  address: string | null;
  network: string;
  chainId: number;
  balances: BalanceView[];
  unreceived: number;
  plasma: PlasmaView | null;
  powRequired: boolean;
  plasmaBotAvailable: boolean;
}

/** The unlocked account, or `null` until a keystore exists in this profile. */
export interface ZenonPort {
  account(): ZenonAccount | null;
}

/** The slice of the keystore the wallet API drives. */
export type KeystorePort = Pick<
  KeystoreRepository,
  "exists" | "create" | "import" | "loadKeyPair" | "revealMnemonic" | "clear"
>;

export interface ZwapApiDependencies {
  keystore: KeystorePort;
  /**
   * The node the composition root connected. It is not called directly here —
   * every read goes through the account `createAccount` builds over this same
   * connection — but taking it keeps one node per page in the wiring.
   */
  node: ZenonNodePort;
  config: ZwapConfig;
  /**
   * Builds the account for the profile's single key pair. Injected so the
   * browser can hand it a `KeystoreSigner` over the live node while tests sign
   * through `FakeZenonNode` without touching the SDK's PoW machinery.
   */
  createAccount: (keyPair: KeyPair) => ZenonAccount;
  fetchImpl?: typeof fetch;
}

/**
 * The wallet-facing half of zwap: one self-custodial Zenon address, its
 * balances, its plasma, and the four transfers a user drives by hand. Trading
 * lives in `TradeApi`; this class deliberately knows nothing about HTLCs.
 *
 * The key pair is derived at most once and stays resident for the lifetime of
 * the page — the wallet is a hot wallet by construction, and re-deriving per
 * action would only spread the same secret over more allocations. It is wiped
 * when `clearWallet` erases the seed.
 */
export class ZwapApi implements ZenonPort {
  private readonly keystore: KeystorePort;
  private readonly config: ZwapConfig;
  private readonly createAccount: (keyPair: KeyPair) => ZenonAccount;
  private readonly fetchImpl: typeof fetch | undefined;
  private current: ZenonAccount | null = null;
  private keyPair: KeyPair | null = null;
  private unlocking: Promise<ZenonAccount | null> | undefined;
  /**
   * Bumped by `clearWallet`. A derive that started before the erase finishes
   * after it, and must not re-install the key pair the erase just wiped.
   */
  private generation = 0;

  constructor(dependencies: ZwapApiDependencies) {
    this.keystore = dependencies.keystore;
    this.config = dependencies.config;
    this.createAccount = dependencies.createAccount;
    this.fetchImpl = dependencies.fetchImpl;
  }

  account(): ZenonAccount | null {
    return this.current;
  }

  async getState(): Promise<ZwapState> {
    const account = await this.unlock();
    const empty = {
      network: this.config.network,
      chainId: this.config.chainId,
      plasmaBotAvailable: this.config.plasmaBotUrl !== null
    };
    if (account === null) {
      return {
        address: null,
        balances: [],
        unreceived: 0,
        plasma: null,
        powRequired: false,
        ...empty
      };
    }
    const snapshot = await account.snapshot();
    return {
      address: snapshot.address,
      balances: snapshot.balances,
      unreceived: snapshot.unreceived,
      plasma: snapshot.plasma,
      powRequired: snapshot.powRequired,
      ...empty
    };
  }

  async createWallet(): Promise<ZwapState> {
    await this.keystore.create();
    return this.getState();
  }

  async importWallet(mnemonic: string): Promise<ZwapState> {
    await this.keystore.import(mnemonic);
    return this.getState();
  }

  async receivePending(): Promise<ZwapState> {
    await (await this.require()).receiveAll();
    return this.getState();
  }

  async fusePlasma(tier: PlasmaTier): Promise<FuseResult> {
    const baseUrl = this.config.plasmaBotUrl;
    if (baseUrl === null) {
      throw new Error("Plasma bot is not configured for this network");
    }
    const account = await this.require();
    return fusePlasma(baseUrl, account.address(), tier, this.fetchImpl);
  }

  async send(
    toAddress: string,
    tokenStandard: string,
    amount: string
  ): Promise<SendReceipt> {
    return (await this.require()).send(toAddress, tokenStandard, amount);
  }

  async revealMnemonic(confirmation: string): Promise<string> {
    return this.keystore.revealMnemonic(confirmation);
  }

  /** Erases the seed and zeroes the resident key pair the signer still holds. */
  async clearWallet(confirmation: string): Promise<void> {
    await this.keystore.clear(confirmation);
    this.invalidate();
  }

  /**
   * Drops the in-memory wallet without touching storage, for when the seed is
   * erased by other means - a whole-profile reset deletes the database under
   * this object, and the key pair it derived must not outlive it.
   */
  forgetWallet(): void {
    this.invalidate();
  }

  private invalidate(): void {
    this.generation += 1;
    this.unlocking = undefined;
    this.current = null;
    this.keyPair?.clear();
    this.keyPair = null;
  }

  private async require(): Promise<ZenonAccount> {
    const account = await this.unlock();
    if (account === null) {
      throw new Error("There is no wallet in this browser profile");
    }
    return account;
  }

  /**
   * Single-flight: concurrent callers share one derivation rather than racing
   * two key pairs — and therefore two send queues — onto the same address.
   */
  private async unlock(): Promise<ZenonAccount | null> {
    if (this.current !== null) return this.current;
    const pending = this.unlocking ?? this.derive(this.generation);
    this.unlocking = pending;
    try {
      return await pending;
    } finally {
      if (this.unlocking === pending) this.unlocking = undefined;
    }
  }

  private async derive(generation: number): Promise<ZenonAccount | null> {
    if (!(await this.keystore.exists())) return null;
    const keyPair = await this.keystore.loadKeyPair();
    let account: ZenonAccount;
    try {
      account = this.createAccount(keyPair);
    } catch (error) {
      keyPair.clear();
      throw error;
    }
    if (generation !== this.generation) {
      // `clearWallet` landed while this derive was in flight. The seed is gone;
      // installing this key pair would resurrect a wallet the user erased.
      keyPair.clear();
      return null;
    }
    this.keyPair = keyPair;
    this.current = account;
    return account;
  }
}
