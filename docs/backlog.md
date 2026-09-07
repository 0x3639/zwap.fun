# Backlog

Open follow-ups, in recommended order. Each item is scoped to be implemented
(and reviewed) on its own branch. Sources: the 2026-08-30 external security
review, the DM-handling trace, per-task code reviews, and deliberate
deferrals recorded in commit messages.

## 1. ~~Wallet-control polish batch~~ — done (`eff52eb`, 2026-08-31)

Deferred minors that share one component surface:

- **Popover a11y**: the `role="menu"` popover moves focus nowhere on open and
  returns it nowhere on close/Escape — a real ARIA-menu gap
  (`src/ui/wallet-control.ts`).
- **Listener lifecycle**: the document `keydown`/`pointerdown` listeners
  linger if the root is removed while the menu is open (single permanent
  masthead root today, so latent).
- **Gating unit coverage**: `setWalletGating` and the connectedness repaint
  logic became testable when `main.ts` split into `src/app/wallet.ts`; they
  have no unit tests (the class of bug the Task-3 review caught by hand).
  Hoist the loop-invariant `blockedReason` guard and stop clobbering
  authored `title` attributes while in there.
- **Disconnected funding message**: `assertOrderFunding` while disconnected
  reports "this wallet holds 0 ZNN" instead of "connect your wallet"
  (`src/app/trading.ts`).
- **Readability**: the `providerName` ternary in `src/api/zwap-api.ts`.

## 2. ~~Early release of an abandoned reservation~~ — done (`39a14fa`, 2026-08-31; new `withdrawn` release reason)

After the deferred-base-lock change, a squatting proposal costs the maker
nothing on chain but still holds the order's public slot until
`reservationExpiresAt` (long + grace, ~70 min). Shrinking that needs a
self-authorized early-release reason in the signed projection schema:
`order/model.ts` currently refuses `expired` before `reservation.expires_at`
and the only other reason (`abort`) requires a taker-signed event.
Implemented as sketched: `withdrawn` reason, self-authorized by the maker
order key; the planner stages it from the frozen-holding-nothing state, the
`long + grace` expiry pin is untouched, and the refund ladder still releases
as `expired`.

## 3. End-to-end mainnet swap test with the extension (manual, needs funds)

The original wallet-extension test sequence was never completed past
connect/disconnect: the extension account held no funds. Still to exercise
on mainnet with small amounts, two funded accounts (maker + taker in
separate browser profiles):

1. Publish a tiny order → HTLC-create sign window → verify the hash in the
   activity log — now expecting the **deferred** flow: accept publishes the
   reservation first, the sign window appears only after the taker's
   session_ack.
2. Lock the wallet mid-session → next sign request surfaces the unlock flow.
3. Settings → revoke the site → `accountsChanged: []` → zwap disconnects.
4. Negative: wallet on the wrong chain → connect fails 4901; a mid-session
   network switch fails the send (4901) before `zenon_sendBlock`.
5. The full settle: take → quote lock → unlock ladder → fill projection,
   plus `docs/guides/live-test.md`'s reference-run checklist.

## 4. ~~Inbox robustness leftovers~~ — done (`ae3e445` + `6b7f9f7`, 2026-08-31)

- `queryGiftWraps` uses `limit: 500` over a 48 h lookback; a flooded inbox
  can push the wanted wrap outside the relay's returned page (the client-side
  accumulation cap from the security fixes bounds memory, not relay
  ordering). Consider paging by `until`, or narrowing `since` from the
  transcript cursor (`src/nostr/inbox.ts`).
- `handleSubscriptionError` swallows `relay_start` silently
  (`src/browser/trade-controller.ts`) — acceptable but undiagnosable; a
  one-line activity trace would help.

