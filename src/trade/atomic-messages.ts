import {
  canonicalJson,
  termsHash,
  type ZwapTradeMessage,
  type ZwapTradeTerms,
  type JsonValue
} from "./messages.js";
import { isAmount, isHex32, isTokenStandard, isZenonAddress } from "../zenon/validate.js";

export const ATOMIC_SWAP_BODY_SCHEMA = "zwap/atomic-swap-body/v1" as const;

export const ATOMIC_SWAP_MESSAGE_TYPES = [
  "reserve_propose",
  "reserve_accept",
  "session_ack",
  "base_lock",
  "base_lock_ack",
  "quote_lock",
  "quote_lock_ack",
  "claim_notice",
  "fill_request",
  "settlement_ack",
  "refund",
  "error"
] as const;

export type AtomicSwapMessageType = (typeof ATOMIC_SWAP_MESSAGE_TYPES)[number];

interface VersionedBody {
  [key: string]: JsonValue;
  schema: typeof ATOMIC_SWAP_BODY_SCHEMA;
}

export interface ReserveProposeBody extends VersionedBody {
  taker_session_pubkey: string;
  taker_address: string;
  fill_amount: string;
}

export interface ReserveAcceptBody extends VersionedBody {
  taker_session_pubkey: string;
  maker_session_pubkey: string;
  maker_address: string;
  reserve_projection_id: string;
  reserve_revision: string;
  settlement_hash: string;
  short_locktime: number;
  maker_claim_cutoff: number;
  long_locktime: number;
  taker_claim_cutoff: number;
  reservation_expires_at: number;
  base_lock: LockBody;
}

export interface SessionAckBody extends VersionedBody {
  reserve_accept_message_id: string;
  reserve_accept_transcript_hash: string;
  reserve_projection_id: string;
  reserve_revision: string;
  settlement_hash: string;
}

export interface LockBody extends VersionedBody {
  htlc_id: string;
  validation_commitment: string;
  settlement_hash: string;
  chain_id: string;
  token_standard: string;
  amount: string;
  hash_locked_address: string;
  time_locked_address: string;
  expiration_time: number;
}

export interface LockAckBody extends VersionedBody {
  lock_message_id: string;
  lock_transcript_hash: string;
  htlc_id: string;
  validation_commitment: string;
  settlement_hash: string;
}

export interface ClaimNoticeBody extends VersionedBody {
  quote_htlc_id: string;
  claim_operation_commitment: string;
  settlement_hash: string;
  claimed_at: number;
}

export interface FillRequestBody extends VersionedBody {
  base_htlc_id: string;
  quote_htlc_id: string;
  base_spend_commitment: string;
  quote_spend_commitment: string;
  settlement_hash: string;
}

export interface SettlementAckBody extends VersionedBody {
  fill_projection_id: string;
  fill_revision: string;
  base_htlc_id: string;
  quote_htlc_id: string;
  settlement_hash: string;
}

export type RefundLeg = "base" | "quote";

export interface RefundBody extends VersionedBody {
  leg: RefundLeg;
  htlc_id: string;
  refund_operation_commitment: string;
  settlement_hash: string;
  refunded_at: number;
}

export const ATOMIC_SWAP_ERROR_CODES = [
  "invalid_message",
  "protocol_violation",
  "terms_mismatch",
  "order_changed",
  "relay_unavailable",
  "node_unavailable",
  "chain_rejected",
  "htlc_state_invalid",
  "plasma_unavailable",
  "witness_invalid",
  "deadline_reached",
  "counterparty_abort",
  "internal_error"
] as const;

export type AtomicSwapErrorCode = (typeof ATOMIC_SWAP_ERROR_CODES)[number];

export const ATOMIC_SWAP_ERROR_PHASES = [
  "negotiating",
  "reserved",
  "base_locked",
  "quote_locked",
  "quote_claimed",
  "base_claimed",
  "filled",
  "waiting_quote_refund",
  "waiting_base_refund",
  "waiting_base_claim",
  "released",
  "frozen"
] as const;

export type AtomicSwapErrorPhase = (typeof ATOMIC_SWAP_ERROR_PHASES)[number];

export interface ErrorBody extends VersionedBody {
  code: AtomicSwapErrorCode;
  at_phase: AtomicSwapErrorPhase;
  failed_message_id: string | null;
  retryable: boolean;
}

