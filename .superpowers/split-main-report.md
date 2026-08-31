# refactor: split main.ts into app modules

Pure restructuring of the composition root. No behavior change intended or made:
identical `window.zwap` surface, identical DOM ids and selectors, identical
user-facing strings, identical startup ordering and error handling.

## Module map

| File | Responsibilities | Lines |
| --- | --- | --- |
| `src/main.ts` | Bootstrap only: theme paint, config, storage driver, account/outbox locks, maker identity, relay client, order service/outbox/`OrderApi`, provider discovery, node connect + `ZwapApi` (top-level `await`, `catch` → `blockTrading`), the memoised `tradeController()` composition and `resetTradeController()`, the token lookup cell, instantiation of the four app surfaces, Web Locks notice, masthead badge, startup loop, `pagehide`. | 274 |
| `src/app/status.ts` | The `#status` bar (`showStatus`/`clearStatus`/`report`), `blockTrading`/`blockedReason()`/`unavailable()`, `disableRetryActions`, and the activity log (`log`, `trace`, the 100-entry ring, `renderActivityLog` wiring). Module-level pure helpers `messageOf`, `shortIdentifier`, `publicNpub`. Leaf module — imports nothing from `src/app`. | 134 |
| `src/app/wallet.ts` | Wallet lifecycle: `refresh` (the single wallet paint), painted-connectedness tracking + `repaintWalletDependentSurfaces` hookup, `setWalletGating`, `teardownWallet`, `requireWallet`, `accountHandlers`, `walletHandlers`, the `accountsChanged` reaction, the `#refresh` button listener, and the wallet-backed facade operations (`getState`, `connectWallet`, `disconnectWallet`, `receivePending`, `send`). | 222 |
| `src/app/trading.ts` | Order book (`refreshOrderBook`), trades (`refreshTrades`, `renderTradesEmptyState`, node-unavailable card), publications (`refreshPendingPublications`, `retryPendingPublication`), `takeOrderFromBook`, `cancelOrderFromBook`, `publishOrderWithFunding`, `assertOrderFunding`, `TOKEN_SYMBOLS`, `tradeTrace` + its dedup sets and `clearTradeTraces`, the `TakeRequestRegistry`, the body of `repaintWalletDependentSurfaces`, and the `#refresh-orderbook` / `#refresh-trades` listeners. Mounts the order form. | 383 |
| `src/app/order-form.ts` | The publish form: `requiredOrderInput`, the settlement hint (`updateOrderSettlementHint` + its input/change/invalid listeners and initial call) and the `submit` handler. Split out of `trading.ts` to keep that file near the size target; it is a self-contained surface whose only outward reach (`publishOrder`, `refreshOrderBook`, `refreshPendingPublications`) is injected. | 106 |
| `src/app/maker-inbox.ts` | `syncMakerInboxes`, `startMakerInbox`, the resync-queued flag, retry attempt counter and backoff timer. | 92 |
| `src/app/facade.ts` | `ZwapBrowserFacade` type + the `declare global` for `window.zwap`, assembly and installation of the facade, `RESET_LOCAL_DATA_CONFIRMATION` + `resetLocalData`, the reset-local-data gate and button listener, and `runAgentSettlement` with its `zwap:run-until-settled` document listener and `?runUntilSettled=` URL trigger. | 161 |

Total 1372 lines vs the original 1006 — the growth is dependency interfaces and
factory plumbing, not logic.

## Seams and how circular needs are resolved

Construction order in `main.ts`: `status` → `tradeController()`/`resetTradeController()`
(function declarations, only ever invoked later) → provider discovery → `wallet`
→ node connect try/catch → `makerInbox` → `trading` → Web Locks notice → facade →
badge → startup loop → `pagehide`.

Every factory takes its dependencies as arguments. The genuinely circular runtime
needs are late-bound function references, exactly as the original relied on
hoisting:

- `wallet` needs `trading.clearTradeTraces` and `trading.repaintWalletDependentSurfaces`
  → passed as arrows that dereference the later `const trading` at call time.
- `tradeController()`'s `onChange`/`onMakerAccepted` callbacks reach `trading` and
  `wallet` the same way.
- `trading` needs `wallet.refresh`/`wallet.requireWallet` and
  `makerInbox.syncMakerInboxes` → both already constructed, passed directly.
- No module re-reads a global; `walletApi` and `tokens` stay as `let` cells in
  `main.ts`, exposed to the surfaces as `() => walletApi` / `() => tokens` readers
  and a `setTokens` writer.

Import graph is acyclic: `status` is a leaf; `order-form` → `status`; `trading` →
`status`, `order-form`; `wallet`, `maker-inbox`, `facade` → `status`; `main` → all.

