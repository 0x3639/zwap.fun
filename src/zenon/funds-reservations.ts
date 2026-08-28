import type { StorageDriver } from "../storage/driver.js";
import { isAmount, isTokenStandard } from "./validate.js";

export interface FundsReservation {
  sessionId: string;
  tokenStandard: string;
  amount: string;
  reservedAt: number;
}

export interface FundsReservationState {
  version: 1;
  revision: number;
  reservations: FundsReservation[];
}

const KEY = "zwap.funds-reservations.v1";

function assertState(value: unknown): FundsReservationState {
  if (!value || typeof value !== "object") throw new Error("Corrupt funds reservation state");
  const state = value as FundsReservationState;
  if (
    state.version !== 1 ||
    !Number.isSafeInteger(state.revision) ||
    state.revision < 0 ||
    !Array.isArray(state.reservations)
  ) throw new Error("Corrupt funds reservation state");
  const sessions = new Set<string>();
  for (const reservation of state.reservations) {
    if (
      !reservation ||
      typeof reservation !== "object" ||
      typeof reservation.sessionId !== "string" ||
      reservation.sessionId.length === 0 ||
      !isTokenStandard(reservation.tokenStandard) ||
      !isAmount(reservation.amount) ||
      !Number.isSafeInteger(reservation.reservedAt) ||
      reservation.reservedAt < 0
    ) throw new Error("Corrupt funds reservation entry");
    if (sessions.has(reservation.sessionId)) {
      throw new Error("Corrupt funds reservation entry");
    }
    sessions.add(reservation.sessionId);
  }
  return state;
}

export function reservedAmount(
  state: FundsReservationState,
  tokenStandard: string,
  excludeSessionId?: string
): bigint {
  return state.reservations
    .filter((r) => r.tokenStandard === tokenStandard && r.sessionId !== excludeSessionId)
    .reduce((sum, r) => sum + BigInt(r.amount), 0n);
}

export class FundsReservationRepository {
  constructor(private readonly driver: StorageDriver) {}

  async load(): Promise<FundsReservationState> {
    const raw = await this.driver.get(KEY);
    return raw === undefined || raw === null
      ? { version: 1, revision: 0, reservations: [] }
      : assertState(raw);
  }

  private async commit(
    expectedRevision: number,
    mutate: (state: FundsReservationState) => FundsReservation[]
  ): Promise<FundsReservationState> {
    const current = await this.load();
    if (current.revision !== expectedRevision) {
      throw new Error("Funds reservation revision mismatch");
    }
    const next: FundsReservationState = {
      version: 1,
      revision: current.revision + 1,
      reservations: mutate(current)
    };
    assertState(next);
    await this.driver.set(KEY, next);
    return next;
  }

  reserve(expectedRevision: number, input: FundsReservation): Promise<FundsReservationState> {
    return this.commit(expectedRevision, (state) => {
      if (state.reservations.some((r) => r.sessionId === input.sessionId)) {
        throw new Error("Session already has a funds reservation");
      }
      return [...state.reservations, { ...input }];
    });
  }

  release(
    expectedRevision: number,
    input: { sessionId: string }
  ): Promise<FundsReservationState> {
    return this.commit(
      expectedRevision,
      (state) => state.reservations.filter((r) => r.sessionId !== input.sessionId)
    );
  }
}