interface AtomicSwapBodyMap {
  reserve_propose: ReserveProposeBody;
  reserve_accept: ReserveAcceptBody;
  session_ack: SessionAckBody;
  base_lock: LockBody;
  base_lock_ack: LockAckBody;
  quote_lock: LockBody;
  quote_lock_ack: LockAckBody;
  claim_notice: ClaimNoticeBody;
  fill_request: FillRequestBody;
  settlement_ack: SettlementAckBody;
  refund: RefundBody;
  error: ErrorBody;
}

export type AtomicSwapBody<T extends AtomicSwapMessageType = AtomicSwapMessageType> =
  AtomicSwapBodyMap[T];

export type AtomicSwapMessage<T extends AtomicSwapMessageType = AtomicSwapMessageType> =
  Omit<ZwapTradeMessage, "type" | "body"> & {
    type: T;
    body: AtomicSwapBody<T>;
  };

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CHAIN_ID = /^[1-9]\d*$/;

function bodyRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Atomic swap body must be an object");
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error("Atomic swap body contains missing or unknown fields");
  }
}

function exactBody(value: unknown, fields: readonly string[]): Record<string, unknown> {
  const body = bodyRecord(value);
  exactKeys(body, ["schema", ...fields]);
  if (body.schema !== ATOMIC_SWAP_BODY_SCHEMA) {
    throw new Error("Unknown atomic swap body schema");
  }
  return body;
}

function requiredString(value: unknown, label: string, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function hex32(value: unknown, label: string): string {
  if (!isHex32(value)) throw new Error(`${label} is invalid`);
  return value;
}

function zenonAddress(value: unknown, label: string): string {
  if (!isZenonAddress(value)) throw new Error(`${label} is invalid`);
  return value;
}

function tokenStandard(value: unknown, label: string): string {
  if (!isTokenStandard(value)) throw new Error(`${label} is invalid`);
  return value;
}

function uuid(value: unknown, label: string): string {
  return requiredString(value, label, UUID_V4);
}

function amount(value: unknown, label: string): string {
  if (!isAmount(value)) throw new Error(`${label} is invalid`);
  return value;
}

function chainId(value: unknown, label: string): string {
  return requiredString(value, label, CHAIN_ID);
}

function revision(value: unknown, label: string): string {
  return requiredString(value, label, /^(0|[1-9][0-9]*)$/);
}

function timestamp(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe Unix timestamp`);
  }
  return value;
}

function expirationTime(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe Unix timestamp`);
  }
  return value;
}

function reservePropose(value: unknown): ReserveProposeBody {
  const body = exactBody(value, [
    "taker_session_pubkey",
    "taker_address",
    "fill_amount"
  ]);
  hex32(body.taker_session_pubkey, "Taker session public key");
  zenonAddress(body.taker_address, "Taker address");
  amount(body.fill_amount, "Fill amount");
  return body as unknown as ReserveProposeBody;
}

function reserveAccept(value: unknown): ReserveAcceptBody {
  const body = exactBody(value, [
    "taker_session_pubkey",
    "maker_session_pubkey",
    "maker_address",
    "reserve_projection_id",
    "reserve_revision",
    "settlement_hash",
    "short_locktime",
    "maker_claim_cutoff",
    "long_locktime",
    "taker_claim_cutoff",
    "reservation_expires_at",
    "base_lock"
  ]);
  hex32(body.taker_session_pubkey, "Taker session public key");
  hex32(body.maker_session_pubkey, "Maker session public key");
  zenonAddress(body.maker_address, "Maker address");
  hex32(body.reserve_projection_id, "Reserve projection ID");
  revision(body.reserve_revision, "Reserve revision");
  hex32(body.settlement_hash, "Settlement hash");
  const short = timestamp(body.short_locktime, "Short locktime");
  const makerCutoff = timestamp(body.maker_claim_cutoff, "Maker claim cutoff");
  const long = timestamp(body.long_locktime, "Long locktime");
  const takerCutoff = timestamp(body.taker_claim_cutoff, "Taker claim cutoff");
  const reservationExpiry = timestamp(body.reservation_expires_at, "Reservation expiry");
  if (
    makerCutoff !== short - 120 ||
    long - short < 600 ||
    takerCutoff !== long - 120
  ) {
    throw new Error("Settlement deadline profile is invalid");
  }
  if (reservationExpiry < long + 600) {
    throw new Error("Reservation expiry does not cover the recovery window");
  }
  const baseLock = lock(body.base_lock);
  if (baseLock.time_locked_address !== body.maker_address) {
    throw new Error("Base lock time-locked address must be the maker address");
  }
  return body as unknown as ReserveAcceptBody;
}

