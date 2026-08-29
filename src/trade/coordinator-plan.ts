import { isHex32 } from "../zenon/validate.js";
import type { TradePhase } from "./model.js";
import type { TradeSession } from "./session.js";

export type CoordinatorAction =
  | { kind: "publish_order_projection" }
  | { kind: "commit_order_publication" }
  | { kind: "clear_order_publication" }
  | { kind: "stage_inbox_registration" }
  | { kind: "publish_inbox_registration" }
  | { kind: "verify_inbox_registration" }
  | { kind: "deliver_outbox" }
  | { kind: "commit_outbox" }
  | { kind: "validate_incoming" }
  | { kind: "commit_incoming" }
  | { kind: "reserve_funds" }
  | { kind: "execute_chain_operation" }
  | { kind: "reconcile_account" }
  | { kind: "clear_chain_operation" }
  | { kind: "stage_reserve_propose" }
  | { kind: "stage_order_reserve" }
  | { kind: "stage_reserve_accept" }
  | { kind: "poll_inbox" }
  | { kind: "stage_session_ack" }
  | { kind: "prepare_base_lock" }
  | { kind: "stage_base_lock" }
  | { kind: "stage_base_lock_ack" }
  | { kind: "prepare_quote_lock" }
  | { kind: "stage_quote_lock" }
  | { kind: "stage_quote_lock_ack" }
  | { kind: "prepare_quote_claim" }
  | { kind: "stage_claim_notice" }
  | { kind: "observe_quote" }
  | { kind: "prepare_base_claim" }
  | { kind: "stage_fill_request" }
  | { kind: "observe_base" }
  | { kind: "stage_order_fill" }
  | { kind: "verify_order_fill" }
  | { kind: "stage_order_release" }
  | { kind: "stage_settlement_ack" }
  | { kind: "prepare_quote_refund" }
  | { kind: "prepare_base_refund" }
  | { kind: "enter_recovery" }
  | { kind: "none" };

function safeNow(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Coordinator time must be a Unix timestamp");
  }
  return value;
}

function makerOffersBase(session: TradeSession): boolean {
  return session.orderSide !== "buy";
}

function slotLeg(session: TradeSession, slot: "base" | "quote"): "base" | "quote" {
  if (slot === "base") return makerOffersBase(session) ? "base" : "quote";
  return makerOffersBase(session) ? "quote" : "base";
}

function legSlot(session: TradeSession, leg: "base" | "quote"): "base" | "quote" {
  return slotLeg(session, "base") === leg ? "base" : "quote";
}

function independentlySpent(session: TradeSession, leg: "base" | "quote"): boolean {
  const evidence = session.evidence.legs[leg];
  if (
    evidence.htlcState !== "UNLOCKED" ||
    evidence.observedAt === null ||
    !isHex32(evidence.spendCommitment)
  ) return false;
  return session.privateState.legs[leg].observations.some((observation) =>
    observation.state === "UNLOCKED" &&
    observation.observedAt === evidence.observedAt &&
    isHex32(observation.witnessCommitment) &&
    observation.witnessCommitment === evidence.spendCommitment
  );
}

function bothLegsSpent(session: TradeSession): boolean {
  return independentlySpent(session, "base") && independentlySpent(session, "quote");
}

function hasCommittedPublication(
  session: TradeSession,
  operation: "reserve" | "fill" | "release",
  projectionId: string | null = null
): boolean {
  const publication = session.pendingOrderPublication;
  return publication !== null &&
    publication.operation === operation &&
    publication.status === "committed" &&
    (projectionId === null || publication.projection.id === projectionId);
}

function exactCommittedFill(session: TradeSession): boolean {
  return session.fillProjectionId !== null &&
    session.evidence.fillProjectionId === session.fillProjectionId &&
    hasCommittedPublication(session, "fill", session.fillProjectionId);
}

function exactVerifiedTakerFill(session: TradeSession): boolean {
  return session.fillProjectionId !== null &&
    session.evidence.fillProjectionId === session.fillProjectionId;
}

function exactCommittedRelease(session: TradeSession): boolean {
  return hasCommittedPublication(session, "release");
}

