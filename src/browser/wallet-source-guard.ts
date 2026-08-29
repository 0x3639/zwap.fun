/**
 * Which wallet signs for the page. Mirrors `ZwapState.walletSource`, but lives
 * here so the guard stays a pure function with no dependency on the wallet API.
 */
export type WalletSource = "keystore" | "injected";

/**
 * The four actions that only make sense against the in-page keystore. Each
 * value is the human name that goes into the refusal message.
 */
export const KEYSTORE_ONLY_ACTIONS = {
  createWallet: "Creating a local wallet",
  importWallet: "Importing a seed",
  revealMnemonic: "Revealing the seed",
  clearWallet: "Erasing the local wallet"
} as const;

export type KeystoreOnlyAction = keyof typeof KEYSTORE_ONLY_ACTIONS;

/**
 * Hiding a button is a UI courtesy, not a rule: `window.zwap` is a public
 * surface an agent script drives directly. While a browser-extension wallet is
 * connected the profile's seed is not the wallet in use, and reading or
 * erasing it behind the user's back must fail loudly rather than quietly
 * succeed against the wrong wallet.
 */
export function assertKeystoreActionAllowed(
  walletSource: WalletSource,
  action: string
): void {
  if (walletSource === "injected") {
    throw new Error(
      `${action} is unavailable while a browser-extension wallet is connected`
    );
  }
}

export interface KeystoreOnlyFacade<TState> {
  createWallet: () => Promise<TState>;
  importWallet: (mnemonic: string) => Promise<TState>;
  revealMnemonic: (confirmation: string) => Promise<string>;
  clearWallet: (confirmation: string) => Promise<void>;
}

/**
 * Wraps the keystore-only half of the browser facade behind the guard. The
 * source is read per call, never captured: a session that connects an
 * extension mid-flight must close these doors immediately.
 */
export function guardKeystoreActions<TState>(
  walletSource: () => WalletSource,
  actions: KeystoreOnlyFacade<TState>
): KeystoreOnlyFacade<TState> {
  const check = (action: KeystoreOnlyAction): void => {
    assertKeystoreActionAllowed(walletSource(), KEYSTORE_ONLY_ACTIONS[action]);
  };
  return {
    createWallet: async () => {
      check("createWallet");
      return actions.createWallet();
    },
    importWallet: async (mnemonic) => {
      check("importWallet");
      return actions.importWallet(mnemonic);
    },
    revealMnemonic: async (confirmation) => {
      check("revealMnemonic");
      return actions.revealMnemonic(confirmation);
    },
    clearWallet: async (confirmation) => {
      check("clearWallet");
      return actions.clearWallet(confirmation);
    }
  };
}