function sessionAck(value: unknown): SessionAckBody {
  const body = exactBody(value, [
    "reserve_accept_message_id",
    "reserve_accept_transcript_hash",
    "reserve_projection_id",
    "reserve_revision",
    "settlement_hash"
  ]);
  uuid(body.reserve_accept_message_id, "Reserve acceptance message ID");
  hex32(body.reserve_accept_transcript_hash, "Reserve acceptance transcript hash");
  hex32(body.reserve_projection_id, "Reserve projection ID");
  revision(body.reserve_revision, "Reserve revision");
  hex32(body.settlement_hash, "Settlement hash");
  return body as unknown as SessionAckBody;
}

function lock(value: unknown): LockBody {
  const body = exactBody(value, [
    "htlc_id",
    "validation_commitment",
    "settlement_hash",
    "chain_id",
    "token_standard",
    "amount",
    "hash_locked_address",
    "time_locked_address",
    "expiration_time"
  ]);
  hex32(body.htlc_id, "HTLC ID");
  hex32(body.validation_commitment, "Validation commitment");
  hex32(body.settlement_hash, "Settlement hash");
  chainId(body.chain_id, "Chain ID");
  tokenStandard(body.token_standard, "Token standard");
  amount(body.amount, "Lock amount");
  zenonAddress(body.hash_locked_address, "Hash-locked address");
  zenonAddress(body.time_locked_address, "Time-locked address");
  expirationTime(body.expiration_time, "Expiration time");
  if (body.hash_locked_address === body.time_locked_address) {
    throw new Error("Lock hash-locked and time-locked addresses must differ");
  }
  return body as unknown as LockBody;
}

function lockAck(value: unknown): LockAckBody {
  const body = exactBody(value, [
    "lock_message_id",
    "lock_transcript_hash",
    "htlc_id",
    "validation_commitment",
    "settlement_hash"
  ]);
  uuid(body.lock_message_id, "Lock message ID");
  hex32(body.lock_transcript_hash, "Lock transcript hash");
  hex32(body.htlc_id, "HTLC ID");
  hex32(body.validation_commitment, "Validation commitment");
  hex32(body.settlement_hash, "Settlement hash");
  return body as unknown as LockAckBody;
}

function claimNotice(value: unknown): ClaimNoticeBody {
  const body = exactBody(value, [
    "quote_htlc_id",
    "claim_operation_commitment",
    "settlement_hash",
    "claimed_at"
  ]);
  hex32(body.quote_htlc_id, "Quote HTLC ID");
  hex32(body.claim_operation_commitment, "Claim operation commitment");
  hex32(body.settlement_hash, "Settlement hash");
  timestamp(body.claimed_at, "Claim timestamp");
  return body as unknown as ClaimNoticeBody;
}

function fillRequest(value: unknown): FillRequestBody {
  const body = exactBody(value, [
    "base_htlc_id",
    "quote_htlc_id",
    "base_spend_commitment",
    "quote_spend_commitment",
    "settlement_hash"
  ]);
  hex32(body.base_htlc_id, "Base HTLC ID");
  hex32(body.quote_htlc_id, "Quote HTLC ID");
  hex32(body.base_spend_commitment, "Base spend commitment");
  hex32(body.quote_spend_commitment, "Quote spend commitment");
  hex32(body.settlement_hash, "Settlement hash");
  return body as unknown as FillRequestBody;
}

function settlementAck(value: unknown): SettlementAckBody {
  const body = exactBody(value, [
    "fill_projection_id",
    "fill_revision",
    "base_htlc_id",
    "quote_htlc_id",
    "settlement_hash"
  ]);
  hex32(body.fill_projection_id, "Fill projection ID");
  revision(body.fill_revision, "Fill revision");
  hex32(body.base_htlc_id, "Base HTLC ID");
  hex32(body.quote_htlc_id, "Quote HTLC ID");
  hex32(body.settlement_hash, "Settlement hash");
  return body as unknown as SettlementAckBody;
}

