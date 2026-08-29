import { describe, expect, it, vi } from "vitest";
import { finalizeEvent, getPublicKey, type EventTemplate } from "nostr-tools";

import type { NostrEvent } from "../order/events.js";
import { createNip42AuthEvent } from "./inbox.js";
import { NostrToolsInboxRelayPort, type InboxRelayConnection } from "./inbox-relay.js";

const key = (last: number): Uint8Array => {
  const bytes = new Uint8Array(32);
  bytes[31] = last;
  return bytes;
};

const protocolKey = key(1);
const protocolPubkey = getPublicKey(protocolKey);
const now = 1_800_000_000;
const relayUrl = "wss://auth.example/path";

function event(): NostrEvent {
  return finalizeEvent({ kind: 1059, created_at: now, tags: [["p", protocolPubkey]], content: "ciphertext" }, key(2));
}

class FakeConnection implements InboxRelayConnection {
  onauth: ((template: EventTemplate) => Promise<NostrEvent>) | undefined;
  published: NostrEvent[] = [];
  authPubkeys: string[] = [];

  async auth(signer: (template: EventTemplate) => Promise<NostrEvent>): Promise<string> {
    const auth = await signer({
      kind: 22242,
      created_at: now,
      tags: [["relay", relayUrl], ["challenge", "relay-challenge"]],
      content: ""
    });
    this.authPubkeys.push(auth.pubkey);
    return "authenticated";
  }

  async publish(value: NostrEvent): Promise<string> {
    this.published.push(value);
    return "stored";
  }

  subscribe(
    _filters: Record<string, unknown>[],
    callbacks: { onevent: (value: NostrEvent) => void; oneose: () => void; onclose: (reason: string) => void }
  ): { close(reason?: string): void } {
    queueMicrotask(() => {
      callbacks.onevent(event());
      callbacks.oneose();
    });
    return { close: vi.fn() };
  }

  close(): void {}
}

