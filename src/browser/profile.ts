const PROFILE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,31})$/;

export function profileFromLocation(href: string): string {
  const value = new URL(href).searchParams.get("wallet");
  const profile = value === null ? "default" : value;
  if (!PROFILE_PATTERN.test(profile)) {
    throw new Error("Invalid wallet profile: use 1–32 lowercase letters, numbers, or hyphens");
  }
  return profile;
}

export function storageNameForProfile(profile: string): string {
  if (!PROFILE_PATTERN.test(profile)) throw new Error("Invalid wallet profile");
  return `zwap-wallet-${profile}`;
}

export interface ProfileResetSteps {
  /** Serializes the erase against every other wallet action. */
  runLocked: <T>(action: () => Promise<T>) => Promise<T>;
  /** Drops the in-memory wallet: zeroes the derived key pair and account. */
  forgetWallet: () => void;
  resetDatabase: () => Promise<void>;
  /** Drops the signer, the trade runtime and the maker listener. */
  teardown: () => Promise<void>;
}

/**
 * Erases a browser profile in the one order that leaves nothing signing.
 *
 * The live key pair is zeroed *before* the database goes, because the seed it
 * was derived from is about to stop existing and a key pair that outlives its
 * seed is a signer for a wallet nobody can recover. The teardown runs outside
 * the lock - it stops the trade controller, which takes the same lock - and it
 * runs even when the delete fails, since the wallet is already invalidated by
 * then and the stale runtime would otherwise keep signing with zeroes.
 */
export async function resetProfileSequence(steps: ProfileResetSteps): Promise<void> {
  try {
    await steps.runLocked(async () => {
      steps.forgetWallet();
      await steps.resetDatabase();
    });
  } finally {
    await steps.teardown();
  }
}