function refund(value: unknown): RefundBody {
  const body = exactBody(value, [
    "leg",
    "htlc_id",
    "refund_operation_commitment",
    "settlement_hash",
    "refunded_at"
  ]);
  if (body.leg !== "base" && body.leg !== "quote") throw new Error("Refund leg is invalid");
  hex32(body.htlc_id, "Refund HTLC ID");
  hex32(body.refund_operation_commitment, "Refund operation commitment");
  hex32(body.settlement_hash, "Settlement hash");
  timestamp(body.refunded_at, "Refund timestamp");
  return body as unknown as RefundBody;
}

function errorBody(value: unknown): ErrorBody {
  const body = exactBody(value, ["code", "at_phase", "failed_message_id", "retryable"]);
  if (!ATOMIC_SWAP_ERROR_CODES.includes(body.code as AtomicSwapErrorCode)) {
    throw new Error("Atomic swap error code is invalid");
  }
  if (!ATOMIC_SWAP_ERROR_PHASES.includes(body.at_phase as AtomicSwapErrorPhase)) {
    throw new Error("Atomic swap error phase is invalid");
  }
  if (body.failed_message_id !== null) uuid(body.failed_message_id, "Failed message ID");
  if (typeof body.retryable !== "boolean") throw new Error("Error retryable flag is invalid");
  return body as unknown as ErrorBody;
}

const parsers: {
  [T in AtomicSwapMessageType]: (value: unknown) => AtomicSwapBodyMap[T];
} = {
  reserve_propose: reservePropose,
  reserve_accept: reserveAccept,
  session_ack: sessionAck,
  base_lock: lock,
  base_lock_ack: lockAck,
  quote_lock: lock,
  quote_lock_ack: lockAck,
  claim_notice: claimNotice,
  fill_request: fillRequest,
  settlement_ack: settlementAck,
  refund,
  error: errorBody
};

export async function validateAtomicSwapMessage(
  message: ZwapTradeMessage
): Promise<AtomicSwapMessage> {
  if (!ATOMIC_SWAP_MESSAGE_TYPES.includes(message.type as AtomicSwapMessageType)) {
    throw new Error("Message is not a Zwap atomic swap message");
  }
  const type = message.type as AtomicSwapMessageType;
  const parsedBody = parsers[type](message.body);
  const sentAt = timestamp(message.sent_at, "Message sent_at");
  const hasTerms = message.terms !== undefined;
  if (type === "reserve_propose" || type === "reserve_accept") {
    if (!hasTerms) throw new Error(`${type} must carry canonical terms`);
    const computed = await termsHash(message.terms!);
    if (computed !== message.terms_hash) throw new Error("Atomic swap terms hash is invalid");
  } else if (hasTerms) {
    throw new Error(`${type} must not repeat complete terms`);
  }
  if (
    type === "reserve_propose" &&
    (parsedBody as ReserveProposeBody).fill_amount !== message.terms!.base_amount
  ) {
    throw new Error("Fill amount differs from canonical terms");
  }
  if (type === "reserve_accept") {
    const body = parsedBody as ReserveAcceptBody;
    if (body.maker_claim_cutoff <= sentAt) {
      throw new Error("Settlement deadlines are already unsafe at acceptance");
    }
    if (body.base_lock.expiration_time <= sentAt) throw new Error("Lock expiration has already passed");
  }
  if (type === "base_lock" || type === "quote_lock") {
    const body = parsedBody as LockBody;
    if (body.expiration_time <= sentAt) throw new Error("Lock expiration has already passed");
  }
  if (type === "claim_notice" && (parsedBody as ClaimNoticeBody).claimed_at > sentAt) {
    throw new Error("Claim timestamp is later than the message");
  }
  if (type === "refund" && (parsedBody as RefundBody).refunded_at > sentAt) {
    throw new Error("Refund timestamp is later than the message");
  }
  return { ...message, type, body: parsedBody } as AtomicSwapMessage;
}

export type AtomicSwapChoreographyPhase =
  | "awaiting_reserve_propose"
  | "awaiting_reserve_accept"
  | "awaiting_session_ack"
  | "awaiting_base_lock"
  | "awaiting_base_lock_ack"
  | "awaiting_quote_lock"
  | "awaiting_quote_lock_ack"
  | "awaiting_claim_notice"
  | "awaiting_fill_request"
  | "awaiting_settlement_ack"
  | "settling"
  | "settled"
  | "refunding"
  | "failed";

