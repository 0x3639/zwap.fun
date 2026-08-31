import { safeUnixTimestamp, isHex32 } from "../zenon/validate.js";
import { getPublicKey } from "nostr-tools";

import type { NostrEvent } from "../order/events.js";
import {
  createNip42AuthEvent,
  normalizeInboxListRelays,
  validateGiftWrap,
  type AuthHandler
} from "./inbox.js";
import type { PersistentInboxSubscription } from "./inbox-relay.js";

export interface TradeSubscriptionCallbacks {
  onevent(event: NostrEvent): void;
  onclose(reason: string): void;
}

export interface TradeSubscriptionRelayPort {
  subscribe(
    relay: string,
    filter: Record<string, unknown>,
    auth: AuthHandler,
    callbacks: TradeSubscriptionCallbacks
  ): Promise<PersistentInboxSubscription>;
}

export interface TradeSubscriptionError {
  relay: string;
  kind:
    | "relay_start"
    | "relay_closed"
    | "event_callback"
    | "event_rejected"
    | "event_dropped"
    | "subscription_stop";
  message: string;
}

export interface TradeSubscriptionCursor {
  since: number;
}

export interface TradeSubscriptionRestart {
  recipientPubkey: string;
  inboxRelays: readonly string[];
  cursor: Readonly<TradeSubscriptionCursor>;
}

export interface TradeSubscription {
  /**
   * Non-secret configuration needed to call startTradeSubscription again with
   * the caller's latest durably saved cursor and a freshly supplied key.
   */
  readonly restart: Readonly<TradeSubscriptionRestart>;
  stop(): void;
}

export interface StartTradeSubscriptionInput {
  recipientPubkey: string;
  recipientSecretKey: Uint8Array;
  inboxRelays: readonly string[];
  cursor: TradeSubscriptionCursor;
  /**
   * Memory bounds for a hostile-but-authenticated inbox: how many event ids
   * the replay-dedup cache retains, and how many events may wait behind the
   * in-flight callback before new ones are dropped (and reported). Defaults
   * sit far above any honest volume.
   */
  limits?: { dedup?: number; queue?: number };
  port: TradeSubscriptionRelayPort;
  now(): number;
  onEvent(event: NostrEvent, relay: string): void | Promise<void>;
  onError(error: TradeSubscriptionError): void;
}


const timestamp = safeUnixTimestamp;

function reportSafely(
  callback: (error: TradeSubscriptionError) => void,
  error: TradeSubscriptionError
): void {
  try {
    callback(error);
  } catch {
    // Error reporting must not break subscription cleanup or event ordering.
  }
}

/**
 * Opens the live half of the durable inbox. The caller owns cursor persistence:
 * after a stop or relay failure, call this function again with the last saved
 * `cursor.since` and a newly loaded secret key.
 */
export async function startTradeSubscription(
  input: StartTradeSubscriptionInput
): Promise<TradeSubscription> {
  const retainedKey = Uint8Array.from(input.recipientSecretKey);
  const opened: PersistentInboxSubscription[] = [];
  let stopped = false;
  try {
    if (!isHex32(input.recipientPubkey)) {
      throw new Error("Trade subscription recipient pubkey must be lowercase hex");
    }
    if (
      retainedKey.length !== 32 ||
      getPublicKey(retainedKey) !== input.recipientPubkey
    ) {
      throw new Error("Trade subscription requires the exact recipient key");
    }
    const since = timestamp(input.cursor.since, "Trade subscription cursor");
    const relays = normalizeInboxListRelays(input.inboxRelays);
    const seen = new Set<string>();
    const dedupLimit = input.limits?.dedup ?? 4096;
    const queueLimit = input.limits?.queue ?? 256;
    let queued = 0;
    let eventQueue = Promise.resolve();

    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      for (let index = 0; index < opened.length; index += 1) {
        try {
          opened[index]!.close("zwap trade subscription stopped");
        } catch {
          reportSafely(input.onError, {
            relay: relays[index]!,
            kind: "subscription_stop",
            message: "Inbox relay subscription failed to stop cleanly"
          });
        }
      }
      opened.length = 0;
      seen.clear();
      retainedKey.fill(0);
    };

    for (const relay of relays) {
      try {
        const subscription = await input.port.subscribe(
          relay,
          { kinds: [1059], "#p": [input.recipientPubkey], since },
          async (challenge) => createNip42AuthEvent(
            relay,
            challenge,
            retainedKey,
            timestamp(input.now(), "Trade subscription AUTH time")
          ),
          {
            onevent: (event) => {
              if (stopped) return;
              // Validate before the dedup set, not after: an unsigned event
              // carrying a genuine event's id would otherwise claim that id
              // and silently suppress the real delivery.
              try {
                validateGiftWrap(
                  event,
                  input.recipientPubkey,
                  timestamp(input.now(), "Trade subscription event time")
                );
              } catch {
                reportSafely(input.onError, {
                  relay,
                  kind: "event_rejected",
                  message: "Inbox relay delivered an invalid gift wrap"
                });
                return;
              }
              if (seen.has(event.id)) return;
              seen.add(event.id);
              // Bounded replay memory: evict the oldest id once over the cap.
              // A very old replay may then deliver again - the transcript
              // layer discards it; unbounded growth would not be discarded.
              if (seen.size > dedupLimit) {
                const oldest = seen.values().next().value;
                if (oldest !== undefined) seen.delete(oldest);
              }
              // Backpressure: beyond one in-flight callback plus the queue
              // bound, drop and report rather than queue without limit.
              if (queued > queueLimit) {
                reportSafely(input.onError, {
                  relay,
                  kind: "event_dropped",
                  message: "Trade inbox event dropped: processing queue is full"
                });
                return;
              }
              queued += 1;
              const snapshot = structuredClone(event);
              eventQueue = eventQueue
                .then(async () => {
                  try {
                    if (!stopped) await input.onEvent(snapshot, relay);
                  } finally {
                    queued -= 1;
                  }
                })
                .catch(() => {
                  reportSafely(input.onError, {
                    relay,
                    kind: "event_callback",
                    message: "Trade inbox event callback failed"
                  });
                });
            },
            onclose: () => {
              if (!stopped) {
                reportSafely(input.onError, {
                  relay,
                  kind: "relay_closed",
                  message: "Inbox relay subscription closed unexpectedly"
                });
              }
            }
          }
        );
        opened.push(subscription);
      } catch {
        reportSafely(input.onError, {
          relay,
          kind: "relay_start",
          message: "Inbox relay subscription failed to start"
        });
        stop();
        throw new Error(`Inbox relay subscription failed: ${relay}`);
      }
    }

    const restart = Object.freeze({
      recipientPubkey: input.recipientPubkey,
      inboxRelays: Object.freeze([...relays]),
      cursor: Object.freeze({ since })
    });
    return Object.freeze({ restart, stop });
  } catch (error) {
    if (!stopped) {
      for (const subscription of opened) {
        try {
          subscription.close("zwap trade subscription start failed");
        } catch {
          // Best-effort cleanup continues for every already-opened relay.
        }
      }
      retainedKey.fill(0);
    }
    throw error;
  }
}