function terminal(session: TradeSession): boolean {
  if (session.privateState.transcript.choreography.phase === "settled") {
    const authoritativeFill = session.role === "maker"
      ? exactCommittedFill(session)
      : exactVerifiedTakerFill(session);
    return bothLegsSpent(session) && authoritativeFill;
  }
  if (session.phase === "released") {
    // Only the maker owes a release projection; once it is committed - or was
    // never owed, which is every taker and any maker that never reserved - a
    // released session has nothing left to do.
    return session.role !== "maker" ||
      session.reserveProjectionId === null ||
      exactCommittedRelease(session);
  }
  if (session.phase === "frozen") {
    return session.reserveProjectionId === null &&
      session.privateState.legs.base.htlcId === null &&
      session.privateState.legs.quote.htlcId === null;
  }
  return false;
}

function lockReady(session: TradeSession, leg: "base" | "quote"): boolean {
  const actualLeg = slotLeg(session, leg);
  const privateLeg = session.privateState.legs[actualLeg];
  const evidence = session.evidence.legs[actualLeg];
  const expected = privateLeg.expected;
  if (
    privateLeg.htlcId === null ||
    expected === null ||
    evidence.htlcId === null ||
    evidence.htlcId !== privateLeg.htlcId ||
    evidence.validationCommitment === null ||
    session.privateState.htlcHash === null ||
    session.privateState.settlementTranscriptHash === null
  ) return false;
  const base = actualLeg === "base";
  return expected.leg === actualLeg &&
    expected.chainId === session.terms.chainId &&
    expected.tokenStandard === (base ? session.terms.baseToken : session.terms.quoteToken) &&
    expected.amount === (base ? session.terms.baseAmount : session.terms.quoteAmount) &&
    expected.hashLock === session.privateState.htlcHash &&
    expected.expirationTime ===
      (leg === "base" ? session.plan.longLocktime : session.plan.shortLocktime) &&
    expected.binding.sessionId === session.sessionId &&
    expected.binding.reservationId === session.reservationId &&
    expected.binding.transcriptHash === session.privateState.settlementTranscriptHash;
}

function accountAppliedRefund(
  session: TradeSession,
  leg: "base" | "quote"
): boolean {
  const operation = session.privateState.chainOperation;
  return operation !== null &&
    operation.status === "account_applied" &&
    operation.kind === "refund" &&
    operation.leg === leg &&
    operation.result !== null &&
    operation.artifact.operationCommitment ===
      session.evidence.legs[leg].refundOperationCommitment;
}

function hasPostExpiryLockedObservation(
  session: TradeSession,
  leg: "base" | "quote",
  eligibleAfter: number
): boolean {
  const evidence = session.evidence.legs[leg];
  return (
    evidence.htlcState === "LOCKED" &&
    evidence.observedAt !== null &&
    evidence.observedAt > eligibleAfter &&
    session.privateState.legs[leg].observations.some((observation) =>
      observation.state === "LOCKED" &&
      observation.observedAt === evidence.observedAt
    )
  );
}

function unsafePreparedOperation(session: TradeSession, now: number): boolean {
  const operation = session.privateState.chainOperation;
  if (!operation || operation.status !== "prepared") return false;
  if (operation.kind === "refund") {
    const locktime = legSlot(session, operation.leg) === "base"
      ? session.plan.longLocktime
      : session.plan.shortLocktime;
    return now <= locktime + session.plan.refundGuardSeconds;
  }
  const cutoff = operation.kind === "claim" && legSlot(session, operation.leg) === "base"
    ? session.plan.takerClaimCutoff
    : session.plan.makerClaimCutoff;
  return now >= cutoff;
}

function unsafeStagedDelivery(session: TradeSession, now: number): boolean {
  const outbox = session.privateState.outbox;
  if (!outbox || outbox.status !== "staged") return false;
  if (Number.isSafeInteger(outbox.message.expires_at) && now >= outbox.message.expires_at) {
    return true;
  }
  if ([
    "reserve_propose",
    "reserve_accept",
    "session_ack",
    "base_lock",
    "base_lock_ack",
    "quote_lock",
    "quote_lock_ack"
  ].includes(outbox.message.type)) {
    return now >= session.plan.makerClaimCutoff;
  }
  if (outbox.message.type === "fill_request") {
    return now >= session.plan.takerClaimCutoff;
  }
  return false;
}

