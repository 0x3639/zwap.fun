import { describe, expect, it } from "vitest";

import type { ExpectedZenonLock } from "../zenon/htlc.js";
import { nextCoordinatorAction } from "./coordinator-plan.js";
import type { TradeSession } from "./session.js";
import {
  FIXTURE_ANCHOR,
  FIXTURE_COUNTERPARTY_ADDRESS,
  FIXTURE_LOCAL_ADDRESS,
  FIXTURE_ORDER_ID,
  sessionFixture
} from "./test-fixtures.js";

const NOW = FIXTURE_ANCHOR + 100;
const BASE_HTLC_ID = "ab".repeat(32);
const QUOTE_HTLC_ID = "cd".repeat(32);

function session(
  role: "maker" | "taker",
  choreographyPhase: TradeSession["privateState"]["transcript"]["choreography"]["phase"]
): TradeSession {
  return sessionFixture({
    role,
    privateState: {
      counterpartyAddress: role === "maker" ? FIXTURE_COUNTERPARTY_ADDRESS : null,
      preimage: role === "maker" ? "04".repeat(32) : null,
      htlcHash: role === "maker" ? "05".repeat(32) : null,
      transcript: { choreography: { phase: choreographyPhase } }
    },
    evidence: { commitments: role === "maker" ? ["05".repeat(32)] : [] }
  });
}

function markSpent(
  current: TradeSession,
  leg: "base" | "quote",
  observedAt = NOW
): void {
  current.evidence.legs[leg].htlcState = "UNLOCKED";
  current.evidence.legs[leg].observedAt = observedAt;
  current.evidence.legs[leg].spendCommitment = "aa".repeat(32);
  current.privateState.legs[leg].observations.push({
    observedAt,
    state: "UNLOCKED",
    witnessCommitment: current.evidence.legs[leg].spendCommitment
  });
}

function markPostExpiryLocked(
  current: TradeSession,
  leg: "base" | "quote",
  observedAt: number
): void {
  current.evidence.legs[leg].htlcState = "LOCKED";
  current.evidence.legs[leg].observedAt = observedAt;
  current.privateState.legs[leg].observations.push({
    observedAt,
    state: "LOCKED",
    witnessCommitment: null
  });
}

function setCommittedPublication(
  current: TradeSession,
  operation: "reserve" | "fill" | "release",
  projectionId: string
): void {
  current.pendingOrderPublication = {
    operation,
    orderId: FIXTURE_ORDER_ID,
    projection: { id: projectionId },
    receipts: [{ relay: "wss://relay.example", ok: true, message: "stored" }],
    status: "committed",
    stagedAt: FIXTURE_ANCHOR,
    acknowledgedAt: FIXTURE_ANCHOR + 1,
    committedAt: FIXTURE_ANCHOR + 2
  } as TradeSession["pendingOrderPublication"];
  if (operation === "reserve") {
    current.reserveProjectionId = projectionId;
    current.reserveProjectionRevision = "1";
    current.evidence.reserveProjectionId = projectionId;
    current.evidence.reserveProjectionRevision = "1";
  } else if (operation === "fill") {
    current.fillProjectionId = projectionId;
    current.fillProjectionRevision = "2";
    current.evidence.fillProjectionId = projectionId;
    current.evidence.fillProjectionRevision = "2";
  } else {
    current.phase = "released";
  }
}

function expectedLock(current: TradeSession, leg: "base" | "quote"): ExpectedZenonLock {
  return {
    leg,
    chainId: current.terms.chainId,
    tokenStandard: leg === "base" ? current.terms.baseToken : current.terms.quoteToken,
    amount: leg === "base" ? current.terms.baseAmount : current.terms.quoteAmount,
    hashLock: current.privateState.htlcHash!,
    hashType: 1,
    keyMaxSize: 32,
    hashLockedAddress: FIXTURE_COUNTERPARTY_ADDRESS,
    timeLockedAddress: FIXTURE_LOCAL_ADDRESS,
    expirationTime: leg === "base"
      ? current.plan.longLocktime
      : current.plan.shortLocktime,
    binding: {
      protocolVersion: "1",
      network: "zenon-1",
      orderId: FIXTURE_ORDER_ID,
      sessionId: current.sessionId,
      reservationId: current.reservationId,
      transcriptHash: current.privateState.settlementTranscriptHash!
    }
  };
}

