# ADR 0006: Zenon HTLC embedded contract as the settlement layer

- Status: accepted
- Date: 2026-08-28
- Supersedes: [ADR 0004](0004-cashu-htlc-settlement.md)
- Depends on: [ADR 0001](0001-nostr-order-events.md), [ADR 0003](0003-nostr-private-swap-messages.md)
- Amends: [ADR 0005](0005-quote-minor-unit-settlement.md)

## Context

zwap swaps two Zenon ZTS tokens (by default ZNN and QSR) instead of Cashu
ecash. Zenon's Network of Momentum ships a native **HTLC embedded contract**
(`z1qxemdeddedxhtlcxxxxxxxxxxxxxxxxxygecvw`) with `Create`, `Unlock`, and
`Reclaim` methods and a `getById` read. There is no Cashu mint, no NUT
capability negotiation, and no proof state to poll — settlement correctness
now depends on the embedded contract's own accounting and on the account
chain of whichever node the wallet is connected to.

Every account block also needs **plasma** (Zenon's feeless resource) or
proof-of-work; there is no NUT-07-style spend witness to await, but there is a
comparable "is this block going to land" gate before signing.

There is no RPC that lists open HTLCs by participant. An id is only knowable
once its `Create` block exists (the id is the hash of that block), so ids must
travel out-of-band — the existing NIP-17 DMs are still the transport ADR 0003
established.

## Decision

Use the embedded HTLC contract directly, with the same maker/taker roles and
staggered-deadline shape as ADR 0004, adapted to Zenon's primitives:

- `hashType = 1` (SHA-256), `keyMaxSize = 32`. Both are fixed; `zenon/htlc.ts`
  rejects any observed HTLC whose `hashType` or `keyMaxSize` differ.
- One fresh 32-byte preimage and its SHA-256 hash per reservation, generated
  and durably stored by the maker before accepting the reservation (unchanged
  from ADR 0004).
- **Maker locks the base leg first**, with the **long locktime** (default
  3600 s, `VITE_LONG_LOCK_SECONDS`): `Create(hashLocked=takerAddress,
  tokenStandard=baseZts, amount, expirationTime=anchor+long, hashType=1,
  keyMaxSize=32, hashLock=H)`.
- **Taker verifies the base HTLC against the node**, not against the DM, then
  **locks the quote leg** with the **short locktime** (default 1800 s,
  `VITE_SHORT_LOCK_SECONDS`): `Create(hashLocked=makerAddress,
  tokenStandard=quoteZts, amount, expirationTime=anchor+short, same H)`.
- **Maker verifies the quote HTLC**, then **claims it**: `Unlock(quoteId,
  preimage)`. This is the disclosure step — the preimage becomes part of the
  public account-block data the moment this block confirms.
- **Taker learns the preimage only by observing the chain.** There is no
  "spent proof witness" API to poll, so `ZenonTradeClient.observe` scans the
  **unlocker's own account chain** (`hashLockedAddress`, i.e. the address that
  was allowed to unlock) page by page — `listAccountBlocks(address, page,
  pageSize)` — decoding each block's `data` as an `Unlock` embedded-contract
  call and checking it names the expected HTLC id and hashlock. Defaults:
  `scanPages = 3`, `pageSize = 100`, i.e. up to 300 most-recent blocks. This
  bound is a tunable trade-off (an active address could in principle push the
  Unlock block outside the window before it is observed); it is not a protocol
  limit, and callers needing a deeper search can pass larger values.
- **Taker claims the base leg**: `Unlock(baseId, preimage)`, using the exact
  preimage read from the chain, never from a DM.
- **Refund = `Reclaim(id)`**, only after `now >= expirationTime + expiryGrace`
  (`expiryGrace = 60` seconds). `prepareRefund` throws `not-yet-refundable`
  before that. As on Cashu, expiry does not revoke the receiver's `Unlock`
  authority — it only makes `Reclaim` available to the original sender, so
  expiry creates a receiver/refund race, not a hard cutover. Implementations
  stop attempting claims at a `claimCutoff` (`expirationTime - 120`) and enter
  recovery instead of racing a `Reclaim` at the wire.

### HTLC ids travel in DMs but are never trusted from DMs

An HTLC's id is the hash of its `Create` account block and is therefore only
known after that block is confirmed. The `reserve_accept` and `quote_lock`
messages (ADR 0003's transport) carry `{chainId, htlcId, tokenStandard,
amount, expirationTime, hashLock}`, but every recipient re-reads the HTLC from
the node with `embedded.htlc.getById(id)` (`ZenonTradeClient.validateIncomingLock`)
and validates every field against the terms it independently agreed to
(`validateHtlcInfo` in `zenon/htlc.ts`) before treating the leg as funded.
A DM is a hint for which id to look up; the node's answer is the only thing
that can make a leg claimable.

### `completeLock` is idempotent, claims and refunds are not

Because an HTLC's id is the hash of the very `Create` block that funds it, a
`Create` send whose read-back failed (page reload, dropped connection, node
timeout after the block was accepted) still leaves a fully valid, discoverable
lock on chain — it is not "lost," only unconfirmed to the caller.
`ZenonTradeClient.completeLock` therefore scans the signer's own recent
account blocks (`adoptExistingLock`, same `scanPages × pageSize` window) for
one that already matches the expected terms before sending a new `Create`,
and adopts it instead of creating a second, orphaned lock. A retried
`completeClaim` or `completeRefund` has no equivalent adoption path: the node
itself rejects a second `Unlock`/`Reclaim` against an already-spent HTLC, so a
retry after an ambiguous send either lands once or fails loudly — it never
double-spends. This is a known, accepted limitation (see "Known limitations"
below), not a bug: funds are safe either way, but a caller cannot yet
distinguish "my retry failed because the first attempt already landed" from
"my retry failed for some other reason" without an extra `getById`/observe
round trip.

### Plasma and proof-of-work

Every embedded-contract call and every plain send is an account block and
needs fused plasma or proof-of-work. `zenon/plasma-bot.ts` implements
`fusePlasma(tier)` → `POST {VITE_PLASMA_BOT_URL}/api/agent/fuse {address,
tier}` against the community bot at `https://plazma.bot`, which fuses QSR on
**mainnet only** — there is no equivalent service on the public testnet today.
When plasma is insufficient, `znn-typescript-sdk`'s `PowWorker` generates
proof-of-work in a browser Web Worker (`KeystoreSigner.installPowWorker`);
the UI surfaces a "Generating proof of work…" status while it runs. A plasma
shortfall surfaces to the trade coordinator as the `plasma_unavailable` error
code (`src/trade/effects.ts`), which is marked retryable and leaves the trade
in its current phase — it is not a terminal protocol error, because fusing
plasma or waiting for PoW to finish resolves it without touching settlement
state.

