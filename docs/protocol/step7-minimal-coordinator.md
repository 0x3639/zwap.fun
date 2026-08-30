# Step 7 minimal swap coordinator

This document describes the first functional zwap swap coordinator. It is an
implementation boundary, not a claim that the protocol is hardened for every
production scenario.

## Scope

The coordinator's current acceptance target is one real
maker-sells-ZNN-for-QSR swap between two isolated browser profiles. It keeps
the authenticated NIP-17 inbox subscription open while the page is active.
Existing timeout/refund safeguards remain available, but further recovery
hardening is not a prerequisite for this happy-path demonstration.

The implementation accepts only the exact signer, recipient, session,
reservation, order address, current projection ID and revision, message
type, sequence, predecessor, and transcript hash required by the current
choreography. A valid Nostr signature alone is not enough.

## One-action loop

`advance(sessionId)` chooses at most one action from persisted state.

1. Acquire the per-session browser lock.
2. Load and validate the current revision.
3. Persist the exact artifact for the next external effect.
4. Release the storage lock before using a relay or the Zenon node.
5. Perform that one effect.
6. Reacquire the lock, compare the same artifact and revision, and persist
   the exact result.
7. Return the new public session view. A later call plans the next action.

If the page closes between steps 3 and 6, the next call retries the same
signed Nostr event, gift wrap, or prepared HTLC operation. It never creates a
replacement artifact just because the previous result is unknown — see the
idempotency notes in
[ADR 0006](../adr/0006-zenon-htlc-settlement.md#completelock-is-idempotent-claims-and-refunds-are-not)
for the one place this does not hold (a retried claim or refund).

## Persisted checkpoints

| Effect | Before | After |
| --- | --- | --- |
| Inbox registration | exact signed kind 10050 and target relay | relay receipt and exact readback |
| Private delivery | exact kind 1059 wrapper, rumor/transcript IDs, recipient relays | authenticated relay receipts; the next private message must bind its predecessor |
| Public order projection | exact signed projection and expected current ID/revision | one relay acknowledgement, then local commit |
| HTLC lock, claim, or refund | prepared operation, exact expected HTLC terms | confirmed account block hash, wallet reconciliation, then reservation release |
| Incoming private message | raw wrapper and receive time | authenticated opened message and deterministic next choreography |

Mnemonics, private keys, preimages before they are on-chain, and private raw
event IDs remain inside encrypted local state. The public API and test trace
expose commitments, public order events, phases, amounts, token standards,
HTLC ids, timestamps, and relay/chain outcomes only.

New settlement plans use `VITE_SHORT_LOCK_SECONDS` (default 1800 s) for the
quote leg and `VITE_LONG_LOCK_SECONDS` (default 3600 s) for the base leg. On
`reserve_accept`, the taker persists the maker's exact signed plan and
validates the maker's base-leg HTLC against the node before preparing any
Zenon effect, so small independent clock-sampling differences cannot produce
mismatched HTLC terms.

## Happy-path choreography

1. Taker sends `reserve_propose` to the maker order key.
2. Maker publishes the reserved projection at the same `d` tag, creates the
   base-leg HTLC (`Create`, long locktime), and sends `reserve_accept`
   containing the exact signed plan and HTLC id.
3. Taker validates both against the node, creates the quote-leg HTLC
   (`Create`, short locktime) with the same hashlock, and sends `quote_lock`.
4. Maker validates the quote-leg HTLC against the node and claims it
   (`Unlock`), which writes the preimage into that account block.
5. Taker independently observes that `Unlock` block by scanning the maker's
   account chain, recovers the preimage, and claims the base-leg HTLC
   (`Unlock`).
6. Maker independently observes both `Unlock`s and publishes the signed fill
   projection; taker independently verifies that current projection.

Chain state and the signed public projection replace private verification,
claim, and receipt messages. The complete happy path therefore uses three
authenticated DMs.

## Existing timeout and refund boundary

No new claim starts at or after its `claimCutoff`. After a leg's
`expirationTime` plus the 60-second guard, its original sender first observes
the exact locked HTLC. If it is still unclaimed, the coordinator prepares and
checkpoints the refund, executes `Reclaim`, reconciles the returned funds
into the wallet as a pending receive, sends the bound `refund` message when
possible, and stages the authoritative public reservation release. A peer
message never substitutes for a chain observation. This section documents
the already-implemented safety boundary; Step 7 does not expand it unless the
live happy path exposes a funds-loss blocker.

## Browser runtime

Each browser origin gets one IndexedDB namespace — the trade-session
journal, order-key store, and outbox — and one Web Lock namespace; the
connected wallet address itself lives in the browser-extension wallet, not
in this storage. Before advertising the private inbox, the page performs a
disposable recipient-only live probe against `wss://auth.nostr1.com`; all
probe keys are zeroized afterward.

The shared page automatically enables and reconnects each active order-key
inbox. A valid `reserve_propose` opens a maker session through the same
exact-order and exact-funding preflight used by the agent API. Once either
role's per-session kind `10050` registration is committed, the page opens a
persistent subscription using that session key. A live event is only a
wakeup: the coordinator queries the stored wrapper, authenticates and
decrypts it through the persisted state machine, and advances at most one
action. Gift-wrap reads and subscriptions use the protocol's 172,800-second
randomized-timestamp lookback.

## Deferred production hardening

The first swap implementation does not block on:

- exhaustive crash injection at every journal field transition;
- every malicious nested-storage corruption case;
- generalized multi-device coordination;
- long-running reconnect/backoff and relay failover policy;
- production relay availability policy beyond one configured public-relay
  acknowledgement;
- cross-node corroboration of a single Zenon node's answers (see the trust
  boundary in [ADR 0006](../adr/0006-zenon-htlc-settlement.md));
- every abort/equivocation permutation; or
- production monitoring, rate limiting, and key-erasure policy.

These remain follow-up work. A deferred case must be promoted to a blocker if
it can break the implemented happy path or lose funds already committed to an
HTLC.
