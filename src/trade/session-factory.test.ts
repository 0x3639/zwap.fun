import { getPublicKey } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";

import { createOrderState, type OrderRecord } from "../order/model.js";
import { MemoryStorageDriver } from "../storage/driver.js";
import { EncryptedStorageDriver } from "../storage/encrypted-storage.js";
import { TradeSessionRepository } from "../storage/trade-session.js";
import { createHtlcMaterial } from "../zenon/htlc-material.js";
import { QSR_ZTS, ZNN_ZTS } from "../zenon/types.js";
import { ATOMIC_SWAP_BODY_SCHEMA } from "./atomic-messages.js";
import {
  createTradeRumor,
  deploymentFor,
  termsHash,
  unwrapInitialReserveProposal,
  wrapTradeRumor,
  type SignedNostrEvent,
  type VerifiedInitialReserveProposal,
  type ZwapTradeMessage,
  type ZwapTradeTerms
} from "./messages.js";
import {
  createMakerSession,
  createTakerSession,
  type SessionFactoryEntropy,
  type SessionMarketSelection
} from "./session-factory.js";
import {
  FIXTURE_COUNTERPARTY_ADDRESS,
  FIXTURE_LOCAL_ADDRESS,
  FIXTURE_THIRD_ADDRESS
} from "./test-fixtures.js";

function bytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g) ?? [], (part) => Number.parseInt(part, 16));
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes(value) as BufferSource);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

const now = 1_800_000_000;
const chainId = "1";
const orderId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22".repeat(32);
const reservationId = "33333333-3333-4333-8333-333333333333";
const makerOrderSecret = Uint8Array.from({ length: 32 }, (_, index) => index === 31 ? 9 : 0);
const maker = getPublicKey(makerOrderSecret);
const takerAddress = FIXTURE_COUNTERPARTY_ADDRESS;
const makerAddress = FIXTURE_LOCAL_ADDRESS;
const preimage = "ab".repeat(32);
const fixedMaterial = { preimage, hash: await sha256Hex(preimage) };

const market: SessionMarketSelection = {
  chainId,
  baseToken: ZNN_ZTS,
  quoteToken: QSR_ZTS
};

