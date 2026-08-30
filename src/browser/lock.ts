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
  action: () => Promise<T>,
  locks: LockPort | undefined = hasNativeWebLocks() ? navigator.locks : undefined
): Promise<T> {
  return requestLock(
    "zwap-account-default-write",
    action,
    locks
  );
}

/**
 * Guards the encrypted `zwap.maker-identity` namespace, where the per-order
 * Nostr secret keys live. Its own name for the same reason the storage
 * driver re-acquires this runner on every `get`/`set`, and callers above
 * already hold the account lock.
 */
export async function withMakerIdentityLock<T>(
  action: () => Promise<T>,
  locks: LockPort | undefined = hasNativeWebLocks() ? navigator.locks : undefined
): Promise<T> {
  return requestLock(
    "zwap-maker-identity-default",
    action,
    locks
  );
}

/**
 * Serializes `MakerIdentity`'s read-then-write of the whole order-key record.
 *
 * A second name again: `withMakerIdentityLock` is re-acquired by the encrypted
 * driver inside every `get`/`set`, and the account lock may already be held by
 * the facade above - either one would deadlock here.
 */
export async function withMakerIdentityWriteLock<T>(
  action: () => Promise<T>,
  locks: LockPort | undefined = hasNativeWebLocks() ? navigator.locks : undefined
): Promise<T> {
  return requestLock(
    "zwap-maker-identity-default-write",
    action,
    locks
  );
}

export async function withOrderOutboxLock<T>(
  action: () => Promise<T>,
  locks: LockPort | undefined = hasNativeWebLocks() ? navigator.locks : undefined
): Promise<T> {
  return requestLock(
    "zwap-order-outbox-default-write",
    action,
    locks
  );
}

export async function withTradeSessionLock<T>(
  sessionId: string,
  action: () => Promise<T>,
  locks: LockPort | undefined = hasNativeWebLocks() ? navigator.locks : undefined
): Promise<T> {
  if (!/^[0-9a-f]{64}$/.test(sessionId)) {
    throw new Error("Trade lock session ID is invalid");
  }
  return requestLock(
    `zwap-trade-default-${sessionId}-write`,
    action,
    locks
  );
}

export async function withTradeSessionStorageLock<T>(
  action: () => Promise<T>,
  locks: LockPort | undefined = hasNativeWebLocks() ? navigator.locks : undefined
): Promise<T> {
  return requestLock(
    "zwap-trade-default-storage-write",
    action,
    locks
  );
}