function markLockReady(current: TradeSession, leg: "base" | "quote"): void {
  const htlcId = leg === "base" ? BASE_HTLC_ID : QUOTE_HTLC_ID;
  current.privateState.htlcHash ??= "05".repeat(32);
  current.privateState.settlementTranscriptHash ??= "09".repeat(32);
  current.evidence.legs[leg].htlcId = htlcId;
  current.evidence.legs[leg].validationCommitment =
    (leg === "base" ? "66" : "77").repeat(32);
  current.privateState.legs[leg].htlcId = htlcId;
  current.privateState.legs[leg].expected = expectedLock(current, leg);
}

function setAccountAppliedRefund(
  current: TradeSession,
  leg: "base" | "quote",
  status: "completed" | "account_applied"
): void {
  const expected = current.privateState.legs[leg].expected;
  if (expected === null) throw new Error("Test refund requires a prepared lock");
  const commitment = "aa".repeat(32);
  current.evidence.legs[leg].refundOperationCommitment = commitment;
  current.privateState.chainOperation = {
    operationId: "33333333-3333-4333-8333-333333333333",
    leg,
    kind: "refund",
    status,
    preparedAt: current.updatedAt,
    fundsReserved: true,
    artifact: {
      version: 1,
      kind: "refund",
      chainId: expected.chainId,
      tokenStandard: expected.tokenStandard,
      amount: expected.amount,
      htlcId: current.privateState.legs[leg].htlcId,
      expected,
      operationCommitment: commitment
    },
    result: {
      blockHash: "be".repeat(32),
      htlcId: current.privateState.legs[leg].htlcId!,
      tokenStandard: expected.tokenStandard,
      amount: expected.amount
    }
  };
}