export interface AtomicSwapParticipants {
  makerOrderPubkey: string;
  makerSessionPubkey?: string;
  takerSessionPubkey?: string;
  makerAddress?: string;
  takerAddress?: string;
}

export interface AtomicSwapChoreography {
  phase: AtomicSwapChoreographyPhase;
  participants: AtomicSwapParticipants;
  sessionId?: string;
  reservationId?: string;
  orderAddress?: string;
  orderProjectionId?: string;
  orderRevision?: string;
  termsHash?: string;
  terms?: ZwapTradeTerms;
  lastMessageId?: string;
  settlementHash?: string;
  reserveProjectionId?: string;
  reserveProjectionRevision?: string;
  shortLocktime?: number;
  longLocktime?: number;
  baseHtlcId?: string;
  baseValidationCommitment?: string;
  quoteHtlcId?: string;
  quoteValidationCommitment?: string;
  refundedLegs: RefundLeg[];
}

export function initialAtomicSwapChoreography(makerOrderPubkey: string): AtomicSwapChoreography {
  hex32(makerOrderPubkey, "Maker order public key");
  return {
    phase: "awaiting_reserve_propose",
    participants: { makerOrderPubkey },
    refundedLegs: []
  };
}

function nextState(
  state: AtomicSwapChoreography,
  message: AtomicSwapMessage,
  patch: Partial<AtomicSwapChoreography>
): AtomicSwapChoreography {
  return {
    ...state,
    ...patch,
    participants: patch.participants ?? state.participants,
    refundedLegs: patch.refundedLegs ?? state.refundedLegs,
    lastMessageId: message.message_id
  };
}

function expectedType(state: AtomicSwapChoreography, type: AtomicSwapMessageType): void {
  const expected: Partial<Record<AtomicSwapChoreographyPhase, AtomicSwapMessageType>> = {
    awaiting_reserve_propose: "reserve_propose",
    awaiting_reserve_accept: "reserve_accept",
    awaiting_session_ack: "session_ack",
    awaiting_base_lock: "base_lock",
    awaiting_base_lock_ack: "base_lock_ack",
    awaiting_quote_lock: "quote_lock",
    awaiting_quote_lock_ack: "quote_lock_ack",
    awaiting_claim_notice: "claim_notice",
    awaiting_fill_request: "fill_request",
    awaiting_settlement_ack: "settlement_ack"
  };
  const required = expected[state.phase];
  if (required !== type) throw new Error(`Expected ${required ?? "no further message"}, received ${type}`);
}

function sameCommonSession(
  state: AtomicSwapChoreography,
  message: AtomicSwapMessage,
  allowProjectionChange = false
): void {
  if (
    message.maker_order_pubkey !== state.participants.makerOrderPubkey ||
    message.session_id !== state.sessionId ||
    message.reservation_id !== state.reservationId ||
    message.order_address !== state.orderAddress ||
    message.terms_hash !== state.termsHash
  ) {
    throw new Error("Atomic swap message does not match the bound session");
  }
  if (
    !allowProjectionChange &&
    state.orderProjectionId !== undefined &&
    (message.order_projection_id !== state.orderProjectionId ||
      message.order_revision !== state.orderRevision)
  ) {
    throw new Error("Atomic swap message does not match the current order projection");
  }
  if (message.previous_message_id !== state.lastMessageId) {
    throw new Error("Atomic swap message predecessor is not the last accepted message");
  }
}

function assertRole(message: AtomicSwapMessage, author: string | undefined, recipient: string | undefined): void {
  if (!author || message.author_pubkey !== author) throw new Error("Atomic swap message author role is invalid");
  if (!recipient || message.recipient_pubkey !== recipient) {
    throw new Error("Atomic swap message recipient role is invalid");
  }
}

function assertSettlement(state: AtomicSwapChoreography, settlementHash: string): void {
  if (!state.settlementHash || settlementHash !== state.settlementHash) {
    throw new Error("Settlement hash changed during the session");
  }
}

