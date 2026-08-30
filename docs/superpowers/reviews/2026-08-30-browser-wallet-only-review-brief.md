# Review brief: browser-wallet-only (aee4db5..1c4cd17 on main)

Review request for the range `git diff aee4db5..1c4cd17` (12 commits, 65 files,
+3010/−3031). Spec: `docs/superpowers/specs/2026-08-30-browser-wallet-only-design.md`
(the binding authority — it was amended twice during the work, deliberately).
Plan: `docs/superpowers/plans/2026-08-30-browser-wallet-only.md`.

## What changed and why

zwap previously had two signing paths: an in-page BIP39 keystore (encrypted in
IndexedDB, with a plasma-bot integration and an in-browser PoW worker) and an
optional browser-extension wallet behind `VITE_INJECTED_WALLET=1`. This change
removes the keystore path entirely: only a browser-extension wallet implementing
the injected provider (`docs/proposals/zenon-injected-provider.md`) signs Zenon
account blocks. The wallet control moved to the masthead (install / connect /
address pill + menu). The `?wallet=<name>` profile workspaces were removed.

Nostr signing is intentionally untouched: per-order keys (`src/nostr/identity.ts`)
and per-session keys are generated in-page and encrypted independently of the
wallet. The extension is asked for exactly two methods: `zenon_requestAccounts`
and `zenon_sendBlock`.

## Key files

- `src/api/zwap-api.ts` — new wallet state machine (`absent | detected |
  connected`), derived not stored; single-flight `connect()`; error mapping
  (4001 → "Wallet connection refused", 4901 → "Wallet is on chain N; zwap needs
  chain M"); `accountsChanged: []` → disconnect; non-empty forwarded only while
  connected.
- `src/ui/wallet-control.ts` (+test) — pure-render masthead control; popover
  state keyed per root in a WeakMap; visibility driven by the `hidden`
  attribute (`.wallet-control__menu[hidden]{display:none}` in `styles.css`
  exists because the class sets `display:flex`).
- `src/main.ts` — composition root rewired: discovery hoisted above the node
  connect (a node outage must render as "node unavailable", not "install a
  wallet"); `paintedWalletConnected` edge-trigger repaints order book / outbox /
  trades on connectedness change; `resetLocalData` behind a typed confirmation
  input (`RESET ZWAP DATA`); every signing surface gated while disconnected.
- `src/browser/lock.ts` — profile parameter removed; lock names keep the
  literal `default` segment so they stay byte-identical (cross-tab safety).
  Same constraint: storage name literal `zwap-wallet-default` (`main.ts`).
- Deleted: `keystore-repository`, `keystore-signer` (+PoW worker),
  `plasma-bot`, `keystore-compose`, `wallet-source-guard`, `profile`,
  `seed-dialog`, `vite-pow-plugin` and their tests. SDK signing survives only
  as `test/helpers/sdk-signer.ts` (Node-side, live test + its own test; no app
  imports).
- CSP tightened in `index.html`, `public/_headers`, `deploy/nginx.conf`:
  dropped `'wasm-unsafe-eval'`, `worker-src blob:`, `https://plazma.bot`.
- Docs rewritten: `docs/guides/wallet.md`, `manual-swap.md`, `agent-api.md`,
  deploy guides; ADR 0002/0006 got dated notes.

## Invariants to verify (the load-bearing ones)

1. Nothing signs a Zenon block while disconnected — every path must end at
   `require()` ("Connect your wallet before trading") or a disabled/absent
   control. UI gating is defence in depth, not the only gate.
2. One signer instance per address: the trade runtime must share
   `api.account().signer`; two signers would race the account-chain frontier.
3. Storage name and all six lock names byte-identical to pre-change values —
   existing IndexedDB data (trade journal, encrypted order keys, outbox) must
   survive the upgrade.
4. `accountsChanged` semantics: `[]` → page-local disconnect (teardown, no
   reload); `[other]` while connected → reload; anything while *disconnected* →
   ignored. The provider-level subscription is registered once and deliberately
   never reset (comment in `zwap-api.ts` explains why).
5. Verbatim UI/error strings are contract: the spec's Errors table, the
   "Connect your wallet first" titles, `RESET ZWAP DATA`.
6. `src/trade/**`, `src/nostr/**`, `src/storage/**` are unchanged except
   `storage/driver.ts` (one error string). Any other diff there is a bug.

## Deliberate decisions — don't re-flag, but do challenge if you disagree

- Cancel and Receive-pending are *not rendered* while disconnected (rather
  than disabled-with-title); Sign/Take/Retry are disabled with
  `title="Connect your wallet first"`. Spec was amended to say this.
- The masthead pill and popover show first-6…last-6 (`truncateAddress(addr, 6)`);
  the spec's older "full address in mono / truncateAddress(address)" wording at
  spec lines ~129/132 is stale (known, follow-up).
- Sessions/order keys are keyed to the browser, not the signing address;
  switching extension accounts reloads. Documented limitation in `wallet.md`.
- `test/helpers/sdk-signer.ts` keeps SDK key-pair signing for the gated live
  integration test only; it has no PoW provider (live-test addresses hold
  fused plasma).
- Working directly on the repo (no worktree); `npm run lint` in the plan's
  gate was never a real script — the gate is `tsc --noEmit`, `vitest run`
  (582 passing / 1 gated skip), `npm run build`.

## Known open items (already tracked; flag only if you see them as worse than minor)

1. Reset confirmation gate compares `value.trim()` but the click passes the
   untrimmed value — trailing whitespace arms the button, then fails safe.
2. DM metadata: sender NIP-42-AUTHs to the inbox relay with its session/maker
   key while publishing an ephemerally-signed gift wrap (relay can link
   sender→recipient); the wrap `expiration` tag is deterministic
   (`expires_at + 3600`) and re-reveals the send time that the randomized
   `created_at` hides.
3. `TradeSessionRepository` never prunes finished sessions (keys/preimages
   persist, encrypted, indefinitely).
4. Reserve-slot griefing: a well-formed `reserve_propose` from anyone claims an
   order's single live maker slot until it expires.
5. `INSTALL_URL` in `wallet-control.ts` is a placeholder until the extension
   has a store listing.
6. No focus management on the `role="menu"` popover (a11y); document listeners
   linger if the root is removed while the menu is open (single permanent root
   today).

## What a fresh review would add most value on

- The `main.ts` composition root end-to-end (it was rewired, not restructured;
  restructuring was an explicit non-goal): startup ordering, the node-outage
  branch, teardown paths, the maker-inbox retry guards.
- The `ZwapApi` connect/disconnect races: `disconnect()` during an in-flight
  `doConnect()` resurrects the connection when the promise resolves (reachable
  only via `window.zwap.disconnectWallet()` today).
- CSP completeness against everything the built app actually loads.
- Whether any deleted-module reference survives outside `docs/` history files.
