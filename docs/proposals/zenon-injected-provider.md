# Proposal: a Zenon injected provider for the NoM web wallet

- Status: proposal, unfiled
- Target: [digitalSloth/nom-webwallet](https://github.com/digitalSloth/nom-webwallet), Phase 2 (browser extension)
- Author: the zwap.fun project
- Date: 2026-08-28
- Reference consumer: zwap's [`src/zenon/injected-signer.ts`](../../src/zenon/injected-signer.ts)

This proposes the page-facing API a Zenon browser-extension wallet should
expose, so that a dapp in the same browser can ask the wallet to sign and
publish account blocks without ever seeing a key. It is deliberately close to
EIP-1193/EIP-6963 in shape, because that is the interface web developers
already know and the one their tooling already assumes.

## 1. Motivation

Dapps on Zenon today have exactly two options, and both are bad.

They can **hold keys themselves**. zwap.fun does this: it derives a BIP39 seed
in the page, keeps it in IndexedDB, and signs every block in the tab. That is
a hot wallet by construction. It works, and it is honest about the tradeoff,
but it means every dapp is a fresh custody surface, every dapp re-implements
seed creation, import, reveal and erase, and a user who wants to trade with
funds they already hold has to move those funds into a browser page.

Or they can **use WalletConnect**. For a mobile wallet talking to a desktop
browser that is the right tool. For an extension sitting in the same browser
as the page it is a poor fit: it adds a relay server and a pairing QR to a
link that is already local, it introduces a session lifetime that has nothing
to do with the tab, and it degrades badly when the network the relay lives on
is exactly the thing the user is trying to avoid depending on.

What a dapp actually needs from a Zenon wallet is small. zwap needs to build
four kinds of account block:

- **HTLC `Create`** — lock the base or quote leg under a shared hashlock.
- **HTLC `Unlock`** — spend a leg by revealing the preimage.
- **HTLC `Reclaim`** — take a leg back after its locktime expires.
- **`receive`** — accept the block the counterparty's unlock produced.

Plus a plain **`send`** for the wallet panel. Every one of these is "here is a
template, please fill in the chain-specific parts, sign it, and publish it."
None of them requires the dapp to know the key, the account-chain height, the
frontier momentum, or whether the address has plasma. All of that is the
wallet's job, and the wallet is the only party that can do it well: it already
tracks the frontier, it already owns the plasma, and it already has a UI in
which a human can be shown what they are about to sign.

An injected provider also fixes something a dapp cannot fix on its own: the
**confirmation**. When zwap signs its own HTLC `Create`, nothing shows the
user the token, the amount, the counterparty hashlock, or the expiry in a
surface the page cannot forge. An extension can.

## 2. Architecture

Four processes, three hops, one trust boundary.

```
  ┌──────────────────────────── browser tab ───────────────────────────┐
  │                                                                    │
  │   page (main world)                     content script (isolated)  │
  │   ┌──────────────────┐                  ┌───────────────────────┐  │
  │   │ dapp             │                  │ content.js            │  │
  │   │  ↕               │                  │  matches <all_urls>   │  │
  │   │ inpage provider  │                  │  run_at document_start│  │
  │   │ (injected.js)    │                  │                       │  │
  │   └────────┬─────────┘                  └───────────┬───────────┘  │
  │            │                                        │              │
  │            │  window.postMessage                    │              │
  │            │  { source: "zenon-provider", ... }     │              │
  │            └────────────────┬───────────────────────┘              │
  │                             │  same-window, origin-checked         │
  └─────────────────────────────┼──────────────────────────────────────┘
                                │
                                │  chrome.runtime.connect({ name: "zenon" })
                                │  long-lived port, one per tab
                                ▼
                 ┌──────────────────────────────────┐
                 │ background service worker        │
                 │  · per-origin permission store   │
                 │  · request queue + rate limiter  │
                 │  · template validation           │
                 │  · keys, unlocked vault          │───▶ NoM node (ws)
                 │  · plasma / PoW decision         │
                 └───────────────┬──────────────────┘
                                 │ opens on approval-needing methods
                                 ▼
                 ┌──────────────────────────────────┐
                 │ approval popup                   │
                 │  decoded contract call + fee mode│
                 └──────────────────────────────────┘
```

**Content script.** Declared in the manifest with
`"matches": ["<all_urls>"]`, `"run_at": "document_start"`, `"all_frames":
false` for v1. It runs in the isolated world, so the page cannot reach its
globals. Its only jobs are to inject the inpage script and to relay envelopes
between `window.postMessage` and the extension port.

**Inpage script.** Listed in `web_accessible_resources` and injected as a
`<script src=chrome-extension://…/injected.js>` at `document_start`, so that
the provider exists before the page's own scripts run. It constructs the
provider object, announces it (§3), and turns each `request()` into an
envelope. It must not hold anything secret: it lives in the page's world and
the page can read every property it exposes.

**Envelope.** Both directions use one shape, and both sides filter on it:

```jsonc
// page → content script
{
  "source": "zenon-provider",     // fixed; ignore anything else
  "direction": "request",
  "id": "3f2a…",                  // uuid, unique per in-flight request
  "method": "zenon_sendBlock",
  "params": [ /* method-specific */ ]
}

// content script → page
{
  "source": "zenon-provider",
  "direction": "response",
  "id": "3f2a…",
  "result": { "hash": "…" }       // xor "error": { code, message, data? }
}

// content script → page, unsolicited
{
  "source": "zenon-provider",
  "direction": "event",
  "event": "accountsChanged",
  "payload": ["z1…"]
}
```

Both listeners MUST check `event.source === window` and
`event.origin === window.location.origin` before reading the envelope, and
MUST ignore any message whose `source` field is not exactly
`"zenon-provider"`. Responses are matched to requests by `id`; an `id` the
page did not issue is dropped, and an `id` is retired once answered so a
second response cannot resolve a settled promise.

**Port.** The content script opens one long-lived
`chrome.runtime.connect({ name: "zenon" })` per tab. The background attaches
the sender's `origin` and `tabId` to every request from that port. **The
origin comes from `port.sender`, never from the message body** — a
page-supplied origin is a claim, not a fact.

**Background.** The only process that touches keys. It checks the per-origin
permission, validates the template against the schema in §4, decides plasma
vs proof of work, opens the approval popup where one is needed, and only then
signs and publishes. It also owns the rate limiter and the request queue: one
in-flight signing request per origin, and account blocks for a single address
strictly serialized, because the account chain is hash-linked and two
concurrent blocks race the same frontier.

## 3. Discovery

Follow EIP-6963's shape so that multiple wallets can coexist and no wallet has
to win a race for a global.

On load, and again on every `zenon:requestProvider` event, the inpage script
dispatches:

```js
window.dispatchEvent(new CustomEvent("zenon:announceProvider", {
  detail: Object.freeze({
    info: {
      uuid: "350670db-19fa-4704-a166-e52e178b59d2", // per page load, RFC 4122 v4
      name: "Syrius Extension",
      icon: "data:image/svg+xml;base64,…",          // square, ≥ 96px, data: URI
      rdns: "network.zenon.syrius"                  // reverse-DNS, stable
    },
    provider  // the EIP-1193-style object of §4
  })
}));
```

A dapp discovers wallets by listening for `zenon:announceProvider` and then
dispatching `zenon:requestProvider`; conforming wallets answer that request
**synchronously**, so a page can decide within a microtask whether a wallet is
present. `uuid` is fresh per page load and identifies this announcement;
`rdns` identifies the wallet product and is what a dapp should persist when a
user picks a wallet.

**Fallback.** The provider MAY also set `window.zenon`, but only when the
property is absent:

```js
if (window.zenon === undefined) {
  Object.defineProperty(window, "zenon", {
    value: provider, writable: false, configurable: false
  });
}
```

Never overwrite another wallet's global. Dapps should prefer the announced
provider and treat `window.zenon` only as a last resort — zwap's
`detectInjectedProvider` does exactly this, and gives up with `null` after
300 ms so a page with no wallet stays fast.

## 4. Provider API

```ts
interface ZenonProvider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on(event: string, handler: (payload: unknown) => void): void;
  removeListener(event: string, handler: (payload: unknown) => void): void;
}
```

`request` rejects with the error object of §6. Unknown methods reject with
4200 rather than hanging.

### `zenon_requestAccounts`

```jsonc
// params: none (or [])
// result:
["z1qzal6c5s9rjnnxd2z7dvdhjxpmmj4fmw56a0mz"]
```

Prompts the user the first time an origin asks, and grants that origin a
persisted permission. Rejects 4001 if the user declines. Returns the
authorized addresses, most-recently-selected first. v1 wallets MAY return a
single-element array.

### `zenon_accounts`

```jsonc
// params: none
// result: [] when the origin has no permission — never a prompt
["z1qzal6c5s9rjnnxd2z7dvdhjxpmmj4fmw56a0mz"]
```

The silent form, for a page restoring a session on reload.

### `zenon_chainId`

```jsonc
// params: none
// result:
1        // mainnet; a testnet reports its own chain identifier, e.g. 73404
```

A number, not a hex string: Zenon's chain identifier is a small integer in the
protocol itself, and stringifying it would only invite the 0x-parsing bugs
that plague EVM dapps.

### `zenon_sendBlock`

```jsonc
// params:
[{ "template": { "kind": "htlc_unlock", "id": "…", "preimage": "…" } }]

// result:
{ "hash": "5c1f…" }   // 64 lowercase hex chars, the published block's hash
```

This is the whole write API. The page supplies **only** the semantic content
of the block. The wallet fills in everything chain-shaped:

| Field | Filled by |
| --- | --- |
| `address` | wallet — the authorized account |
| `height`, `previousHash` | wallet — from its own account-chain frontier |
| `momentumAcknowledged` | wallet — from the frontier momentum |
| `blockType`, `toAddress`, `data`, `amount`, `tokenStandard` | wallet — derived from the template |
| plasma vs proof of work | wallet |
| signature, publication | wallet |

The wallet MUST NOT accept a page-supplied `address`, `height`,
`previousHash`, `momentumAcknowledged`, `publicKey`, or `signature`. A
template carrying any of them is invalid params (-32602). Resolution happens
after the node accepts the block; the promise resolves with the hash of the
block the wallet actually published.

**Confirmation requirement.** Before signing, the wallet MUST show a
confirmation that decodes the embedded-contract call into human terms. Raw
`data` bytes are not a confirmation; a user cannot audit a hex blob.

- HTLC `Create`: token symbol **and** token standard, amount at the token's
  real decimals, the `hashLocked` recipient address, the expiry as both an
  absolute time and a duration from now, and the hashlock.
- HTLC `Unlock`: the HTLC id, and — because this reveals bearer material —
  that a preimage will become public.
- HTLC `Reclaim`: the HTLC id, and whether its locktime has actually passed.
- `receive`: the source block, its amount and token.
- `send`: recipient, token, amount.

Every confirmation MUST also state the **fee mode**: whether the block will be
covered by fused plasma, or whether the wallet is about to spend tens of
seconds on proof of work. A PoW block is a real cost to the user — in time and
in a locked-up UI — and consenting to it is part of consenting to the block.

### Wire schema for `template`

Reproduced verbatim from zwap's `src/zenon/types.ts`, which is the reference
consumer's own type:

```ts
export type ZenonTemplate =
  | { kind: "htlc_create"; tokenStandard: string; amount: string; hashLocked: string; expirationTime: number; hashType: 1; keyMaxSize: 32; hashLock: string }
  | { kind: "htlc_unlock"; id: string; preimage: string }
  | { kind: "htlc_reclaim"; id: string }
  | { kind: "receive"; fromBlockHash: string }
  | { kind: "send"; toAddress: string; tokenStandard: string; amount: string };
```

As JSON on the wire, with these encoding rules:

| Field | Encoding |
| --- | --- |
| `kind` | one of the five literals; any other value is -32602 |
| `tokenStandard` | canonical ZTS string, `zts1…`, e.g. `zts1znnxxxxxxxxxxxxx9z4ulx` |
| `amount` | **decimal string** in the token's smallest unit, `/^[1-9][0-9]*$/`. Never a JSON number: `2^53` is not enough for 8-decimal balances |
| `hashLocked`, `toAddress` | canonical Zenon address, `z1…`, 40 chars |
| `expirationTime` | unix seconds, JSON number, integer, in the future |
| `hashType` | exactly `1` (SHA-256). Reject anything else |
| `keyMaxSize` | exactly `32`. Reject anything else |
| `hashLock`, `id`, `fromBlockHash` | **bare lowercase hex**, no `0x` prefix, exactly 64 chars |
| `preimage` | bare lowercase hex, ≤ `2 * keyMaxSize` chars, even length |

"Bare lowercase hex" is not decoration. A wallet that accepts `0x`-prefixed or
mixed-case hex will hash a different byte string than the dapp intended, and
for a hashlock that means an HTLC nobody can unlock.

## 5. Events

```ts
provider.on("accountsChanged", (accounts: string[]) => {});
provider.on("chainChanged",    (chainId: number)   => {});
provider.on("disconnect",      (error: { code: number; message: string }) => {});
```

- **`accountsChanged`** — the user switched accounts, or revoked this origin.
  An empty array means "no longer authorized"; the dapp must return to its
  disconnected state and must not keep signing against the old address.
- **`chainChanged`** — the wallet moved to another chain identifier. A dapp
  with chain-bound state (zwap has exactly that: every settlement plan is
  pinned to a chain id) should freeze rather than silently follow.
- **`disconnect`** — the wallet lost its node, or locked. Carries the §6 error
  shape.

Events are one-way and unsolicited. A wallet MUST NOT deliver events to an
origin that holds no permission.

## 6. Errors

Every rejection is:

```ts
{ code: number; message: string; data?: unknown }
```

| Code | Meaning |
| --- | --- |
| `4001` | user rejected the request |
| `4100` | unauthorized — the origin has no permission for this method |
| `4200` | unsupported method |
| `4900` | disconnected — the wallet has no node |
| `4901` | chain mismatch — the request targeted a chain the wallet is not on |
| `-32602` | invalid params — a template that failed validation |
| `-32603` | internal error |

Node-level failures surface as `-32603` with the node's own code preserved:

```jsonc
{
  "code": -32603,
  "message": "account block rejected: insufficient plasma",
  "data": { "rpcCode": -32000, "rpcMessage": "…" }
}
```

`data.rpcCode` matters to a dapp: a plasma failure is retryable and must not
change a trade's phase, while a rejected block is terminal. Collapsing both
into one opaque string forces the dapp to string-match the message, which is
how retry loops become infinite ones.

## 7. Security requirements

1. **Origin-scoped permissions.** Permission is granted per origin (scheme +
   host + port), derived from `port.sender`, never from message content. The
   wallet ships a UI listing every permitted origin with a one-click revoke,
   and revocation emits `accountsChanged: []` to that origin's live ports.
2. **Keys never leave the background.** No method returns a private key, a
   mnemonic, a seed, or a raw signature over caller-chosen bytes. The inpage
   script and the content script hold nothing secret, because the page can
   read the first and a compromised renderer can reach the second.
3. **Whitelisted methods only.** The background dispatches from a fixed table.
   An unknown `method` is 4200 — never a passthrough to the node's RPC, which
   would turn every dapp into an unmetered proxy for the user's node.
4. **Validate templates in the extension.** Re-check every field against §4
   in the background, after the message crosses the port. The page is
   untrusted, and so is the content script the page shares a renderer with.
   Reject rather than coerce: a silently normalized amount is a wrong amount.
5. **Decoded, user-visible confirmations.** As §4 requires. The confirmation
   is rendered from the *validated* template in extension UI — never from
   page-supplied display strings, which is how a "send 0.1 ZNN" dialog signs
   away 1000.
6. **Rate limiting.** Per origin: one in-flight approval at a time, a cap on
   prompts per minute, and a cooldown after a rejection. Without it a hostile
   page can spam approval popups until a user clicks the wrong one, and can
   drain the wallet's node connection with silent reads.
7. **No auto-approval.** Permission to *see* an address is not permission to
   *sign*. Every `zenon_sendBlock` gets a confirmation in v1, with any
   "allowance"-style relaxation left to a later phase that can be designed
   with its own limits.
8. **Serialize per address.** The wallet queues account blocks for one address
   and never signs a second while one is in flight, regardless of how many
   origins ask.

## 8. Out of scope for v1

- **Message signing** (`zenon_signMessage`). Useful for dapp login, but it
  needs its own domain-separation design so a signed "login" string can never
  be replayed as something else.
- **Multi-account selection beyond index 0.** v1 exposes the wallet's selected
  account. Letting a page ask for a specific derivation index is a
  linkability leak and a UI problem, both better solved once real usage
  exists.
- **Batch requests.** A dapp that wants two blocks can send two requests and
  await them in order; batching would need atomicity semantics the account
  chain does not offer anyway.
- **Watch-only / read RPC passthrough.** Dapps talk to a node directly for
  reads. The wallet is for signing.
- **Cross-frame injection.** `all_frames: false` in v1; a provider inside a
  third-party iframe deserves its own origin story first.

## 9. Reference consumer

zwap.fun implements the page side of this proposal in
[`src/zenon/injected-signer.ts`](../../src/zenon/injected-signer.ts):

- `detectInjectedProvider(window, timeoutMs)` — §3 discovery, announce event
  first and `window.zenon` second, resolving `null` after 300 ms.
- `InjectedZenonSigner.connect(provider, expectedChainId)` — §4
  `zenon_chainId` then `zenon_requestAccounts`, raising 4901 on a chain
  mismatch and 4100 when no canonical address comes back.
- `InjectedZenonSigner.send(template)` — §4 `zenon_sendBlock`, serialized per
  instance, validating the returned hash and re-raising provider errors with
  their own codes.
- `InjectedZenonSigner.onAccountsChanged(handler)` — §5.

It is enabled behind `VITE_INJECTED_WALLET=1`; with no wallet detected, zwap
falls back to its in-page keystore. The unit tests in
`src/zenon/injected-signer.test.ts` double as an executable conformance
sketch for the page-facing half of this document.
