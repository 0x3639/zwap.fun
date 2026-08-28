import { describe, expect, it } from "vitest";

import { QSR_ZTS, ZNN_ZTS } from "../zenon/types.js";
import {
  createProjectionTemplate,
  parseProjectionEvent,
  type NostrEvent
} from "./events.js";
import { createOrderState, reserveOrder } from "./model.js";

const maker = "a".repeat(64);
const signature = "b".repeat(128);
const orderId = "11111111-1111-4111-8111-111111111111";

function open() {
  return createOrderState({
    orderId,
    createdAt: 1_700_000_000,
    expiresAt: 1_700_003_600,
    side: "sell",
    chainId: "1",
    baseToken: ZNN_ZTS,
    quoteToken: QSR_ZTS,
    amount: "100",
    price: "200000000"
  });
}

async function signed(
  state = open(),
  id = "c".repeat(64),
  createdAt = state.created_at
): Promise<NostrEvent> {
  return {
    ...await createProjectionTemplate(state, maker, createdAt),
    id,
    pubkey: maker,
    sig: signature
  };
}

describe("order projection events", () => {
  it("publishes the complete v1 state in one parameterized replaceable event", async () => {
    const state = open();
    const projection = await createProjectionTemplate(state, maker);

    expect(projection.kind).toBe(30078);
    expect(projection.tags).toEqual(expect.arrayContaining([
      ["d", `zwap:order:v1:${orderId}`],
      ["t", "zwap-order"],
      ["v", "1"],
      ["s", "open"],
      ["side", "sell"],
      ["chain", "1"]
    ]));
    expect(projection.tags.some((tag) => tag[0] === "e")).toBe(false);
    expect(JSON.parse(projection.content)).toEqual(state);
    expect(JSON.parse(projection.content)).not.toHaveProperty("head");
  });

  it("keeps the same d tag while event ID and revision change", async () => {
    const initial = await signed();
    const reservedState = reserveOrder(open(), {
      reservationId: "22222222-2222-4222-8222-222222222222",
      amount: "100",
      acceptedAt: 1_700_000_001,
      expiresAt: 1_700_000_600,
      proposalEventId: "d".repeat(64),
      takerCommitment: "e".repeat(64)
    });
    const reserved = await signed(
      reservedState,
      "f".repeat(64),
      reservedState.reservation!.accepted_at
    );

    expect(reserved.id).not.toBe(initial.id);
    expect(reservedState.revision).toBe("1");
    expect(reserved.tags.find((tag) => tag[0] === "d")).toEqual(
      initial.tags.find((tag) => tag[0] === "d")
    );
  });

  it("parses a signed canonical projection as authoritative current state", async () => {
    const event = await signed();
    await expect(parseProjectionEvent(event, () => true)).resolves.toEqual({
      address: `30078:${maker}:zwap:order:v1:${orderId}`,
      eventId: event.id,
      makerPubkey: maker,
      verified: true,
      state: open()
    });
  });

  it("rejects predecessor chains, embedded heads, and noncanonical state", async () => {
    const event = await signed();
    await expect(parseProjectionEvent({
      ...event,
      tags: [...event.tags, ["e", "d".repeat(64)]]
    }, () => true)).rejects.toThrow(/predecessor/i);

    await expect(parseProjectionEvent({
      ...event,
      content: JSON.stringify({ ...open(), head: "d".repeat(64) })
    }, () => true)).rejects.toThrow(/canonical/i);

    await expect(parseProjectionEvent({
      ...event,
      content: JSON.stringify({ ...open(), revision: "01" })
    }, () => true)).rejects.toThrow(/canonical/i);
  });

  it("rejects a mismatched chain tag", async () => {
    const event = await signed();
    await expect(parseProjectionEvent({
      ...event,
      tags: event.tags.map((tag) => (tag[0] === "chain" ? ["chain", "2"] : tag))
    }, () => true)).rejects.toThrow(/chain/i);
  });

  it("rejects invalid signatures and mismatched indexes", async () => {
    const event = await signed();
    await expect(parseProjectionEvent(event, () => false))
      .rejects.toThrow(/signature/i);
    await expect(parseProjectionEvent({
      ...event,
      tags: event.tags.map((tag) =>
        tag[0] === "s" ? ["s", "filled"] : tag
      )
    }, () => true)).rejects.toThrow(/status/i);
  });
});
