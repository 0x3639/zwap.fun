import { nip19 } from "nostr-tools";
import { describe, expect, it } from "vitest";

import type { PublicTradeView, TradeLegEvidence } from "../trade/session.js";
import { QSR_ZTS, ZNN_ZTS } from "../zenon/types.js";
import { renderTrades } from "./trades.js";
import { tokenDirectory } from "./tokens.js";

function leg(overrides: Partial<TradeLegEvidence> = {}): TradeLegEvidence {
  return {
    htlcId: "55".repeat(32),
    validationCommitment: "66".repeat(32),
    htlcState: "LOCKED",
    observedAt: 1_700_000_009,
    spendCommitment: null,
    claimOperationCommitment: null,
    refundOperationCommitment: null,
    ...overrides
  };
}

const trade: PublicTradeView = {
  revision: 0,
  sessionId: "11".repeat(32),
  reservationId: "11111111-1111-4111-8111-111111111111",
  role: "taker",
  phase: "quote_locked",
  orderAddress: `30078:${"22".repeat(32)}:zwap:order:v1:22222222-2222-4222-8222-222222222222`,
  offeredProjectionId: "33".repeat(32),
  offeredProjectionRevision: "0",
  reserveProjectionId: "44".repeat(32),
  reserveProjectionRevision: "1",
  fillProjectionId: null,
  fillProjectionRevision: null,
  pendingOrderPublication: null,
  createdAt: 1_700_000_000,
  updatedAt: 1_700_000_010,
  protocol: {
    localNostrPubkey: null,
    orderAuthorityPubkey: "22".repeat(32),
    counterpartyNostrPubkey: "aa".repeat(32),
    inbox: {
      status: "registered",
      registrationEventId: "bb".repeat(32),
      relayCount: 3,
      acknowledgements: 3
    },
    messages: []
  },
  terms: {
    chainId: "1",
    baseToken: ZNN_ZTS,
    baseAmount: "2000000000",
    quoteToken: QSR_ZTS,
    quoteAmount: "700000000",
    price: "35000000"
  },
  plan: {
    anchor: 1_700_000_000,
    shortLocktime: 1_700_000_600,
    makerClaimCutoff: 1_700_000_480,
    longLocktime: 1_700_001_200,
    takerClaimCutoff: 1_700_001_080,
    reservationExpiresAt: 1_700_001_800,
    refundGuardSeconds: 60
  },
  evidence: {
    makerPubkey: "22".repeat(32),
    commitments: ["44".repeat(32)],
    chainStates: ["base:LOCKED", "quote:LOCKED"],
    reserveProjectionId: "44".repeat(32),
    reserveProjectionRevision: "1",
    fillProjectionId: null,
    fillProjectionRevision: null,
    reservation: {
      proposalSealId: "99".repeat(32),
      takerCommitment: "aa".repeat(32),
      abortSealId: null
    },
    legs: {
      base: leg(),
      quote: leg({ htlcId: "77".repeat(32), validationCommitment: "88".repeat(32) })
    }
  }
};

function withLegs(
  base: Partial<TradeLegEvidence>,
  quote: Partial<TradeLegEvidence> = {}
): PublicTradeView {
  return {
    ...trade,
    evidence: {
      ...trade.evidence,
      legs: {
        base: leg(base),
        quote: leg({ htlcId: "77".repeat(32), ...quote })
      }
    }
  };
}

