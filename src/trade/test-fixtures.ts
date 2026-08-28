import { finalizeEvent, getPublicKey } from "nostr-tools";

import { QSR_ZTS, ZNN_ZTS } from "../zenon/types.js";
import type { TradeSession } from "./session.js";

/**
 * Deterministic, storage-valid trade session fixtures shared by the session,
 * coordinator and storage suites. Every value is exact: the Nostr keys are
 * fixed, the inbox registration is really signed, and the settlement plan
 * follows `createSettlementPlan`.
 */

export type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

export const FIXTURE_LOCAL_ADDRESS = "z1qzal6c5s9rjnnxd2z7dvdhjxpmmj4fmw56a0mz";
export const FIXTURE_COUNTERPARTY_ADDRESS = "z1qqw6sypygz8sq4tzy4c8u7tlmqf5dh9kupt2wg";
export const FIXTURE_THIRD_ADDRESS = "z1qr7f4wx3ma9tv5c2n8ekhdjq6zsu0y7pl3dg4h";

function fixedKey(byte: number): Uint8Array {
  return new Uint8Array(32).fill(byte);
}

export const FIXTURE_SESSION_SECRET = fixedKey(1);
export const FIXTURE_MAKER_SECRET = fixedKey(2);
export const FIXTURE_SESSION_PUBKEY = getPublicKey(FIXTURE_SESSION_SECRET);
export const FIXTURE_MAKER_PUBKEY = getPublicKey(FIXTURE_MAKER_SECRET);
export const FIXTURE_SESSION_PRIVATE_KEY = "01".repeat(32);

export const FIXTURE_SESSION_ID = "11".repeat(32);
export const FIXTURE_RESERVATION_ID = "11111111-1111-4111-8111-111111111111";
export const FIXTURE_ORDER_ID = "22222222-2222-4222-8222-222222222222";
export const FIXTURE_OFFERED_PROJECTION_ID = "33".repeat(32);
export const FIXTURE_ORDER_ADDRESS =
  `30078:${FIXTURE_MAKER_PUBKEY}:granola:order:v1:${FIXTURE_ORDER_ID}`;
export const FIXTURE_INBOX_RELAY = "wss://inbox-one.example";
export const FIXTURE_DISCOVERY_RELAY = "wss://discovery-one.example";

export const FIXTURE_ANCHOR = 1_700_000_000;
export const FIXTURE_CREATED_AT = FIXTURE_ANCHOR;
export const FIXTURE_UPDATED_AT = FIXTURE_ANCHOR + 10;

export const FIXTURE_INBOX_REGISTRATION = structuredClone(finalizeEvent({
  kind: 10050,
  created_at: FIXTURE_ANCHOR,
  tags: [["relay", FIXTURE_INBOX_RELAY]],
  content: ""
}, FIXTURE_SESSION_SECRET));

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeValue(base: unknown, patch: unknown): unknown {
  if (!isPlainObject(patch) || !isPlainObject(base)) return patch;
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    merged[key] = Object.hasOwn(base, key) ? mergeValue(base[key], value) : value;
  }
  return merged;
}

function baseSessionFixture(): TradeSession {
  const shortLocktime = FIXTURE_ANCHOR + 1_800;
  const longLocktime = FIXTURE_ANCHOR + 3_600;
  const leg = () => ({
    htlcId: null,
    validationCommitment: null,
    htlcState: "UNKNOWN" as const,
    observedAt: null,
    spendCommitment: null,
    claimOperationCommitment: null,
    refundOperationCommitment: null
  });
  return {
    schema: "zwap/trade-session/v1",
    revision: 0,
    sessionId: FIXTURE_SESSION_ID,
    reservationId: FIXTURE_RESERVATION_ID,
    role: "maker",
    phase: "negotiating",
    orderSide: "sell",
    orderAddress: FIXTURE_ORDER_ADDRESS,
    offeredProjectionId: FIXTURE_OFFERED_PROJECTION_ID,
    offeredProjectionRevision: "0",
    reserveProjectionId: null,
    reserveProjectionRevision: null,
    fillProjectionId: null,
    fillProjectionRevision: null,
    pendingOrderPublication: null,
    createdAt: FIXTURE_CREATED_AT,
    updatedAt: FIXTURE_UPDATED_AT,
    terms: {
      makerSide: "sell",
      chainId: "1",
      baseToken: ZNN_ZTS,
      baseAmount: "20",
      quoteToken: QSR_ZTS,
      quoteAmount: "1",
      price: "5000000"
    },
    plan: {
      anchor: FIXTURE_ANCHOR,
      shortLocktime,
      makerClaimCutoff: shortLocktime - 120,
      longLocktime,
      takerClaimCutoff: longLocktime - 120,
      reservationExpiresAt: longLocktime + 600,
      refundGuardSeconds: 60
    },
    evidence: {
      makerPubkey: FIXTURE_MAKER_PUBKEY,
      commitments: [],
      chainStates: [],
      reserveProjectionId: null,
      reserveProjectionRevision: null,
      fillProjectionId: null,
      fillProjectionRevision: null,
      reservation: {
        proposalSealId: null,
        takerCommitment: null,
        abortSeal: null
      },
      legs: { base: leg(), quote: leg() }
    },
    privateState: {
      nostrPrivateKey: FIXTURE_SESSION_PRIVATE_KEY,
      localAddress: FIXTURE_LOCAL_ADDRESS,
      counterpartyAddress: FIXTURE_COUNTERPARTY_ADDRESS,
      preimage: null,
      htlcHash: null,
      settlementTranscriptHash: null,
      inbox: {
        status: "registered",
        quorum: 1,
        event: structuredClone(FIXTURE_INBOX_REGISTRATION),
        discoveryRelays: [FIXTURE_DISCOVERY_RELAY],
        inboxRelays: [FIXTURE_INBOX_RELAY],
        receipts: [{ relay: FIXTURE_DISCOVERY_RELAY, ok: true, message: "stored" }],
        readbacks: [{
          relay: FIXTURE_DISCOVERY_RELAY,
          found: true,
          event: structuredClone(FIXTURE_INBOX_REGISTRATION),
          observedAt: FIXTURE_ANCHOR + 3
        }],
        stagedAt: FIXTURE_ANCHOR,
        acknowledgedAt: FIXTURE_ANCHOR + 2,
        registeredAt: FIXTURE_ANCHOR + 3
      },
      pendingIncoming: null,
      transcript: {
        choreography: {
          phase: "awaiting_reserve_propose",
          participants: { makerOrderPubkey: FIXTURE_MAKER_PUBKEY },
          refundedLegs: []
        },
        nextSequence: "0",
        lastRumorId: null,
        lastMessageId: null,
        lastTranscriptHash: null,
        accepted: []
      },
      outbox: null,
      chainOperation: null,
      legs: {
        base: { htlcId: null, expected: null, observations: [] },
        quote: { htlcId: null, expected: null, observations: [] }
      }
    }
  };
}

/**
 * Returns a complete, storage-valid `TradeSession`. Overrides are deep-merged:
 * plain objects merge key by key, everything else (arrays, `null`, primitives)
 * replaces the fixture value outright.
 */
export function sessionFixture(
  overrides: DeepPartial<TradeSession> = {}
): TradeSession {
  return mergeValue(baseSessionFixture(), overrides) as TradeSession;
}
