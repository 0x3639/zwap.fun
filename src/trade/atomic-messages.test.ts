import { describe, expect, it } from "vitest";

import { termsHash, type ZwapTradeMessage, type ZwapTradeTerms } from "./messages.js";
import { ZNN_ZTS, QSR_ZTS } from "../zenon/types.js";
import {
  ATOMIC_SWAP_BODY_SCHEMA,
  advanceAtomicSwapChoreography,
  initialAtomicSwapChoreography,
  validateAtomicSwapMessage,
  type AtomicSwapBody,
  type AtomicSwapMessageType
} from "./atomic-messages.js";

const makerOrder = "11".repeat(32);
const makerSession = "22".repeat(32);
const takerSession = "33".repeat(32);
const makerAddress = `z1${"9".repeat(38)}`;
const takerAddress = `z1${"2".repeat(38)}`;
const otherAddress = `z1${"7".repeat(38)}`;
const reservationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const sessionId = "88".repeat(32);
const proposalHead = "99".repeat(32);
const reserveHead = "aa".repeat(32);
const settlementHash = "bb".repeat(32);
const baseValidationCommitment = "dd".repeat(32);
const quoteValidationCommitment = "ff".repeat(32);
const baseHtlcId = "a".repeat(64);
const quoteHtlcId = "c".repeat(64);

const terms: ZwapTradeTerms = {
  chain_id: "1",
  base_token: ZNN_ZTS,
  quote_token: QSR_ZTS,
  base_amount: "100000000",
  quote_amount: "350000000",
  price: "350000000"
};

const NOW = 1_800_000_000;
const SHORT = NOW + 1800;
const LONG = NOW + 3600;
const MAKER_CUTOFF = SHORT - 120;
const TAKER_CUTOFF = LONG - 120;
const RESERVATION_EXPIRES = LONG + 600;

const ids = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000003",
  "00000000-0000-4000-8000-000000000004",
  "00000000-0000-4000-8000-000000000005",
  "00000000-0000-4000-8000-000000000006",
  "00000000-0000-4000-8000-000000000007",
  "00000000-0000-4000-8000-000000000008",
  "00000000-0000-4000-8000-000000000009",
  "00000000-0000-4000-8000-00000000000a"
] as const;

