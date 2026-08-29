/**
 * Remembers the idempotency key each open take attempt was started with.
 *
 * `takeOrder` is idempotent on `requestId`: the same id returns the same trade
 * session instead of opening a second one against the same order. So the id
 * has to outlive a failed attempt - a settlement that threw halfway may
 * already have an on-chain lock behind it, and a fresh id would start a
 * *second* session for the same fill and settle it in parallel.
 *
 * The entry is therefore released only once the take has definitively
 * finished: `settle` after the session reaches its terminal, successful phase.
 * A retry between those two points deliberately reuses the reserved id.
 */
export class TakeRequestRegistry {
  private readonly reserved = new Map<string, string>();

  constructor(private readonly newId: () => string = () => crypto.randomUUID()) {}

  /** The id for this attempt: the one already reserved, or a fresh one. */
  reserve(key: string): string {
    const existing = this.reserved.get(key);
    if (existing !== undefined) return existing;
    const requestId = this.newId();
    this.reserved.set(key, requestId);
    return requestId;
  }

  /** Drops the reservation. Only call this once the take truly finished. */
  settle(key: string): void {
    this.reserved.delete(key);
  }

  /** The reserved id, or `undefined` when nothing is outstanding. */
  peek(key: string): string | undefined {
    return this.reserved.get(key);
  }

  get size(): number {
    return this.reserved.size;
  }
}