describe("nostr-tools inbox relay port", () => {
  it("calls the browser fetch implementation with the Window receiver", async () => {
    const receiver = vi.fn();
    vi.stubGlobal("fetch", function (
      this: unknown,
      _input: RequestInfo | URL,
      _init?: RequestInit
    ): Promise<Response> {
      receiver(this);
      return Promise.resolve(new Response(JSON.stringify({
        supported_nips: [17, 40, 42],
        limitation: { auth_required: true }
      }), { status: 200 }));
    });
    try {
      const port = new NostrToolsInboxRelayPort(
        async () => new FakeConnection()
      );
      await port.info(relayUrl);
      expect(receiver).toHaveBeenCalledWith(globalThis);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reads NIP-11 capabilities and authenticates publish/query with the supplied key", async () => {
    const connection = new FakeConnection();
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      supported_nips: [17, 40, 42],
      limitation: { auth_required: true }
    }), { status: 200 }));
    const port = new NostrToolsInboxRelayPort(
      async () => connection,
      fetcher,
      1_000
    );
    const auth = async (challenge: string) =>
      createNip42AuthEvent(relayUrl, challenge, protocolKey, now);

    await expect(port.info(relayUrl)).resolves.toEqual({
      supportedNips: [17, 40, 42],
      authRequired: true
    });
    await expect(port.publish(relayUrl, event(), auth)).resolves.toBe("stored");
    await expect(port.query(relayUrl, { kinds: [1059] }, auth)).resolves.toHaveLength(1);

    expect(fetcher).toHaveBeenCalledWith("https://auth.example/path", expect.objectContaining({
      headers: { Accept: "application/nostr+json" }
    }));
    expect(connection.authPubkeys).toEqual([protocolPubkey, protocolPubkey]);
  });

  it("rejects an AUTH template without an exact challenge", async () => {
    class MissingChallengeConnection extends FakeConnection {
      override async auth(signer: (template: EventTemplate) => Promise<NostrEvent>): Promise<string> {
        await signer({ kind: 22242, created_at: now, tags: [], content: "" });
        return "unreachable";
      }
    }
    const port = new NostrToolsInboxRelayPort(
      async () => new MissingChallengeConnection(),
      async () => new Response(JSON.stringify({
        supported_nips: [17, 40, 42],
        limitation: { auth_required: true }
      }), { status: 200 }),
      1_000
    );

    await expect(port.publish(relayUrl, event(), async (challenge) =>
      createNip42AuthEvent(relayUrl, challenge, protocolKey, now)))
      .rejects.toThrow(/challenge/i);
  });

  it("waits for a challenge that arrives just after connect before publishing", async () => {
    class DelayedChallengeConnection extends FakeConnection {
      challenged = false;

      override async auth(signer: (template: EventTemplate) => Promise<NostrEvent>): Promise<string> {
        const template: EventTemplate = {
          kind: 22242,
          created_at: now,
          tags: [["relay", relayUrl], ["challenge", "delayed-challenge"]],
          content: ""
        };
        if (!this.challenged) {
          queueMicrotask(() => {
            this.challenged = true;
            void this.onauth?.(template);
          });
          throw new Error("can't perform auth, no challenge was received");
        }
        return super.auth(signer);
      }
    }
    const connection = new DelayedChallengeConnection();
    const port = new NostrToolsInboxRelayPort(
      async () => connection,
      async () => new Response(JSON.stringify({
        supported_nips: [17, 40, 42],
        limitation: { auth_required: true }
      }), { status: 200 }),
      1_000
    );

    await expect(port.publish(relayUrl, event(), async (challenge) =>
      createNip42AuthEvent(relayUrl, challenge, protocolKey, now)))
      .resolves.toBe("stored");
    expect(connection.challenged).toBe(true);
  });

  it("keeps an authenticated inbox subscription open after EOSE until explicitly closed", async () => {
    class PersistentConnection extends FakeConnection {
      closed = false;
      subscriptionClosed = false;
      callbacks:
        | {
            onevent: (value: NostrEvent) => void;
            oneose: () => void;
            onclose: (reason: string) => void;
          }
        | undefined;

      override subscribe(
        _filters: Record<string, unknown>[],
        callbacks: {
          onevent: (value: NostrEvent) => void;
          oneose: () => void;
          onclose: (reason: string) => void;
        }
      ) {
        this.callbacks = callbacks;
        return {
          close: () => {
            this.subscriptionClosed = true;
          }
        };
      }

      override close(): void {
        this.closed = true;
      }
    }

    const connection = new PersistentConnection();
    const port = new NostrToolsInboxRelayPort(
      async () => connection,
      async () => new Response(JSON.stringify({
        supported_nips: [17, 40, 42],
        limitation: { auth_required: true }
      }), { status: 200 }),
      1_000
    );
    const received: string[] = [];
    const closed: string[] = [];
    const subscription = await port.subscribe(
      relayUrl,
      { kinds: [1059], "#p": [protocolPubkey], since: now },
      async (challenge) => createNip42AuthEvent(relayUrl, challenge, protocolKey, now),
      {
        onevent: (value) => received.push(value.id),
        onclose: (reason) => closed.push(reason)
      }
    );

    connection.callbacks?.oneose();
    connection.callbacks?.onevent(event());
    expect(received).toEqual([event().id]);
    expect(connection.closed).toBe(false);
    expect(connection.subscriptionClosed).toBe(false);

    subscription.close("test complete");
    expect(connection.subscriptionClosed).toBe(true);
    expect(connection.closed).toBe(true);
    expect(closed).toEqual([]);
  });

  it("closes the connection and reports an unexpected persistent subscription failure once", async () => {
    class ClosingConnection extends FakeConnection {
      closed = false;
      callbacks:
        | {
            onevent: (value: NostrEvent) => void;
            oneose: () => void;
            onclose: (reason: string) => void;
          }
        | undefined;

      override subscribe(
        _filters: Record<string, unknown>[],
        callbacks: {
          onevent: (value: NostrEvent) => void;
          oneose: () => void;
          onclose: (reason: string) => void;
        }
      ) {
        this.callbacks = callbacks;
        return { close: vi.fn() };
      }

      override close(): void {
        this.closed = true;
      }
    }

    const connection = new ClosingConnection();
    const port = new NostrToolsInboxRelayPort(
      async () => connection,
      async () => new Response(JSON.stringify({
        supported_nips: [17, 40, 42],
        limitation: { auth_required: true }
      }), { status: 200 }),
      1_000
    );
    const closed: string[] = [];
    await port.subscribe(
      relayUrl,
      { kinds: [1059], "#p": [protocolPubkey], since: now },
      async (challenge) => createNip42AuthEvent(relayUrl, challenge, protocolKey, now),
      { onevent: vi.fn(), onclose: (reason) => closed.push(reason) }
    );

    connection.callbacks?.onclose("relay unavailable");
    connection.callbacks?.onclose("duplicate close");
    expect(connection.closed).toBe(true);
    expect(closed).toEqual(["relay unavailable"]);
  });
  /** A fetch that never settles on its own; only the abort signal ends it. */
  function stalledFetch(stage: "headers" | "body") {
    return vi.fn(async (
      _input: RequestInfo | URL,
      init?: RequestInit
    ): Promise<Response> => {
      const signal = init?.signal;
      const aborted = new Promise<never>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason));
      });
      if (stage === "headers") return aborted;
      return {
        ok: true,
        status: 200,
        json: async () => aborted
      } as unknown as Response;
    });
  }

  it.each(["headers", "body"] as const)(
    "aborts a NIP-11 request stalled at the %s at the query timeout",
    async (stage) => {
      vi.useFakeTimers();
      try {
        const fetcher = stalledFetch(stage);
        const port = new NostrToolsInboxRelayPort(
          async () => new FakeConnection(),
          fetcher,
          8_000
        );

        const pending = port.info(relayUrl);
        const settled = vi.fn();
        void pending.then(settled, settled);

        await vi.advanceTimersByTimeAsync(7_999);
        expect(settled).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);
        await expect(pending).rejects.toThrow(/NIP-11 request timed out/);
        expect(fetcher.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
      } finally {
        vi.useRealTimers();
      }
    }
  );

  it("bounds publish on a relay whose NIP-11 document never arrives", async () => {
    // Without this, `open()` blocks before any publish/query/subscribe timeout
    // has started, so the caller waits forever.
    vi.useFakeTimers();
    try {
      const port = new NostrToolsInboxRelayPort(
        async () => new FakeConnection(),
        stalledFetch("headers"),
        8_000
      );
      const auth = async (challenge: string) =>
        createNip42AuthEvent(relayUrl, challenge, protocolKey, now);

      const pending = port.publish(relayUrl, event(), auth);
      void pending.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(8_000);

      await expect(pending).rejects.toThrow(/NIP-11 request timed out/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not leave the timeout armed after a successful NIP-11 read", async () => {
    vi.useFakeTimers();
    try {
      const port = new NostrToolsInboxRelayPort(
        async () => new FakeConnection(),
        async () => new Response(JSON.stringify({ supported_nips: [17] }), { status: 200 }),
        8_000
      );

      await expect(port.info(relayUrl)).resolves.toEqual({
        supportedNips: [17],
        authRequired: false
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
