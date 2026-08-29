import { describe, expect, it, vi } from "vitest";

import {
  assertKeystoreActionAllowed,
  guardKeystoreActions,
  type KeystoreOnlyFacade,
  type WalletSource
} from "./wallet-source-guard.js";

function facade(): KeystoreOnlyFacade<string> & {
  createWallet: ReturnType<typeof vi.fn>;
  importWallet: ReturnType<typeof vi.fn>;
  revealMnemonic: ReturnType<typeof vi.fn>;
  clearWallet: ReturnType<typeof vi.fn>;
} {
  return {
    createWallet: vi.fn(async () => "created"),
    importWallet: vi.fn(async () => "imported"),
    revealMnemonic: vi.fn(async () => "twelve words"),
    clearWallet: vi.fn(async () => undefined)
  };
}

describe("assertKeystoreActionAllowed", () => {
  it("lets a keystore session through", () => {
    expect(() => assertKeystoreActionAllowed("keystore", "Revealing the seed")).not.toThrow();
  });

  it("names the action it refused and why", () => {
    expect(() => assertKeystoreActionAllowed("injected", "Revealing the seed"))
      .toThrow("Revealing the seed is unavailable while a browser-extension wallet is connected");
  });
});

describe("guardKeystoreActions", () => {
  it("forwards every action while the keystore is the wallet in use", async () => {
    const actions = facade();
    const guarded = guardKeystoreActions(() => "keystore", actions);

    await expect(guarded.createWallet()).resolves.toBe("created");
    await expect(guarded.importWallet("legal winner")).resolves.toBe("imported");
    await expect(guarded.revealMnemonic("REVEAL SEED")).resolves.toBe("twelve words");
    await expect(guarded.clearWallet("DELETE WALLET")).resolves.toBeUndefined();
    expect(actions.importWallet).toHaveBeenCalledWith("legal winner");
    expect(actions.clearWallet).toHaveBeenCalledWith("DELETE WALLET");
  });

  it("refuses all four keystore actions while an extension wallet is connected", async () => {
    const actions = facade();
    const guarded = guardKeystoreActions(() => "injected", actions);

    await expect(guarded.createWallet()).rejects.toThrow(/browser-extension wallet is connected/);
    await expect(guarded.importWallet("legal winner"))
      .rejects.toThrow(/browser-extension wallet is connected/);
    await expect(guarded.revealMnemonic("REVEAL SEED"))
      .rejects.toThrow(/browser-extension wallet is connected/);
    await expect(guarded.clearWallet("DELETE WALLET"))
      .rejects.toThrow(/browser-extension wallet is connected/);

    // The seed is never read, and never erased, on the way to the refusal.
    expect(actions.createWallet).not.toHaveBeenCalled();
    expect(actions.importWallet).not.toHaveBeenCalled();
    expect(actions.revealMnemonic).not.toHaveBeenCalled();
    expect(actions.clearWallet).not.toHaveBeenCalled();
  });

  it("reads the wallet source per call, so connecting mid-session closes the door", async () => {
    const actions = facade();
    let source: WalletSource = "keystore";
    const guarded = guardKeystoreActions(() => source, actions);

    await expect(guarded.revealMnemonic("REVEAL SEED")).resolves.toBe("twelve words");
    source = "injected";
    await expect(guarded.revealMnemonic("REVEAL SEED"))
      .rejects.toThrow(/browser-extension wallet is connected/);
    expect(actions.revealMnemonic).toHaveBeenCalledTimes(1);
  });
});
