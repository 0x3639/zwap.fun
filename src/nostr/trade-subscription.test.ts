import { describe, expect, it, vi } from "vitest";
import { finalizeEvent, getPublicKey, verifyEvent } from "nostr-tools";

import type { NostrEvent } from "../order/events.js";
import {
  startTradeSubscription,
  type StartTradeSubscriptionInput,
  type TradeSubscriptionCallbacks,
  type TradeSubscriptionError,
  type TradeSubscriptionRelayPort
} from "./trade-subscription.js";

const key = (last: number): Uint8Array => {
  const bytes = new Uint8Array(32);
  bytes[31] = last;
  return bytes;
};

const recipientKey = key(1);
const recipientPubkey = getPublicKey(recipientKey);
const since = 1_800_000_000;

const senderKey = key(2);

/** A gift wrap the port would actually accept: signed, tagged and unexpired. */
function wrapper(seed: string, createdAt = since): NostrEvent {
  return finalizeEvent({
    kind: 1059,
    created_at: createdAt,
    tags: [["p", recipientPubkey], ["expiration", String(since + 3_600)]],
    content: `ciphertext:${seed}`
  }, senderKey) as NostrEvent;
}

/** Same shape, but nothing signed it. */
function forged(overrides: Partial<NostrEvent> = {}): NostrEvent {
  return {
    ...wrapper("forged"),
    sig: "33".repeat(64),
    ...overrides
  };
}

interface RecordedSubscription {
  relay: string;
  filter: Record<string, unknown>;
  auth: (challenge: string) => Promise<NostrEvent>;
  callbacks: TradeSubscriptionCallbacks;
  close: ReturnType<typeof vi.fn>;
}

class FakeRelayPort implements TradeSubscriptionRelayPort {
  readonly subscriptions: RecordedSubscription[] = [];
  failRelay: string | null = null;
  failureMessage = "connection failed";

  async subscribe(
    relay: string,
    filter: Record<string, unknown>,
    auth: (challenge: string) => Promise<NostrEvent>,
    callbacks: TradeSubscriptionCallbacks
  ) {
    if (relay === this.failRelay) throw new Error(this.failureMessage);
    const close = vi.fn();
    this.subscriptions.push({ relay, filter, auth, callbacks, close });
    return { close };
  }
}