/**
 * The single description of what `enter_recovery` does, shared by the planner
 * and the effect so the two can never disagree.
 *
 * A side that still holds its own live HTLC steps onto its rung of the refund
 * ladder; a side with nothing left on chain fails the session outright. The
 * rung matters because the durable validator only accepts a release along the
 * ladder: a session that reclaims first and changes phase later would get its
 * funds back on chain and then wedge forever retrying the release commit,
 * leaving the order reserved on the relay.
 *
 * `filled` and `released` are value-terminal: there is nothing left to reclaim,
 * so recovery leaves them exactly as they are and the planner idles.
 */
export interface RecoveryStep {
  phase: TradePhase;
  choreography: "refunding" | "failed";
}

export function recoveryStep(session: TradeSession): RecoveryStep {
  const choreography = session.privateState.transcript.choreography.phase;
  if (session.phase === "filled" || session.phase === "released") {
    return {
      phase: session.phase,
      choreography: choreography === "refunding" ? "refunding" : "failed"
    };
  }
  const leg = slotLeg(session, session.role === "maker" ? "base" : "quote");
  const holdsLiveLock =
    session.privateState.legs[leg].htlcId !== null &&
    session.evidence.legs[leg].htlcState !== "UNLOCKED";
  if (!holdsLiveLock) return { phase: "frozen", choreography: "failed" };
  return {
    phase: session.role === "maker" ? "waiting_base_refund" : "waiting_quote_refund",
    choreography: "refunding"
  };
}

/**
 * True when `enter_recovery` would change nothing. Bumping a revision without
 * moving the session is a livelock: between `makerClaimCutoff` and the refund
 * window there is no recovery work to do, and the browser's bounded drive loop
 * would spend its whole action budget re-entering the same rung.
 */
export function recoveryIsIdle(session: TradeSession): boolean {
  if (session.privateState.pendingIncoming?.validation.status === "rejected") {
    return false;
  }
  const step = recoveryStep(session);
  return session.phase === step.phase &&
    session.privateState.transcript.choreography.phase === step.choreography;
}

/** True when this side still has to step onto the refund ladder. */
function owesRefundLadderEntry(session: TradeSession): boolean {
  return !recoveryIsIdle(session);
}

function recoveryAction(session: TradeSession, now: number): CoordinatorAction | undefined {
  const makerOfferLeg = slotLeg(session, "base");
  const takerPaymentLeg = slotLeg(session, "quote");
  const base = session.privateState.legs[makerOfferLeg];
  const quote = session.privateState.legs[takerPaymentLeg];
  const baseSpent = independentlySpent(session, makerOfferLeg);
  const quoteSpent = independentlySpent(session, takerPaymentLeg);
  const guard = session.plan.refundGuardSeconds;

  const quoteExpiryGuard = session.plan.shortLocktime + guard;
  if (session.role === "taker" && quote.htlcId !== null && !quoteSpent && now >= quoteExpiryGuard) {
    if (owesRefundLadderEntry(session)) return { kind: "enter_recovery" };
    return hasPostExpiryLockedObservation(session, takerPaymentLeg, quoteExpiryGuard)
      ? { kind: "prepare_quote_refund" }
      : { kind: "observe_quote" };
  }
  const baseExpiryGuard = session.plan.longLocktime + guard;
  if (session.role === "maker" && base.htlcId !== null && !baseSpent && now >= baseExpiryGuard) {
    if (owesRefundLadderEntry(session)) return { kind: "enter_recovery" };
    return hasPostExpiryLockedObservation(session, makerOfferLeg, baseExpiryGuard)
      ? { kind: "prepare_base_refund" }
      : { kind: "observe_base" };
  }

  const phase = session.privateState.transcript.choreography.phase;
  if (
    session.role === "maker" &&
    ["awaiting_reserve_accept", "settling"].includes(phase) &&
    now >= session.plan.makerClaimCutoff
  ) {
    return { kind: "enter_recovery" };
  }
  if (session.role === "taker" && phase === "settling" &&
    now >= session.plan.takerClaimCutoff) {
    return { kind: "enter_recovery" };
  }
  return undefined;
}

