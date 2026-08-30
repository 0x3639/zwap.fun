# Wallet notes

zwap signs every Zenon account block through a browser-extension wallet.
zwap itself holds no key: the extension owns the seed, shows every signing
confirmation, and decides whether a block pays with fused plasma or
proof-of-work.

## Install

At startup zwap listens for a wallet extension to announce itself
(`zenon:announceProvider`, per
[`docs/proposals/zenon-injected-provider.md`](../proposals/zenon-injected-provider.md)).
If none announces within the discovery window, the masthead shows an
**Install NoM Wallet** button linking to `INSTALL_URL` in
`src/ui/wallet-control.ts` — a placeholder repository URL until the
extension has a store listing.

## Connect

Once an extension is detected, the masthead button reads **Connect
wallet**. Pressing it opens the extension's own connect window; zwap waits
for that window's response rather than prompting itself. zwap then checks
the wallet's reported chain against `VITE_ZENON_CHAIN_ID` and refuses a
mismatch with "Wallet is on chain N; zwap needs chain M" rather than
silently signing against the wrong network. Rejecting the extension's
prompt logs "Wallet connection refused"; any other provider error appears
in the activity log prefixed "Wallet:".

## What zwap asks the wallet for

zwap calls `zenon_requestAccounts` to connect, then `zenon_sendBlock` for
every account block it needs signed: HTLC `Create` (locking a leg),
`Unlock` (claiming), and `Reclaim` (refund), plus plain `receive` and
`send` blocks. The extension — not zwap — decides whether a given block
spends fused plasma or computes proof-of-work.

## Nostr keys are not the wallet's

The per-order and per-session Nostr keys zwap uses for order projections
and private coordination are generated in the page and encrypted at rest
in this browser's IndexedDB; the connected wallet never sees or signs
them. See [ADR 0002](../adr/0002-maker-signing-identity.md).

## Disconnect and account switch

Open the connected pill's menu and press **Disconnect** to return to the
`detected` state and tear down the trade runtime; the activity log records
"Wallet disconnected". Revoking the site's grant from inside the extension
has the same effect. Switching the connected account inside the extension
reloads the page — the signing address is the identity of every open
session, and half-migrating an in-flight trade is worse than restarting.

## Local data

**Erase local data and restart**, in the danger zone (confirmed by typing
`RESET ZWAP DATA`), erases this browser's trade-session journal,
order-key store, and publication outbox. The button stays disabled until the
phrase is typed exactly, and the phrase is re-checked by `resetLocalData`
itself, so an agent calling it has to pass the same gate. It never touches the
wallet — the extension holds the seed, not zwap.

Data written under the old `?wallet=<name>` profile namespaces, before
profiles were removed, is no longer reachable from the page: everything now
lives in the single default namespace. Those old stores were not deleted, so
they still occupy this browser's storage until the site's data is cleared
through the browser itself.

Known limitation: trade sessions and per-order Nostr keys are keyed to the
browser, not to the signing address. A session opened with account A
cannot be signed by account B; the reload on account switch keeps this
visible rather than hiding it.

## Balances and the connected node

Balances, plasma, and unreceived-block counts come from whichever node
`VITE_ZENON_NODE_WS` points at — that node is your only view of the chain;
see the trust-boundary note in
[ADR 0006](../adr/0006-zenon-htlc-settlement.md). Zenon requires the
recipient to explicitly receive an incoming block: fund an account from an
external wallet — [go-syrius](https://github.com/0x3639/go-syrius) or
[nom-webwallet](https://github.com/digitalSloth/nom-webwallet) — then press
**Receive pending**; the button's label shows how many blocks are waiting.
Settlement HTLC unlocks and refunds also arrive as pending blocks and need
the same explicit receive.
