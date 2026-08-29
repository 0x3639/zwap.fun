import { MakerIdentity } from "../nostr/identity.js";
import type { StorageDriver } from "../storage/driver.js";
import { EncryptedStorageDriver } from "../storage/encrypted-storage.js";
import { withMakerIdentityLock, withMakerIdentityWriteLock } from "./lock.js";

/** Encrypted namespace for the per-order Nostr secret keys. */
export const MAKER_IDENTITY_NAMESPACE = "zwap.maker-identity";

/**
 * Builds the profile's maker identity on top of the encrypted driver.
 *
 * The per-order Nostr secret keys are wallet-grade material - whoever holds
 * one can sign as that order - so they go through `EncryptedStorageDriver`
 * rather than sitting in IndexedDB in the clear.
 *
 * Three locks are in play and all three must be different names, because none
 * of them is re-entrant:
 *
 * - the *maker identity* lock, which the encrypted driver re-acquires on every
 *   `get`/`set` while resolving the profile key;
 * - the *maker identity write* lock, which makes `MakerIdentity`'s own
 *   read-then-write of the record atomic;
 * - the *account* lock, which the facade may already be holding when it calls
 *   in, so neither of the two above may be it.
 *
 * Migration: this moves the record from `zwap.nostr.order-keys.v1` to the
 * encrypted `zwap.maker-identity.data.…` key. There is deliberately no
 * migration - no plaintext record exists outside development - so any
 * left-over plaintext entry is simply ignored and never read again.
 */
export function composeMakerIdentity(
  driver: StorageDriver,
  profile: string
): MakerIdentity {
  return new MakerIdentity(
    new EncryptedStorageDriver(
      driver,
      MAKER_IDENTITY_NAMESPACE,
      (action) => withMakerIdentityLock(profile, action)
    ),
    (action) => withMakerIdentityWriteLock(profile, action)
  );
}