/**
 * Chooses at most one durable or external effect. The executor must persist the
 * corresponding journal transition before asking for another action.
 *
 * Recovery is filtered here rather than at each of its call sites: an
 * `enter_recovery` that would not change the session is no progress at all, so
 * the planner idles instead of spinning revisions.
 */
export function nextCoordinatorAction(
  session: TradeSession,
  currentTime: number
): CoordinatorAction {
  const action = planCoordinatorAction(session, currentTime);
  return action.kind === "enter_recovery" && recoveryIsIdle(session)
    ? { kind: "none" }
    : action;
}

function planCoordinatorAction(
  session: TradeSession,
  currentTime: number
): CoordinatorAction {
  const now = safeNow(currentTime);

  const chain = session.privateState.chainOperation;
  const publication = session.pendingOrderPublication;
  if (chain?.status === "completed") return { kind: "reconcile_account" };
  if (chain?.status === "account_applied") {
    const releasableRefund =
      session.role === "maker" &&
      session.reserveProjectionId !== null &&
      accountAppliedRefund(session, slotLeg(session, "base"));
    if (!releasableRefund) return { kind: "clear_chain_operation" };
    if (publication === null) return { kind: "stage_order_release" };
    if (publication.operation !== "release") {
      return publication.operation === "reserve" &&
        publication.status === "committed"
        ? { kind: "clear_order_publication" }
        : { kind: "enter_recovery" };
    }
    if (publication.status === "committed") {
      return { kind: "clear_chain_operation" };
    }
  }

  if (publication !== null && publication.status !== "committed") {
    switch (publication.status) {
      case "staged":
        return { kind: "publish_order_projection" };
      case "acknowledged":
        return { kind: "commit_order_publication" };
    }
  }

  switch (session.privateState.inbox.status) {
    case "unregistered":
      return { kind: "stage_inbox_registration" };
    case "staged":
      return { kind: "publish_inbox_registration" };
    case "acknowledged":
      return { kind: "verify_inbox_registration" };
    case "registered":
      break;
  }

  const outbox = session.privateState.outbox;
  if (outbox?.status === "acknowledged") return { kind: "commit_outbox" };
  if (outbox?.status === "staged") {
    return unsafeStagedDelivery(session, now)
      ? { kind: "enter_recovery" }
      : { kind: "deliver_outbox" };
  }

  if (chain?.status === "prepared") {
    if (unsafePreparedOperation(session, now)) return { kind: "enter_recovery" };
    return chain.fundsReserved
      ? { kind: "execute_chain_operation" }
      : { kind: "reserve_funds" };
  }

  const incoming = session.privateState.pendingIncoming;
  if (incoming !== null) {
    switch (incoming.validation.status) {
      case "unvalidated":
        return { kind: "validate_incoming" };
      case "validated":
        return { kind: "commit_incoming" };
      case "rejected":
        return { kind: "enter_recovery" };
    }
  }

  if (terminal(session)) return { kind: "none" };
  if (session.privateState.transcript.choreography.phase === "settled") {
    return { kind: "enter_recovery" };
  }
  const recovery = recoveryAction(session, now);
  if (recovery) return recovery;

  const phase = session.privateState.transcript.choreography.phase;
  if (now >= session.plan.reservationExpiresAt) {
    return { kind: "enter_recovery" };
  }
  if (publication?.status === "committed") {
    if (publication.operation === "reserve") {
      return { kind: "clear_order_publication" };
    }
    if (publication.operation === "fill") {
      return { kind: "enter_recovery" };
    }
    if (publication.operation === "release") return { kind: "none" };
  }
  switch (phase) {
    case "awaiting_reserve_propose":
      if (now >= session.plan.makerClaimCutoff) return { kind: "enter_recovery" };
      return session.role === "taker"
        ? { kind: "stage_reserve_propose" }
        : { kind: "poll_inbox" };
    case "awaiting_reserve_accept":
      if (now >= session.plan.makerClaimCutoff) return { kind: "enter_recovery" };
      return session.role === "maker"
        ? session.reserveProjectionId === null
          ? { kind: "stage_order_reserve" }
          : session.privateState.legs[slotLeg(session, "base")].htlcId === null
            ? { kind: "prepare_base_lock" }
            : lockReady(session, "base")
              ? { kind: "stage_reserve_accept" }
              : { kind: "enter_recovery" }
        : { kind: "poll_inbox" };
    case "awaiting_session_ack":
      if (now >= session.plan.makerClaimCutoff) return { kind: "enter_recovery" };
      return session.role === "taker"
        ? { kind: "stage_session_ack" }
        : { kind: "poll_inbox" };
    case "awaiting_base_lock":
      if (now >= session.plan.makerClaimCutoff) return { kind: "enter_recovery" };
      return session.role === "maker"
        ? session.privateState.legs[slotLeg(session, "base")].htlcId === null
          ? { kind: "prepare_base_lock" }
          : lockReady(session, "base")
            ? { kind: "stage_base_lock" }
            : { kind: "enter_recovery" }
        : { kind: "poll_inbox" };
    case "awaiting_base_lock_ack":
      return session.role === "taker"
        ? { kind: "stage_base_lock_ack" }
        : { kind: "poll_inbox" };
    case "awaiting_quote_lock":
      if (now >= session.plan.makerClaimCutoff) return { kind: "enter_recovery" };
      return session.role === "taker"
        ? session.privateState.legs[slotLeg(session, "quote")].htlcId === null
          ? { kind: "prepare_quote_lock" }
          : lockReady(session, "quote")
            ? { kind: "stage_quote_lock" }
            : { kind: "enter_recovery" }
        : { kind: "poll_inbox" };
    case "awaiting_quote_lock_ack":
      return session.role === "maker"
        ? { kind: "stage_quote_lock_ack" }
        : { kind: "poll_inbox" };
    case "awaiting_claim_notice":
      if (session.role === "taker") return { kind: "poll_inbox" };
      if (now >= session.plan.makerClaimCutoff) return { kind: "enter_recovery" };
      if (!lockReady(session, "quote")) return { kind: "enter_recovery" };
      return session.evidence.legs[slotLeg(session, "quote")].claimOperationCommitment === null
        ? { kind: "prepare_quote_claim" }
        : independentlySpent(session, slotLeg(session, "quote"))
          ? { kind: "stage_claim_notice" }
          : { kind: "observe_quote" };
    case "awaiting_fill_request":
      if (session.role === "maker") return { kind: "poll_inbox" };
      if (now >= session.plan.takerClaimCutoff) return { kind: "enter_recovery" };
      if (
        !independentlySpent(session, slotLeg(session, "quote")) ||
        session.privateState.preimage === null
      ) {
        return { kind: "observe_quote" };
      }
      if (session.evidence.legs[slotLeg(session, "base")].claimOperationCommitment === null) {
        return { kind: "prepare_base_claim" };
      }
      if (!independentlySpent(session, slotLeg(session, "base"))) {
        return { kind: "observe_base" };
      }
      return { kind: "stage_fill_request" };
    case "awaiting_settlement_ack":
      if (session.role === "taker") return { kind: "poll_inbox" };
      if (!independentlySpent(session, slotLeg(session, "quote"))) {
        return { kind: "observe_quote" };
      }
      if (!independentlySpent(session, slotLeg(session, "base"))) {
        return { kind: "observe_base" };
      }
      return session.fillProjectionId === null
        ? { kind: "stage_order_fill" }
        : { kind: "enter_recovery" };
    case "settling": {
      const offerLeg = slotLeg(session, "base");
      const paymentLeg = slotLeg(session, "quote");
      if (!independentlySpent(session, paymentLeg)) {
        if (
          session.role === "maker" &&
          session.evidence.legs[paymentLeg].claimOperationCommitment === null
        ) return { kind: "prepare_quote_claim" };
        return { kind: "observe_quote" };
      }
      if (session.role === "taker" && session.privateState.preimage === null) {
        return { kind: "observe_quote" };
      }
      if (!independentlySpent(session, offerLeg)) {
        if (
          session.role === "taker" &&
          session.evidence.legs[offerLeg].claimOperationCommitment === null
        ) return { kind: "prepare_base_claim" };
        return { kind: "observe_base" };
      }
      return session.role === "maker"
        ? session.fillProjectionId === null
          ? { kind: "stage_order_fill" }
          : { kind: "enter_recovery" }
        : { kind: "verify_order_fill" };
    }
    case "refunding":
      return { kind: "enter_recovery" };
    case "failed":
      return { kind: "none" };
  }
}