function semanticPhase(phase: AtomicSwapChoreographyPhase): AtomicSwapErrorPhase {
  const phases: Record<AtomicSwapChoreographyPhase, AtomicSwapErrorPhase> = {
    awaiting_reserve_propose: "negotiating",
    awaiting_reserve_accept: "negotiating",
    awaiting_session_ack: "reserved",
    awaiting_base_lock: "reserved",
    awaiting_base_lock_ack: "base_locked",
    awaiting_quote_lock: "base_locked",
    awaiting_quote_lock_ack: "quote_locked",
    awaiting_claim_notice: "quote_locked",
    awaiting_fill_request: "quote_claimed",
    awaiting_settlement_ack: "base_claimed",
    settling: "quote_locked",
    settled: "filled",
    refunding: "waiting_base_refund",
    failed: "frozen"
  };
  return phases[phase];
}

function assertLockTerms(
  state: AtomicSwapChoreography,
  body: LockBody,
  slot: "base" | "quote"
): void {
  const terms = state.terms;
  if (!terms) throw new Error("Canonical terms are unavailable");
  const makerOffersBase = terms.maker_side !== "buy";
  const actualLeg = slot === "base"
    ? (makerOffersBase ? "base" : "quote")
    : (makerOffersBase ? "quote" : "base");
  const prefix = actualLeg === "base" ? "base" : "quote";
  if (body.chain_id !== terms.chain_id) throw new Error("Chain ID differs from terms");
  if (body.token_standard !== terms[`${prefix}_token`]) throw new Error(`${prefix} token differs from terms`);
  if (body.amount !== terms[`${prefix}_amount`]) throw new Error(`${prefix} amount differs from terms`);
  if (body.expiration_time !== (slot === "base" ? state.longLocktime : state.shortLocktime)) {
    throw new Error(`${prefix} expiration differs from accepted deadlines`);
  }
  assertSettlement(state, body.settlement_hash);
}