describe("atomic swap coordinator action planning", () => {
  it("retries durable effects before planning any new protocol action", () => {
    const current = session("maker", "awaiting_base_lock");
    current.pendingOrderPublication = {
      operation: "reserve",
      status: "staged"
    } as TradeSession["pendingOrderPublication"];
    expect(nextCoordinatorAction(current, NOW)).toEqual({
      kind: "publish_order_projection"
    });
    current.pendingOrderPublication!.status = "acknowledged";
    expect(nextCoordinatorAction(current, NOW)).toEqual({
      kind: "commit_order_publication"
    });
    current.pendingOrderPublication!.status = "committed";
    expect(nextCoordinatorAction(current, NOW)).toEqual({
      kind: "clear_order_publication"
    });

    current.pendingOrderPublication = null;
    current.privateState.outbox = {
      status: "staged",
      message: {
        type: "claim_notice",
        expires_at: FIXTURE_ANCHOR + 300
      }
    } as TradeSession["privateState"]["outbox"];
    expect(nextCoordinatorAction(current, NOW)).toEqual({
      kind: "deliver_outbox"
    });
    current.privateState.outbox!.status = "acknowledged";
    expect(nextCoordinatorAction(current, NOW)).toEqual({
      kind: "commit_outbox"
    });
  });

  it("reserves, executes, reconciles, then clears one durable chain operation", () => {
    const current = session("maker", "awaiting_base_lock");
    current.privateState.chainOperation = {
      status: "prepared",
      fundsReserved: false
    } as TradeSession["privateState"]["chainOperation"];
    expect(nextCoordinatorAction(current, NOW).kind)
      .toBe("reserve_funds");
    current.privateState.chainOperation!.fundsReserved = true;
    expect(nextCoordinatorAction(current, NOW).kind)
      .toBe("execute_chain_operation");
    current.privateState.chainOperation!.status = "completed";
    expect(nextCoordinatorAction(current, NOW).kind)
      .toBe("reconcile_account");
    current.privateState.chainOperation!.status = "account_applied";
    expect(nextCoordinatorAction(current, NOW).kind)
      .toBe("clear_chain_operation");
  });

  it("registers the exact local inbox before any protocol message", () => {
    const current = session("taker", "awaiting_reserve_propose");
    current.privateState.inbox = {
      status: "unregistered",
      quorum: 2,
      event: null,
      discoveryRelays: [],
      inboxRelays: [],
      receipts: [],
      readbacks: [],
      stagedAt: null,
      acknowledgedAt: null,
      registeredAt: null
    };
    expect(nextCoordinatorAction(current, NOW).kind)
      .toBe("stage_inbox_registration");
    current.privateState.inbox.status = "staged";
    current.privateState.inbox.event = session(
      "taker",
      "awaiting_reserve_propose"
    ).privateState.inbox.event;
    current.privateState.inbox.discoveryRelays = [
      "wss://auth.example",
      "wss://auth-two.example"
    ];
    current.privateState.inbox.inboxRelays = ["wss://auth.example"];
    current.privateState.inbox.stagedAt = NOW;
    expect(nextCoordinatorAction(current, NOW).kind)
      .toBe("publish_inbox_registration");
    current.privateState.inbox.status = "acknowledged";
    expect(nextCoordinatorAction(current, NOW).kind)
      .toBe("verify_inbox_registration");
  });

  it("validates and commits one durable incoming message before new work", () => {
    const current = session("taker", "awaiting_reserve_accept");
    current.privateState.pendingIncoming = {
      validation: { status: "unvalidated", checkedAt: null, error: null }
    } as TradeSession["privateState"]["pendingIncoming"];
    expect(nextCoordinatorAction(current, NOW).kind)
      .toBe("validate_incoming");
    current.privateState.pendingIncoming!.validation = {
      status: "validated",
      checkedAt: NOW,
      error: null
    };
    expect(nextCoordinatorAction(current, NOW).kind)
      .toBe("commit_incoming");
    current.privateState.pendingIncoming!.validation = {
      status: "rejected",
      checkedAt: NOW,
      error: "conflicting replay"
    };
    expect(nextCoordinatorAction(current, NOW).kind)
      .toBe("enter_recovery");
  });

  it.each([
    ["taker", "awaiting_reserve_propose", "stage_reserve_propose"],
    ["maker", "awaiting_reserve_propose", "poll_inbox"],
    ["maker", "awaiting_reserve_accept", "stage_order_reserve"],
    ["taker", "awaiting_reserve_accept", "poll_inbox"],
    ["maker", "awaiting_session_ack", "poll_inbox"],
    ["taker", "awaiting_session_ack", "stage_session_ack"],
    ["maker", "awaiting_base_lock", "prepare_base_lock"],
    ["taker", "awaiting_base_lock", "poll_inbox"],
    ["maker", "awaiting_base_lock_ack", "poll_inbox"],
    ["taker", "awaiting_base_lock_ack", "stage_base_lock_ack"],
    ["maker", "awaiting_quote_lock", "poll_inbox"],
    ["taker", "awaiting_quote_lock", "prepare_quote_lock"],
    ["maker", "awaiting_quote_lock_ack", "stage_quote_lock_ack"],
    ["taker", "awaiting_quote_lock_ack", "poll_inbox"],
    ["taker", "awaiting_claim_notice", "poll_inbox"],
    ["maker", "awaiting_fill_request", "poll_inbox"],
    ["taker", "awaiting_settlement_ack", "poll_inbox"]
  ] as const)("%s at %s plans %s", (role, phase, action) => {
    expect(nextCoordinatorAction(session(role, phase), NOW).kind)
      .toBe(action);
  });

  it("stages each protocol message only after its durable prerequisite exists", () => {
    const reserve = session("maker", "awaiting_reserve_accept");
    reserve.reserveProjectionId = "44".repeat(32);
    reserve.evidence.reserveProjectionId = reserve.reserveProjectionId;
    expect(nextCoordinatorAction(reserve, NOW).kind)
      .toBe("prepare_base_lock");
    setCommittedPublication(reserve, "reserve", reserve.reserveProjectionId);
    expect(nextCoordinatorAction(reserve, NOW).kind)
      .toBe("clear_order_publication");
    reserve.pendingOrderPublication = null;
    markLockReady(reserve, "base");
    expect(nextCoordinatorAction(reserve, NOW).kind)
      .toBe("stage_reserve_accept");

    const base = session("maker", "awaiting_base_lock");
    base.privateState.legs.base.htlcId = BASE_HTLC_ID;
    expect(nextCoordinatorAction(base, NOW).kind)
      .toBe("enter_recovery");
    markLockReady(base, "base");
    expect(nextCoordinatorAction(base, NOW).kind)
      .toBe("stage_base_lock");

    const quote = session("taker", "awaiting_quote_lock");
    quote.privateState.legs.quote.htlcId = QUOTE_HTLC_ID;
    expect(nextCoordinatorAction(quote, NOW).kind)
      .toBe("enter_recovery");
    markLockReady(quote, "quote");
    expect(nextCoordinatorAction(quote, NOW).kind)
      .toBe("stage_quote_lock");
  });

  it("rejects a lock whose durable HTLC identity disagrees with its evidence", () => {
    const current = session("maker", "awaiting_base_lock");
    markLockReady(current, "base");
    expect(nextCoordinatorAction(current, NOW).kind).toBe("stage_base_lock");
    current.evidence.legs.base.htlcId = QUOTE_HTLC_ID;
    expect(nextCoordinatorAction(current, NOW).kind).toBe("enter_recovery");
  });

  it("plans claim, observation, fill, and settlement only from chain evidence", () => {
    const makerClaim = session("maker", "settling");
    makerClaim.privateState.legs.base.htlcId = BASE_HTLC_ID;
    markLockReady(makerClaim, "quote");
    expect(nextCoordinatorAction(makerClaim, NOW).kind)
      .toBe("prepare_quote_claim");
    makerClaim.evidence.legs.quote.claimOperationCommitment = "44".repeat(32);
    expect(nextCoordinatorAction(makerClaim, NOW).kind)
      .toBe("observe_quote");
    markSpent(makerClaim, "quote");
    expect(nextCoordinatorAction(makerClaim, NOW).kind)
      .toBe("observe_base");

    const takerClaim = session("taker", "settling");
    takerClaim.privateState.legs.base.htlcId = BASE_HTLC_ID;
    takerClaim.privateState.legs.quote.htlcId = QUOTE_HTLC_ID;
    expect(nextCoordinatorAction(takerClaim, NOW).kind)
      .toBe("observe_quote");
    markSpent(takerClaim, "quote");
    expect(nextCoordinatorAction(takerClaim, NOW).kind)
      .toBe("observe_quote");
    takerClaim.privateState.preimage = "66".repeat(32);
    expect(nextCoordinatorAction(takerClaim, NOW).kind)
      .toBe("prepare_base_claim");
    takerClaim.evidence.legs.base.claimOperationCommitment = "77".repeat(32);
    expect(nextCoordinatorAction(takerClaim, NOW).kind)
      .toBe("observe_base");
    markSpent(takerClaim, "base");
    expect(nextCoordinatorAction(takerClaim, NOW).kind)
      .toBe("verify_order_fill");

    const makerFill = session("maker", "settling");
    makerFill.reserveProjectionId = "88".repeat(32);
    makerFill.privateState.legs.base.htlcId = BASE_HTLC_ID;
    makerFill.privateState.legs.quote.htlcId = QUOTE_HTLC_ID;
    makerFill.evidence.legs.quote.claimOperationCommitment = "44".repeat(32);
    expect(nextCoordinatorAction(makerFill, NOW).kind).toBe("observe_quote");
    markSpent(makerFill, "quote");
    expect(nextCoordinatorAction(makerFill, NOW).kind).toBe("observe_base");
    markSpent(makerFill, "base");
    expect(nextCoordinatorAction(makerFill, NOW).kind)
      .toBe("stage_order_fill");
    setCommittedPublication(makerFill, "fill", "99".repeat(32));
    makerFill.privateState.transcript.choreography.phase = "settled";
    makerFill.phase = "filled";
    expect(nextCoordinatorAction(makerFill, NOW).kind)
      .toBe("none");
  });

  it("fails closed at claim cutoffs and plans refunds only after locktime plus guard", () => {
    const maker = session("maker", "awaiting_claim_notice");
    maker.privateState.legs.base.htlcId = BASE_HTLC_ID;
    maker.privateState.legs.quote.htlcId = QUOTE_HTLC_ID;
    expect(nextCoordinatorAction(maker, maker.plan.makerClaimCutoff).kind)
      .toBe("enter_recovery");
    expect(nextCoordinatorAction(maker, maker.plan.longLocktime + 59).kind)
      .toBe("enter_recovery");
    expect(nextCoordinatorAction(maker, maker.plan.longLocktime + 60).kind)
      .toBe("observe_base");
    markPostExpiryLocked(maker, "base", maker.plan.longLocktime + 61);
    expect(nextCoordinatorAction(maker, maker.plan.longLocktime + 61).kind)
      .toBe("prepare_base_refund");

    const taker = session("taker", "awaiting_fill_request");
    taker.privateState.legs.base.htlcId = BASE_HTLC_ID;
    taker.privateState.legs.quote.htlcId = QUOTE_HTLC_ID;
    markSpent(taker, "quote", taker.plan.takerClaimCutoff);
    expect(nextCoordinatorAction(taker, taker.plan.takerClaimCutoff).kind)
      .toBe("enter_recovery");
    taker.privateState.legs.quote.observations = [];
    taker.evidence.legs.quote.htlcState = "UNKNOWN";
    expect(nextCoordinatorAction(taker, taker.plan.shortLocktime + 60).kind)
      .toBe("observe_quote");
    markPostExpiryLocked(taker, "quote", taker.plan.shortLocktime + 61);
    expect(nextCoordinatorAction(taker, taker.plan.shortLocktime + 61).kind)
      .toBe("prepare_quote_refund");
  });

  it("requires independently persisted unlocked observations for settlement", () => {
    const inconsistent = session("maker", "settled");
    expect(nextCoordinatorAction(inconsistent, NOW))
      .toEqual({ kind: "enter_recovery" });

    markSpent(inconsistent, "base");
    markSpent(inconsistent, "quote");
    expect(nextCoordinatorAction(inconsistent, NOW))
      .toEqual({ kind: "enter_recovery" });
    setCommittedPublication(inconsistent, "fill", "99".repeat(32));
    expect(nextCoordinatorAction(inconsistent, NOW))
      .toEqual({ kind: "none" });
  });

  it("ignores an unlocked claim whose witness commitment does not match", () => {
    const current = session("maker", "settled");
    markSpent(current, "base");
    markSpent(current, "quote");
    setCommittedPublication(current, "fill", "99".repeat(32));
    expect(nextCoordinatorAction(current, NOW)).toEqual({ kind: "none" });

    current.privateState.legs.quote.observations = [{
      observedAt: NOW,
      state: "UNLOCKED",
      witnessCommitment: "bc".repeat(32)
    }];
    expect(nextCoordinatorAction(current, NOW))
      .toEqual({ kind: "enter_recovery" });
  });

  it("needs no private acknowledgement after the public fill is committed", () => {
    const current = session("maker", "settled");
    current.phase = "filled";
    current.fillProjectionId = "99".repeat(32);
    current.evidence.fillProjectionId = current.fillProjectionId;
    markSpent(current, "base");
    markSpent(current, "quote");
    setCommittedPublication(current, "fill", current.fillProjectionId);
    expect(nextCoordinatorAction(current, NOW).kind)
      .toBe("none");
  });

  it("does not initiate a prepared effect or private delivery after its cutoff", () => {
    const prepared = session("maker", "awaiting_claim_notice");
    prepared.privateState.chainOperation = {
      status: "prepared",
      leg: "quote",
      kind: "claim",
      fundsReserved: true
    } as TradeSession["privateState"]["chainOperation"];
    expect(nextCoordinatorAction(prepared, prepared.plan.makerClaimCutoff).kind)
      .toBe("enter_recovery");
    prepared.privateState.chainOperation!.fundsReserved = false;
    expect(nextCoordinatorAction(prepared, prepared.plan.makerClaimCutoff).kind)
      .toBe("enter_recovery");
    prepared.privateState.chainOperation!.status = "completed";
    expect(nextCoordinatorAction(prepared, prepared.plan.makerClaimCutoff).kind)
      .toBe("reconcile_account");

    const staged = session("maker", "awaiting_base_lock_ack");
    staged.privateState.outbox = {
      status: "staged",
      message: { type: "base_lock" }
    } as TradeSession["privateState"]["outbox"];
    expect(nextCoordinatorAction(staged, staged.plan.makerClaimCutoff).kind)
      .toBe("enter_recovery");
  });

  it("does not start settlement after its safe deadline", () => {
    const expired = session("taker", "awaiting_reserve_propose");
    expect(nextCoordinatorAction(expired, expired.plan.reservationExpiresAt).kind)
      .toBe("enter_recovery");

    const lateQuote = session("taker", "awaiting_quote_lock");
    markLockReady(lateQuote, "quote");
    expect(nextCoordinatorAction(lateQuote, lateQuote.plan.makerClaimCutoff).kind)
      .toBe("enter_recovery");
  });

  it("releases after a completed and account-reconciled refund without claim witness evidence", () => {
    const current = session("maker", "refunding");
    setCommittedPublication(current, "reserve", "88".repeat(32));
    markLockReady(current, "base");
    const eligible = current.plan.longLocktime + current.plan.refundGuardSeconds;
    markPostExpiryLocked(current, "base", eligible + 1);

    expect(nextCoordinatorAction(current, eligible + 1).kind)
      .toBe("prepare_base_refund");

    setAccountAppliedRefund(current, "base", "completed");
    expect(nextCoordinatorAction(current, eligible + 2).kind)
      .toBe("reconcile_account");

    current.privateState.chainOperation!.status = "account_applied";
    expect(nextCoordinatorAction(current, eligible + 2).kind)
      .toBe("clear_order_publication");

    current.pendingOrderPublication = null;
    expect(nextCoordinatorAction(current, eligible + 2).kind)
      .toBe("stage_order_release");

    setCommittedPublication(current, "release", "bb".repeat(32));
    expect(nextCoordinatorAction(current, eligible + 2).kind)
      .toBe("clear_chain_operation");

    current.privateState.chainOperation = null;
    expect(nextCoordinatorAction(current, eligible + 2).kind).toBe("none");
  });

  it("keeps an exactly filled authoritative settlement terminal", () => {
    const current = session("maker", "settled");
    markSpent(current, "base");
    markSpent(current, "quote", NOW + 1);
    current.privateState.preimage = "66".repeat(32);
    setCommittedPublication(current, "fill", "cc".repeat(32));

    expect(nextCoordinatorAction(current, NOW + 2).kind).toBe("none");

    current.privateState.legs.quote.observations = [];
    expect(nextCoordinatorAction(current, NOW + 2).kind)
      .toBe("enter_recovery");
  });

  it("requires a taker to verify the maker fill before settlement is terminal", () => {
    const current = session("taker", "settling");
    markSpent(current, "base");
    markSpent(current, "quote", NOW + 1);
    current.privateState.preimage = "66".repeat(32);

    expect(nextCoordinatorAction(current, NOW + 2).kind)
      .toBe("verify_order_fill");

    current.privateState.transcript.choreography.phase = "settled";
    current.phase = "filled";
    current.fillProjectionId = "cc".repeat(32);
    current.evidence.fillProjectionId = current.fillProjectionId;
    expect(nextCoordinatorAction(current, NOW + 2).kind).toBe("none");

    current.evidence.fillProjectionId = "dd".repeat(32);
    expect(nextCoordinatorAction(current, NOW + 2).kind)
      .toBe("enter_recovery");
  });
});