### Trust boundary: the node is your view of the chain

Every verification in this protocol — `getById`, `getAccountBlock`,
`listAccountBlocks`, balances, plasma, the frontier momentum used to check
`chainIdentifier` — goes through exactly one Zenon node connection
(`zenon/sdk-node.ts`). zwap does not cross-check answers against a second
node. A node that lies, omits blocks, or serves a stale/forked view can make
an HTLC look locked, unlocked, or absent when it is not, which would corrupt
every downstream decision (whether to fund a counter-leg, whether a preimage
is genuine, whether a refund is available). This is the same class of trust
assumption ADR 0004 made about mints; here it reduces to one sentence: **the
node you connect to is your view of the chain.** `VITE_ZENON_NODE_WS` is
verified against the configured `VITE_ZENON_CHAIN_ID` on connect
(`ChainMismatchError` blocks trading on a mismatch), but that only proves the
node claims to serve the right network, not that it is honest or fully
synced. Anyone settling real volume should run their own node
(`go-syrius`, https://github.com/0x3639/go-syrius) rather than depend on a
public endpoint's honesty and availability.

### Transcript binding

Transcript binding replaces mint/keyset identities with `chainId + htlcId(s)
+ tokenStandards + addresses + amounts + expirationTimes`. A chain id
mismatch freezes the trade rather than silently settling on the wrong
network.

## Alternatives not chosen

### Poll a "spend witness" style API

Zenon's HTLC contract has no NUT-07 analogue that returns a witness alongside
spend state. The only authoritative record of an `Unlock` is the account
block itself, so observation has to be a chain scan rather than a single
state read.

### Trust the DM's `htlcId` without `getById`

A peer could claim a leg exists, or exists with different terms, before or
without ever creating it. Every id is re-verified against the node's own view
before it is treated as funded (see "HTLC ids travel in DMs" above).

### An id-listing RPC

None exists on the embedded contract today. If one is added upstream, the
scan in `observe`/`adoptExistingLock` could be replaced with a direct lookup;
until then, `scanPages × pageSize` is the practical bound.

### Cross-checking multiple nodes

Would reduce (but not eliminate) the single-node trust assumption above, at
the cost of needing agreement/quorum logic this phase does not implement. Out
of scope; see "Trust boundary" for the accepted mitigation (run your own
node).

## Known limitations

- **Claims and refunds are not idempotent on retry.** A caller cannot safely
  resend `Unlock`/`Reclaim` on an ambiguous result the way `completeLock`
  resends `Create`; the node's own single-spend enforcement is what keeps a
  retry from double-spending, not application-level idempotency. Funds are
  never at risk — a rejected retry means the first attempt already succeeded
  — but a caller has to re-observe the HTLC to find out.
- **The observation window is bounded**, not exhaustive (`scanPages ×
  pageSize`, default 300 blocks per address). An extremely active
  `hashLocked` address could in principle push the relevant `Unlock` block
  outside that window before it is observed.
- **No cross-node corroboration.** See "Trust boundary" above.

## Consequences

- `zenon/htlc.ts`, `zenon/trade-client.ts`, `zenon/sdk-node.ts`, and
  `zenon/plasma-bot.ts` replace `cashu/htlc.ts`, `cashu/trade-client.ts`, and
  `cashu/client.ts` entirely; there is no mint, keyset, or NUT capability
  concept anywhere in the codebase.
- The coordinator's `prepare_*_lock` / `prepare_*_claim` / `prepare_*_refund`,
  `execute_*_operation`, and `observe_base` / `observe_quote` actions
  (ADR 0004's shape) are unchanged in structure; only their Cashu
  implementations were replaced with Zenon ones.
- `plasma_unavailable` is a new retryable error code in the existing
  atomic-swap error set (alongside the mint-era errors it does not replace).
- The public verification trace may include chain id, HTLC ids, token
  standards, amounts, expiration times, addresses, and block hashes. It never
  includes preimages before they are on-chain, private keys, or mnemonics.

## Sources

- [znn-typescript-sdk](https://github.com/digitalSloth/znn-typescript-sdk)
- [go-syrius](https://github.com/0x3639/go-syrius)
- `src/zenon/htlc.ts`, `src/zenon/trade-client.ts`, `src/zenon/sdk-node.ts`,
  `src/zenon/plasma-bot.ts`, `src/trade/effects.ts`
