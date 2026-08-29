# zwap.fun — Zenon HTLC DEX over Nostr (design)

Date: 2026-08-28
Status: approved design, pre-implementation

## 1. Goal

Replicate [brenorb/granola](https://github.com/brenorb/granola) — a custodian-free
exchange that publishes orders on Nostr, coordinates privately over encrypted
Nostr DMs, and settles atomically with hash-linked HTLCs — for the **Zenon
Network of Momentum**. Both legs of every swap are Zenon ZTS tokens (ZNN, QSR,
or any ZTS) settled through Zenon's native HTLC embedded contract.

Target: **Zenon mainnet** (chain identifier `1`, node
`wss://my.hc1node.com:35998`, with an alternative public node at
`wss://node.zenon.network:35998`), tested with small real amounts, because the
public testnet (chain `73404`, node `172.245.236.40`, HTTP `:35997`, WS
`:35998`) has no plasma bot or faucet yet. The testnet remains a supported
alternate configuration; switching is a `.env` change, not a code change.

## 2. Approach

Fork granola and replace only its settlement layer. Everything about order
publication, private coordination, session/transcript binding, encrypted
storage, the coordinator state machine, and the browser/agent shell is kept.

Stack: Vite + TypeScript + vitest (as granola), framework-free DOM UI,
`nostr-tools`, and [`znn-typescript-sdk`](https://github.com/digitalSloth/znn-typescript-sdk)
(browser ESM build, BIP39 keystore, `PowWorker`, ledger subscriptions,
`embedded.htlc`). Cashu dependencies are removed entirely.

### 2.1 Module fate

| granola module | zwap.fun |
|---|---|
| `nostr/*`, `order/*`, `trade/coordinator*`, `trade/messages*`, `trade/atomic-messages`, `trade/transcript`, `trade/session*`, `storage/encrypted-storage`, `storage/trade-session`, `storage/order-outbox`, `ui/*` shell, `api/*` | **Keep.** Schema strings `granola/…` → `zwap/…`; `window.granola` → `window.zwap`. |
| `cashu/client`, `cashu/htlc`, `cashu/trade-client` | **Delete.** Replaced by `zenon/node`, `zenon/htlc`, `zenon/trade-client`. |
| `core/wallet`, `core/proof-reservations`, `storage/wallet-repository`, `storage/proof-reservation-repository`, `trade/wallet-reconcile` | **Replace** with `zenon/signer`, `zenon/keystore-signer`, `zenon/account`, `zenon/plasma`. Reservations become "amount earmarked per open trade" checked against on-chain balance. |
| `ui/mint-actions` | → `ui/account-actions` (address, balances, receive pending, fuse plasma, backup). |
| `api/granola-api` `CashuPort` | → `ZenonPort` (address, balances, receive, plasma status, token list, fuse plasma). |

### 2.2 New `zenon/` modules

- `zenon/node` — thin wrapper over the SDK client: connect (WS for
  subscriptions, HTTP fallback for reads), verify `chainIdentifier` from
  `ledger.getFrontierMomentum` equals the configured id, expose
  `htlc.getById`, `ledger.getAccountBlockByHash`, `subscribe.toAccountBlocksByAddress`,
  `subscribe.toUnreceivedAccountBlocksByAddress`, `plasma.get`, `token.getByZts`.
- `zenon/signer` — interface `{ address(): Address; signAndPublish(template): Promise<Hash> }`.
  Implementation #1 is the in-browser keystore. A WalletConnect/go-syrius
  implementation can be added later without touching trade logic.
- `zenon/keystore-signer` — BIP39 mnemonic → SDK `KeyStore`, index-0 address.
  Mnemonic encrypted at rest with granola's `encrypted-storage` (password
  derived). Backup = reveal mnemonic behind a password prompt.
- `zenon/plasma` — before publishing a block: read plasma for the address; if
  insufficient, generate PoW in a Web Worker (`Zenon.usePowWorker()` /
  `PowWorker`) and surface a "Generating PoW" UI state. Also implements
  `fusePlasma(tier)` → `POST {VITE_PLASMA_BOT_URL}/api/agent/fuse {address, tier}`.
- `zenon/account` — balances by ZTS, unreceived-block auto-receive (subscription
  + poll), token decimals cache.
- `zenon/htlc` — pure helpers: build Create/Unlock/Reclaim templates, validate
  an on-chain `HtlcInfo` against expected terms, extract and verify the
  preimage from an Unlock account block (`sha256(preimage) == hashLock`).
- `zenon/trade-client` — implements the executor behind the coordinator's
  `prepare_*_lock / prepare_*_claim / prepare_*_refund`, `execute_*_operation`,
  `observe_base / observe_quote`, and `reconcile_wallet` actions.

## 3. Settlement protocol on Zenon

Roles keep granola's convention. Maker locks the base leg first with the long
locktime; taker locks the quote leg with the short locktime; maker unlocks the
quote leg (revealing the preimage on-chain); taker unlocks the base leg.

| Step | Zenon action |
|---|---|
| Maker locks base | `htlc.Create(hashLocked=takerAddr, expirationTime=longLocktime, hashType=1 (SHA256), keyMaxSize=32, hashLock=H)` with base ZTS + amount |
| Taker verifies | `embedded.htlc.getById(id)` — checks `hashLocked`, `tokenStandard`, `amount`, `hashLock`, `expirationTime`, `hashType`, `keyMaxSize` |
| Taker locks quote | `Create(hashLocked=makerAddr, expirationTime=shortLocktime, same H)` with quote ZTS |
| Maker verifies | same check on the quote HTLC |
| Maker claims quote | `Unlock(quoteId, preimage)` — preimage is now public in the account block data |
| Taker observes | subscription/poll on the quote HTLC; on Unlock, read preimage from the block, verify against H |
| Taker claims base | `Unlock(baseId, preimage)` |
| Refund | `Reclaim(id)` after `expirationTime`, respecting the existing refund-guard seconds |

Details:

- HTLC id = hash of the Create account block, so it is only known after
  publication. The `lock` DM carries `{chainId, htlcId, tokenStandard, amount,
  expirationTime, hashLock}`; the counterparty never trusts the DM alone — it
  re-reads the HTLC from the node.
- Locktimes are configurable; defaults: short 30 min, long 60 min.
  `createSettlementPlan` keeps its shape (anchor, short/long locktimes, claim
  cutoffs) but uses momentum timestamps from the node instead of mint clocks.
- Unlocked and reclaimed funds arrive as unreceived blocks; `zenon/account`
  auto-receives them. `fill_confirmed` fires after the receive block is confirmed.
- Every step needs plasma or PoW. Plasma failures map to a new
  `plasma_unavailable` error code in the existing atomic-swap error set and
  keep the trade in its current phase (retryable).
- Transcript binding = `chainId + htlcId(s) + tokenStandards + addresses +
  amounts + expirations`, replacing mint/keyset identities. Chain id mismatch
  freezes the trade.
- The `claim_notice` DM is kept as a courtesy hint; the chain is authoritative.

## 4. Orders and markets

- Market = `{ chainId, base: ZTS, quote: ZTS }`. Default market ZNN/QSR
  (`zts1znnxxxxxxxxxxxxx9z4ulx` / `zts1qsrxxxxxxxxxxxxxmrhjll`). The UI shows one
  market at a time, selectable; any ZTS pair is allowed by the data model.
- Price = exact rational quote-per-base in minor units (replaces
  `priceCentsPerBtc`). Token decimals are fetched from `token.getByZts` and cached.
- Nostr order events keep granola's addressable kind `30078`, schema
  `zwap/order/v1`, tags: `chain`,
  `base`, `quote`, `side`, `price`, `amount`, `expiry`, `execution`, `min`.
- Makers still sign orders with an ephemeral per-order Nostr key. Zenon
  addresses appear only inside encrypted DMs (reserve-accept / lock messages).

## 5. Configuration

`.env` (Vite):

```
# mainnet (default, .env.example)
VITE_ZENON_NODE_WS=wss://my.hc1node.com:35998
# alternative public node: wss://node.zenon.network:35998
VITE_ZENON_CHAIN_ID=1
VITE_PLASMA_BOT_URL=https://plazma.bot
VITE_NOSTR_RELAYS=wss://relay.primal.net,wss://nos.lol,wss://offchain.pub
VITE_NOSTR_INBOX_RELAY=wss://auth.nostr1.com

# testnet (.env.testnet, no plasma bot / faucet yet)
VITE_ZENON_NODE_WS=ws://172.245.236.40:35998
VITE_ZENON_CHAIN_ID=73404
VITE_PLASMA_BOT_URL=
```

The chain id is verified on connect; a mismatch blocks trading. The plasma
button is shown only when `VITE_PLASMA_BOT_URL` is set (plazma.bot fuses on
mainnet only). The UI shows a persistent "mainnet — real funds" badge when
chain id is `1`. go-syrius is the documented companion wallet for funding the
browser address (it supports both networks).

## 6. UI and design system

Use [zenon-design-system](https://github.com/digitalSloth/zenon-design-system)
directly: link `design-system/styles.css` (tokens + fonts + `components.css`)
and use its CSS classes (`.nom-btn--primary`, `.nom-card`, `.nom-badge--*`,
`.nom-address`, `.nom-input`, `.nom-tabs`) from granola's framework-free DOM
code. Brand rules: data is the hero (mono + tabular-nums for amounts,
addresses, hashes); Space Grotesk for UI, JetBrains Mono for data; semantic
tokens only; plasma gradient only on the primary action; Lucide icons, no
emoji; light and dark both tested. `nom-ui` (Vue) and the React components are
not used. `nom-webwallet` is a reference for keystore/PoW/plasma UX, not a
dependency (it exposes no dapp API).

## 7. Agent API

`window.zwap` mirrors `window.granola`: publish/cancel orders, list order book,
take order, list trades, account (address, balances, receive, plasma status,
`fusePlasma(tier)`), backup (password-gated mnemonic). Documented in
`docs/guides/agent-api.md`.

## 8. Testing

- Retain granola's vitest suites for kept modules; delete Cashu suites.
- `zenon/*` unit tests run against an in-memory **fake node** implementing the
  HTLC contract (create/unlock/reclaim/getById, expirations, proxy-unlock
  default), account balances, unreceived blocks and subscriptions. The full
  happy path and both refund paths run against it.
- One integration test gated by `ZENON_INTEGRATION=1` performing a real swap
  between two keystores (funded seeds via env, small amounts, either network);
  documented in `docs/guides/manual-swap.md`.
- `npm run typecheck` + `npm test` in CI; `pages.yml` kept for static deploy.

## 9. Out of scope (this phase)

External wallet signing (nom-webwallet has no provider API; go-syrius
WalletConnect is restricted to bridge methods), cross-chain legs, a testnet
faucet/plasma bot, order matching beyond granola's maker/taker model.