export async function advanceAtomicSwapChoreography(
  state: AtomicSwapChoreography,
  rawMessage: ZwapTradeMessage
): Promise<AtomicSwapChoreography> {
  if (state.phase === "settled" || state.phase === "failed") {
    throw new Error("Atomic swap choreography is terminal");
  }
  const message = await validateAtomicSwapMessage(rawMessage);

  if (message.type === "error") {
    if (state.phase === "awaiting_reserve_propose") {
      throw new Error("An error cannot precede the reservation proposal");
    }
    sameCommonSession(state, message);
    const body = message.body as ErrorBody;
    if (body.at_phase !== semanticPhase(state.phase)) {
      throw new Error("Error phase does not match the current choreography");
    }
    if (body.failed_message_id !== null && body.failed_message_id !== state.lastMessageId) {
      throw new Error("Error does not reference the last accepted message");
    }
    const maker = state.participants.makerSessionPubkey ??
      state.participants.makerOrderPubkey;
    const taker = state.participants.takerSessionPubkey;
    if (
      !taker ||
      !(
        (message.author_pubkey === maker && message.recipient_pubkey === taker) ||
        (message.author_pubkey === taker && message.recipient_pubkey === maker)
      )
    ) {
      throw new Error("Error must be exchanged between the current session counterparties");
    }
    return nextState(state, message, { phase: "failed" });
  }

  if (message.type === "refund") {
    if (!state.baseHtlcId) throw new Error("A refund requires a locked leg");
    sameCommonSession(state, message);
    const body = message.body as RefundBody;
    assertSettlement(state, body.settlement_hash);
    if (body.leg === "base") {
      assertRole(
        message,
        state.participants.makerSessionPubkey,
        state.participants.takerSessionPubkey
      );
      if (
        body.htlc_id !== state.baseHtlcId ||
        state.longLocktime === undefined ||
        body.refunded_at <= state.longLocktime + 60
      ) {
        throw new Error("Base refund is not bound to the locked leg or its recovery deadline");
      }
    } else {
      if (!state.quoteHtlcId) throw new Error("A quote refund requires a locked quote leg");
      assertRole(
        message,
        state.participants.takerSessionPubkey,
        state.participants.makerSessionPubkey
      );
      if (
        body.htlc_id !== state.quoteHtlcId ||
        state.shortLocktime === undefined ||
        body.refunded_at <= state.shortLocktime + 60
      ) {
        throw new Error("Quote refund is not bound to the locked leg or its recovery deadline");
      }
    }
    return nextState(state, message, {
      phase: "refunding",
      refundedLegs: [...new Set([...state.refundedLegs, body.leg])]
    });
  }

  expectedType(state, message.type);

  if (message.type === "reserve_propose") {
    const body = message.body as ReserveProposeBody;
    if (
      message.maker_order_pubkey !== state.participants.makerOrderPubkey ||
      message.recipient_pubkey !== state.participants.makerOrderPubkey ||
      message.author_pubkey !== body.taker_session_pubkey ||
      message.author_pubkey === message.recipient_pubkey
    ) {
      throw new Error("Reservation proposal must use the taker session author and maker order recipient");
    }
    if (message.previous_message_id !== null || message.previous_transcript_hash !== null) {
      throw new Error("Reservation proposal cannot have a predecessor");
    }
    return nextState(state, message, {
      phase: "awaiting_reserve_accept",
      sessionId: message.session_id,
      reservationId: message.reservation_id,
      orderAddress: message.order_address,
      orderProjectionId: message.order_projection_id,
      orderRevision: message.order_revision,
      termsHash: message.terms_hash,
      terms: structuredClone(message.terms!),
      participants: {
        makerOrderPubkey: state.participants.makerOrderPubkey,
        takerSessionPubkey: body.taker_session_pubkey,
        takerAddress: body.taker_address
      }
    });
  }

  sameCommonSession(
    state,
    message,
    message.type === "reserve_accept" || message.type === "settlement_ack"
  );
  const makerOrder = state.participants.makerOrderPubkey;
  const makerSession = state.participants.makerSessionPubkey;
  const takerSession = state.participants.takerSessionPubkey;

  if (message.type === "reserve_accept") {
    const body = message.body as ReserveAcceptBody;
    assertRole(message, makerOrder, takerSession);
    if (
      body.taker_session_pubkey !== takerSession ||
      body.reserve_projection_id !== message.order_projection_id ||
      body.reserve_revision !== message.order_revision ||
      body.maker_session_pubkey === makerOrder ||
      body.maker_session_pubkey === takerSession
    ) {
      throw new Error("Reservation acceptance key handoff or projection is invalid");
    }
    if (body.maker_address === state.participants.takerAddress) {
      throw new Error("Maker and taker settlement addresses must differ");
    }
    if (
      !message.terms ||
      canonicalJson(message.terms) !== canonicalJson(state.terms)
    ) {
      throw new Error("Reservation acceptance terms differ from the proposal");
    }
    const acceptedState = {
      ...state,
      settlementHash: body.settlement_hash,
      shortLocktime: body.short_locktime,
      longLocktime: body.long_locktime,
      participants: {
        ...state.participants,
        makerSessionPubkey: body.maker_session_pubkey,
        makerAddress: body.maker_address
      }
    };
    assertLockTerms(acceptedState, body.base_lock, "base");
    if (
      body.base_lock.hash_locked_address !== state.participants.takerAddress ||
      body.base_lock.time_locked_address !== body.maker_address
    ) {
      throw new Error("Base lock addresses differ from the accepted participants");
    }
    return nextState(state, message, {
      phase: "awaiting_quote_lock",
      orderProjectionId: body.reserve_projection_id,
      orderRevision: body.reserve_revision,
      settlementHash: body.settlement_hash,
      reserveProjectionId: body.reserve_projection_id,
      reserveProjectionRevision: body.reserve_revision,
      shortLocktime: body.short_locktime,
      longLocktime: body.long_locktime,
      baseHtlcId: body.base_lock.htlc_id,
      baseValidationCommitment: body.base_lock.validation_commitment,
      participants: {
        ...state.participants,
        makerSessionPubkey: body.maker_session_pubkey,
        makerAddress: body.maker_address
      }
    });
  }

  if (message.type === "session_ack") {
    const body = message.body as SessionAckBody;
    assertRole(message, takerSession, makerSession);
    if (
      body.reserve_accept_message_id !== message.previous_message_id ||
      body.reserve_accept_transcript_hash !== message.previous_transcript_hash
    ) {
      throw new Error("Session acknowledgement does not bind the acceptance message");
    }
    if (
      body.reserve_projection_id !== state.reserveProjectionId ||
      body.reserve_revision !== state.reserveProjectionRevision ||
      body.settlement_hash !== state.settlementHash
    ) {
      throw new Error("Session acknowledgement changed the accepted reservation");
    }
    return nextState(state, message, { phase: "awaiting_base_lock" });
  }

  if (message.type === "base_lock") {
    const body = message.body as LockBody;
    assertRole(message, makerSession, takerSession);
    assertLockTerms(state, body, "base");
    if (
      body.hash_locked_address !== state.participants.takerAddress ||
      body.time_locked_address !== state.participants.makerAddress
    ) {
      throw new Error("Base lock addresses differ from the accepted participants");
    }
    return nextState(state, message, {
      phase: "awaiting_base_lock_ack",
      baseHtlcId: body.htlc_id,
      baseValidationCommitment: body.validation_commitment
    });
  }

  if (message.type === "base_lock_ack") {
    const body = message.body as LockAckBody;
    assertRole(message, takerSession, makerSession);
    if (
      body.lock_message_id !== message.previous_message_id ||
      body.lock_transcript_hash !== message.previous_transcript_hash
    ) {
      throw new Error("Base lock acknowledgement does not bind the lock message");
    }
    if (body.htlc_id !== state.baseHtlcId) {
      throw new Error("Base HTLC ID changed in the acknowledgement");
    }
    if (body.validation_commitment !== state.baseValidationCommitment) {
      throw new Error("Base validation commitment changed in the acknowledgement");
    }
    assertSettlement(state, body.settlement_hash);
    return nextState(state, message, { phase: "awaiting_quote_lock" });
  }

  if (message.type === "quote_lock") {
    const body = message.body as LockBody;
    assertRole(message, takerSession, makerSession);
    assertLockTerms(state, body, "quote");
    if (
      body.hash_locked_address !== state.participants.makerAddress ||
      body.time_locked_address !== state.participants.takerAddress
    ) {
      throw new Error("Quote lock addresses differ from the accepted participants");
    }
    return nextState(state, message, {
      phase: "settling",
      quoteHtlcId: body.htlc_id,
      quoteValidationCommitment: body.validation_commitment
    });
  }

  if (message.type === "quote_lock_ack") {
    const body = message.body as LockAckBody;
    assertRole(message, makerSession, takerSession);
    if (
      body.lock_message_id !== message.previous_message_id ||
      body.lock_transcript_hash !== message.previous_transcript_hash
    ) {
      throw new Error("Quote lock acknowledgement does not bind the lock message");
    }
    if (body.htlc_id !== state.quoteHtlcId) {
      throw new Error("Quote HTLC ID changed in the acknowledgement");
    }
    if (body.validation_commitment !== state.quoteValidationCommitment) {
      throw new Error("Quote validation commitment changed in the acknowledgement");
    }
    assertSettlement(state, body.settlement_hash);
    return nextState(state, message, { phase: "awaiting_claim_notice" });
  }

  if (message.type === "claim_notice") {
    const body = message.body as ClaimNoticeBody;
    assertRole(message, makerSession, takerSession);
    if (body.quote_htlc_id !== state.quoteHtlcId) {
      throw new Error("Claim notice quote HTLC ID changed");
    }
    assertSettlement(state, body.settlement_hash);
    if (state.shortLocktime === undefined || body.claimed_at >= state.shortLocktime - 120) {
      throw new Error("Claim notice is outside the maker claim window");
    }
    return nextState(state, message, { phase: "awaiting_fill_request" });
  }

  if (message.type === "fill_request") {
    const body = message.body as FillRequestBody;
    assertRole(message, takerSession, makerSession);
    if (
      body.base_htlc_id !== state.baseHtlcId ||
      body.quote_htlc_id !== state.quoteHtlcId
    ) {
      throw new Error("Fill request HTLC ID changed");
    }
    assertSettlement(state, body.settlement_hash);
    return nextState(state, message, { phase: "awaiting_settlement_ack" });
  }

  const body = message.body as SettlementAckBody;
  assertRole(message, makerSession, takerSession);
  if (
    body.fill_projection_id !== message.order_projection_id ||
    body.fill_revision !== message.order_revision ||
    state.reserveProjectionRevision === undefined ||
    BigInt(body.fill_revision) !== BigInt(state.reserveProjectionRevision) + 1n ||
    body.base_htlc_id !== state.baseHtlcId ||
    body.quote_htlc_id !== state.quoteHtlcId
  ) {
    throw new Error("Settlement acknowledgement HTLC ID changed");
  }
  assertSettlement(state, body.settlement_hash);
  return nextState(state, message, {
    phase: "settled",
    orderProjectionId: body.fill_projection_id,
    orderRevision: body.fill_revision
  });
}
