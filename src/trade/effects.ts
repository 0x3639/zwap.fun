import { isHex32 } from "../zenon/validate.js";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";

import type {
  OrderApi,
  PublishFillInput,
  PublishReleaseInput,
  PublishReserveInput
} from "../api/order-api.js";
import type {
  DiscoveredTradeInbox,
  NostrTradeTransport
} from "../nostr/trade-transport.js";
import type { NostrEvent } from "../order/events.js";
import type { PublishedOrderProjection } from "../order/service.js";
import type {
  OrderOutboxEntry,
  OrderOutboxPort,
  OrderPublicationStatus
} from "../storage/order-outbox.js";
import {
  reservedAmount,
  type FundsReservationRepository
} from "../zenon/funds-reservations.js";
import {
  HtlcValidationError,
  type ExpectedZenonLock
} from "../zenon/htlc.js";
import { verifyHtlcMaterial } from "../zenon/htlc-material.js";
import {
  ZenonTradeError,
  type PreparedChainOperation,
  type ZenonTradeClient
} from "../zenon/trade-client.js";
import type { ZenonNodePort } from "../zenon/types.js";
import {
  advanceAtomicSwapChoreography,
  validateAtomicSwapMessage,
  ATOMIC_SWAP_BODY_SCHEMA,
  type AtomicSwapBody,
  type AtomicSwapErrorCode,
  type AtomicSwapMessageType
} from "./atomic-messages.js";
import {
  legSlot,
  makerOffersBase,
  recoveryIsIdle,
  recoveryStep,
  slotLeg,
  type CoordinatorAction
} from "./coordinator-plan.js";
import type {
  CoordinatorEffectPort,
  CoordinatorExternalEffectInput,
  CoordinatorStepInput
} from "./coordinator.js";
import {
  createTradeRumor,
  deploymentFor,
  termsHash,
  transcriptHash,
  unwrapReserveAcceptance,
  unwrapTradeMessage,
  wrapTradeRumor,
  type OpenedTradeMessage,
  type WrappedTradeRumor,
  type ZwapTradeMessage,
  type ZwapTradeTerms,
  randomOuterExpiration
} from "./messages.js";
import { advanceTrade, canAdvanceTrade, SHORT_LOCK_SECONDS } from "./model.js";
import type {
  ChainOperationResult,
  PersistedHtlcState,
  TradeSession
} from "./session.js";
import { verifyEvent } from "nostr-tools/pure";
import { parseProjectionEvent } from "../order/events.js";

type WithAccountLock = <T>(action: () => Promise<T>) => Promise<T>;

/**
 * A chain or node failure translated into the atomic-swap error vocabulary the
 * counterparty understands. The original failure is kept as `cause` so nothing
 * is lost when the coordinator surfaces it.
 */
export class ZwapChainEffectError extends Error {
  constructor(
    readonly code: AtomicSwapErrorCode,
    readonly retryable: boolean,
    override readonly cause: unknown,
    message: string
  ) {
    super(message);
    this.name = "ZwapChainEffectError";
  }
}

// `\bpow\b` and not a bare `pow`: "empowered" is not a plasma shortfall, and
// mistaking one for the other makes a terminal failure look retryable.
const PLASMA_PATTERN = /plasma|\bpow\b/i;
const NETWORK_PATTERN = /network|timeout|ECONN|socket/i;

/**
 * Maps a Zenon failure onto an atomic-swap error code. `reclaimed` marks the
 * one case where a missing HTLC is terminal rather than "keep polling": the leg
 * was already observed as `RECLAIMED`.
 */
export function classifyChainError(
  error: unknown,
  options: { reclaimed?: boolean } = {}
): { code: AtomicSwapErrorCode; retryable: boolean } {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof ZenonTradeError && error.code === "insufficient-balance") {
    return { code: "chain_rejected", retryable: false };
  }
  if (error instanceof HtlcValidationError) {
    return { code: "terms_mismatch", retryable: false };
  }
  if (error instanceof ZenonTradeError && error.code === "htlc-missing") {
    return { code: "htlc_state_invalid", retryable: options.reclaimed !== true };
  }
  if (PLASMA_PATTERN.test(message)) {
    return { code: "plasma_unavailable", retryable: true };
  }
  if (
    (error instanceof Error && error.name === "ZnnClientException") ||
    NETWORK_PATTERN.test(message)
  ) {
    return { code: "node_unavailable", retryable: true };
  }
  if (error instanceof ZenonTradeError) {
    return { code: "chain_rejected", retryable: false };
  }
  return { code: "internal_error", retryable: false };
}

