import { generateSecretKey, getPublicKey } from "nostr-tools/pure";

import type { OrderRecord } from "../order/model.js";
import { createHtlcMaterial, verifyHtlcMaterial } from "../zenon/htlc-material.js";
import { isTokenStandard, isZenonAddress } from "../zenon/validate.js";
import {
  advanceAtomicSwapChoreography,
  initialAtomicSwapChoreography,
  validateAtomicSwapMessage,
  type ReserveProposeBody
} from "./atomic-messages.js";
import {
  assertVerifiedInitialReserveProposal,
  type VerifiedInitialReserveProposal
} from "./messages.js";
import {
  createSettlementPlan,
  settlementAmounts,
  type SettlementPlanInput
} from "./model.js";
import type {
  TradeEvidence,
  TradeSession,
  TradeTerms,
  TradeTranscriptJournal
} from "./session.js";

export interface SessionMarketSelection {
  chainId: string;
  baseToken: string;
  quoteToken: string;
}

export type SessionKeyPurpose = "nostr";

export interface SessionFactoryEntropy {
  sessionId(): string;
  reservationId(): string;
  privateKey(purpose: SessionKeyPurpose): string;
  htlcMaterial(): Promise<{ preimage: string; hash: string }>;
}

export interface TakerSessionInput {
  order: OrderRecord;
  expectedOrderProjectionId: string;
  expectedOrderRevision: string;
  market: SessionMarketSelection;
  fillBaseAmount: string;
  clocks: Omit<SettlementPlanInput, "orderExpiresAt">;
  localAddress: string;
}

export interface MakerSessionInput {
  order: OrderRecord;
  proposal: VerifiedInitialReserveProposal;
  market: SessionMarketSelection;
  clocks: Omit<SettlementPlanInput, "orderExpiresAt">;
  localAddress: string;
}

const HEX_32 = /^[0-9a-f]{64}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CHAIN_ID = /^[1-9]\d*$/;

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fromHex(value: string, label: string): Uint8Array {
  if (!HEX_32.test(value)) throw new Error(`${label} must be 32-byte lowercase hex`);
  return Uint8Array.from(value.match(/../g) ?? [], (part) => Number.parseInt(part, 16));
}

const defaultEntropy: SessionFactoryEntropy = {
  sessionId: () => hex(generateSecretKey()),
  reservationId: () => crypto.randomUUID(),
  privateKey: () => hex(generateSecretKey()),
  htlcMaterial: () => createHtlcMaterial()
};

function canonicalMarket(input: SessionMarketSelection): SessionMarketSelection {
  if (!CHAIN_ID.test(input.chainId)) throw new Error("Session chain ID is not canonical");
  for (const [label, token] of [
    ["Base", input.baseToken],
    ["Quote", input.quoteToken]
  ] as const) {
    if (!isTokenStandard(token)) throw new Error(`${label} token standard is not canonical`);
  }
  if (input.baseToken === input.quoteToken) {
    throw new Error("Base and quote token standards must differ");
  }
  return { chainId: input.chainId, baseToken: input.baseToken, quoteToken: input.quoteToken };
}

function assertOpenOrder(
  order: OrderRecord,
  expectedProjectionId: string,
  expectedRevision: string,
  marketInput: SessionMarketSelection,
  now: number
): SessionMarketSelection {
  const market = canonicalMarket(marketInput);
  if (!order.verified) throw new Error("Order must be verified");
  if (
    !HEX_32.test(expectedProjectionId) ||
    order.eventId !== expectedProjectionId ||
    order.state.revision !== expectedRevision
  ) {
    throw new Error("Order projection is stale");
  }
  if (!HEX_32.test(order.eventId) || !HEX_32.test(order.makerPubkey)) {
    throw new Error("Order authority or projection ID is invalid");
  }
  const expectedAddress =
    `30078:${order.makerPubkey}:zwap:order:v1:${order.state.order_id}`;
  if (order.address !== expectedAddress) throw new Error("Order address does not match its authority");
  const state = order.state;
  if (
    state.schema !== "zwap/order/v1" ||
    (state.side !== "sell" && state.side !== "buy") ||
    state.status !== "open"
  ) throw new Error("Session factory accepts only open maker orders");
  if (
    state.reservation !== null ||
    state.reserved_amount !== "0" ||
    state.remaining_amount !== state.original_amount
  ) throw new Error("Open order contains stale reservation state");
  if (!Number.isSafeInteger(now) || now < 0 || now >= state.expires_at) {
    throw new Error("Order has expired");
  }
  if (state.chain_id !== market.chainId) {
    throw new Error("Order chain does not match the selected market");
  }
  if (
    state.base_token !== market.baseToken ||
    state.quote_token !== market.quoteToken ||
    (state.side === "sell"
      ? state.offered.token !== market.baseToken ||
        state.requested.token !== market.quoteToken
      : state.offered.token !== market.quoteToken ||
        state.requested.token !== market.baseToken)
  ) throw new Error("Order assets do not match the selected market");
  return market;
}

