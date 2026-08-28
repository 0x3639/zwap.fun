import { withKeystoreLock } from "./lock.js";
import type { StorageDriver } from "../storage/driver.js";
import { KeystoreRepository } from "../zenon/keystore-repository.js";

/**
 * Builds the profile's keystore on its own lock.
 *
 * The repository forwards this runner to `EncryptedStorageDriver`, which
 * re-acquires it for every `get` and `set` while resolving the profile key. So
 * the runner must be a lock nothing above the keystore already holds: the
 * facade wraps wallet mutations in the *account* lock, and reusing that here
 * would make `createWallet()` wait on the lock its own caller is holding.
 * Exclusive locks are not re-entrant, so that wait never ends.
 */
export function composeKeystore(
  driver: StorageDriver,
  profile: string
): KeystoreRepository {
  return new KeystoreRepository(
    driver,
    (action) => withKeystoreLock(profile, action)
  );
}