describe("trade session presentation", () => {
  it("renders an honest empty state", () => {
    const root = document.createElement("section");
    renderTrades(root, []);

    expect(root.textContent).toContain("No active swap sessions");
  });

  it("shows both legs at exact token precision without secrets", () => {
    const root = document.createElement("section");
    renderTrades(root, [trade]);

    expect(root.textContent).toContain("Quote locked");
    expect(root.querySelector('[data-trade-leg="base"]')?.textContent)
      .toContain("20.00000000");
    expect(root.querySelector('[data-trade-leg="base"]')?.textContent).toContain("ZNN");
    expect(root.querySelector('[data-trade-leg="quote"]')?.textContent)
      .toContain("7.00000000");
    expect(root.querySelector('[data-trade-leg="quote"]')?.textContent).toContain("QSR");
    expect(root.querySelector("[data-trade-price]")?.textContent).toBe("0.35 QSR/ZNN");
    expect(root.querySelector("[data-advance-trade]")).toBeNull();
    expect(root.innerHTML).not.toContain("privateState");
    expect(root.innerHTML).not.toContain("preimage");
  });

  it("reads token symbols and decimals from observed chain balances", () => {
    const root = document.createElement("section");
    renderTrades(root, [trade], {
      tokens: tokenDirectory([
        { tokenStandard: ZNN_ZTS, symbol: "ZNN", decimals: 8, balance: "0" },
        { tokenStandard: QSR_ZTS, symbol: "QSR", decimals: 8, balance: "0" }
      ])
    });

    expect(root.querySelector('[data-trade-leg="quote"]')?.textContent)
      .toContain("7.00000000 QSR");
  });

  it("renders HTLC ids truncated and mono with the full id on hover", () => {
    const root = document.createElement("section");
    renderTrades(root, [trade]);

    const htlc = root.querySelector<HTMLElement>('[data-trade-leg="base"] [data-htlc-id]');
    expect(htlc?.textContent).toBe("55555555…55555555");
    expect(htlc?.title).toBe("55".repeat(32));
    expect(htlc?.className).toContain("font-mono");
  });

  it("says a leg has no HTLC yet rather than rendering an empty hash", () => {
    const root = document.createElement("section");
    renderTrades(root, [withLegs({ htlcId: null, htlcState: "UNKNOWN" })]);

    expect(root.querySelector('[data-trade-leg="base"] [data-htlc-id]')?.textContent)
      .toBe("not created");
  });

  it.each([
    ["LOCKED", "Locked", "nom-badge--pending"],
    ["UNKNOWN", "Awaiting chain", "nom-badge--pending"],
    ["UNLOCKED", "Unlocked", "nom-badge--success"],
    ["RECLAIMED", "Reclaimed", "nom-badge--warning"]
  ] as const)("badges a %s leg as %s", (htlcState, label, variant) => {
    const root = document.createElement("section");
    renderTrades(root, [withLegs({ htlcState })]);

    const badge = root.querySelector<HTMLElement>('[data-trade-leg="base"] .nom-badge');
    expect(badge?.textContent).toBe(label);
    expect(badge?.className).toContain(variant);
  });

  it("shows a refunded leg as refunded even while the lock still reads LOCKED", () => {
    const root = document.createElement("section");
    renderTrades(root, [withLegs({
      htlcState: "LOCKED",
      refundOperationCommitment: "cc".repeat(32)
    })]);

    const badge = root.querySelector<HTMLElement>('[data-trade-leg="base"] .nom-badge');
    expect(badge?.textContent).toBe("Refunded");
    expect(badge?.className).toContain("nom-badge--warning");
  });

  it("truncates the counterparty key with the full value on hover", () => {
    const root = document.createElement("section");
    const counterparty = "aa".repeat(32);
    renderTrades(root, [trade]);

    const npub = nip19.npubEncode(counterparty);
    const rendered = [...root.querySelectorAll<HTMLElement>(".trade-protocol-summary strong")]
      .find((node) => node.title === npub);
    expect(rendered?.textContent).toBe(`${npub.slice(0, 6)}…${npub.slice(-4)}`);
    expect(rendered?.className).toContain("font-mono");
  });

  it("keeps maker and taker sessions visibly distinct on the shared page", () => {
    const root = document.createElement("section");
    renderTrades(root, [
      trade,
      { ...trade, sessionId: "aa".repeat(32), role: "maker" }
    ]);

    expect(root.querySelectorAll("[data-trade-role='taker']")).toHaveLength(1);
    expect(root.querySelectorAll("[data-trade-role='maker']")).toHaveLength(1);
    expect(root.textContent).toContain("Taker session");
    expect(root.textContent).toContain("Maker session");
  });

  it("opens the accepted DM count as a readable redacted transcript", () => {
    const root = document.createElement("section");
    const local = "cc".repeat(32);
    renderTrades(root, [{
      ...trade,
      protocol: {
        ...trade.protocol,
        localNostrPubkey: local,
        messages: [{
          sequence: "0",
          messageId: "01".repeat(32),
          rumorId: "02".repeat(32),
          transcriptHash: "03".repeat(32),
          type: "reserve_propose",
          authorPubkey: "aa".repeat(32),
          recipientPubkey: local
        }, {
          sequence: "1",
          messageId: "04".repeat(32),
          rumorId: "05".repeat(32),
          transcriptHash: "06".repeat(32),
          type: "quote_lock",
          authorPubkey: local,
          recipientPubkey: "aa".repeat(32)
        }]
      }
    }]);

    const trigger = root.querySelector<HTMLButtonElement>(".trade-dms-trigger");
    const dialog = root.querySelector<HTMLDialogElement>(".trade-dm-dialog");
    expect(trigger?.textContent).toContain("2 accepted");
    expect(trigger?.getAttribute("aria-haspopup")).toBe("dialog");

    trigger?.click();

    expect(dialog?.hasAttribute("open")).toBe(true);
    expect(dialog?.textContent).toContain("Order taken");
    expect(dialog?.textContent).toContain("Received by you");
    expect(dialog?.textContent).toContain("Payment locked");
    expect(dialog?.textContent).toContain(
      "The chain now drives settlement — an unlock on the quote HTLC reveals the preimage."
    );
    expect(dialog?.textContent).toContain("Sent by you");
    expect(dialog?.textContent).toContain(nip19.npubEncode(local));

    dialog?.querySelector<HTMLButtonElement>(".trade-dm-dialog__close")?.click();
    expect(dialog?.hasAttribute("open")).toBe(false);
  });

  it("carries no emoji", () => {
    const root = document.createElement("section");
    renderTrades(root, [trade]);

    expect(root.textContent ?? "").not.toMatch(/\p{Extended_Pictographic}/u);
  });
});