function amounts(order: OrderRecord, fillBaseAmount: string): { base: string; quote: string } {
  const result = settlementAmounts({
    remainingBaseAmount: order.state.remaining_amount,
    fillBaseAmount,
    price: order.state.price,
    execution: order.state.execution,
    minimumFillAmount: order.state.minimum_fill_amount
  });
  const remainder = BigInt(order.state.remaining_amount) - BigInt(result.base);
  if (remainder > 0n && remainder < BigInt(order.state.minimum_fill_amount)) {
    throw new Error("Partial fill would leave dust below the order minimum");
  }
  return result;
}

interface LocalKeys {
  nostrPrivateKey: string;
  nostrPubkey: string;
  localAddress: string;
}

function localKeys(entropy: SessionFactoryEntropy, localAddress: string): LocalKeys {
  if (!isZenonAddress(localAddress)) {
    throw new Error("Session local address is not a canonical Zenon address");
  }
  const nostrPrivateKey = entropy.privateKey("nostr");
  const nostrBytes = fromHex(nostrPrivateKey, "Nostr private key");
  let nostrPubkey: string;
  try {
    nostrPubkey = getPublicKey(nostrBytes);
  } catch {
    throw new Error("Session private key is not a valid secp256k1 scalar");
  } finally {
    nostrBytes.fill(0);
  }
  return { nostrPrivateKey, nostrPubkey, localAddress };
}

function assertSeparatedFromOrderAuthority(keys: LocalKeys, makerPubkey: string): void {
  if (keys.nostrPubkey === makerPubkey) {
    throw new Error("Session keys must be independent from the maker order authority");
  }
}

function tradeTerms(
  market: SessionMarketSelection,
  selected: { base: string; quote: string },
  order: OrderRecord
): TradeTerms {
  return {
    makerSide: order.state.side,
    chainId: market.chainId,
    baseToken: market.baseToken,
    baseAmount: selected.base,
    quoteToken: market.quoteToken,
    quoteAmount: selected.quote,
    price: order.state.price
  };
}

function emptyEvidence(order: OrderRecord): TradeEvidence {
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
    makerPubkey: order.makerPubkey,
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
    legs: {
      base: leg(),
      quote: leg()
    }
  };
}

function baseSession(input: {
  role: "maker" | "taker";
  order: OrderRecord;
  sessionId: string;
  reservationId: string;
  terms: TradeTerms;
  plan: ReturnType<typeof createSettlementPlan>;
  keys: LocalKeys;
  counterpartyAddress: string | null;
  transcript: TradeTranscriptJournal;
  evidence: TradeEvidence;
  preimage: string | null;
  htlcHash: string | null;
  createdAt: number;
}): TradeSession {
  if (!HEX_32.test(input.sessionId)) throw new Error("Session ID is invalid");
  if (!UUID_V4.test(input.reservationId)) throw new Error("Reservation ID is invalid");
  return {
    schema: "zwap/trade-session/v1",
    revision: 0,
    sessionId: input.sessionId,
    reservationId: input.reservationId,
    role: input.role,
    phase: "negotiating",
    orderAddress: input.order.address,
    orderSide: input.order.state.side,
    offeredProjectionId: input.order.eventId,
    offeredProjectionRevision: input.order.state.revision,
    reserveProjectionId: null,
    reserveProjectionRevision: null,
    fillProjectionId: null,
    fillProjectionRevision: null,
    pendingOrderPublication: null,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    terms: input.terms,
    plan: input.plan,
    evidence: input.evidence,
    privateState: {
      nostrPrivateKey: input.keys.nostrPrivateKey,
      localAddress: input.keys.localAddress,
      counterpartyAddress: input.counterpartyAddress,
      preimage: input.preimage,
      htlcHash: input.htlcHash,
      settlementTranscriptHash: null,
      inbox: {
        status: "unregistered",
        quorum: 1,
        event: null,
        discoveryRelays: [],
        inboxRelays: [],
        receipts: [],
        readbacks: [],
        stagedAt: null,
        acknowledgedAt: null,
        registeredAt: null
      },
      pendingIncoming: null,
      transcript: input.transcript,
      outbox: null,
      chainOperation: null,
      legs: {
        base: { htlcId: null, expected: null, observations: [] },
        quote: { htlcId: null, expected: null, observations: [] }
      }
    }
  };
}

function plan(order: OrderRecord, clocks: Omit<SettlementPlanInput, "orderExpiresAt">) {
  return createSettlementPlan({ ...clocks, orderExpiresAt: order.state.expires_at });
}

export async function createTakerSession(
  input: TakerSessionInput,
  entropy: SessionFactoryEntropy = defaultEntropy
): Promise<TradeSession> {
  const market = assertOpenOrder(
    input.order,
    input.expectedOrderProjectionId,
    input.expectedOrderRevision,
    input.market,
    input.clocks.localNow
  );
  const selected = amounts(input.order, input.fillBaseAmount);
  const keys = localKeys(entropy, input.localAddress);
  assertSeparatedFromOrderAuthority(keys, input.order.makerPubkey);
  const sessionId = entropy.sessionId();
  const reservationId = entropy.reservationId();
  return baseSession({
    role: "taker",
    order: input.order,
    sessionId,
    reservationId,
    terms: tradeTerms(market, selected, input.order),
    plan: plan(input.order, input.clocks),
    keys,
    counterpartyAddress: null,
    transcript: {
      choreography: initialAtomicSwapChoreography(input.order.makerPubkey),
      nextSequence: "0",
      lastRumorId: null,
      lastMessageId: null,
      lastTranscriptHash: null,
      accepted: []
    },
    evidence: emptyEvidence(input.order),
    preimage: null,
    htlcHash: null,
    createdAt: input.clocks.localNow
  });
}