async function onChain<T>(
  action: () => Promise<T>,
  options: { reclaimed?: boolean } = {}
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof ZwapChainEffectError) throw error;
    const { code, retryable } = classifyChainError(error, options);
    throw new ZwapChainEffectError(
      code,
      retryable,
      error,
      `Zenon settlement effect failed (${code}): ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

export interface CoordinatorMakerIdentity {
  publicKey(orderId?: string): Promise<string>;
  useSecretKey?<T>(action: (secretKey: Uint8Array) => Promise<T>): Promise<T>;
  useOrderSecretKey?<T>(orderId: string, action: (secretKey: Uint8Array) => Promise<T>): Promise<T>;
}

export interface CoordinatorEffectsEntropy {
  messageId(): string;
  operationId(): string;
  ephemeralSecretKey(): Uint8Array;
  nonce(purpose: "seal" | "wrapper"): Uint8Array;
  randomizedTimestamp(now: number, purpose: "seal" | "wrapper"): number;
  outerExpiration(messageExpiration: number): number;
}

export type { PublishedOrderProjection } from "../order/service.js";

export interface CoordinatorOrderReadPort {
  loadPublishedProjection(
    address: string,
    expectedProjectionId: string,
    expectedRevision: string
  ): Promise<PublishedOrderProjection>;
  loadLatestPublishedProjection(
    address: string
  ): Promise<PublishedOrderProjection>;
}

export interface ZwapCoordinatorEffectsOptions {
  orderApi: Pick<
    OrderApi,
    | "ensureReserveStaged"
    | "ensureFillStaged"
    | "ensureReleaseStaged"
    | "publishNextStage"
    | "clearAcknowledgedOrderPublication"
    | "pruneCommittedOrderPublication"
  >;
  orderOutbox: Pick<OrderOutboxPort, "load">;
  orderReader: CoordinatorOrderReadPort;
  nostr: Pick<
    NostrTradeTransport,
    | "createRegistration"
    | "publishRegistration"
    | "discoverInbox"
    | "send"
    | "read"
  >;
  chain: Pick<
    ZenonTradeClient,
    | "address"
    | "prepareLock"
    | "completeLock"
    | "validateIncomingLock"
    | "prepareClaim"
    | "completeClaim"
    | "prepareRefund"
    | "completeRefund"
    | "observe"
  >;
  node: Pick<ZenonNodePort, "getBalances">;
  reservations: Pick<FundsReservationRepository, "load" | "reserve" | "release">;
  makerIdentity: CoordinatorMakerIdentity;
  discoveryRelays: readonly string[];
  withAccountLock: WithAccountLock;
  network: string;
  /**
   * The short locktime this deployment plans with. The taker rebuilds the
   * maker's plan anchor from it, because `reserve_accept` carries the absolute
   * deadlines but not the anchor they were derived from.
   */
  shortLockSeconds?: number;
  entropy?: CoordinatorEffectsEntropy;
  commitment?: (value: string) => Promise<string>;
}

const EXTERNAL_ACTIONS = new Set<CoordinatorAction["kind"]>([
  "publish_order_projection",
  "commit_order_publication",
  "clear_order_publication",
  "publish_inbox_registration",
  "verify_inbox_registration",
  "deliver_outbox",
  "validate_incoming",
  "reserve_funds",
  "execute_chain_operation",
  "reconcile_account",
  "stage_reserve_propose",
  "stage_order_reserve",
  "stage_reserve_accept",
  "poll_inbox",
  "stage_session_ack",
  "prepare_base_lock",
  "stage_base_lock",
  "stage_base_lock_ack",
  "prepare_quote_lock",
  "stage_quote_lock",
  "stage_quote_lock_ack",
  "prepare_quote_claim",
  "stage_claim_notice",
  "observe_quote",
  "prepare_base_claim",
  "stage_fill_request",
  "observe_base",
  "stage_order_fill",
  "verify_order_fill",
  "stage_order_release",
  "stage_settlement_ack",
  "prepare_quote_refund",
  "prepare_base_refund"
]);

const OUTGOING_ACTIONS = new Map<CoordinatorAction["kind"], AtomicSwapMessageType>([
  ["stage_reserve_propose", "reserve_propose"],
  ["stage_reserve_accept", "reserve_accept"],
  ["stage_session_ack", "session_ack"],
  ["stage_base_lock", "base_lock"],
  ["stage_base_lock_ack", "base_lock_ack"],
  ["stage_quote_lock", "quote_lock"],
  ["stage_quote_lock_ack", "quote_lock_ack"],
  ["stage_claim_notice", "claim_notice"],
  ["stage_fill_request", "fill_request"],
  ["stage_settlement_ack", "settlement_ack"]
]);

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NIP17_TIMESTAMP_LOOKBACK_SECONDS = 172_800;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function bytes(hex: string, label: string): Uint8Array {
  if (!isHex32(hex)) throw new Error(`${label} is not a 32-byte key`);
  return Uint8Array.from(hex.match(/../g) ?? [], (part) => Number.parseInt(part, 16));
}

function hex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return hex(new Uint8Array(digest));
}

const defaultEntropy: CoordinatorEffectsEntropy = {
  messageId: () => crypto.randomUUID(),
  operationId: () => crypto.randomUUID(),
  ephemeralSecretKey: () => generateSecretKey(),
  nonce: () => crypto.getRandomValues(new Uint8Array(32)),
  randomizedTimestamp: (now) => now -
    Math.floor(crypto.getRandomValues(new Uint32Array(1))[0]! % 172_801),
  outerExpiration: (expiration) => randomOuterExpiration(expiration)
};

function bump(session: TradeSession, now: number): TradeSession {
  if (!Number.isSafeInteger(now) || now < session.updatedAt) {
    throw new Error("Coordinator effect time regressed");
  }
  const next = clone(session);
  next.revision += 1;
  next.updatedAt = now;
  return next;
}

function orderId(session: TradeSession): string {
  const id = session.orderAddress.split(":").at(-1);
  if (!id || !UUID_V4.test(id)) throw new Error("Trade order address lacks its order ID");
  return id;
}

function zwapTerms(session: TradeSession): ZwapTradeTerms {
  return {
    ...(session.terms.makerSide === undefined
      ? {}
      : { maker_side: session.terms.makerSide }),
    chain_id: session.terms.chainId,
    base_token: session.terms.baseToken,
    quote_token: session.terms.quoteToken,
    base_amount: session.terms.baseAmount,
    quote_amount: session.terms.quoteAmount,
    price: session.terms.price
  };
}

function participant(
  session: TradeSession,
  field: "makerSessionPubkey" | "takerSessionPubkey" |
    "makerAddress" | "takerAddress"
): string {
  const value = session.privateState.transcript.choreography.participants[field];
  if (!value) throw new Error(`Trade participant ${field} is not checkpointed`);
  return value;
}

function localNostrPubkey(session: TradeSession): string {
  const key = bytes(session.privateState.nostrPrivateKey, "Trade Nostr private key");
  try {
    return getPublicKey(key);
  } finally {
    key.fill(0);
  }
}

/**
 * How far a leg has progressed. The evidence summary never moves backwards
 * through this order, so an inconclusive reading cannot retract a settled one.
 */
const HTLC_STATE_RANK: Record<PersistedHtlcState, number> = {
  UNKNOWN: 0,
  LOCKED: 1,
  RECLAIMED: 2,
  UNLOCKED: 3
};

type ProtocolSlot = "base" | "quote";

/**
 * Builds the exact HTLC terms both sides must agree on for one protocol slot.
 *
 * The maker always funds the `base` slot (long locktime) and the taker the
 * `quote` slot (short locktime); which *market* leg that is depends on the
 * maker's order side. Locktimes are therefore keyed off the slot — the same
 * convention `coordinator-plan.lockReady`, the durable validator and
 * `atomic-messages.assertLockTerms` use — while the token and amount are keyed
 * off the leg.
 */
function expectedLock(
  session: TradeSession,
  slot: ProtocolSlot,
  network: string
): ExpectedZenonLock {
  const leg = slotLeg(session, slot);
  const p = session.privateState;
  if (!p.htlcHash || !p.settlementTranscriptHash || !p.counterpartyAddress) {
    throw new Error("Settlement terms are not bound yet");
  }
  const makerLocksThisLeg = (leg === "base") === makerOffersBase(session);
  const localIsLocker = (session.role === "maker") === makerLocksThisLeg;
  const timeLockedAddress = localIsLocker ? p.localAddress : p.counterpartyAddress;
  const hashLockedAddress = localIsLocker ? p.counterpartyAddress : p.localAddress;
  return {
    leg,
    chainId: session.terms.chainId,
    tokenStandard: leg === "base" ? session.terms.baseToken : session.terms.quoteToken,
    amount: leg === "base" ? session.terms.baseAmount : session.terms.quoteAmount,
    hashLock: p.htlcHash,
    hashType: 1,
    keyMaxSize: 32,
    hashLockedAddress,
    timeLockedAddress,
    expirationTime: slot === "base"
      ? session.plan.longLocktime
      : session.plan.shortLocktime,
    binding: {
      protocolVersion: "1",
      network,
      orderId: orderId(session),
      sessionId: session.sessionId,
      reservationId: session.reservationId,
      transcriptHash: p.settlementTranscriptHash
    }
  };
}

function completedLockBody(
  session: TradeSession,
  slot: ProtocolSlot
): AtomicSwapBody<"base_lock"> {
  const leg = slotLeg(session, slot);
  const evidence = session.evidence.legs[leg];
  const privateLeg = session.privateState.legs[leg];
  const expected = privateLeg.expected;
  const htlcHash = session.privateState.htlcHash;
  if (
    !privateLeg.htlcId ||
    !expected ||
    !evidence.htlcId ||
    !evidence.validationCommitment ||
    !htlcHash
  ) {
    throw new Error(`${leg} lock lacks completed on-chain evidence`);
  }
  return {
    schema: ATOMIC_SWAP_BODY_SCHEMA,
    htlc_id: evidence.htlcId,
    validation_commitment: evidence.validationCommitment,
    settlement_hash: htlcHash,
    chain_id: expected.chainId,
    token_standard: expected.tokenStandard,
    amount: expected.amount,
    hash_locked_address: expected.hashLockedAddress,
    time_locked_address: expected.timeLockedAddress,
    expiration_time: expected.expirationTime
  };
}

function rootPhase(
  choreography: TradeSession["privateState"]["transcript"]["choreography"]
): TradeSession["phase"] {
  const phases: Record<typeof choreography.phase, TradeSession["phase"]> = {
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
  return phases[choreography.phase];
}

function publicationTimes(
  entry: OrderOutboxEntry,
  previous: TradeSession["pendingOrderPublication"],
  now: number
): Pick<
  NonNullable<TradeSession["pendingOrderPublication"]>,
  "stagedAt" | "acknowledgedAt" | "committedAt"
> {
  const rank: Record<OrderPublicationStatus, number> = {
    staged: 0,
    acknowledged: 1,
    committed: 2
  };
  return {
    stagedAt: previous?.stagedAt ?? entry.intent.createdAt,
    acknowledgedAt: rank[entry.status] >= 1
      ? previous?.acknowledgedAt ?? now
      : null,
    committedAt: rank[entry.status] >= 2
      ? previous?.committedAt ?? now
      : null
  };
}

function exactPendingPublication(
  session: TradeSession,
  entry: OrderOutboxEntry,
  now: number
): NonNullable<TradeSession["pendingOrderPublication"]> {
  const previous = session.pendingOrderPublication;
  if (
    entry.intent.address !== session.orderAddress ||
    entry.intent.orderId !== orderId(session) ||
    (entry.intent.operation !== "reserve" &&
      entry.intent.operation !== "fill" &&
      entry.intent.operation !== "release") ||
    (previous !== null && (
      previous.orderId !== entry.intent.orderId ||
      previous.projection.id !== entry.publication.projection.id
    ))
  ) throw new Error("Order outbox entry conflicts with the trade session");
  return {
    operation: entry.intent.operation,
    orderId: entry.intent.orderId,
    projection: clone(entry.publication.projection),
    receipts: clone(entry.publication.receipts),
    status: entry.status,
    ...publicationTimes(entry, previous, now)
  };
}

export class ZwapCoordinatorEffects implements CoordinatorEffectPort {
  private readonly orderApi: ZwapCoordinatorEffectsOptions["orderApi"];
  private readonly orderOutbox: ZwapCoordinatorEffectsOptions["orderOutbox"];
  private readonly orderReader: CoordinatorOrderReadPort;
  private readonly nostr: ZwapCoordinatorEffectsOptions["nostr"];
  private readonly chain: ZwapCoordinatorEffectsOptions["chain"];
  private readonly node: ZwapCoordinatorEffectsOptions["node"];
  private readonly reservations: ZwapCoordinatorEffectsOptions["reservations"];
  private readonly makerIdentity: CoordinatorMakerIdentity;
  private readonly discoveryRelays: string[];
  private readonly withAccountLock: WithAccountLock;
  private readonly network: string;
  private readonly shortLockSeconds: number;
  private readonly entropy: CoordinatorEffectsEntropy;
  private readonly commitment: (value: string) => Promise<string>;

  constructor(options: ZwapCoordinatorEffectsOptions) {
    this.orderApi = options.orderApi;
    this.orderOutbox = options.orderOutbox;
    this.orderReader = options.orderReader;
    this.nostr = options.nostr;
    this.chain = options.chain;
    this.node = options.node;
    this.reservations = options.reservations;
    this.makerIdentity = options.makerIdentity;
    this.discoveryRelays = [...options.discoveryRelays];
    this.withAccountLock = options.withAccountLock;
    this.network = options.network;
    this.shortLockSeconds = options.shortLockSeconds ?? SHORT_LOCK_SECONDS;
    this.entropy = options.entropy ?? defaultEntropy;
    this.commitment = options.commitment ?? sha256;
  }

  private expectedLock(session: TradeSession, slot: ProtocolSlot): ExpectedZenonLock {
    return expectedLock(session, slot, this.network);
  }

  classify(action: CoordinatorAction): "local" | "external" {
    return EXTERNAL_ACTIONS.has(action.kind) ? "external" : "local";
  }

  async externalFingerprintMaterial(
    action: CoordinatorAction,
    session: TradeSession
  ): Promise<unknown> {
    if (!action.kind.startsWith("prepare_")) return null;
    return this.withAccountLock(async () => {
      const reservations = await this.reservations.load();
      const slot = action.kind.includes("base") ? "base" : "quote";
      const leg = slotLeg(session, slot);
      const expected = this.expectedLock(session, slot);
      if (action.kind.endsWith("_lock")) {
        return {
          reservationRevision: reservations.revision,
          address: this.chain.address(),
          expected
        };
      }
      const htlcId = session.privateState.legs[leg].htlcId;
      if (!htlcId) throw new Error("Chain spend preparation lacks its HTLC ID");
      return { reservationRevision: reservations.revision, htlcId, expected };
    });
  }

  async applyLocal(input: CoordinatorStepInput): Promise<TradeSession> {
    const { action, session, now } = input;
    switch (action.kind) {
      case "stage_inbox_registration": {
        const key = bytes(session.privateState.nostrPrivateKey, "Trade Nostr private key");
        try {
          const event = this.nostr.createRegistration(key);
          const next = bump(session, now);
          next.privateState.inbox = {
            status: "staged",
            quorum: session.privateState.inbox.quorum,
            event,
            discoveryRelays: [...this.discoveryRelays],
            inboxRelays: event.tags.map((tag) => tag[1]!),
            receipts: [],
            readbacks: [],
            stagedAt: now,
            acknowledgedAt: null,
            registeredAt: null
          };
          return next;
        } finally {
          key.fill(0);
        }
      }
      case "commit_outbox":
        return this.commitOutbox(session, now);
      case "commit_incoming":
        return this.commitIncoming(session, now);
      case "clear_chain_operation": {
        const operation = session.privateState.chainOperation;
        if (operation?.status !== "account_applied") {
          throw new Error("Chain operation is not reconciled");
        }
        const next = bump(session, now);
        next.privateState.chainOperation = null;
        // Each side holds exactly one leg, so applying its own refund ends its
        // ladder. The maker normally reaches `released` through the release
        // projection instead; this covers the taker, which never publishes one.
        if (operation.kind === "refund" && operation.result !== null) {
          const event = legSlot(session, operation.leg) === "base"
            ? "base_refund_confirmed"
            : "quote_refund_confirmed";
          if (canAdvanceTrade(session.phase, event)) {
            next.phase = advanceTrade(session.phase, event);
          }
        }
        return next;
      }
      case "enter_recovery": {
        // The planner owns the decision; this effect only records it. A
        // recovery that would change nothing is a livelock, not a checkpoint.
        if (recoveryIsIdle(session)) {
          throw new Error("Recovery would not move the trade session");
        }
        const step = recoveryStep(session);
        const next = bump(session, now);
        next.phase = step.phase;
        next.privateState.transcript.choreography.phase = step.choreography;
        // A message that failed validation is discarded by recovery; keeping it
        // would block every later action behind a checkpoint nothing can clear.
        if (next.privateState.pendingIncoming?.validation.status === "rejected") {
          next.privateState.pendingIncoming = null;
        }
        return next;
      }
      default:
        throw new Error(`Coordinator action ${action.kind} is not a local effect`);
    }
  }

  async performExternal(input: CoordinatorExternalEffectInput): Promise<TradeSession> {
    const outgoingType = OUTGOING_ACTIONS.get(input.action.kind);
    if (outgoingType !== undefined) {
      return this.stageOutgoing(input.session, outgoingType, input.now);
    }
    switch (input.action.kind) {
      case "stage_order_reserve":
      case "stage_order_fill":
      case "stage_order_release":
        return this.stageOrder(input.session, input.action.kind, input.now);
      case "verify_order_fill":
        return this.verifyOrderFill(input.session, input.now);
      case "publish_order_projection":
        return this.publishOrderStage(input.session, input.now);
      case "commit_order_publication":
        return this.commitOrderPublication(input.session, input.now);
      case "clear_order_publication":
        return this.clearOrderPublication(input.session, input.now);
      case "publish_inbox_registration":
        return this.publishInbox(input.session, input.now, false);
      case "verify_inbox_registration":
        return this.publishInbox(input.session, input.now, true);
      case "deliver_outbox":
        return this.deliverOutbox(input.session, input.now);
      case "poll_inbox":
        return this.pollInbox(input.session, input.now);
      case "validate_incoming":
        return this.validateIncoming(input.session, input.now);
      case "reserve_funds":
        return this.reserveFunds(input.session, input.now);
      case "prepare_base_lock":
      case "prepare_quote_lock":
      case "prepare_base_claim":
      case "prepare_quote_claim":
      case "prepare_base_refund":
      case "prepare_quote_refund":
        return this.prepareChain(input.session, input.action.kind, input.now);
      case "execute_chain_operation":
        return this.executeChain(input.session, input.now);
      case "reconcile_account":
        return this.reconcileAccount(input.session, input.now);
      case "observe_base":
      case "observe_quote":
        return this.observeLeg(
          input.session,
          slotLeg(input.session, input.action.kind === "observe_base" ? "base" : "quote"),
          input.now
        );
      default:
        throw new Error(`Coordinator action ${input.action.kind} is not an external effect`);
    }
  }

  private async verifyOrderFill(
    session: TradeSession,
    now: number
  ): Promise<TradeSession> {
    if (
      session.role !== "taker" ||
      session.privateState.transcript.choreography.phase !== "settling" ||
      session.fillProjectionId !== null ||
      session.evidence.fillProjectionId !== null
    ) {
      throw new Error("Taker fill verification is not checkpoint-ready");
    }
    const published = await this.orderReader.loadLatestPublishedProjection(
      session.orderAddress
    );
    const projection = await parseProjectionEvent(
      published.projection,
      verifyEvent
    );
    if (
      published.eventId !== published.projection.id ||
      published.revision !== projection.state.revision ||
      projection.makerPubkey !== session.evidence.makerPubkey ||
      projection.address !== session.orderAddress
    ) {
      throw new Error("Published fill maker or address does not match the trade");
    }
    if (
      published.eventId === session.reserveProjectionId &&
      published.revision === session.reserveProjectionRevision
    ) {
      return bump(session, now);
    }
    if (
      session.reserveProjectionRevision === null ||
      BigInt(projection.state.revision) !==
        BigInt(session.reserveProjectionRevision) + 1n ||
      projection.state.status !==
        (BigInt(projection.state.remaining_amount) === 0n
          ? "filled"
          : "partially_filled") ||
      projection.state.reservation !== null ||
      projection.state.reserved_amount !== "0"
    ) {
      throw new Error("Published fill projection is not the next terminal state");
    }

    const next = bump(session, now);
    next.fillProjectionId = published.eventId;
    next.fillProjectionRevision = published.revision;
    next.evidence.fillProjectionId = published.eventId;
    next.evidence.fillProjectionRevision = published.revision;
    next.privateState.transcript.choreography.phase = "settled";
    next.phase = "filled";
    return next;
  }

  private async stageOrder(
    session: TradeSession,
    action: "stage_order_reserve" | "stage_order_fill" | "stage_order_release",
    now: number
  ): Promise<TradeSession> {
    if (session.pendingOrderPublication !== null) {
      throw new Error("Order publication is already checkpointed");
    }
    let progress: { orderId: string };
    if (action === "stage_order_reserve") {
      const proposalEventId = session.evidence.reservation.proposalSealId;
      const taker = participant(session, "takerSessionPubkey");
      if (!proposalEventId) throw new Error("Reserve staging lacks proposal evidence");
      const takerCommitment = await this.commitment(
        `zwap-taker-v1:${session.sessionId}:${proposalEventId}:${taker}`
      );
      const request: PublishReserveInput = {
        address: session.orderAddress,
        expectedProjectionId: session.offeredProjectionId,
        expectedRevision: session.offeredProjectionRevision,
        reservationId: session.reservationId,
        amount: session.terms.baseAmount,
        expiresAt: session.plan.reservationExpiresAt,
        proposalEventId,
        takerCommitment
      };
      progress = await this.orderApi.ensureReserveStaged(request);
    } else if (action === "stage_order_fill") {
      const settlementHash = session.privateState.htlcHash;
      const base = session.evidence.legs.base.htlcId;
      const quote = session.evidence.legs.quote.htlcId;
      if (
        !session.reserveProjectionId ||
        !session.reserveProjectionRevision ||
        !settlementHash ||
        !base ||
        !quote
      ) {
        throw new Error("Fill staging lacks exact settlement evidence");
      }
      const request: PublishFillInput = {
        address: session.orderAddress,
        expectedProjectionId: session.reserveProjectionId,
        expectedRevision: session.reserveProjectionRevision,
        reservationId: session.reservationId,
        amount: session.terms.baseAmount,
        evidence: {
          settlement_hash: settlementHash,
          base_htlc_id: base,
          quote_htlc_id: quote
        }
      };
      progress = await this.orderApi.ensureFillStaged(request);
    } else {
      if (!session.reserveProjectionId || !session.reserveProjectionRevision) {
        throw new Error("Release staging lacks the reserve head");
      }
      // A frozen session holding nothing withdraws its reservation early -
      // the whole point of the deferred base lock. A session that walked the
      // refund ladder waited the reservation out and releases as expired.
      const withdrawn = session.phase === "frozen" &&
        session.privateState.legs.base.htlcId === null &&
        session.privateState.legs.quote.htlcId === null;
      const request: PublishReleaseInput = {
        address: session.orderAddress,
        expectedProjectionId: session.reserveProjectionId,
        expectedRevision: session.reserveProjectionRevision,
        reservationId: session.reservationId,
        reason: withdrawn ? "withdrawn" : "expired"
      };
      progress = await this.orderApi.ensureReleaseStaged(request);
    }
    const entry = await this.requiredOrderEntry(progress.orderId);
    const next = bump(session, Math.max(now, entry.intent.createdAt));
    next.pendingOrderPublication = exactPendingPublication(session, entry, now);
    if (entry.intent.operation === "reserve") {
      const takerCommitment =
        (entry.intent.state.reservation as { taker_commitment?: string } | null)
          ?.taker_commitment;
      if (!takerCommitment || !isHex32(takerCommitment)) {
        throw new Error("Staged reserve lacks the taker commitment");
      }
      next.reserveProjectionId = entry.publication.projection.id;
      next.reserveProjectionRevision = entry.publication.state.revision;
      next.evidence.reserveProjectionId = entry.publication.projection.id;
      next.evidence.reserveProjectionRevision = entry.publication.state.revision;
      next.evidence.reservation.takerCommitment = takerCommitment;
    } else if (entry.intent.operation === "fill") {
      next.fillProjectionId = entry.publication.projection.id;
      next.fillProjectionRevision = entry.publication.state.revision;
      next.evidence.fillProjectionId = entry.publication.projection.id;
      next.evidence.fillProjectionRevision = entry.publication.state.revision;
    }
    return next;
  }

  private async publishOrderStage(
    session: TradeSession,
    now: number
  ): Promise<TradeSession> {
    const pending = session.pendingOrderPublication;
    if (!pending) throw new Error("Order publication is not checkpointed");
    const before = await this.requiredOrderEntry(pending.orderId);
    if (before.status !== pending.status) {
      const next = bump(session, now);
      next.pendingOrderPublication = exactPendingPublication(session, before, now);
      return next;
    }
    await this.orderApi.publishNextStage(pending.orderId);
    const entry = await this.requiredOrderEntry(pending.orderId);
    const next = bump(session, now);
    next.pendingOrderPublication = exactPendingPublication(session, entry, now);
    return next;
  }

  private async commitOrderPublication(
    session: TradeSession,
    now: number
  ): Promise<TradeSession> {
    const pending = session.pendingOrderPublication;
    if (!pending || pending.status !== "acknowledged") {
      throw new Error("Order projection is not acknowledged");
    }
    await this.orderApi.clearAcknowledgedOrderPublication(pending.orderId);
    const entry = await this.requiredOrderEntry(pending.orderId);
    const next = bump(session, now);
    next.pendingOrderPublication = exactPendingPublication(session, entry, now);
    if (entry.intent.operation === "reserve") {
      const takerCommitment =
        (entry.intent.state.reservation as { taker_commitment?: string } | null)
          ?.taker_commitment;
      if (!takerCommitment || !isHex32(takerCommitment)) {
        throw new Error("Committed reserve lacks the taker commitment");
      }
      next.reserveProjectionId = entry.publication.projection.id;
      next.reserveProjectionRevision = entry.publication.state.revision;
      next.evidence.reserveProjectionId = entry.publication.projection.id;
      next.evidence.reserveProjectionRevision = entry.publication.state.revision;
      next.evidence.reservation.takerCommitment = takerCommitment;
    } else if (entry.intent.operation === "fill") {
      next.fillProjectionId = entry.publication.projection.id;
      next.fillProjectionRevision = entry.publication.state.revision;
      next.evidence.fillProjectionId = entry.publication.projection.id;
      next.evidence.fillProjectionRevision = entry.publication.state.revision;
      next.privateState.transcript.choreography.phase = "settled";
      next.phase = "filled";
    } else {
      next.phase = "released";
    }
    return next;
  }

  private async clearOrderPublication(
    session: TradeSession,
    now: number
  ): Promise<TradeSession> {
    const pending = session.pendingOrderPublication;
    if (!pending || pending.status !== "committed") {
      throw new Error("Order publication is not committed");
    }
    await this.orderApi.pruneCommittedOrderPublication(pending.orderId);
    const next = bump(session, now);
    next.pendingOrderPublication = null;
    return next;
  }

  private async requiredOrderEntry(id: string): Promise<OrderOutboxEntry> {
    const entry = await this.orderOutbox.load(id);
    if (!entry) throw new Error("Shared order outbox lost its exact publication");
    return entry;
  }

  private async publishInbox(
    session: TradeSession,
    now: number,
    verify: boolean
  ): Promise<TradeSession> {
    const inbox = session.privateState.inbox;
    if (!inbox.event) throw new Error("Inbox registration is not checkpointed");
    const key = bytes(session.privateState.nostrPrivateKey, "Trade Nostr private key");
    try {
      const result = await this.nostr.publishRegistration(inbox.event, key);
      if (result.event.id !== inbox.event.id) {
        throw new Error("Inbox transport returned a replacement registration");
      }
      const next = bump(session, now);
      next.privateState.inbox = verify
        ? {
            ...clone(inbox),
            status: "registered",
            receipts: clone(result.receipts),
            readbacks: clone(result.readback),
            acknowledgedAt: inbox.acknowledgedAt ?? now,
            registeredAt: now
          }
        : {
            ...clone(inbox),
            status: "acknowledged",
            receipts: clone(result.receipts),
            readbacks: [],
            acknowledgedAt: now,
            registeredAt: null
          };
      return next;
    } finally {
      key.fill(0);
    }
  }

  private async stageOutgoing(
    session: TradeSession,
    type: AtomicSwapMessageType,
    now: number
  ): Promise<TradeSession> {
    if (session.privateState.outbox !== null) {
      throw new Error("An exact outgoing envelope is already checkpointed");
    }
    const recipient = this.outgoingRecipient(session, type);
    const requesterKey = bytes(
      session.privateState.nostrPrivateKey,
      "Trade Nostr private key"
    );
    let discovered: DiscoveredTradeInbox;
    try {
      discovered = await this.nostr.discoverInbox(recipient, requesterKey);
    } finally {
      requesterKey.fill(0);
    }
    const terms = zwapTerms(session);
    const hash = await termsHash(terms);
    const body = await this.outgoingBody(session, type, now);
    const expiresAt = Math.min(session.plan.reservationExpiresAt, now + 3_600);
    if (expiresAt <= now) throw new Error("Trade message deadline has passed");

    const stageWithKey = async (authorKey: Uint8Array): Promise<{
      message: ZwapTradeMessage;
      wrapped: WrappedTradeRumor;
      nextChoreography: TradeSession["privateState"]["transcript"]["choreography"];
      nextTranscriptHash: string;
    }> => {
      const message: ZwapTradeMessage = {
        schema: "zwap/dm/v1",
        deployment: deploymentFor(session.terms.chainId),
        type,
        message_id: this.entropy.messageId(),
        session_id: session.sessionId,
        reservation_id: session.reservationId,
        order_address: session.orderAddress,
        order_projection_id:
          session.fillProjectionId ??
          session.reserveProjectionId ??
          session.offeredProjectionId,
          order_revision:
          session.fillProjectionRevision ??
          session.reserveProjectionRevision ??
          session.offeredProjectionRevision,
          maker_order_pubkey: session.evidence.makerPubkey,
        author_pubkey: getPublicKey(authorKey),
        recipient_pubkey: recipient,
        sequence: session.privateState.transcript.nextSequence,
        previous_message_id: session.privateState.transcript.lastMessageId,
        previous_transcript_hash:
          session.privateState.transcript.lastTranscriptHash,
          sent_at: now,
        expires_at: expiresAt,
        terms_hash: hash,
        ...(type === "reserve_propose" || type === "reserve_accept"
          ? { terms }
          : {}),
          body
      };
      const checked = await validateAtomicSwapMessage(message);
      const nextChoreography = await advanceAtomicSwapChoreography(
        session.privateState.transcript.choreography,
        checked
      );
      const rumor = await createTradeRumor(
        message,
        authorKey,
        session.privateState.transcript.lastRumorId ?? undefined
      );
      const wrapped = wrapTradeRumor(rumor, authorKey, {
        ephemeralSecretKey: this.entropy.ephemeralSecretKey(),
        sealCreatedAt: this.entropy.randomizedTimestamp(now, "seal"),
        wrapperCreatedAt: this.entropy.randomizedTimestamp(now, "wrapper"),
        outerExpiration: this.entropy.outerExpiration(expiresAt),
        sealNonce: this.entropy.nonce("seal"),
        wrapperNonce: this.entropy.nonce("wrapper")
      });
      return {
        message,
        wrapped,
        nextChoreography,
        nextTranscriptHash: await transcriptHash(
          session.privateState.transcript.lastTranscriptHash,
          rumor.id
        )
      };
    };

    const staged = type === "reserve_accept"
      ? await this.withMakerOrderKey(session, stageWithKey)
      : await this.withSessionKey(session, stageWithKey);
    const next = bump(session, now);
    next.privateState.outbox = {
      message: staged.message,
      rumor: staged.wrapped.rumor,
      seal: staged.wrapped.seal,
      wrapper: staged.wrapped.wrapper,
      recipientInboxListId: discovered.eventId,
      recipientRelays: [...discovered.relays],
      receipts: [],
      nextChoreography: staged.nextChoreography,
      status: "staged"
    };
    if (type === "reserve_accept") {
      next.privateState.htlcHash = session.privateState.htlcHash;
    }
    return next;
  }

  private async withMakerOrderKey<T>(
    session: TradeSession,
    action: (secretKey: Uint8Array) => Promise<T>
  ): Promise<T> {
    const id = orderId(session);
    if (this.makerIdentity.useOrderSecretKey) {
      return this.makerIdentity.useOrderSecretKey(id, action);
    }
    if (this.makerIdentity.useSecretKey) return this.makerIdentity.useSecretKey(action);
    throw new Error("Maker order key access is unavailable");
  }

  private outgoingRecipient(
    session: TradeSession,
    type: AtomicSwapMessageType
  ): string {
    if (type === "reserve_propose") return session.evidence.makerPubkey;
    if (type === "reserve_accept") return participant(session, "takerSessionPubkey");
    return session.role === "maker"
      ? participant(session, "takerSessionPubkey")
      : participant(session, "makerSessionPubkey");
  }

  private async outgoingBody(
    session: TradeSession,
    type: AtomicSwapMessageType,
    now: number
  ): Promise<AtomicSwapBody> {
    const schema = ATOMIC_SWAP_BODY_SCHEMA;
    const transcript = session.privateState.transcript;
    const htlcHash = session.privateState.htlcHash;
    switch (type) {
      case "reserve_propose":
        return {
          schema,
          taker_session_pubkey: localNostrPubkey(session),
          taker_address: session.privateState.localAddress,
          fill_amount: session.terms.baseAmount
        };
      case "reserve_accept":
        if (
          !session.reserveProjectionId ||
          !session.reserveProjectionRevision ||
          !htlcHash
        ) {
          throw new Error("Reserve acceptance lacks committed reserve and settlement hash");
        }
        return {
          schema,
          taker_session_pubkey: participant(session, "takerSessionPubkey"),
          maker_session_pubkey: localNostrPubkey(session),
          maker_address: session.privateState.localAddress,
          reserve_projection_id: session.reserveProjectionId,
          reserve_revision: session.reserveProjectionRevision,
          settlement_hash: htlcHash,
          short_locktime: session.plan.shortLocktime,
          maker_claim_cutoff: session.plan.makerClaimCutoff,
          long_locktime: session.plan.longLocktime,
          taker_claim_cutoff: session.plan.takerClaimCutoff,
          reservation_expires_at: session.plan.reservationExpiresAt
        };
      case "session_ack":
        if (!session.reserveProjectionId || !session.reserveProjectionRevision || !htlcHash ||
          !transcript.lastMessageId || !transcript.lastTranscriptHash) {
          throw new Error("Session acknowledgement lacks reserve evidence");
        }
        return {
          schema,
          reserve_accept_message_id: transcript.lastMessageId,
          reserve_accept_transcript_hash: transcript.lastTranscriptHash,
          reserve_projection_id: session.reserveProjectionId,
          reserve_revision: session.reserveProjectionRevision,
          settlement_hash: htlcHash
        };
      case "base_lock":
      case "quote_lock": {
        const slot = type === "base_lock" ? "base" : "quote";
        return completedLockBody(session, slot);
      }
      case "base_lock_ack":
      case "quote_lock_ack": {
        const slot = type === "base_lock_ack" ? "base" : "quote";
        const leg = slotLeg(session, slot);
        const evidence = session.evidence.legs[leg];
        if (!transcript.lastMessageId || !transcript.lastTranscriptHash ||
          !evidence.htlcId || !evidence.validationCommitment || !htlcHash) {
          throw new Error(`${slot} lock acknowledgement lacks exact evidence`);
        }
        return {
          schema,
          lock_message_id: transcript.lastMessageId,
          lock_transcript_hash: transcript.lastTranscriptHash,
          htlc_id: evidence.htlcId,
          validation_commitment: evidence.validationCommitment,
          settlement_hash: htlcHash
        };
      }
      case "claim_notice":
        const paymentLeg = slotLeg(session, "quote");
        const payment = session.evidence.legs[paymentLeg];
        if (!payment.htlcId || !payment.claimOperationCommitment || !htlcHash) {
          throw new Error("Claim notice lacks quote claim evidence");
        }
        return {
          schema,
          quote_htlc_id: payment.htlcId,
          claim_operation_commitment: payment.claimOperationCommitment,
          settlement_hash: htlcHash,
          claimed_at: now
        };
      case "fill_request":
        const makerOfferLeg = slotLeg(session, "base");
        const takerPaymentLeg = slotLeg(session, "quote");
        const makerOffer = session.evidence.legs[makerOfferLeg];
        const takerPayment = session.evidence.legs[takerPaymentLeg];
        if (!makerOffer.htlcId || !takerPayment.htlcId ||
          !makerOffer.spendCommitment || !takerPayment.spendCommitment || !htlcHash) {
          throw new Error("Fill request lacks independently observed spends");
        }
        return {
          schema,
          base_htlc_id: makerOffer.htlcId,
          quote_htlc_id: takerPayment.htlcId,
          base_spend_commitment: makerOffer.spendCommitment,
          quote_spend_commitment: takerPayment.spendCommitment,
          settlement_hash: htlcHash
        };
      case "settlement_ack":
        const settledOffer = session.evidence.legs[slotLeg(session, "base")];
        const settledPayment = session.evidence.legs[slotLeg(session, "quote")];
        if (!session.fillProjectionId || !session.fillProjectionRevision ||
          !settledOffer.htlcId || !settledPayment.htlcId || !htlcHash) {
          throw new Error("Settlement acknowledgement lacks the committed fill");
        }
        return {
          schema,
          fill_projection_id: session.fillProjectionId,
          fill_revision: session.fillProjectionRevision,
          base_htlc_id: settledOffer.htlcId,
          quote_htlc_id: settledPayment.htlcId,
          settlement_hash: htlcHash
        };
      default:
        throw new Error(`No happy-path body exists for ${type}`);
    }
  }

  private async deliverOutbox(
    session: TradeSession,
    now: number
  ): Promise<TradeSession> {
    const outbox = session.privateState.outbox;
    if (!outbox || outbox.status !== "staged") {
      throw new Error("Outgoing envelope is not staged");
    }
    // Delivery needs no signing identity of its own: the wrap is already
    // sealed and signed, and the transport authenticates to the relay with a
    // throwaway key precisely so the session and maker keys stay out of the
    // relay's view.
    const receipts = await this.nostr.send(outbox.wrapper, outbox.recipientRelays);
    const next = bump(session, now);
    next.privateState.outbox = {
      ...clone(outbox),
      receipts: clone(receipts),
      status: "acknowledged"
    };
    return next;
  }

  private async pollInbox(
    session: TradeSession,
    now: number
  ): Promise<TradeSession> {
    if (session.privateState.pendingIncoming !== null) {
      throw new Error("An incoming message is already checkpointed");
    }
    const recipient = localNostrPubkey(session);
    const key = bytes(session.privateState.nostrPrivateKey, "Trade Nostr private key");
    let wrappers: NostrEvent[];
    try {
      wrappers = await this.nostr.read(
        recipient,
        key,
        Math.max(0, session.updatedAt - NIP17_TIMESTAMP_LOOKBACK_SECONDS)
      );
    } finally {
      key.fill(0);
    }
    if (wrappers.length === 0) {
      throw new Error("No private trade message is available");
    }
    let opened: OpenedTradeMessage | null = null;
    for (const wrapper of wrappers) {
      try {
        const candidate = await this.openIncoming(session, wrapper, now);
        if (session.privateState.transcript.accepted.some(
          ({ messageId, rumorId }) =>
            messageId === candidate.message.message_id ||
            rumorId === candidate.rumor.id
        )) continue;
        opened = candidate;
        break;
      } catch {
        // NIP-17 timestamp randomization requires a lookback, so old and noisy
        // wrappers are expected. Only the exact next transcript message wins.
      }
    }
    if (opened === null) {
      throw new Error("No next private trade message is available");
    }
    const next = bump(session, now);
    next.privateState.pendingIncoming = {
      wrapper: opened.wrapper,
      seal: opened.seal,
      rumor: opened.rumor,
      message: opened.message,
      transcriptHash: opened.transcriptHash,
      receivedAt: now,
      validation: { status: "unvalidated", checkedAt: null, error: null }
    };
    return next;
  }

  private async openIncoming(
    session: TradeSession,
    wrapper: NostrEvent,
    now: number
  ): Promise<OpenedTradeMessage> {
    const transcript = session.privateState.transcript;
    const key = bytes(session.privateState.nostrPrivateKey, "Trade Nostr private key");
    try {
      const expectedTermsHash = await termsHash(zwapTerms(session));
      if (
        session.role === "taker" &&
        transcript.choreography.phase === "awaiting_reserve_accept"
      ) {
        return unwrapReserveAcceptance(wrapper, key, {
          now,
          expectedAuthorPubkey: session.evidence.makerPubkey,
          expectedOrderAddress: session.orderAddress,
          expectedTermsHash,
          expectedPreviousRumorId: transcript.lastRumorId!,
          expectedPreviousMessageId: transcript.lastMessageId!,
          expectedPreviousTranscriptHash: transcript.lastTranscriptHash!
        });
      }
      const counterparty = session.role === "maker"
        ? participant(session, "takerSessionPubkey")
        : participant(session, "makerSessionPubkey");
      return unwrapTradeMessage(wrapper, key, {
        now,
        expectedAuthorPubkey: counterparty,
        expectedOrderAddress: session.orderAddress,
        ...(transcript.choreography.phase === "awaiting_settlement_ack"
          ? {}
          : {
              expectedOrderProjectionId:
                session.reserveProjectionId ?? session.offeredProjectionId,
                expectedOrderRevision:
                session.reserveProjectionRevision ??
                session.offeredProjectionRevision
            }),
            expectedTermsHash,
        expectedSequence: transcript.nextSequence,
        ...(transcript.lastRumorId === null
          ? {}
          : { expectedPreviousRumorId: transcript.lastRumorId }),
          ...(transcript.lastMessageId === null
          ? {}
          : { expectedPreviousMessageId: transcript.lastMessageId }),
          ...(transcript.lastTranscriptHash === null
          ? {}
          : { expectedPreviousTranscriptHash: transcript.lastTranscriptHash })
      });
    } finally {
      key.fill(0);
    }
  }

  private async validateIncoming(
    session: TradeSession,
    now: number
  ): Promise<TradeSession> {
    const pending = session.privateState.pendingIncoming;
    if (!pending || pending.validation.status !== "unvalidated") {
      throw new Error("Incoming message is not awaiting validation");
    }
    const opened = await this.openIncoming(session, pending.wrapper, now);
    if (
      opened.seal.id !== pending.seal.id ||
      opened.rumor.id !== pending.rumor.id ||
      opened.message.message_id !== pending.message.message_id ||
      opened.transcriptHash !== pending.transcriptHash
    ) throw new Error("Incoming retry opened a different exact message");
    const checked = await validateAtomicSwapMessage(opened.message);
    const nextChoreography = await advanceAtomicSwapChoreography(
      session.privateState.transcript.choreography,
      checked
    );
    const next = bump(session, now);
    next.privateState.pendingIncoming = {
      ...clone(pending),
      validation: { status: "validated", checkedAt: now, error: null }
    };
    if (
      checked.type === "base_lock" ||
      checked.type === "quote_lock"
    ) {
      const slot = checked.type === "quote_lock" ? "quote" : "base";
      const leg = slotLeg(session, slot);
      const body = checked.body as AtomicSwapBody<"base_lock">;
      // The acceptance (already committed by the time a lock arrives) carried
      // the plan and the maker's settlement address; locks validate against
      // the session state it established.
      const acceptedPlan = session.plan;
      const counterpartyAddress = session.privateState.counterpartyAddress;
      const expected = this.expectedLock({
        ...session,
        plan: acceptedPlan,
        privateState: {
          ...session.privateState,
          counterpartyAddress,
          htlcHash: session.privateState.htlcHash ?? body.settlement_hash,
          transcript: {
            ...session.privateState.transcript,
            choreography: nextChoreography
          }
        }
      }, slot);
      const summary = await onChain(() =>
        this.chain.validateIncomingLock(body.htlc_id, expected));
      if (
        summary.validationCommitment !== body.validation_commitment ||
        body.amount !== expected.amount ||
        body.chain_id !== expected.chainId
      ) {
        throw new ZwapChainEffectError(
          "terms_mismatch",
          false,
          null,
          "Incoming HTLC validation differs from the signed lock body"
        );
      }
      next.privateState.counterpartyAddress = counterpartyAddress;
      next.privateState.htlcHash ??= body.settlement_hash;
      if (!next.evidence.commitments.includes(body.settlement_hash)) {
        next.evidence.commitments.push(body.settlement_hash);
      }
      next.privateState.legs[leg] = {
        ...next.privateState.legs[leg],
        htlcId: body.htlc_id,
        expected,
        observations: [
          ...next.privateState.legs[leg].observations,
          { observedAt: now, state: "LOCKED", witnessCommitment: null }
        ]
      };
      next.evidence.legs[leg] = {
        ...next.evidence.legs[leg],
        htlcId: body.htlc_id,
        validationCommitment: body.validation_commitment,
        htlcState: "LOCKED",
        observedAt: now
      };
    }
    return next;
  }

  private async commitIncoming(
    session: TradeSession,
    now: number
  ): Promise<TradeSession> {
    const pending = session.privateState.pendingIncoming;
    if (!pending || pending.validation.status !== "validated") {
      throw new Error("Incoming message is not validated");
    }
    const message = await validateAtomicSwapMessage(pending.message);
    const choreography = await advanceAtomicSwapChoreography(
      session.privateState.transcript.choreography,
      message
    );
    const next = bump(session, now);
    next.privateState.transcript = {
      choreography,
      nextSequence: (BigInt(session.privateState.transcript.nextSequence) + 1n)
        .toString(),
        lastRumorId: pending.rumor.id,
      lastMessageId: pending.message.message_id,
      lastTranscriptHash: pending.transcriptHash,
      accepted: [
        ...clone(session.privateState.transcript.accepted),
        {
          sequence: pending.message.sequence,
          messageId: pending.message.message_id,
          rumorId: pending.rumor.id,
          transcriptHash: pending.transcriptHash,
          type: pending.message.type,
          authorPubkey: pending.message.author_pubkey,
          recipientPubkey: pending.message.recipient_pubkey
        }
      ]
    };
    next.privateState.pendingIncoming = null;
    next.phase = rootPhase(choreography);
    if (message.type === "reserve_accept") {
      const body = message.body as AtomicSwapBody<"reserve_accept">;
      next.plan = {
        // The acceptance carries absolute deadlines, not the anchor they came
        // from; this side rebuilds it with the short lock it is configured for.
        anchor: body.short_locktime - this.shortLockSeconds,
        shortLocktime: body.short_locktime,
        makerClaimCutoff: body.maker_claim_cutoff,
        longLocktime: body.long_locktime,
        takerClaimCutoff: body.taker_claim_cutoff,
        reservationExpiresAt: body.reservation_expires_at,
        refundGuardSeconds: 60
      };
      next.reserveProjectionId = body.reserve_projection_id;
      next.reserveProjectionRevision = body.reserve_revision;
      next.evidence.reserveProjectionId = body.reserve_projection_id;
      next.evidence.reserveProjectionRevision = body.reserve_revision;
      next.evidence.reservation.takerCommitment ??=
        await this.commitment(
          `zwap-taker-v1:${session.sessionId}:` +
          `${session.evidence.reservation.proposalSealId ?? ""}:` +
          `${participant(session, "takerSessionPubkey")}`
        );
      next.privateState.counterpartyAddress = body.maker_address;
      next.privateState.htlcHash = body.settlement_hash;
      if (!next.evidence.commitments.includes(body.settlement_hash)) {
        next.evidence.commitments.push(body.settlement_hash);
      }
    }
    if (message.type === "session_ack") {
      next.privateState.settlementTranscriptHash = pending.transcriptHash;
    }
    if (message.type === "settlement_ack") {
      const body = message.body as AtomicSwapBody<"settlement_ack">;
      next.fillProjectionId = body.fill_projection_id;
      next.fillProjectionRevision = body.fill_revision;
    }
    return next;
  }

  private async commitOutbox(
    session: TradeSession,
    now: number
  ): Promise<TradeSession> {
    const outbox = session.privateState.outbox;
    if (!outbox || outbox.status !== "acknowledged") {
      throw new Error("Outgoing message is not acknowledged");
    }
    const hash = await transcriptHash(
      session.privateState.transcript.lastTranscriptHash,
      outbox.rumor.id
    );
    const next = bump(session, now);
    next.privateState.transcript = {
      choreography: clone(outbox.nextChoreography),
      nextSequence: (BigInt(session.privateState.transcript.nextSequence) + 1n)
        .toString(),
        lastRumorId: outbox.rumor.id,
      lastMessageId: outbox.message.message_id,
      lastTranscriptHash: hash,
      accepted: [
        ...clone(session.privateState.transcript.accepted),
        {
          sequence: outbox.message.sequence,
          messageId: outbox.message.message_id,
          rumorId: outbox.rumor.id,
          transcriptHash: hash,
          type: outbox.message.type,
          authorPubkey: outbox.message.author_pubkey,
          recipientPubkey: outbox.message.recipient_pubkey
        }
      ]
    };
    next.privateState.outbox = null;
    next.phase = rootPhase(outbox.nextChoreography);
    if (outbox.message.type === "session_ack") {
      next.privateState.settlementTranscriptHash = hash;
    }
    if (outbox.message.type === "reserve_propose") {
      next.evidence.reservation.proposalSealId = outbox.seal.id;
      next.privateState.settlementTranscriptHash = hash;
    }
    return next;
  }

  private async prepareChain(
    session: TradeSession,
    action:
      | "prepare_base_lock" | "prepare_quote_lock"
      | "prepare_base_claim" | "prepare_quote_claim"
      | "prepare_base_refund" | "prepare_quote_refund",
    now: number
  ): Promise<TradeSession> {
    const slot: ProtocolSlot = action.includes("base") ? "base" : "quote";
    const leg = slotLeg(session, slot);
    const expected = this.expectedLock(session, slot);
    return this.withAccountLock(async () => {
      const artifact = await onChain(async (): Promise<PreparedChainOperation> => {
        if (action.endsWith("_lock")) {
          // Reserved funds belong to other in-flight sessions; this session's
          // own reservation (a retry of the same lock) must not count twice.
          const reservations = await this.reservations.load();
          const balances = await this.node.getBalances(this.chain.address());
          const balance = BigInt(
            balances.find(({ tokenStandard }) => tokenStandard === expected.tokenStandard)
              ?.balance ?? "0"
          );
          const available = balance -
            reservedAmount(reservations, expected.tokenStandard, session.sessionId);
          if (available < BigInt(expected.amount)) {
            throw new ZenonTradeError("insufficient-balance");
          }
          return this.chain.prepareLock({ expected, now });
        }
        const htlcId = session.privateState.legs[leg].htlcId;
        if (!htlcId) throw new Error("Chain spend preparation lacks its HTLC ID");
        if (action.endsWith("_claim")) {
          const preimage = session.privateState.preimage;
          if (!preimage) throw new Error("Chain claim lacks its preimage");
          return this.chain.prepareClaim({
            htlcId,
            expected,
            preimage,
            now,
            claimCutoff: slot === "base"
              ? session.plan.takerClaimCutoff
              : session.plan.makerClaimCutoff
          });
        }
        return this.chain.prepareRefund({
          htlcId,
          expected,
          now,
          expiryGrace: session.plan.refundGuardSeconds
        });
      });
      const next = bump(session, now);
      next.privateState.legs[leg].expected = expected;
      next.privateState.chainOperation = {
        operationId: this.entropy.operationId(),
        leg,
        kind: artifact.kind,
        status: "prepared",
        preparedAt: now,
        // Only a lock moves this account's own funds, so only a lock needs a
        // reservation; claims and refunds go straight to execution.
        fundsReserved: artifact.kind !== "lock",
        artifact,
        result: null
      };
      if (artifact.kind === "claim") {
        next.evidence.legs[leg].claimOperationCommitment = artifact.operationCommitment;
      } else if (artifact.kind === "refund") {
        next.evidence.legs[leg].refundOperationCommitment = artifact.operationCommitment;
      }
      return next;
    });
  }

  private async reserveFunds(
    session: TradeSession,
    now: number
  ): Promise<TradeSession> {
    const operation = session.privateState.chainOperation;
    if (!operation || operation.status !== "prepared" || operation.fundsReserved) {
      throw new Error("Chain funds are not awaiting reservation");
    }
    await this.withAccountLock(async () => {
      const reservations = await this.reservations.load();
      if (reservations.reservations.some(({ sessionId }) => sessionId === session.sessionId)) {
        return;
      }
      await this.reservations.reserve(reservations.revision, {
        sessionId: session.sessionId,
        tokenStandard: operation.artifact.tokenStandard,
        amount: operation.artifact.amount,
        reservedAt: operation.preparedAt
      });
    });
    const next = bump(session, now);
    next.privateState.chainOperation!.fundsReserved = true;
    return next;
  }

  private async executeChain(
    session: TradeSession,
    now: number
  ): Promise<TradeSession> {
    const operation = session.privateState.chainOperation;
    if (!operation || operation.status !== "prepared" || !operation.fundsReserved) {
      throw new Error("Chain operation is not checkpointed for execution");
    }
    const leg = operation.leg;
    const artifact = operation.artifact;
    const next = bump(session, now);
    let result: ChainOperationResult;
    if (operation.kind === "lock") {
      // The send itself must sit inside the cross-tab account lock: every tab
      // has its own signer queue, so preparation being serialized is not
      // enough - two tabs would otherwise build blocks from the same account
      // frontier concurrently.
      const completed = await this.withAccountLock(() =>
        onChain(() => this.chain.completeLock(artifact)));
      next.privateState.legs[leg].htlcId = completed.htlcId;
      next.privateState.legs[leg].observations.push({
        observedAt: now,
        state: "LOCKED",
        witnessCommitment: null
      });
      next.evidence.legs[leg] = {
        ...next.evidence.legs[leg],
        htlcId: completed.htlcId,
        validationCommitment: completed.summary.validationCommitment,
        htlcState: "LOCKED",
        observedAt: now
      };
      result = {
        blockHash: completed.blockHash,
        htlcId: completed.htlcId,
        tokenStandard: artifact.tokenStandard,
        amount: artifact.amount
      };
    } else {
      // Same cross-tab serialization as the lock branch above.
      const completed = await this.withAccountLock(() => operation.kind === "claim"
        ? onChain(() => {
            const preimage = session.privateState.preimage;
            if (!preimage) throw new Error("Chain claim lacks its preimage");
            return this.chain.completeClaim(artifact, preimage);
          })
        : onChain(() => this.chain.completeRefund(artifact)));
      result = {
        blockHash: completed.blockHash,
        htlcId: completed.htlcId,
        tokenStandard: artifact.tokenStandard,
        amount: artifact.amount
      };
    }
    next.privateState.chainOperation = {
      ...clone(operation),
      status: "completed",
      result
    };
    return next;
  }

  private async reconcileAccount(
    session: TradeSession,
    now: number
  ): Promise<TradeSession> {
    const operation = session.privateState.chainOperation;
    if (!operation || operation.status !== "completed" || operation.result === null) {
      throw new Error("Chain result is not checkpointed for reconciliation");
    }
    await this.withAccountLock(async () => {
      if (!operation.fundsReserved || operation.kind !== "lock") return;
      const reservations = await this.reservations.load();
      if (!reservations.reservations.some(({ sessionId }) => sessionId === session.sessionId)) {
        return;
      }
      await this.reservations.release(reservations.revision, {
        sessionId: session.sessionId
      });
    });
    const next = bump(session, now);
    next.privateState.chainOperation!.status = "account_applied";
    return next;
  }

  private async observeLeg(
    session: TradeSession,
    leg: "base" | "quote",
    now: number
  ): Promise<TradeSession> {
    const privateLeg = session.privateState.legs[leg];
    const evidence = session.evidence.legs[leg];
    const expected = privateLeg.expected;
    if (!privateLeg.htlcId || !expected || !evidence.htlcId) {
      throw new Error(`Trade ${leg} leg lacks its exact on-chain HTLC`);
    }
    let observed;
    try {
      observed = await onChain(
        () => this.chain.observe(privateLeg.htlcId!, expected),
        { reclaimed: evidence.htlcState === "RECLAIMED" }
      );
    } catch (error) {
      // An HTLC that exists but no longer matches the agreed terms is a
      // contradiction, not a retryable failure: freeze the session.
      if (
        error instanceof ZwapChainEffectError &&
        error.code === "terms_mismatch" &&
        error.cause instanceof HtlcValidationError &&
        session.phase !== "filled" &&
        session.phase !== "released"
      ) {
        return this.freezeOnContradiction(session, leg, error.cause.code, now);
      }
      throw error;
    }
    const next = bump(session, now);
    next.privateState.legs[leg].observations.push({
      observedAt: now,
      state: observed.state,
      witnessCommitment: observed.witnessCommitment
    });
    // The observation log keeps every reading, but the evidence summary only
    // ever moves forward: a transient UNKNOWN after a settled UNLOCKED must not
    // retract the spend the counterparty is entitled to rely on.
    if (HTLC_STATE_RANK[observed.state] >= HTLC_STATE_RANK[evidence.htlcState]) {
      next.evidence.legs[leg] = {
        ...next.evidence.legs[leg],
        htlcState: observed.state,
        observedAt: now,
        spendCommitment: observed.witnessCommitment ?? evidence.spendCommitment
      };
    }
    if (observed.state === "UNLOCKED") {
      const preimage = observed.preimage;
      if (preimage === null || !(await verifyHtlcMaterial(preimage, expected.hashLock))) {
        throw new ZwapChainEffectError(
          "witness_invalid",
          false,
          null,
          "Observed Zenon preimage does not match the locked hash"
        );
      }
      // The taker only ever learns the preimage from the chain: the maker's
      // unlock of the quote leg reveals it. It never arrives in a DM.
      if (session.role === "taker" && leg === slotLeg(session, "quote")) {
        next.privateState.preimage = preimage;
      }
    }
    return next;
  }

  private freezeOnContradiction(
    session: TradeSession,
    leg: "base" | "quote",
    code: string,
    now: number
  ): TradeSession {
    const next = bump(session, now);
    next.phase = advanceTrade(session.phase, "contradiction_detected");
    next.privateState.transcript.choreography.phase = "failed";
    const marker = `terms_mismatch:${leg}:${code}`;
    if (!next.evidence.chainStates.includes(marker)) {
      next.evidence.chainStates.push(marker);
    }
    return next;
  }

  private async withSessionKey<T>(
    session: TradeSession,
    action: (key: Uint8Array) => Promise<T>
  ): Promise<T> {
    const key = bytes(session.privateState.nostrPrivateKey, "Trade Nostr private key");
    try {
      return await action(key);
    } finally {
      key.fill(0);
    }
  }
}
