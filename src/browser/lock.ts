export interface LockPort {
  request(
    name: string,
    options: { mode: "exclusive" },
    callback: () => Promise<unknown>
  ): Promise<unknown>;
}

const fallbackQueues = new Map<string, Promise<void>>();

export function hasNativeWebLocks(): boolean {
  return typeof navigator !== "undefined" &&
    navigator.locks !== undefined &&
    typeof navigator.locks.request === "function";
}

/** Serialize mutations within this page when Web Locks is unavailable. */
async function withFallbackLock<T>(
  name: string,
  action: () => Promise<T>
): Promise<T> {
  const previous = fallbackQueues.get(name) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  fallbackQueues.set(name, queued);

  await previous;
  try {
    return await action();
  } finally {
    release();
    if (fallbackQueues.get(name) === queued) fallbackQueues.delete(name);
  }
}

async function requestLock<T>(
  name: string,
  action: () => Promise<T>,
  locks: LockPort | undefined
): Promise<T> {
  if (locks !== undefined) {
    return await locks.request(name, { mode: "exclusive" }, action) as T;
  }
  return withFallbackLock(name, action);
}

export async function withAccountLock<T>(
  profile: string,
  action: () => Promise<T>,
  locks: LockPort | undefined = hasNativeWebLocks() ? navigator.locks : undefined
): Promise<T> {
  return requestLock(
    `zwap-account-${profile}-write`,
    action,
    locks
  );
}

/**
 * Guards the encrypted keystore namespace. It is deliberately NOT the account
 * lock: `KeystoreRepository` hands this runner to `EncryptedStorageDriver`,
 * which acquires it again on every `get`/`set`, so a facade call that already
 * held the account lock would deadlock on itself — Web Locks and the in-page
 * fallback queue are both non-re-entrant.
 */
export async function withKeystoreLock<T>(
  profile: string,
  action: () => Promise<T>,
  locks: LockPort | undefined = hasNativeWebLocks() ? navigator.locks : undefined
): Promise<T> {
  return requestLock(
    `zwap-keystore-${profile}`,
    action,
    locks
  );
}

/**
 * Serializes the keystore's own check-then-write pairs (`create`, `import`).
 *
 * Deliberately a third name: the driver runner (`withKeystoreLock`) is
 * re-acquired inside every `get`/`set`, so reusing it around a whole
 * `create()` would deadlock, and the account lock is already held by the
 * facade above.
 */
export async function withKeystoreWriteLock<T>(
  profile: string,
  action: () => Promise<T>,
  locks: LockPort | undefined = hasNativeWebLocks() ? navigator.locks : undefined
): Promise<T> {
  return requestLock(
    `zwap-keystore-${profile}-write`,
    action,
    locks
  );
}

export async function withOrderOutboxLock<T>(
  profile: string,
  action: () => Promise<T>,
  locks: LockPort | undefined = hasNativeWebLocks() ? navigator.locks : undefined
): Promise<T> {
  return requestLock(
    `zwap-order-outbox-${profile}-write`,
    action,
    locks
  );
}

export async function withTradeSessionLock<T>(
  profile: string,
  sessionId: string,
  action: () => Promise<T>,
  locks: LockPort | undefined = hasNativeWebLocks() ? navigator.locks : undefined
): Promise<T> {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(profile)) {
    throw new Error("Trade lock profile is invalid");
  }
  if (!/^[0-9a-f]{64}$/.test(sessionId)) {
    throw new Error("Trade lock session ID is invalid");
  }
  return requestLock(
    `zwap-trade-${profile}-${sessionId}-write`,
    action,
    locks
  );
}

export async function withTradeSessionStorageLock<T>(
  profile: string,
  action: () => Promise<T>,
  locks: LockPort | undefined = hasNativeWebLocks() ? navigator.locks : undefined
): Promise<T> {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(profile)) {
    throw new Error("Trade storage lock profile is invalid");
  }
  return requestLock(
    `zwap-trade-${profile}-storage-write`,
    action,
    locks
  );
}