function input(
  port: TradeSubscriptionRelayPort,
  callbacks: Partial<
    Pick<StartTradeSubscriptionInput, "onEvent" | "onError">
  > = {}
): StartTradeSubscriptionInput {
  return {
    recipientPubkey,
    recipientSecretKey: recipientKey,
    inboxRelays: ["wss://b.example/", "wss://a.example"],
    cursor: { since },
    port,
    now: () => since + 10,
    onEvent: callbacks.onEvent ?? vi.fn(),
    onError: callbacks.onError ?? vi.fn()
  };
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("live trade inbox subscription", () => {
  it("opens one exact authenticated persistent filter per canonical relay", async () => {
    const port = new FakeRelayPort();
    const subscription = await startTradeSubscription(input(port));

    expect(port.subscriptions.map(({ relay }) => relay)).toEqual([
      "wss://a.example",
      "wss://b.example"
    ]);
    for (const opened of port.subscriptions) {
      expect(opened.filter).toEqual({
        kinds: [1059],
        "#p": [recipientPubkey],
        since
      });
      const auth = await opened.auth("challenge");
      expect(auth.kind).toBe(22242);
      expect(auth.pubkey).toBe(recipientPubkey);
      expect(auth.tags).toContainEqual(["relay", opened.relay]);
      expect(auth.tags).toContainEqual(["challenge", "challenge"]);
      expect(verifyEvent(auth)).toBe(true);
    }
    expect(subscription.restart).toEqual({
      recipientPubkey,
      inboxRelays: ["wss://a.example", "wss://b.example"],
      cursor: { since }
    });
  });

  it("rejects invalid identity, cursor, and relay configuration before subscribing", async () => {
    const port = new FakeRelayPort();
    await expect(startTradeSubscription({
      ...input(port),
      recipientPubkey: "44".repeat(32)
    })).rejects.toThrow(/exact recipient/i);
    await expect(startTradeSubscription({
      ...input(port),
      cursor: { since: -1 }
    })).rejects.toThrow(/cursor/i);
    await expect(startTradeSubscription({
      ...input(port),
      inboxRelays: []
    })).rejects.toThrow(/1-3 relays/i);
    await expect(startTradeSubscription({
      ...input(port),
      inboxRelays: ["wss://a.example", "wss://a.example/"]
    })).rejects.toThrow(/duplicate/i);
    expect(port.subscriptions).toHaveLength(0);
  });

  it("deduplicates relay replays and serializes event processing", async () => {
    const port = new FakeRelayPort();
    const first = wrapper("44".repeat(32));
    const second = wrapper("55".repeat(32), since + 1);
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const started: string[] = [];
    let active = 0;
    let maximumActive = 0;
    const subscription = await startTradeSubscription({
      ...input(port),
      onEvent: async (event) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        started.push(event.id);
        if (event.id === first.id) await firstGate;
        active -= 1;
      }
    });

    port.subscriptions[0]!.callbacks.onevent(first);
    port.subscriptions[1]!.callbacks.onevent(first);
    port.subscriptions[1]!.callbacks.onevent(second);

    await vi.waitFor(() => expect(started).toEqual([first.id]));
    expect(maximumActive).toBe(1);
    releaseFirst();
    await vi.waitFor(() => expect(started).toEqual([first.id, second.id]));
    expect(maximumActive).toBe(1);

    subscription.stop();
    port.subscriptions[0]!.callbacks.onevent(wrapper("66".repeat(32)));
    await Promise.resolve();
    expect(started).toEqual([first.id, second.id]);
  });

  it("surfaces sanitized relay and event failures without stopping other relays", async () => {
    const secretText = hex(recipientKey);
    const port = new FakeRelayPort();
    const errors: TradeSubscriptionError[] = [];
    const subscription = await startTradeSubscription({
      ...input(port),
      onEvent: async () => {
        throw new Error(`event leaked ${secretText}`);
      },
      onError: (error) => errors.push(error)
    });

    port.subscriptions[0]!.callbacks.onevent(wrapper("77".repeat(32)));
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    port.subscriptions[0]!.callbacks.onclose(`relay leaked ${secretText}`);
    await vi.waitFor(() => expect(errors).toHaveLength(2));

    expect(errors.map(({ kind }) => kind)).toEqual([
      "event_callback",
      "relay_closed"
    ]);
    expect(JSON.stringify(errors)).not.toContain(secretText);

    port.subscriptions[1]!.callbacks.onevent(wrapper("88".repeat(32)));
    await vi.waitFor(() => expect(errors).toHaveLength(3));
    subscription.stop();
  });

  it("cleans up a partial start and never reports an underlying secret-bearing error", async () => {
    const secretText = hex(recipientKey);
    const port = new FakeRelayPort();
    port.failRelay = "wss://b.example";
    port.failureMessage = `failed with ${secretText}`;
    const errors: TradeSubscriptionError[] = [];

    await expect(startTradeSubscription({
      ...input(port),
      onError: (error) => errors.push(error)
    })).rejects.toThrow("Inbox relay subscription failed");

    expect(port.subscriptions).toHaveLength(1);
    expect(port.subscriptions[0]!.close).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(errors)).not.toContain(secretText);
  });

  it("stops idempotently, closes every relay, and zeroizes its retained key copy", async () => {
    const originalFrom = Uint8Array.from.bind(Uint8Array);
    const keyCopies: Uint8Array[] = [];
    const from = vi.spyOn(Uint8Array, "from").mockImplementation((value) => {
      const copy = originalFrom(value);
      if (copy.length === 32) keyCopies.push(copy);
      return copy;
    });
    const port = new FakeRelayPort();
    const mutableKey = key(1);
    const subscription = await startTradeSubscription({
      ...input(port),
      recipientSecretKey: mutableKey
    });
    from.mockRestore();

    expect(keyCopies).toHaveLength(1);
    expect(keyCopies[0]!.some((byte) => byte !== 0)).toBe(true);
    mutableKey.fill(0);
    const lateAuth = await port.subscriptions[0]!.auth("late challenge");
    expect(lateAuth.pubkey).toBe(recipientPubkey);

    subscription.stop();
    subscription.stop();
    expect(port.subscriptions.every(({ close }) =>
      close.mock.calls.length === 1
    )).toBe(true);
    expect(keyCopies[0]).toEqual(new Uint8Array(32));
  });
  it("rejects an unsigned gift wrap before it can enter the dedup set", async () => {
    // Validation has to come first: a forged event carrying the id of a real
    // one would otherwise claim that id in `seen` and suppress the real
    // delivery when it arrives.
    const port = new FakeRelayPort();
    const genuine = wrapper("99".repeat(32));
    const delivered: string[] = [];
    const errors: TradeSubscriptionError[] = [];
    const subscription = await startTradeSubscription({
      ...input(port),
      onEvent: async (event) => {
        delivered.push(event.id);
      },
      onError: (error) => errors.push(error)
    });

    port.subscriptions[0]!.callbacks.onevent(forged({ id: genuine.id }));
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    port.subscriptions[0]!.callbacks.onevent(genuine);
    await vi.waitFor(() => expect(delivered).toEqual([genuine.id]));

    expect(errors.map(({ kind }) => kind)).toEqual(["event_rejected"]);
    expect(errors[0]!.relay).toBe("wss://a.example");
    subscription.stop();
  });

  it("rejects an oversized gift wrap before it is remembered or queued", async () => {
    const port = new FakeRelayPort();
    const delivered: string[] = [];
    const errors: TradeSubscriptionError[] = [];
    const subscription = await startTradeSubscription({
      ...input(port),
      onEvent: async (event) => { delivered.push(event.id); },
      onError: (error) => errors.push(error)
    });

    const oversized = finalizeEvent({
      kind: 1059,
      created_at: since,
      tags: [["p", recipientPubkey], ["expiration", String(since + 3_600)]],
      content: "x".repeat(32 * 1024 + 1)
    }, senderKey) as NostrEvent;
    port.subscriptions[0]!.callbacks.onevent(oversized);

    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0]!.kind).toBe("event_rejected");
    expect(delivered).toEqual([]);
    subscription.stop();
  });

  it("bounds the dedup cache instead of remembering every id forever", async () => {
    const port = new FakeRelayPort();
    const delivered: string[] = [];
    const subscription = await startTradeSubscription({
      ...input(port),
      limits: { dedup: 2 },
      onEvent: async (event) => { delivered.push(event.id); }
    });
    const [first, second, third] = [wrapper("a"), wrapper("b"), wrapper("c")];

    port.subscriptions[0]!.callbacks.onevent(first);
    port.subscriptions[0]!.callbacks.onevent(first);
    port.subscriptions[0]!.callbacks.onevent(second);
    port.subscriptions[0]!.callbacks.onevent(third);
    // `first` was evicted by the two newer ids, so a replay delivers again -
    // bounded memory is the property; the transcript layer discards replays.
    port.subscriptions[0]!.callbacks.onevent(first);

    await vi.waitFor(() => expect(delivered).toEqual(
      [first.id, second.id, third.id, first.id]
    ));
    subscription.stop();
  });

  it("drops events beyond the queue bound instead of queueing without limit", async () => {
    const port = new FakeRelayPort();
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const delivered: string[] = [];
    const errors: TradeSubscriptionError[] = [];
    const subscription = await startTradeSubscription({
      ...input(port),
      limits: { queue: 1 },
      onEvent: async (event) => {
        delivered.push(event.id);
        if (delivered.length === 1) await firstGate;
      },
      onError: (error) => errors.push(error)
    });
    const [first, second, third] = [wrapper("d"), wrapper("e"), wrapper("f")];

    port.subscriptions[0]!.callbacks.onevent(first);
    port.subscriptions[0]!.callbacks.onevent(second);
    port.subscriptions[0]!.callbacks.onevent(third);

    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0]!.kind).toBe("event_dropped");
    releaseFirst();
    await vi.waitFor(() => expect(delivered).toEqual([first.id, second.id]));
    subscription.stop();
  });

  it("rejects a gift wrap addressed elsewhere, of the wrong kind, or expired", async () => {
    const port = new FakeRelayPort();
    const onEvent = vi.fn();
    const errors: TradeSubscriptionError[] = [];
    const subscription = await startTradeSubscription({
      ...input(port),
      onEvent,
      onError: (error) => errors.push(error)
    });

    for (const bad of [
      finalizeEvent({
        kind: 1059,
        created_at: since,
        tags: [["p", "44".repeat(32)], ["expiration", String(since + 3_600)]],
        content: "elsewhere"
      }, senderKey) as NostrEvent,
      finalizeEvent({
        kind: 1,
        created_at: since,
        tags: [["p", recipientPubkey], ["expiration", String(since + 3_600)]],
        content: "wrong kind"
      }, senderKey) as NostrEvent,
      finalizeEvent({
        kind: 1059,
        created_at: since,
        tags: [["p", recipientPubkey], ["expiration", String(since + 5)]],
        content: "already expired"
      }, senderKey) as NostrEvent
    ]) port.subscriptions[0]!.callbacks.onevent(bad);

    await vi.waitFor(() => expect(errors).toHaveLength(3));
    expect(errors.every(({ kind }) => kind === "event_rejected")).toBe(true);
    expect(onEvent).not.toHaveBeenCalled();
    subscription.stop();
  });
});