Shipped: `queryGiftWraps` pages per relay by `until` (8-page cap,
exclusive `until - 1` step past full-page timestamp plateaus, partial
results kept when a later page fails), and `relay_start` now leaves a
one-line activity trace via a new `onTrace` controller hook. Review
minors deferred, not planned: per-page websocket/AUTH re-handshake in the
production port (worst case 8 x 8 s per relay — consider connection reuse
or a wall-clock budget if it bites), and the 32 KiB wrap-size check still
running post-collection (a hostile relay can park up to ~4000 oversized
blobs per relay transiently; a per-page size pre-filter would restore the
old ceiling).

## 5. Upstream and external waits

- ~~**SDK ESM issue**~~ (digitalSloth/znn-typescript-sdk#33) — worked
  around on our side 2026-09-07: `package.json` now takes the SDK from the
  fork branch `0x3639/znn-typescript-sdk#zwap/tree-shakeable` (lockfile
  pins the commit; npm fetches public GitHub git deps as an https tarball
  and runs the SDK's `prepare` build, verified in the Docker image). The
  fork makes the modular ESM the browser entry with `sideEffects: false`,
  drops Node `crypto` / `crypto-browserify` / `ed25519-hd-key` for
  `@noble/*`, and loads argon2 lazily from the bundled build. Result: the
  924 KB SDK chunk, the 620 KB argon2 chunk, the eval warning, and
  `vite-plugin-node-polyfills` (140 packages) are gone; total JS 2.06 MB →
  0.60 MB; the `src/main.ts` SDK import is static again. Key derivation
  and AES-GCM were cross-checked against the old implementations (1,000
  and 200 random cases). **Still open**: once upstream merges and publishes,
  switch the dependency back to a registry version and drop the git dep.
- **`INSTALL_URL`** in `src/ui/wallet-control.ts` is a placeholder pointing
  at the extension's repository; pin it when the store listing exists.

## 6. Security-pass follow-ups (2026-08-31; decided 2026-09-07)

From the post-review security pass over `6aecb7b..e4a0caf` (no reportable
findings; quick wins shipped on `fix/security-hardening`):

- ~~**`assertTakerClaim` proof-of-control**~~ — accepted and documented
  (see *Accepted limitations* below and the gate's docstring in
  `src/api/trade-api.ts`). Revisit when the take flow's wire format next
  changes: a wallet-signed, session-bound challenge would close it.
- ~~**Generate the CSP from one source at build time**~~ — done. The
  policy lives in `deploy/csp.ts`; a Vite plugin (`deploy/csp-plugin.ts`)
  injects the `<meta>` into both HTML entries in dev and build, emits
  `dist/_headers` from `deploy/_headers.template`, and renders the
  gitignored `deploy/nginx.conf` from `deploy/nginx.conf.template` (the
  Dockerfile now copies it from the build stage). Tests in `deploy/` check
  the rendered outputs and that no hand-written CSP meta creeps back into
  the source HTML.
- **Re-run the external security review** after the manual mainnet test
  and before launch, on the running system.

## Accepted limitations (documented, not planned)

- The anti-squatting gate on incoming reservation proposals
  (`assertTakerClaim`) checks that the *claimed* taker address is funded and
  not already backing another live reservation, but not that the proposer
  controls it. Anyone can name a funded stranger's address. Since the
  deferred base lock, that buys a public slot and nothing on chain, and the
  `withdrawn` release frees the slot early; residual risk is DoS-class
  squatting. Proof of control (a wallet-signed, session-bound challenge)
  is deferred to the next take-flow wire-format change.
- Per-session Nostr secret keys exist transiently as immutable JS strings;
  `fill(0)` clears the byte copies but cannot scrub string interning. Noted
  in the DM trace; no practical JS fix.
- The zenon-side canonicalizers (`trade-client.ts` `canonical`, `htlc.ts`
  single-level sort) stay separate from `order/canonical.ts` /
  `order/legacy-canonical.ts` on purpose: their outputs feed persisted
  commitments with their own comparator (see the consolidation commit).
- Trade sessions are keyed to the browser, not the signing address; an
  extension account switch reloads (documented in `docs/guides/wallet.md`).
