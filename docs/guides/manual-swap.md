# Manually reproduce a zwap swap

This tutorial reproduces the demonstrated happy path: one browser wallet
sells 20 ZNN for QSR at a limit price of 3.5 QSR/ZNN, while a second browser
wallet takes the order. **This uses real Zenon mainnet funds** unless you
point both tabs at a testnet build (`.env.testnet`) — there is no faucet on
the public testnet today, so most manual testing happens on mainnet with
small amounts.

Allow 15–30 minutes, plus whatever time your Zenon node needs to confirm
blocks. Use a desktop browser with IndexedDB, Web Locks, WebSocket, and
developer tools enabled. Keep both pages open throughout the swap.

## Before you start

1. **Fund two Zenon addresses.** You need a maker address holding at least
   1 ZNN and a taker address holding at least 4 QSR, each with either fused
   plasma or a browser willing to compute proof-of-work. Fund them from an
   external wallet — [go-syrius](https://github.com/0x3639/go-syrius) or
   [nom-webwallet](https://github.com/digitalSloth/nom-webwallet) — by
   sending ZNN/QSR to the addresses zwap will generate in step 2. Both
   companion wallets work on mainnet and testnet.
2. Open the shared site in two tabs or windows, one workspace per role:

   ```text
   https://zwap.fun/?wallet=maker
   https://zwap.fun/?wallet=taker
   ```

   The `wallet` query is only an optional local storage namespace so two
   wallets can coexist in one browser profile. It does not put a page into a
   maker or taker *mode* — the same page can publish orders and take other
   orders at the same time. If you already used these workspaces for
   something else, pick a fresh suffix, e.g. `maker-tutorial-2`.
3. Never paste, log, publish, or commit a seed phrase, a private key, or a
   preimage that has not yet appeared on chain. Every example below uses the
   placeholder `<your 24 words>`.

## 1. Create the maker wallet

On the maker tab's **Account** panel, press **Create wallet**. zwap generates
a BIP39 mnemonic locally, encrypts it at rest in this browser profile's
IndexedDB, and shows the new address. Press the copy icon next to the
address and send it at least 1 ZNN plus a little QSR (for plasma or a refund
margin later) from go-syrius or nom-webwallet.

If you are restoring an existing address instead of creating a new one, use
**Import an existing seed** and paste `<your 24 words>` — never a mnemonic
you use for other holdings.

## 2. Create the taker wallet

Repeat step 1 on the taker tab: press **Create wallet**, copy the address,
and send it at least 4 QSR (enough to cover a 20 ZNN order at 3.5 QSR/ZNN,
which settles 70 QSR — send more if you plan to take the full size) from an
external wallet.

## 3. Receive the funding sends

Zenon requires the recipient to explicitly receive an incoming block. After
your external wallet's send confirms, press **Receive pending** on the
matching tab — the button's label counts how many blocks are waiting (for
example "Receive 1 pending"). Confirm **Balances** on the account panel now
shows the ZNN (maker) or QSR (taker) you sent.

## 4. Fuse plasma (or accept proof-of-work)

Every account block — including the two HTLCs this swap creates — needs
plasma or proof-of-work. On mainnet, press **Fuse plasma**, choose a tier
(Low fuses 10 QSR), and wait for the plasma bot's acknowledgement; plasma
takes a few minutes to become spendable after fusing. Do this on **both**
tabs, since both addresses sign HTLC blocks.

If **Fuse plasma** is not shown (for example on testnet, where
`VITE_PLASMA_BOT_URL` is empty and there is no plasma bot yet), leave plasma
alone — the wallet computes proof-of-work in a background Web Worker
instead, and the status bar shows "Generating proof of work…" while it runs.
This can take tens of seconds per block, so a fused address settles faster.

## 5. Publish the 20 ZNN sell order

On the maker tab, fill in **Post an order**:

| Field | Value |
| --- | --- |
| Side | `Sell ZNN` |
| Amount (ZNN) | `20` |
| Limit price (QSR per ZNN) | `3.5` |
| Good for (hours) | `24` |

The settlement hint below the form shows the exact integers zwap will sign
(minor units for both legs) before you submit — check that it reads `20 ZNN`
and `70 QSR` (`20 * 3.5`). zwap checks your on-chain ZNN balance before
signing; if the check fails you will see the exact shortfall.

Press **Sign and post order**. If a pending-publication card appears instead
of a normal success message, press its retry action once to attempt the
relay again, then again once acknowledged to commit it locally. Do not
submit a second order while a pending publication for the same order exists.

Press **Refresh orders** on either tab and find the row showing `20 ZNN`,
`3.5 QSR/ZNN`, and an expiry about 24 hours out.

The maker's order-key inbox listener starts automatically after publishing;
no manual sync, reload, or role switch is required.

## 6. Take the order

On the taker tab, press **Refresh orders**. In the matching row, leave the
fill amount at `20` and press **Buy** (the button reads **Buy** when taking a
sell order, **Sell** when taking a buy order). zwap now runs the settlement
coordinator automatically — do not click the button again.

Watch for, in order:

- `Order taken; settling automatically`
- both session cards moving through the phases:

  ```text
  Negotiating → Reserved → Base locked → Quote locked
  → Quote claimed → Base claimed → Filled
  ```

- `Swap filled after … verified actions`

The pages can briefly show adjacent phases while a private message or a
chain confirmation is in flight. Stop only once both cards say **Filled**.

Concretely, this order of events is: the maker creates the ZNN HTLC (**Base
locked**) with the 3600-second long locktime; the taker verifies it against
the node and creates the QSR HTLC (**Quote locked**) with the 1800-second
short locktime; the maker unlocks the QSR HTLC (**Quote claimed** —
this is the moment the preimage becomes visible on chain); the taker reads
that preimage from the chain and unlocks the ZNN HTLC (**Base claimed**);
the maker verifies both HTLCs, publishes the filled order, and the taker
verifies that projection (**Filled**).

## 7. Receive the settled funds

Both HTLC unlocks arrive as pending (unreceived) blocks, exactly like an
external send. On the maker tab, press **Receive pending** to receive the 70
QSR; on the taker tab, press **Receive pending** to receive the 20 ZNN.
Confirm **Balances** on each tab now reflects the trade.

## 8. Verify the result

Press **Refresh balances** on both wallets and **Refresh orders** on the
taker. For fresh workspaces funded exactly as above, expect approximately:

| Wallet | Before | Expected after |
| --- | --- | --- |
| Maker | 1 ZNN | approximately 0 ZNN + 70 QSR |
| Taker | 4+ QSR | 20 ZNN + remaining QSR |

Verify the value movement rather than an absolute total — plasma fusion
amounts and any leftover balance from prior testing will differ:

- the maker spent 20 ZNN and gained 70 QSR;
- the taker spent 70 QSR and gained 20 ZNN;
- both session cards say **Filled**; and
- the exercised order disappears from the refreshed order book.

## The refund drill

This exercises the recovery path when a counterparty disappears mid-swap.

1. Publish and take a small test order exactly as in steps 5–6, but **close
   the taker tab** as soon as its session shows **Base locked** (i.e. right
   after the maker's HTLC is visible on chain but before the taker creates
   the quote HTLC).
2. Wait past the settlement plan's long locktime plus the 60-second refund
   guard — by default `VITE_LONG_LOCK_SECONDS` (3600 s) + 60 s, so about one
   hour and one minute after the maker's lock confirmed.
3. Reopen the maker tab (same `?wallet=maker` workspace) and press **Refresh
   swaps**. The coordinator's automatic executor observes that the base HTLC
   is still unclaimed past its expiry and reclaims it (`Reclaim`), returning
   the 20 ZNN to the maker as a pending block.
4. Press **Receive pending** on the maker tab to receive the refunded ZNN.

If you need to step the coordinator by hand instead of waiting for the
automatic executor, open developer tools on the maker tab and call
`await window.zwap.advanceTrade(sessionId)` (the session ID is visible in
each trade card and in the activity log) — this performs at most one planned
action per call and is safe to call repeatedly.

## If a relay or the node is unavailable

The demonstrated run can encounter transient errors including relay
disconnects, an unreachable inbox relay, or a slow/unreachable Zenon node.
None of these require a replacement trade.

1. Do not create another order or session.
2. Do not erase either wallet.
3. Keep or reopen the same `?wallet=` workspace.
4. If the maker tab reloaded, wait for the automatic maker listener startup.
5. Keep both workspaces open and let the automatic executor retry after a
   short pause — a "waiting for the counterparty" status is not a failure.

zwap reuses the persisted signed Nostr projection and prepared HTLC
operations on retry; it never signs a replacement order or restarts a
completed HTLC lock (see `completeLock`'s idempotent adoption in
[ADR 0006](../adr/0006-zenon-htlc-settlement.md)). A reload or an incoming DM
wakes the full settlement loop from its durable phase.

## What to record

A useful secret-free manual trace contains:

- UTC start and completion times;
- deployed commit, if known;
- only a truncated session or reservation prefix;
- both workspace names;
- chain id and node URL;
- `20 ZNN`, `3.5 QSR/ZNN`, and the 3600 s/1800 s locktime profile;
- visible phase progression;
- before and after balances; and
- confirmation that the filled order left the book.

Do not record mnemonics, private keys, preimages before they appear on
chain, or raw encrypted DM contents.