## Deliberate substitutions (behaviour-identical)

The original called several operations through the local `zwap` const, which
created a false dependency from `trading`/`maker-inbox` onto the facade. Since
`zwap`'s properties are never reassigned, each was replaced by the identical
underlying call:

- `zwap.takeOrder(x)` / `zwap.runUntilSettled(x)` → `(await tradeController()).takeOrder(x)` / `.runUntilSettled(x)`
- `zwap.retryOrderPublication(x)` / `zwap.cancelOrder(x)` → `orderApi.<same>(x)` (the facade entries are `.bind(orderApi)`)
- `zwap.publishOrder(x)` → `publishOrderWithFunding(x)` (the facade entry *is* that function)
- `zwap.getMakerPublicKeys()` → `orderApi.getMakerPublicKeys()`
- `zwap.enableMaker()` → `tradeController().then((c) => c.enableMaker())`
- `zwap.receivePending`/`connectWallet`/`disconnectWallet` in the wallet handlers →
  the same closures `wallet.ts` now also hands to the facade, so there is exactly
  one implementation of each.

`runAgentSettlement` still goes through the facade object it builds, as before.

## Ordering audit

- Top-level `await` bootstrap kept: theme → status → wiring → `await detectInjectedProvider`
  → `await SdkZenonNode.connect` in `try`/`catch` → `blockTrading` on failure.
  `createWalletSurface` is now called between the discovery await and the connect
  try; it is synchronous, paints nothing, and only registers the `#refresh` listener.
- Activity-log entry order preserved: the Web Locks notice is emitted before the
  facade is installed and before `log("Opened zwap")`, matching the original
  line 724 → line 1001 order.
- The `?runUntilSettled=` URL trigger still fires after `window.zwap = zwap` and
  after the Web Locks notice, before the badge.
- Button listeners moved to the module that owns each surface (`#refresh` → wallet;
  `#refresh-orderbook`/`#refresh-trades`/order form → trading/order-form;
  `#reset-local-data` → facade), so they register slightly earlier in the module
  body than before. Registration is inert until clicked, and `blockTrading` disables
  by selector rather than by handler, so gating is unaffected.
- `teardownWallet` still does `disconnect()` → synchronously null the memoised
  controller and reset the runtime → `await stop()` → clear the trace dedup sets,
  in that order (`resetTradeController` runs synchronously up to its first `await`).

All comment texts that encode security or design rationale moved with the code
they describe, unedited.

## Left in main.ts, and why

- `tradeController()` / `resetTradeController()` and the `tradeControllerPromise`,
  `createTradeRuntime`, `resetTradeRuntime` cells. The task assigns
  "trade runtime/controller composition" to the bootstrap, and this is the one
  piece every other surface depends on; keeping it here is what makes the
  dependency graph acyclic.
- `walletApi` and the `tokens` lookup. Both are single mutable cells written by
  one surface and read by several; hoisting them into the bootstrap and handing
  out readers/writers keeps them out of module scope in the shared files, as
  required.
- `byId` and the element lookups. Elements are passed to each factory explicitly
  rather than each module re-resolving ids, so the DOM contract stays visible in
  one place.

## Self-review notes

- Diffed every string and template literal in the old `main.ts` against the union
  of the new files: no user-facing string, DOM id, CSS selector, dataset key, or
  error message was added, removed, or altered. The only new literals are TypeScript
  indexed-access type keys (`ZwapApi["connect"]` and friends) and words inside new
  doc comments.
- Checked every import in the new files for unused symbols (none) and confirmed
  the `src/app` import graph has no cycles.
- One genuinely different-but-inconsequential edge: the `Missing #<id>` /
  `Missing order input <name>` / `Missing order submit button` throws now happen
  during surface construction rather than after `window.zwap` is installed, and
  the theme is painted before the first `getElementById`. These only differ on a
  page whose markup is missing a required element; `index.html` is unchanged and
  is asserted by `src/shell.test.ts` to carry all of them.
- `src/main.ts` is 274 lines against a ~250 aim and `src/app/trading.ts` is 383
  against ~350. Both are close; splitting further would have meant cutting
  cohesive surfaces (e.g. separating `tradeTrace` from the trades panel it
  annotates), which the task explicitly assigns to `trading.ts`.
- No test file was touched.

## Gate

```
$ npx tsc --noEmit
(clean, no output)

$ npx vitest run
 Test Files  60 passed | 1 skipped (61)
      Tests  597 passed | 1 skipped (598)

$ npm run build
✓ built in 388ms
```

Pre-existing, unrelated build warnings (direct `eval` inside
`znn-typescript-sdk`, >500 kB chunk) are unchanged.