function body<T extends AtomicSwapMessageType>(
  type: T,
  overrides: Record<string, unknown> = {}
): AtomicSwapBody<T> {
  const bodies: Record<AtomicSwapMessageType, Record<string, unknown>> = {
    reserve_propose: {
      schema: ATOMIC_SWAP_BODY_SCHEMA,
      taker_session_pubkey: takerSession,
      taker_address: takerAddress,
      fill_amount: terms.base_amount
    },
    reserve_accept: {
      schema: ATOMIC_SWAP_BODY_SCHEMA,
      taker_session_pubkey: takerSession,
      maker_session_pubkey: makerSession,
      maker_address: makerAddress,
      reserve_projection_id: reserveHead,
      reserve_revision: "1",
      settlement_hash: settlementHash,
      short_locktime: SHORT,
      maker_claim_cutoff: MAKER_CUTOFF,
      long_locktime: LONG,
      taker_claim_cutoff: TAKER_CUTOFF,
      reservation_expires_at: RESERVATION_EXPIRES,
      base_lock: {
        schema: ATOMIC_SWAP_BODY_SCHEMA,
        htlc_id: baseHtlcId,
        validation_commitment: baseValidationCommitment,
        settlement_hash: settlementHash,
        chain_id: terms.chain_id,
        token_standard: terms.base_token,
        amount: terms.base_amount,
        hash_locked_address: takerAddress,
        time_locked_address: makerAddress,
        expiration_time: LONG
      }
    },
    session_ack: {
      schema: ATOMIC_SWAP_BODY_SCHEMA,
      reserve_accept_message_id: ids[1],
      reserve_accept_transcript_hash: "12".repeat(32),
      reserve_projection_id: reserveHead,
      reserve_revision: "1",
      settlement_hash: settlementHash
    },
    base_lock: {
      schema: ATOMIC_SWAP_BODY_SCHEMA,
      htlc_id: baseHtlcId,
      validation_commitment: baseValidationCommitment,
      settlement_hash: settlementHash,
      chain_id: terms.chain_id,
      token_standard: terms.base_token,
      amount: terms.base_amount,
      hash_locked_address: takerAddress,
      time_locked_address: makerAddress,
      expiration_time: LONG
    },
    base_lock_ack: {
      schema: ATOMIC_SWAP_BODY_SCHEMA,
      lock_message_id: ids[3],
      lock_transcript_hash: "14".repeat(32),
      htlc_id: baseHtlcId,
      validation_commitment: baseValidationCommitment,
      settlement_hash: settlementHash
    },
    quote_lock: {
      schema: ATOMIC_SWAP_BODY_SCHEMA,
      htlc_id: quoteHtlcId,
      validation_commitment: quoteValidationCommitment,
      settlement_hash: settlementHash,
      chain_id: terms.chain_id,
      token_standard: terms.quote_token,
      amount: terms.quote_amount,
      hash_locked_address: makerAddress,
      time_locked_address: takerAddress,
      expiration_time: SHORT
    },
    quote_lock_ack: {
      schema: ATOMIC_SWAP_BODY_SCHEMA,
      lock_message_id: ids[5],
      lock_transcript_hash: "16".repeat(32),
      htlc_id: quoteHtlcId,
      validation_commitment: quoteValidationCommitment,
      settlement_hash: settlementHash
    },
    claim_notice: {
      schema: ATOMIC_SWAP_BODY_SCHEMA,
      quote_htlc_id: quoteHtlcId,
      claim_operation_commitment: "17".repeat(32),
      settlement_hash: settlementHash,
      claimed_at: 1_800_000_006
    },
    fill_request: {
      schema: ATOMIC_SWAP_BODY_SCHEMA,
      base_htlc_id: baseHtlcId,
      quote_htlc_id: quoteHtlcId,
      base_spend_commitment: "18".repeat(32),
      quote_spend_commitment: "19".repeat(32),
      settlement_hash: settlementHash
    },
    settlement_ack: {
      schema: ATOMIC_SWAP_BODY_SCHEMA,
      fill_projection_id: "20".repeat(32),
      fill_revision: "2",
      base_htlc_id: baseHtlcId,
      quote_htlc_id: quoteHtlcId,
      settlement_hash: settlementHash
    },
    refund: {
      schema: ATOMIC_SWAP_BODY_SCHEMA,
      leg: "base",
      htlc_id: baseHtlcId,
      refund_operation_commitment: "21".repeat(32),
      settlement_hash: settlementHash,
      refunded_at: LONG + 61
    },
    error: {
      schema: ATOMIC_SWAP_BODY_SCHEMA,
      code: "node_unavailable",
      at_phase: "base_locked",
      failed_message_id: ids[3],
      retryable: true
    }
  };
  return { ...bodies[type], ...overrides } as unknown as AtomicSwapBody<T>;
}

