// @vitest-environment node
import { describe, expect, it } from "vitest";
import { KeyStore, type KeyPair } from "znn-typescript-sdk";

import { MemoryStorageDriver } from "../storage/driver.js";
import { KeystoreRepository, wipeKeyStore } from "./keystore-repository.js";

const MNEMONIC = KeyStore.newRandom().mnemonic; // throwaway, never funded
const ADDRESS = /^z1[02-9ac-hj-np-z]{38}$/;

/** `KeyPair.clear` zeroes the key material in place; the buffer keeps its length. */
function zeroed(keyPair: KeyPair): boolean {
  return keyPair.privateKey.length === 32 && keyPair.privateKey.every((byte) => byte === 0);
}

describe("KeystoreRepository", () => {
  it("creates a wallet whose encrypted mnemonic is not stored in the clear", async () => {
    const raw = new MemoryStorageDriver();
    const repository = new KeystoreRepository(raw);

    await expect(repository.exists()).resolves.toBe(false);
    const { address } = await repository.create();

    expect(address).toMatch(ADDRESS);
    await expect(repository.exists()).resolves.toBe(true);
    const mnemonic = await repository.revealMnemonic("REVEAL SEED");
    expect(mnemonic.split(" ")).toHaveLength(24);
    expect(JSON.stringify(await raw.get("zwap.keystore.data.mnemonic")))
      .not.toContain(mnemonic.split(" ")[0]!);
  });

  it("imports a mnemonic and derives the same index-0 address every time", async () => {
    const first = new KeystoreRepository(new MemoryStorageDriver());
    const second = new KeystoreRepository(new MemoryStorageDriver());

    const imported = await first.import(MNEMONIC);
    const reimported = await second.import(MNEMONIC);

    expect(imported.address).toBe(reimported.address);
    expect(imported.address).toBe(KeyStore.fromMnemonic(MNEMONIC).getKeyPair(0).address.toString());
    await expect(first.revealMnemonic("REVEAL SEED")).resolves.toBe(MNEMONIC);
  });

  it("rejects an invalid mnemonic without persisting anything", async () => {
    const repository = new KeystoreRepository(new MemoryStorageDriver());

    await expect(repository.import("not a real seed phrase"))
      .rejects.toThrow(/mnemonic/i);

    await expect(repository.exists()).resolves.toBe(false);
  });

  it("refuses to overwrite an existing wallet", async () => {
    const repository = new KeystoreRepository(new MemoryStorageDriver());
    const created = await repository.create();

    await expect(repository.create()).rejects.toThrow(/already exists/i);
    await expect(repository.import(MNEMONIC)).rejects.toThrow(/already exists/i);
    await expect(repository.exists()).resolves.toBe(true);
    expect((await repository.loadKeyPair()).address.toString()).toBe(created.address);
  });

  it("lends a key pair for the duration of one action and clears it after", async () => {
    const repository = new KeystoreRepository(new MemoryStorageDriver());
    const { address } = await repository.import(MNEMONIC);

    let borrowed: KeyPair | null = null;
    const signature = await repository.useKeyPair(async (keyPair) => {
      borrowed = keyPair;
      expect(keyPair.address.toString()).toBe(address);
      expect(zeroed(keyPair)).toBe(false);
      return keyPair.sign(Buffer.from("zwap", "utf8")).toString("hex");
    });

    expect(signature).toMatch(/^[0-9a-f]{128}$/);
    expect(zeroed(borrowed!)).toBe(true);
  });

  it("clears the borrowed key pair even when the action throws", async () => {
    const repository = new KeystoreRepository(new MemoryStorageDriver());
    await repository.import(MNEMONIC);

    let borrowed: KeyPair | null = null;
    await expect(repository.useKeyPair(async (keyPair) => {
      borrowed = keyPair;
      throw new Error("action failed");
    })).rejects.toThrow(/action failed/);

    expect(zeroed(borrowed!)).toBe(true);
  });

  it("hands loadKeyPair to a caller that owns its lifetime", async () => {
    const repository = new KeystoreRepository(new MemoryStorageDriver());
    const { address } = await repository.import(MNEMONIC);

    const keyPair = await repository.loadKeyPair();

    expect(keyPair.address.toString()).toBe(address);
    expect(zeroed(keyPair)).toBe(false);
    keyPair.clear();
    expect(zeroed(keyPair)).toBe(true);
  });

  it("requires the exact confirmation strings to reveal or delete", async () => {
    const repository = new KeystoreRepository(new MemoryStorageDriver());
    await repository.import(MNEMONIC);

    await expect(repository.revealMnemonic("wrong")).rejects.toThrow(/REVEAL SEED/);
    await expect(repository.revealMnemonic("reveal seed")).rejects.toThrow(/REVEAL SEED/);
    await expect(repository.clear("wrong")).rejects.toThrow(/DELETE WALLET/);
    await expect(repository.exists()).resolves.toBe(true);

    await repository.clear("DELETE WALLET");

    await expect(repository.exists()).resolves.toBe(false);
    await expect(repository.revealMnemonic("REVEAL SEED")).rejects.toThrow(/no wallet/i);
    await expect(repository.useKeyPair(async () => 1)).rejects.toThrow(/no wallet/i);
    await expect(repository.loadKeyPair()).rejects.toThrow(/no wallet/i);
  });

  it("wipes the loaded KeyStore after every use", async () => {
    // Regression: `load()` built a KeyStore holding the mnemonic, its entropy
    // and its seed, and left the whole thing to the garbage collector.
    const store = KeyStore.fromMnemonic(MNEMONIC);
    expect(store.seed.length).toBeGreaterThan(0);

    wipeKeyStore(store);

    expect(store.mnemonic).toBe("");
    expect(store.entropy).toBe("");
    expect(store.seed).toBe("");

    // The repository still answers correctly with the wipe in place: the
    // mnemonic is copied out before the store is cleared, and the key pair is
    // derived before it too.
    const repository = new KeystoreRepository(new MemoryStorageDriver());
    const { address } = await repository.import(MNEMONIC);
    await expect(repository.revealMnemonic("REVEAL SEED")).resolves.toBe(MNEMONIC);
    const keyPair = await repository.loadKeyPair();
    expect(keyPair.address.toString()).toBe(address);
    expect(zeroed(keyPair)).toBe(false);
    keyPair.clear();
  });

  it("sets up the profile key through the exclusive runner without nesting", async () => {
    let depth = 0;
    let maximumDepth = 0;
    const repository = new KeystoreRepository(
      new MemoryStorageDriver(),
      async (action) => {
        depth += 1;
        maximumDepth = Math.max(maximumDepth, depth);
        try {
          return await action();
        } finally {
          depth -= 1;
        }
      }
    );

    await repository.create();
    await repository.revealMnemonic("REVEAL SEED");

    expect(maximumDepth).toBe(1);
  });
});