export async function createMakerSession(
  input: MakerSessionInput,
  entropy: SessionFactoryEntropy = defaultEntropy
): Promise<TradeSession> {
  assertVerifiedInitialReserveProposal(input.proposal);
  const message = await validateAtomicSwapMessage(input.proposal.message);
  if (message.type !== "reserve_propose") {
    throw new Error("Maker session requires a validated reserve proposal");
  }
  if (message.sequence !== "0") {
    throw new Error("Maker session requires an initial reserve proposal");
  }
  if (input.clocks.localNow >= message.expires_at) {
    throw new Error("Reserve proposal has expired");
  }
  if (message.sent_at > input.clocks.localNow + 300) {
    throw new Error("Reserve proposal is too far in the future");
  }
  const market = assertOpenOrder(
    input.order,
    message.order_projection_id,
    message.order_revision,
    input.market,
    input.clocks.localNow
  );
  if (
    message.order_address !== input.order.address ||
    message.maker_order_pubkey !== input.order.makerPubkey ||
    message.recipient_pubkey !== input.order.makerPubkey
  ) throw new Error("Reserve proposal targets a different order");
  const proposalBody = message.body as ReserveProposeBody;
  const selected = amounts(input.order, proposalBody.fill_amount);
  const terms = message.terms!;
  if (
    (terms.maker_side ?? "sell") !== input.order.state.side ||
    terms.chain_id !== market.chainId ||
    terms.base_token !== market.baseToken ||
    terms.quote_token !== market.quoteToken ||
    terms.base_amount !== selected.base ||
    terms.quote_amount !== selected.quote ||
    terms.price !== input.order.state.price
  ) throw new Error("Reserve proposal terms do not match the selected order market");

  const choreography = await advanceAtomicSwapChoreography(
    initialAtomicSwapChoreography(input.order.makerPubkey),
    message
  );
  const keys = localKeys(entropy, input.localAddress);
  assertSeparatedFromOrderAuthority(keys, input.order.makerPubkey);
  const takerAddress = proposalBody.taker_address;
  if (!isZenonAddress(takerAddress)) {
    throw new Error("Reserve proposal taker address is not a canonical Zenon address");
  }
  if (takerAddress === keys.localAddress) {
    throw new Error("Maker settlement address collides with the counterparty address");
  }
  if (proposalBody.taker_session_pubkey === input.order.makerPubkey) {
    throw new Error("Taker keys must be independent from the maker order authority");
  }
  if (proposalBody.taker_session_pubkey === keys.nostrPubkey) {
    throw new Error("Maker keys collide with counterparty session keys");
  }

  const material = await entropy.htlcMaterial();
  if (
    !HEX_32.test(material.preimage) ||
    !HEX_32.test(material.hash) ||
    !(await verifyHtlcMaterial(material.preimage, material.hash))
  ) throw new Error("Maker HTLC material is invalid");
  if ([keys.nostrPrivateKey, message.session_id].includes(material.preimage)) {
    throw new Error("Maker HTLC preimage must be independent");
  }
  if (!HEX_32.test(input.proposal.rumor.id) || !HEX_32.test(input.proposal.transcriptHash)) {
    throw new Error("Validated proposal transcript identifiers are invalid");
  }
  const evidence = emptyEvidence(input.order);
  evidence.commitments = [material.hash];
  evidence.reservation.proposalSealId = input.proposal.seal.id;
  const session = baseSession({
    role: "maker",
    order: input.order,
    sessionId: message.session_id,
    reservationId: message.reservation_id,
    terms: tradeTerms(market, selected, input.order),
    plan: plan(input.order, input.clocks),
    keys,
    counterpartyAddress: takerAddress,
    transcript: {
      choreography,
      nextSequence: "1",
      lastRumorId: input.proposal.rumor.id,
      lastMessageId: message.message_id,
      lastTranscriptHash: input.proposal.transcriptHash,
      accepted: [{
        sequence: "0",
        messageId: message.message_id,
        rumorId: input.proposal.rumor.id,
        transcriptHash: input.proposal.transcriptHash,
        type: message.type,
        authorPubkey: message.author_pubkey,
        recipientPubkey: message.recipient_pubkey
      }]
    },
    evidence,
    preimage: material.preimage,
    htlcHash: material.hash,
    createdAt: input.clocks.localNow
  });
  session.privateState.settlementTranscriptHash = input.proposal.transcriptHash;
  session.privateState.transcript.choreography.participants = {
    ...session.privateState.transcript.choreography.participants,
    makerSessionPubkey: keys.nostrPubkey,
    makerAddress: keys.localAddress,
    takerAddress
  };
  return session;
}