async function message<T extends AtomicSwapMessageType>(
  type: T,
  index: number,
  overrides: Partial<ZwapTradeMessage> = {},
  bodyOverrides: Record<string, unknown> = {}
): Promise<ZwapTradeMessage> {
  const authors: Record<AtomicSwapMessageType, string> = {
    reserve_propose: takerSession,
    reserve_accept: makerOrder,
    session_ack: takerSession,
    base_lock: makerSession,
    base_lock_ack: takerSession,
    quote_lock: takerSession,
    quote_lock_ack: makerSession,
    claim_notice: makerSession,
    fill_request: takerSession,
    settlement_ack: makerSession,
    refund: makerSession,
    error: makerSession
  };
  const recipients: Record<AtomicSwapMessageType, string> = {
    reserve_propose: makerOrder,
    reserve_accept: takerSession,
    session_ack: makerSession,
    base_lock: takerSession,
    base_lock_ack: makerSession,
    quote_lock: makerSession,
    quote_lock_ack: takerSession,
    claim_notice: takerSession,
    fill_request: makerSession,
    settlement_ack: takerSession,
    refund: takerSession,
    error: takerSession
  };
  const includesTerms = type === "reserve_propose" || type === "reserve_accept";
  return {
    schema: "zwap/dm/v1",
    deployment: "zenon-1-v1",
    type,
    message_id: ids[index] ?? "00000000-0000-4000-8000-00000000000b",
    session_id: sessionId,
    reservation_id: reservationId,
    order_address: `30078:${makerOrder}:zwap:order:v1:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb`,
    order_projection_id:
      type === "reserve_propose" ? proposalHead :
      type === "settlement_ack" ? "20".repeat(32) :
      reserveHead,
    order_revision:
      type === "reserve_propose" ? "0" :
      type === "settlement_ack" ? "2" :
      "1",
    maker_order_pubkey: makerOrder,
    author_pubkey: authors[type],
    recipient_pubkey: recipients[type],
    sequence: String(index),
    previous_message_id: index === 0 ? null : ids[index - 1]!,
    previous_transcript_hash: index === 0 ? null : `${(16 + index).toString(16).padStart(2, "0")}`.repeat(32),
    sent_at: NOW + index,
    expires_at: 1_800_002_000,
    terms_hash: await termsHash(terms),
    ...(includesTerms ? { terms } : {}),
    body: body(type, bodyOverrides),
    ...overrides
  };
}