function hexKey(last: number): string {
  const key = new Uint8Array(32);
  key[31] = last;
  return [...key].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function entropy(offset = 0): SessionFactoryEntropy {
  return {
    sessionId: () => sessionId,
    reservationId: () => reservationId,
    privateKey: () => hexKey(1 + offset),
    htlcMaterial: async () => fixedMaterial
  };
}

function record(overrides: Partial<OrderRecord> = {}): OrderRecord {
  const state = createOrderState({
    orderId,
    createdAt: now - 100,
    expiresAt: now + 9 * 86_400,
    side: "sell",
    chainId,
    baseToken: ZNN_ZTS,
    quoteToken: QSR_ZTS,
    amount: "1000",
    price: "2000000"
  });
  return {
    address: `30078:${maker}:zwap:order:v1:${orderId}`,
    eventId: "44".repeat(32),
    makerPubkey: maker,
    verified: true,
    state,
    ...overrides
  };
}

const clocks = {
  localNow: now,
  chainNow: now + 1
};

async function wrappedProposal(
  order = record(),
  bodyOverrides: Record<string, string> = {}
): Promise<{
  proposal: VerifiedInitialReserveProposal;
  wrapper: SignedNostrEvent;
}> {
  const takerSecret = bytes(hexKey(1));
  const takerNostr = getPublicKey(takerSecret);
  const terms: ZwapTradeTerms = {
    maker_side: "sell",
    chain_id: chainId,
    base_token: ZNN_ZTS,
    quote_token: QSR_ZTS,
    base_amount: "1000",
    quote_amount: "20",
    price: "2000000"
  };
  const message: ZwapTradeMessage = {
    schema: "zwap/dm/v1",
    deployment: deploymentFor(chainId),
    type: "reserve_propose",
    message_id: "66666666-6666-4666-8666-666666666666",
    session_id: sessionId,
    reservation_id: reservationId,
    order_address: order.address,
    order_projection_id: order.eventId,
    order_revision: "0",
    maker_order_pubkey: maker,
    author_pubkey: takerNostr,
    recipient_pubkey: maker,
    sequence: "0",
    previous_message_id: null,
    previous_transcript_hash: null,
    sent_at: now,
    expires_at: now + 300,
    terms_hash: await termsHash(terms),
    terms,
    body: {
      schema: ATOMIC_SWAP_BODY_SCHEMA,
      taker_session_pubkey: takerNostr,
      taker_address: takerAddress,
      fill_amount: "1000",
      ...bodyOverrides
    }
  };
  const rumor = await createTradeRumor(message, takerSecret);
  const wrapped = wrapTradeRumor(rumor, takerSecret, {
    ephemeralSecretKey: bytes(hexKey(8)),
    sealCreatedAt: now - 10,
    wrapperCreatedAt: now - 20,
    outerExpiration: message.expires_at + 3_600,
    sealNonce: new Uint8Array(32).fill(9),
    wrapperNonce: new Uint8Array(32).fill(10)
  });
  return {
    proposal: await unwrapInitialReserveProposal(
      wrapped.wrapper,
      makerOrderSecret,
      {
        now,
        expectedOrderAddress: message.order_address,
        expectedOrderProjectionId: message.order_projection_id,
        expectedOrderRevision: "0",
        expectedTermsHash: message.terms_hash
      }
    ),
    wrapper: wrapped.wrapper
  };
}

async function proposal(order = record()): Promise<VerifiedInitialReserveProposal> {
  return (await wrappedProposal(order)).proposal;
}

describe("trade session factory", () => {
  it("creates an encrypted-journal-ready taker session while preserving the offered head", async () => {
    const session = await createTakerSession({
      order: record(),
      expectedOrderProjectionId: "44".repeat(32),
      expectedOrderRevision: "0",
      market,
      fillBaseAmount: "1000",
      clocks,
      localAddress: takerAddress
    }, entropy());
    const raw = new MemoryStorageDriver();
    const repository = new TradeSessionRepository(
      new EncryptedStorageDriver(raw, "factory-test")
    );
    await repository.save(session, null);

    expect(await repository.get(session.sessionId)).toEqual(session);
    expect(session).toMatchObject({
      schema: "zwap/trade-session/v1",
      revision: 0,
      role: "taker",
      phase: "negotiating",
      offeredProjectionId: "44".repeat(32),
      reserveProjectionId: null,
      reserveProjectionRevision: null,
      terms: {
        makerSide: "sell",
        chainId,
        baseToken: ZNN_ZTS,
        baseAmount: "1000",
        quoteToken: QSR_ZTS,
        quoteAmount: "20",
        price: "2000000"
      },
      privateState: {
        localAddress: takerAddress,
        counterpartyAddress: null,
        preimage: null,
        htlcHash: null,
        settlementTranscriptHash: null,
        chainOperation: null,
        legs: {
          base: { htlcId: null, expected: null, observations: [] },
          quote: { htlcId: null, expected: null, observations: [] }
        },
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
        transcript: { nextSequence: "0", lastRumorId: null }
      }
    });
    expect(JSON.stringify(await raw.get("factory-test.data.zwap.trade-sessions.v2")))
      .not.toContain(session.privateState.nostrPrivateKey);
  });

  it("creates a maker session from the validated proposal with a durable transcript head and material", async () => {
    const opened = await proposal();
    const session = await createMakerSession({
      order: record(),
      proposal: opened,
      market,
      clocks,
      localAddress: makerAddress
    }, entropy(3));

    expect(session).toMatchObject({
      sessionId,
      reservationId,
      role: "maker",
      phase: "negotiating",
      offeredProjectionId: "44".repeat(32),
      evidence: {
        commitments: [fixedMaterial.hash],
        reservation: {
          proposalSealId: opened.seal.id,
          takerCommitment: null,
          abortSeal: null
        }
      },
      privateState: {
        localAddress: makerAddress,
        counterpartyAddress: takerAddress,
        preimage: fixedMaterial.preimage,
        htlcHash: fixedMaterial.hash,
        settlementTranscriptHash: opened.transcriptHash,
        chainOperation: null,
        transcript: {
          nextSequence: "1",
          lastRumorId: opened.rumor.id,
          lastMessageId: opened.message.message_id,
          lastTranscriptHash: opened.transcriptHash,
          accepted: [{
            sequence: "0",
            messageId: opened.message.message_id,
            rumorId: opened.rumor.id,
            transcriptHash: opened.transcriptHash
          }],
          choreography: { phase: "awaiting_reserve_accept" }
        }
      }
    });
    expect(session.privateState.transcript.choreography.participants).toMatchObject({
      makerOrderPubkey: maker,
      makerSessionPubkey: getPublicKey(bytes(hexKey(4))),
      takerSessionPubkey: getPublicKey(bytes(hexKey(1))),
      makerAddress,
      takerAddress
    });
    expect(session.privateState.transcript.choreography.deployment)
      .toBe(deploymentFor(chainId));

    const repository = new TradeSessionRepository(new MemoryStorageDriver());
    expect(await repository.createMakerForOrder(session)).toEqual(session);
    expect(await repository.get(session.sessionId)).toEqual(session);
  });

  it("derives independent HTLC material by default", async () => {
    const material = await createHtlcMaterial();
    expect(material.preimage).not.toBe(material.hash);
    expect(material.preimage).toMatch(/^[0-9a-f]{64}$/);
    expect(material.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("accepts only the opaque result of a cryptographically verified initial unwrap", async () => {
    const { proposal: opened, wrapper } = await wrappedProposal();
    expect(Object.isFrozen(opened)).toBe(true);
    expect(Object.isFrozen(opened.message)).toBe(true);
    expect(Object.isFrozen(opened.rumor.tags)).toBe(true);
    const partial = {
      message: opened.message,
      rumor: opened.rumor,
      transcriptHash: opened.transcriptHash
    } as VerifiedInitialReserveProposal;
    await expect(createMakerSession({
      order: record(),
      proposal: partial,
      market,
      clocks,
      localAddress: makerAddress
    }, entropy(3))).rejects.toThrow(/verified initial/i);

    await expect(createMakerSession({
      order: record(),
      proposal: {
        ...opened,
        rumor: { ...opened.rumor, id: "99".repeat(32) }
      } as VerifiedInitialReserveProposal,
      market,
      clocks,
      localAddress: makerAddress
    }, entropy(3))).rejects.toThrow(/verified initial/i);

    await expect(createMakerSession({
      order: record(),
      proposal: {
        ...opened,
        transcriptHash: "aa".repeat(32)
      } as VerifiedInitialReserveProposal,
      market,
      clocks,
      localAddress: makerAddress
    }, entropy(3))).rejects.toThrow(/verified initial/i);

    await expect(unwrapInitialReserveProposal(
      { ...wrapper, sig: "00".repeat(64) },
      makerOrderSecret,
      {
        now,
        expectedOrderAddress: opened.message.order_address,
        expectedOrderProjectionId: opened.message.order_projection_id,
        expectedOrderRevision: "0",
        expectedTermsHash: opened.message.terms_hash
      }
    )).rejects.toThrow(/signature/i);
  });

  it("prevents post-call mutation while maker-session validation is suspended", async () => {
    const opened = await proposal();
    const creation = createMakerSession({
      order: record(),
      proposal: opened,
      market,
      clocks,
      localAddress: makerAddress
    }, entropy(3));

    expect(() => {
      (opened.rumor as { id: string }).id = "99".repeat(32);
    }).toThrow(TypeError);
    expect(() => {
      (opened as { transcriptHash: string }).transcriptHash = "aa".repeat(32);
    }).toThrow(TypeError);
    await expect(creation).resolves.toMatchObject({
      role: "maker",
      privateState: {
        transcript: {
          lastRumorId: opened.rumor.id,
          lastTranscriptHash: opened.transcriptHash
        }
      }
    });
  });

  it.each([
    ["unverified", { verified: false }],
    ["stale", { eventId: "66".repeat(32) }],
    ["expired", { state: { ...record().state, expires_at: now } }],
    ["reserved", {
      state: {
        ...record().state,
        status: "reserved" as const,
        reserved_amount: "1000",
        reservation: {
          id: reservationId,
          amount: "1000",
          accepted_at: now - 1,
          expires_at: now + 100,
          proposal_event_id: "77".repeat(32),
          taker_commitment: "88".repeat(32)
        }
      }
    }]
  ])("rejects a %s order", async (_label, override) => {
    await expect(createTakerSession({
      order: record(override as Partial<OrderRecord>),
      expectedOrderProjectionId: "44".repeat(32),
      expectedOrderRevision: "0",
      market,
      fillBaseAmount: "1000",
      clocks,
      localAddress: takerAddress
    }, entropy())).rejects.toThrow();
  });

  it("accepts bids and rejects wrong tokens, chains, and unsafe clocks", async () => {
    const bid = record({
      state: createOrderState({
        orderId,
        createdAt: now - 100,
        expiresAt: now + 9 * 86_400,
        side: "buy",
        chainId,
        baseToken: ZNN_ZTS,
        quoteToken: QSR_ZTS,
        amount: "1000",
        price: "2000000"
      })
    });
    const bidSession = await createTakerSession({
      order: bid,
      expectedOrderProjectionId: "44".repeat(32),
      expectedOrderRevision: "0",
      market,
      fillBaseAmount: "1000",
      clocks,
      localAddress: takerAddress
    }, entropy());
    expect(bidSession.orderSide).toBe("buy");
    expect(bidSession.terms).toMatchObject({ baseAmount: "1000", quoteAmount: "20" });

    await expect(createTakerSession({
      order: record(),
      expectedOrderProjectionId: "44".repeat(32),
      expectedOrderRevision: "0",
      market: { ...market, quoteToken: `zts1${"q".repeat(22)}` },
      fillBaseAmount: "1000",
      clocks,
      localAddress: takerAddress
    }, entropy())).rejects.toThrow(/assets|market/i);

    await expect(createTakerSession({
      order: record(),
      expectedOrderProjectionId: "44".repeat(32),
      expectedOrderRevision: "0",
      market: { ...market, chainId: "3" },
      fillBaseAmount: "1000",
      clocks,
      localAddress: takerAddress
    }, entropy())).rejects.toThrow(/chain/i);

    await expect(createTakerSession({
      order: record(),
      expectedOrderProjectionId: "44".repeat(32),
      expectedOrderRevision: "0",
      market,
      fillBaseAmount: "1000",
      clocks: { ...clocks, chainNow: now + 121 },
      localAddress: takerAddress
    }, entropy())).rejects.toThrow(/clock/i);
  });

  it.each([
    ["a non-canonical chain ID", { chainId: "01" }],
    ["a non-canonical token standard", { baseToken: ZNN_ZTS.toUpperCase() }],
    ["identical base and quote tokens", { quoteToken: ZNN_ZTS }]
  ] as const)("rejects %s", async (_label, override) => {
    await expect(createTakerSession({
      order: record(),
      expectedOrderProjectionId: "44".repeat(32),
      expectedOrderRevision: "0",
      market: { ...market, ...override },
      fillBaseAmount: "1000",
      clocks,
      localAddress: takerAddress
    }, entropy())).rejects.toThrow(/canonical|differ/i);
  });

  it("rejects a settlement address that is not a canonical Zenon address", async () => {
    for (const localAddress of [
      "",
      "z1qzal6c5s9rjnnxd2z7dvdhjxpmmj4fmw56a0m",
      "0xdeadbeef"
    ]) {
      await expect(createTakerSession({
        order: record(),
        expectedOrderProjectionId: "44".repeat(32),
        expectedOrderRevision: "0",
        market,
        fillBaseAmount: "1000",
        clocks,
        localAddress
      }, entropy())).rejects.toThrow(/canonical Zenon address/i);
    }
  });

  it("rejects invalid all-or-none fills and partial-fill dust", async () => {
    await expect(createTakerSession({
      order: record(),
      expectedOrderProjectionId: "44".repeat(32),
      expectedOrderRevision: "0",
      market,
      fillBaseAmount: "500",
      clocks,
      localAddress: takerAddress
    }, entropy())).rejects.toThrow(/all-or-none/i);

    const partial = record({
      state: {
        ...record().state,
        execution: "partial",
        minimum_fill_amount: "300"
      }
    });
    await expect(createTakerSession({
      order: partial,
      expectedOrderProjectionId: "44".repeat(32),
      expectedOrderRevision: "0",
      market,
      fillBaseAmount: "800",
      clocks,
      localAddress: takerAddress
    }, entropy())).rejects.toThrow(/dust/i);
  });

  it("rejects a session Nostr key equivalent to the maker order authority", async () => {
    const colliding: SessionFactoryEntropy = {
      ...entropy(),
      privateKey: () => hexKey(9)
    };
    await expect(createTakerSession({
      order: record(),
      expectedOrderProjectionId: "44".repeat(32),
      expectedOrderRevision: "0",
      market,
      fillBaseAmount: "1000",
      clocks,
      localAddress: takerAddress
    }, colliding)).rejects.toThrow(/order authority/i);

    await expect(createMakerSession({
      order: record(),
      proposal: await proposal(),
      market,
      clocks,
      localAddress: makerAddress
    }, colliding)).rejects.toThrow(/order authority/i);
  });

  it("rejects maker session keys or addresses that collide with the counterparty", async () => {
    await expect(createMakerSession({
      order: record(),
      proposal: await proposal(),
      market,
      clocks,
      localAddress: makerAddress
    }, entropy())).rejects.toThrow(/collide/i);

    await expect(createMakerSession({
      order: record(),
      proposal: await proposal(),
      market,
      clocks,
      localAddress: takerAddress
    }, entropy(3))).rejects.toThrow(/collides with the counterparty/i);
  });

  it("binds the maker session to the proposal's exact taker address", async () => {
    const relocated = (await wrappedProposal(record(), {
      taker_address: FIXTURE_THIRD_ADDRESS
    })).proposal;
    const session = await createMakerSession({
      order: record(),
      proposal: relocated,
      market,
      clocks,
      localAddress: makerAddress
    }, entropy(3));
    expect(session.privateState.counterpartyAddress).toBe(FIXTURE_THIRD_ADDRESS);
    expect(session.privateState.transcript.choreography.participants.takerAddress)
      .toBe(FIXTURE_THIRD_ADDRESS);
  });

  it("rejects maker HTLC material that does not verify", async () => {
    const broken: SessionFactoryEntropy = {
      ...entropy(3),
      htlcMaterial: async () => ({ preimage, hash: "cc".repeat(32) })
    };
    await expect(createMakerSession({
      order: record(),
      proposal: await proposal(),
      market,
      clocks,
      localAddress: makerAddress
    }, broken)).rejects.toThrow(/HTLC material is invalid/i);
  });

  it("rejects a proposal that expired after it was opened", async () => {
    const opened = await proposal();
    const expired = {
      ...opened,
      message: { ...opened.message, expires_at: now }
    } as VerifiedInitialReserveProposal;
    await expect(createMakerSession({
      order: record(),
      proposal: expired,
      market,
      clocks,
      localAddress: makerAddress
    }, entropy(3))).rejects.toThrow(/verified initial/i);
  });
});
