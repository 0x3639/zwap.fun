# Browser agent API

The static app exposes the same wallet-backed surface used by the human
interface as `window.zwap`. It is intentionally small. zwap holds no key —
a browser-extension wallet signs every account block — so every method
returns addresses, amounts, phases, and public identifiers that are safe to
log or display; there is nothing on `window.zwap` that can leak bearer
material.

## One shared page, one connected wallet

The deployed site is one shared page. Maker and taker are ephemeral roles
tied to individual orders and sessions; the same connected wallet can
publish orders and take other orders concurrently. There is no per-workspace
query parameter any more — local trade data is namespaced per browser
origin, and the wallet itself lives in the browser extension, not in zwap.

## Wallet methods

```ts
const state = await window.zwap.getState();
// { wallet: "absent" | "detected" | "connected", providerName, address,
//   network, chainId, balances, unreceived, plasma }

const connected = await window.zwap.connectWallet(); // opens the extension's connect window
await window.zwap.disconnectWallet();

const afterReceive = await window.zwap.receivePending();

const receipt = await window.zwap.send(
  "z1qz...recipient",
  "zts1znnxxxxxxxxxxxxx9z4ulx", // ZNN
  "100000000" // 1 ZNN, in minor units
);

// Erases this browser's trade-session journal, order-key store, and
// publication outbox. It never touches the wallet — the extension holds
// the seed, not zwap.
await window.zwap.resetLocalData("RESET ZWAP DATA");
```

`getState()` reports the three-state wallet machine (`absent` — no
extension announced itself; `detected` — an extension announced but no
account is granted; `connected` — `zenon_requestAccounts` returned an
address), the announced extension's name once detected, the address
(`null` unless connected), the configured network name and chain id,
balances by ZTS token standard (symbol, decimals, exact integer minor-unit
balance), the count of unreceived pending blocks, and plasma
(`currentPlasma`, `maxPlasma`, `qsrFused`) or `null` if unknown. It never
returns a private key or an unreleased preimage.

`connectWallet()` throws with "Wallet connection refused" on a rejected
extension prompt, or "Wallet is on chain N; zwap needs chain M" on a chain
mismatch. `receivePending()` and `send()` throw "Connect your wallet before
trading" when called while not connected.

`send()` is a plain transfer — for moving funds outside a trade. Settlement
transfers happen automatically inside the trade coordinator and are never
exposed as a raw send.

`resetLocalData` requires the exact literal confirmation string
`"RESET ZWAP DATA"` (case-sensitive) so a stray call cannot accidentally
erase local trade data.

## Order book methods

```ts
const makerKeys = await window.zwap.getMakerPublicKeys();
const { book, rejected } = await window.zwap.getOrderBook();

const publication = await window.zwap.publishOrder({
  side: "sell",
  amount: "2000000000",   // 20 ZNN, in minor units (8 decimals)
  price: "350000000",     // 3.5 QSR per whole ZNN — see ADR 0005
  execution: "all_or_none"
});

const pending = await window.zwap.getPendingOrderPublications();
if (pending[0]) {
  await window.zwap.retryOrderPublication(pending[0].orderId);
}

await window.zwap.cancelOrder({
  address: book.topAsk.address,
  expectedProjectionId: book.topAsk.eventId,
  expectedRevision: book.topAsk.state.revision
});
```

Amounts and `price` are canonical positive integer strings in minor units;
`price` is quote minor units per `10^8` base minor units (see
[ADR 0005](../adr/0005-quote-minor-unit-settlement.md)). Never convert these
strings through JavaScript `number` when exactness matters — use `BigInt`.
`publishOrder()` checks the signer's on-chain balance for the leg the order
would fund before signing, and throws with the exact shortfall if the wallet
does not hold enough.

