# Security invariants

These invariants define what zwap's Zenon-settled swap protocol must
demonstrate. They are acceptance criteria, not claims about the current
implementation.

1. **Node is the source of truth.** Every HTLC's terms (`hashLocked`,
   `timeLocked`, `tokenStandard`, `amount`, `expirationTime`, `hashType`,
   `keyMaxSize`, `hashLock`) are read from the connected Zenon node
   (`embedded.htlc.getById`) and validated before a participant acts on them.
   A DM-carried HTLC id is a pointer to look up, never evidence on its own.
2. **Term binding.** Signatures and private messages bind protocol version,
   chain id, order ID, session ID, each leg's token standard, amounts, exact
   `price` representation, expiration times, and the prior transcript hash.
3. **What-you-see-is-what-you-sign.** The wallet never signs terms different
   from the final human/agent-readable confirmation, and never signs an
   account block without the participant's on-chain balance covering it.
4. **Validate before committing the counter-leg.** A participant validates
   chain id, token standard, amount, hashlock, hash type, key max size, and
   expiration time of the counterparty's HTLC — read fresh from the node —
   before creating its own leg.
5. **Claim symmetry.** The maker's `Unlock` of the quote HTLC is itself the
   disclosure: because the preimage becomes part of the public account-block
   data the moment that block confirms, an honest taker who observes the
   chain has everything required to `Unlock` the base HTLC.
6. **Eventual recovery.** Before funds are committed, a valid `Reclaim` path
   exists once `now >= expirationTime + expiryGrace` (default 60 seconds).
   Peer disconnect or node unavailability cannot create an indefinite lock
   without an explicit, bounded operational assumption (see the trust
   boundary in [ADR 0006](../adr/0006-zenon-htlc-settlement.md)).
7. **Replay isolation.** Reusing an order projection, reservation, private
   message, or transcript in another session is rejected.
8. **Explicit expiry.** Boundary behavior is deterministic; an expired order
   or reservation cannot start or complete a new settlement. Claims stop at a
   `claimCutoff` strictly before `expirationTime`, never at or after it.
9. **Single allocation.** Concurrent reservations and partial fills cannot
   allocate more than the order's remaining amount.
10. **Bearer-secret containment.** Public events, logs, errors, screenshots,
    fixtures, analytics, and audit documents never expose a mnemonic, a
    private key, or a preimage before it has appeared on chain. Once a
    preimage is on-chain it is public by definition and is no longer bearer
    material.
11. **Verifiable evidence.** A completed test records public event IDs,
    signatures, relay acknowledgements, chain id, HTLC ids, token standards,
    amounts, timestamps, block hashes, and redacted state transitions without
    recording bearer secrets.
12. **Chain-id binding.** Every settlement plan and every verified HTLC is
    checked against the configured `VITE_ZENON_CHAIN_ID`. A mismatch freezes
    the trade rather than settling against the wrong network.
13. **Sequential sends per address.** Each locally controlled address signs
    account blocks strictly one at a time (one signer instance per address);
    concurrent sends to the same address are serialized rather than raced,
    since the Zenon account chain is a hash-linked sequence and a race would
    produce a rejected or forked block.

Minimum negative tests cover: an HTLC whose on-chain terms differ from the
signed terms, a wrong hash type or key max size, an already-unlocked or
already-reclaimed HTLC, a chain id mismatch, replay of a private message or
order projection, a duplicate reservation, expiry boundaries exactly at and
just past `expirationTime`, a peer disconnect mid-swap, a temporarily
unreachable node, insufficient plasma (`plasma_unavailable`, retryable), and
a mid-swap abort before either leg is locked.