describe("atomic swap message bodies", () => {
  it("accepts the exact three-message happy-path choreography", async () => {
    let state = initialAtomicSwapChoreography(makerOrder);
    for (const [index, type] of [
      "reserve_propose",
      "reserve_accept",
      "quote_lock"
    ].entries()) {
      state = await advanceAtomicSwapChoreography(
        state,
        await message(type as AtomicSwapMessageType, index)
      );
    }
    expect(state.phase).toBe("settling");
    expect(state.participants).toEqual({
      makerOrderPubkey: makerOrder,
      makerSessionPubkey: makerSession,
      takerSessionPubkey: takerSession,
      makerAddress,
      takerAddress
    });
    expect(state.baseHtlcId).toBe(baseHtlcId);
    expect(state.quoteHtlcId).toBe(quoteHtlcId);
  });

  it.each([
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
  ] as const)("rejects unknown fields in %s", async (type) => {
    await expect(validateAtomicSwapMessage(
      await message(type, 0, {}, { unknown_field: "nope" })
    )).rejects.toThrow(/missing or unknown fields/i);
  });

  it("rejects non-canonical values and malformed identifiers", async () => {
    await expect(validateAtomicSwapMessage(
      await message("reserve_propose", 0, {}, { fill_amount: "01000" })
    )).rejects.toThrow(/fill amount/i);
    await expect(validateAtomicSwapMessage(
      await message("reserve_propose", 0, {}, { taker_address: "02aa" })
    )).rejects.toThrow(/taker address/i);
    await expect(validateAtomicSwapMessage(
      await message("base_lock", 3, {}, { amount: "0" })
    )).rejects.toThrow(/lock amount/i);
    await expect(validateAtomicSwapMessage(
      await message("base_lock", 3, {}, { htlc_id: "zz".repeat(32) })
    )).rejects.toThrow(/htlc id/i);
  });

  it("requires exact deadline arithmetic and canonical terms", async () => {
    await expect(validateAtomicSwapMessage(
      await message("reserve_accept", 1, {}, { long_locktime: LONG + 1 })
    )).rejects.toThrow(/deadline/i);
    await expect(validateAtomicSwapMessage(
      await message("reserve_accept", 1, {}, { reservation_expires_at: RESERVATION_EXPIRES - 1 })
    )).rejects.toThrow(/reservation expiry/i);
    // Regression: the wire accepted any expiry at or past the window while
    // storage only ever persists `long + 600`, so a wider one negotiated fine
    // and then failed every durable save.
    await expect(validateAtomicSwapMessage(
      await message("reserve_accept", 1, {}, { reservation_expires_at: RESERVATION_EXPIRES + 1 })
    )).rejects.toThrow(/reservation expiry/i);
    await expect(validateAtomicSwapMessage(
      await message("reserve_accept", 1, {}, {
        short_locktime: LONG - 300,
        maker_claim_cutoff: LONG - 420
      })
    )).rejects.toThrow(/deadline/i);
    await expect(validateAtomicSwapMessage(
      await message("reserve_propose", 0, {
        terms: { ...terms, base_amount: "999" }
      })
    )).rejects.toThrow(/terms|price/i);
  });

  it("rejects a quote lock that reuses the base HTLC id", async () => {
    // One HTLC cannot be both legs: accepting it would let a taker "fund" the
    // quote leg with the maker's own lock.
    let state = initialAtomicSwapChoreography(makerOrder);
    for (const [index, type] of ["reserve_propose", "reserve_accept"].entries()) {
      state = await advanceAtomicSwapChoreography(
        state,
        await message(type as AtomicSwapMessageType, index)
      );
    }
    await expect(advanceAtomicSwapChoreography(
      state,
      await message("quote_lock", 2, {}, { htlc_id: baseHtlcId })
    )).rejects.toThrow(/base HTLC/i);
  });

  it("rejects a lock whose hash-locked and time-locked addresses are identical", async () => {
    await expect(validateAtomicSwapMessage(
      await message("base_lock", 3, {}, { hash_locked_address: makerAddress })
    )).rejects.toThrow(/must differ/i);
  });

  it("rejects a lock whose expiration has already passed", async () => {
    await expect(validateAtomicSwapMessage(
      await message("base_lock", 3, { sent_at: LONG }, { expiration_time: LONG })
    )).rejects.toThrow(/expiration/i);
  });

  it("binds lock data to the accepted participants, terms, and deadlines", async () => {
    let state = initialAtomicSwapChoreography(makerOrder);
    state = await advanceAtomicSwapChoreography(state, await message("reserve_propose", 0));

    await expect(advanceAtomicSwapChoreography(
      state,
      await message("reserve_accept", 1, {}, {
        base_lock: {
          ...body("base_lock"),
          hash_locked_address: otherAddress
        }
      })
    )).rejects.toThrow(/base lock addresses differ from the accepted participants/i);
    await expect(advanceAtomicSwapChoreography(
      state,
      await message("reserve_accept", 1, {}, {
        base_lock: {
          ...body("base_lock"),
          token_standard: terms.quote_token
        }
      })
    )).rejects.toThrow(/base token/i);
    await expect(advanceAtomicSwapChoreography(
      state,
      await message("reserve_accept", 1, {}, {
        base_lock: {
          ...body("base_lock"),
          expiration_time: SHORT
        }
      })
    )).rejects.toThrow(/base expiration/i);
  });

  it("rejects a reservation acceptance whose maker address is the accepted taker address", async () => {
    let state = initialAtomicSwapChoreography(makerOrder);
    state = await advanceAtomicSwapChoreography(state, await message("reserve_propose", 0));

    await expect(advanceAtomicSwapChoreography(
      state,
      await message("reserve_accept", 1, {}, {
        maker_address: takerAddress,
        base_lock: {
          ...body("base_lock"),
          hash_locked_address: otherAddress,
          time_locked_address: takerAddress
        }
      })
    )).rejects.toThrow(/maker and taker settlement addresses must differ/i);
  });

  it("rejects a locked amount that differs from the canonical terms", async () => {
    let state = initialAtomicSwapChoreography(makerOrder);
    state = await advanceAtomicSwapChoreography(state, await message("reserve_propose", 0));
    state = await advanceAtomicSwapChoreography(state, await message("reserve_accept", 1));
    await expect(advanceAtomicSwapChoreography(
      state,
      await message("quote_lock", 2, {}, { amount: "999" })
    )).rejects.toThrow(/quote amount differs from terms/i);
  });

  it("rejects role confusion, reordered phases, and changed lock addresses", async () => {
    let state = initialAtomicSwapChoreography(makerOrder);
    await expect(advanceAtomicSwapChoreography(
      state,
      await message("reserve_propose", 0, { author_pubkey: makerOrder })
    )).rejects.toThrow(/taker session author/i);

    state = await advanceAtomicSwapChoreography(state, await message("reserve_propose", 0));
    await expect(advanceAtomicSwapChoreography(
      state,
      await message("session_ack", 2)
    )).rejects.toThrow(/expected reserve_accept/i);

    state = await advanceAtomicSwapChoreography(state, await message("reserve_accept", 1));
    await expect(advanceAtomicSwapChoreography(
      state,
      await message("quote_lock", 2, {}, {
        hash_locked_address: otherAddress
      })
    )).rejects.toThrow(/quote lock addresses differ from the accepted participants/i);
  });

  it("permits a bound refund only after a leg is locked and makes error terminal", async () => {
    const start = initialAtomicSwapChoreography(makerOrder);
    await expect(advanceAtomicSwapChoreography(
      start,
      await message("refund", 3, { sent_at: LONG + 62 })
    )).rejects.toThrow(/refund.*locked/i);

    let state = await advanceAtomicSwapChoreography(start, await message("reserve_propose", 0));
    state = await advanceAtomicSwapChoreography(state, await message("reserve_accept", 1));
    const refund = await message("refund", 2, {
      author_pubkey: makerSession,
      recipient_pubkey: takerSession,
      sent_at: LONG + 62
    }, { leg: "base" });
    expect((await advanceAtomicSwapChoreography(state, refund)).phase).toBe("refunding");

    const failed = await advanceAtomicSwapChoreography(
      state,
      await message("error", 2, {
        author_pubkey: takerSession,
        recipient_pubkey: makerSession
      }, { at_phase: "base_locked", failed_message_id: ids[1] })
    );
    expect(failed.phase).toBe("failed");
    await expect(advanceAtomicSwapChoreography(
      failed,
      await message("quote_lock", 3)
    )).rejects.toThrow(/terminal/i);
  });

  it("rejects self-addressed errors and future-dated claims or refunds", async () => {
    let state = initialAtomicSwapChoreography(makerOrder);
    state = await advanceAtomicSwapChoreography(state, await message("reserve_propose", 0));
    state = await advanceAtomicSwapChoreography(state, await message("reserve_accept", 1));

    await expect(advanceAtomicSwapChoreography(
      state,
      await message("error", 2, {
        author_pubkey: makerSession,
        recipient_pubkey: makerSession
      }, { at_phase: "base_locked", failed_message_id: ids[1] })
    )).rejects.toThrow(/counterparties/i);
    await expect(validateAtomicSwapMessage(
      await message("claim_notice", 7, {}, { claimed_at: 1_800_000_008 })
    )).rejects.toThrow(/claim timestamp/i);
    await expect(validateAtomicSwapMessage(
      await message("refund", 4, {}, { refunded_at: 1_800_000_005 })
    )).rejects.toThrow(/refund timestamp/i);
  });

  it("flips lock assets and actors for a buy-side maker", async () => {
    const buyTerms: ZwapTradeTerms = { ...terms, maker_side: "buy" };
    const buyHash = await termsHash(buyTerms);
    const buyBody: Partial<Record<AtomicSwapMessageType, Record<string, unknown>>> = {
      reserve_accept: {
        base_lock: {
          ...body("base_lock"),
          token_standard: terms.quote_token,
          amount: terms.quote_amount
        }
      },
      quote_lock: {
        token_standard: terms.base_token,
        amount: terms.base_amount
      }
    };
    let state = initialAtomicSwapChoreography(makerOrder);
    for (const [index, type] of [
      "reserve_propose", "reserve_accept", "quote_lock"
    ].entries()) {
      const messageOverrides: Partial<ZwapTradeMessage> = {
        terms_hash: buyHash,
        ...(type === "reserve_propose" || type === "reserve_accept"
          ? { terms: buyTerms }
          : {})
      };
      state = await advanceAtomicSwapChoreography(
        state,
        await message(
          type as AtomicSwapMessageType,
          index,
          messageOverrides,
          buyBody[type as AtomicSwapMessageType] ?? {}
        )
      );
    }
    expect(state.phase).toBe("settling");
  });
});