`getOrderBook()` verifies every event's signature and schema, selects the
newest projection at each order address, and returns exact-integer prices and
amounts plus a count of rejected/stale events. `publishOrder()` signs one
parameterized-replaceable kind `30078` projection (schema `zwap/order/v1`)
containing the complete current order state; its return value contains the
order ID, maker public key, projection ID, revision, and per-relay receipts —
never key material.

Before making a relay request, the browser persists the already-signed
projection in a private, origin-scoped outbox. If publication receives no
acknowledgement, `publishOrder()` rejects with an error whose `publication`
field contains the public order ID, projection ID, revision, and receipts.
Call `getPendingOrderPublications()` to inspect the outbox and
`retryOrderPublication(orderId)` to retry that exact signed event — a retry
never re-signs or creates a different event ID. The human UI exposes the same
recovery action.

## Trade methods

```ts
await window.zwap.enableMaker(); // { makerPubkey, inboxRelay }

const trades = await window.zwap.listTrades();
const started = await window.zwap.takeOrder({
  requestId: crypto.randomUUID(),
  address: book.topAsk.address,
  expectedProjectionId: book.topAsk.eventId,
  expectedRevision: book.topAsk.state.revision,
  fillBaseAmount: book.topAsk.state.remaining_amount
});

const nextCheckpoint = await window.zwap.advanceTrade(started.sessionId);
const settled = await window.zwap.runUntilSettled(started.sessionId);
// { sessionId, finalPhase: "filled", checkpoints: [...] }
const currentTrade = await window.zwap.getTrade(started.sessionId);
```

`enableMaker()` publishes each active order's authenticated order-key inbox
registration and keeps the NIP-17 subscriptions open for the life of the
page. The human page calls it automatically on startup and after publishing
an order; call it manually only to retry synchronization.

`takeOrder()` accepts only a verified current projection for the configured
market. Its lowercase UUIDv4 `requestId` is an idempotency key: reuse that
exact ID, address, projection ID, revision, and fill amount if the caller did
not receive the first result.

`advanceTrade(sessionId)` performs at most one planned action from the
persisted trade state — verify an HTLC against the node, create a lock,
observe an unlock, claim, refund, or send a private message — and returns the
new public phase. Call it again only after inspecting the returned phase.
Live inbox messages wake one such step automatically; explicit calls are
useful for local staging or manual recovery (see the refund drill in
[the manual swap guide](manual-swap.md)).

`runUntilSettled(sessionId)` repeatedly invokes `advanceTrade`, waits when the
peer has not delivered the next private message or the chain has not yet
confirmed a block, and stops only at `filled` or a terminal error. It does
not skip durable checkpoints. Its result contains only the session ID, final
phase, and redacted checkpoints (role/phase/revision) — never HTLC ids,
preimages, addresses, or amounts beyond what `listTrades`/`getTrade` already
expose publicly.

`listTrades()` and `getTrade()` return only public views: phase, role, exact
amounts, token standards, HTLC ids and validated terms, public projection IDs
and revisions, and a redacted protocol/message trace. They never return
private keys, preimages before they are on-chain, or raw NIP-17 message
bodies.

Browser automation running in an isolated script world can set
`document.documentElement.dataset.zwapRunSession`, dispatch
`zwap:run-until-settled`, and poll `data-zwap-run-status`. A filled run
places the same redacted JSON result in `data-zwap-run-result`; failures put
only a sanitized message in `data-zwap-run-error`. If the browser sandbox
cannot mutate page DOM, navigate the page with `?runUntilSettled=<session-id>`
in the query string instead — the page starts the same executor on load and
exposes the same status/result attributes.

## Network allowlist

The public app has a fixed network allowlist matching its Content Security
Policy (`index.html`): the configured Zenon node WebSocket
(`VITE_ZENON_NODE_WS`) and the configured Nostr relays (`VITE_NOSTR_RELAYS`,
`VITE_NOSTR_INBOX_RELAY`). Any other origin is unreachable from the page
regardless of what an agent asks for — the wallet extension talks to the
Zenon node on its own, outside the page's CSP.
