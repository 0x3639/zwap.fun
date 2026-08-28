import { KeyStore, type KeyPair } from "znn-typescript-sdk";

import type { StorageDriver } from "../storage/driver.js";
import {
  EncryptedStorageDriver,
  type StorageExclusiveRunner
} from "../storage/encrypted-storage.js";

const NAMESPACE = "zwap.keystore";
const KEY = "mnemonic";
const REVEAL_CONFIRMATION = "REVEAL SEED";
const DELETE_CONFIRMATION = "DELETE WALLET";

/**
 * The single self-custodial wallet this browser profile holds.
 *
 * Only the BIP-39 mnemonic is persisted, encrypted through
 * `EncryptedStorageDriver`; seeds, private keys and addresses are derived on
 * demand and never written down. The SDK's `KeyFile` is deliberately not used:
 * its Argon2 step needs a WASM bundle we do not ship, and the AES-GCM profile
 * key already gives the same "a raw storage dump is not a wallet" property.
 */
export class KeystoreRepository {
  private readonly storage: EncryptedStorageDriver;

  constructor(driver: StorageDriver, runExclusive?: StorageExclusiveRunner) {
    this.storage = runExclusive === undefined
      ? new EncryptedStorageDriver(driver, NAMESPACE)
      : new EncryptedStorageDriver(driver, NAMESPACE, runExclusive);
  }

  async exists(): Promise<boolean> {
    return (await this.storage.get(KEY)) !== undefined;
  }

  /** Generates a fresh 24-word wallet. Refuses to shadow an existing seed. */
  async create(): Promise<{ address: string }> {
    await this.assertEmpty();
    return this.persist(KeyStore.newRandom());
  }

  /** Restores a wallet from user-supplied words after validating them. */
  async import(mnemonic: string): Promise<{ address: string }> {
    await this.assertEmpty();
    return this.persist(this.parse(mnemonic));
  }

  /**
   * Lends a derived key pair for exactly one action and wipes it afterwards,
   * including when the action throws. Callers that need a longer-lived key
   * pair (the page-lifetime signer) must use `loadKeyPair` and own the wipe.
   */
  async useKeyPair<T>(action: (keyPair: KeyPair) => Promise<T>): Promise<T> {
    const keyPair = await this.loadKeyPair();
    try {
      return await action(keyPair);
    } finally {
      keyPair.clear();
    }
  }

  /**
   * Derives the index-0 key pair and hands it over. The caller owns its
   * lifetime and must call `clear()` when it is done with it.
   */
  async loadKeyPair(): Promise<KeyPair> {
    return (await this.load()).getKeyPair(0);
  }

  async revealMnemonic(confirmation: string): Promise<string> {
    this.assertConfirmation(confirmation, REVEAL_CONFIRMATION);
    return (await this.load()).mnemonic;
  }

  async clear(confirmation: string): Promise<void> {
    this.assertConfirmation(confirmation, DELETE_CONFIRMATION);
    await this.storage.delete(KEY);
  }

  private assertConfirmation(value: string, expected: string): void {
    if (value !== expected) {
      throw new Error(`This action requires the exact confirmation "${expected}"`);
    }
  }

  private parse(mnemonic: string): KeyStore {
    try {
      return KeyStore.fromMnemonic(mnemonic);
    } catch (error) {
      throw new Error("Wallet mnemonic is not a valid BIP-39 seed phrase", { cause: error });
    }
  }

  private async assertEmpty(): Promise<void> {
    if (await this.exists()) {
      throw new Error("A wallet already exists in this browser profile");
    }
  }

  private async persist(keyStore: KeyStore): Promise<{ address: string }> {
    await this.storage.set(KEY, keyStore.mnemonic);
    return { address: keyStore.getKeyPair(0).address.toString() };
  }

  private async load(): Promise<KeyStore> {
    const stored = await this.storage.get(KEY);
    if (stored === undefined) {
      throw new Error("There is no wallet in this browser profile");
    }
    if (typeof stored !== "string") {
      throw new Error("Stored wallet mnemonic is corrupt");
    }
    return this.parse(stored);
  }
}
