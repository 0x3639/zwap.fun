# Browser-wallet-only zwap

- Status: Approved design
- Date: 2026-08-30
- Supersedes the keystore-wallet sections of
  [2026-08-28-zwap-zenon-dex-design.md](2026-08-28-zwap-zenon-dex-design.md)

## Goal

zwap signs Zenon account blocks only through a browser-extension wallet that
implements the injected provider described in
`docs/proposals/zenon-injected-provider.md`. The in-page keystore (BIP39
seed in encrypted IndexedDB), and everything that existed only to serve it,
is removed. The wallet control moves to the masthead, where web3 users
expect it.

Non-goals: restructuring `src/main.ts` into modules (follow-up), changing
the trade, Nostr, or storage layers, supporting more than one provider at a
time.

## Wallet model

Discovery always runs at startup (`detectInjectedProvider`); the
`VITE_INJECTED_WALLET` flag is removed. The page is in exactly one of three
wallet states:

| State       | Meaning                                              |
| ----------- | ---------------------------------------------------- |
| `absent`    | No provider announced within the discovery window.   |
| `detected`  | A provider announced; no account has been granted.   |
| `connected` | `zenon_requestAccounts` returned an address.         |

`ZwapApi` (`src/api/zwap-api.ts`) becomes the wallet-state owner instead of
the keystore owner:

```ts
interface ZwapState {
  wallet: "absent" | "detected" | "connected";
  providerName: string | null;   // from the announcement, when detected
  address: string | null;
  network: string;
  chainId: number;
  balances: BalanceView[];
  unreceived: number;
  plasma: PlasmaView | null;
}

class ZwapApi {
  constructor(deps: { node: ZenonNodePort; config: ZwapConfig;
                      provider: DetectedProvider | null });
  getState(): Promise<ZwapState>;
  connect(): Promise<ZwapState>;      // detected -> connected, or throws
  disconnect(): void;                 // connected -> detected
  account(): ZenonAccount | null;     // the signer-backed account, when connected
  receivePending(): Promise<ZwapState>;
  send(to, tokenStandard, amount): Promise<SendReceipt>;
  onAccountsChanged(handler: (accounts: string[]) => void): void;
}
```

Removed from the API: `createWallet`, `importWallet`, `revealMnemonic`,
`clearWallet`, `forgetWallet`, `fusePlasma`, `powRequired`,
`plasmaBotAvailable`, `walletSource`.

`account()` returns `null` unless connected; `createTradeRuntime` in
`main.ts` throws "Connect your wallet before trading" on `null`.

### Account changes

- `accountsChanged: []` (site grant revoked, or the wallet locked out the
  site) is handled as `disconnect()`: the page returns to `detected`, the
  trade runtime is torn down, and the activity log records "Wallet
  disconnected".
- `accountsChanged: [other]` reloads the page, as today: the signing
  address is the identity of every open session and half-migrating is
  worse than restarting.

## Deleted code

| Path                                   | Reason                                   |
| -------------------------------------- | ---------------------------------------- |
| `src/zenon/keystore-repository.ts`     | seed storage                             |
| `src/zenon/keystore-signer.ts`         | in-page signer + PoW worker              |
| `src/zenon/plasma-bot.ts`              | plasma for the in-page signer only       |
| `src/browser/keystore-compose.ts`      | keystore wiring                          |
| `src/browser/wallet-source-guard.ts`   | keystore-vs-injected guard               |
| `src/browser/profile.ts`               | `?profile=` workspaces                   |
| `src/ui/seed-dialog.ts`                | seed reveal / erase dialogs              |
| `vite-pow-plugin.ts`, `public/pow.*`   | PoW wasm for the in-page signer          |
| tests of all of the above              |                                          |

Config removals: `VITE_INJECTED_WALLET`, `VITE_PLASMA_BOT_URL` (`.env*`,
`Dockerfile` ARG/ENV, `src/config.ts`), `https://plazma.bot` and the
`'wasm-unsafe-eval'` / `worker-src blob:` entries in both CSPs, the
`/pow.*` `_headers` rules.

`live.integration.test.ts` and `scripts/publish-test-orders.ts` still need a
Node-side signer. `KeystoreSigner`'s SDK-signing core moves to
`test/helpers/sdk-signer.ts` without the PoW worker (the helper requires
fused plasma, which the live-test addresses already have). It is not
imported by app code.

Locks: the per-profile lock names in `src/browser/lock.ts` lose their
profile suffix. `withAccountLock` stays (it still serialises sends and
receives); `withKeystoreLock` / `withKeystoreWriteLock` go.

## Storage

One namespace per browser origin. `storageNameForProfile("default")` is the
name in use today; the constant keeps that exact value so existing trade
sessions, order keys, and outbox entries are untouched. Nothing else in
`storage/` changes.

Known limitation, documented in `docs/guides/wallet.md`: trade sessions and
per-order Nostr keys are keyed to the browser, not to the signing address.
A session opened with account A cannot be signed by account B; the reload on
account switch keeps this visible rather than hiding it.

## Masthead wallet control

`src/ui/wallet-control.ts` renders into a new `#wallet-control` slot that
replaces `#profile-label` (masthead order: wordmark, network badge, wallet
control, theme toggle).

| State       | Rendering                                                                  |
| ----------- | -------------------------------------------------------------------------- |
| `absent`    | outline button "Install NoM Wallet" → opens the extension's install URL in a new tab (`INSTALL_URL` constant in `wallet-control.ts`, updated when the store listing exists) |
| `detected`  | primary button "Connect wallet"; busy label "Connecting…" via `withButtonFeedback` |
| `connected` | pill button: shield icon + `truncateAddress(address)`, `aria-haspopup="menu"` |

The connected pill toggles a popover (`role="menu"`) anchored under it:
the full address in mono, **Copy address**, **Disconnect**. Escape or an
outside click closes it. Copy uses `navigator.clipboard.writeText` and
reports "Address copied" in the activity log. Disconnect calls
`ZwapApi.disconnect()`.

Component contract:

```ts
renderWalletControl(root: HTMLElement, state: ZwapState, handlers: {
  onConnect(button: HTMLButtonElement): void;
  onDisconnect(): void;
  onCopy(address: string): void;
}): void;
```

Pure render, re-invoked on every `refresh()`; no internal state beyond the
open/closed popover, which the render preserves when the address is
unchanged.

## Page body

- Section 02 "Your Zenon address" becomes the account card only: address,
  balances, plasma, "Receive N pending". When not connected it shows one
  line — "Connect your wallet to see balances and trade" — and nothing else.
  The extension badge, Create/Import wallet, seed reveal, erase wallet, and
  Fuse plasma controls are gone.
- "Sign and post order", "Take", "Cancel", "Retry publication", and
  "Receive pending" are disabled (with `title="Connect your wallet first"`)
  while not `connected`. The order book and trade list remain readable.
- The "Reset profile" danger action becomes "Reset local data" and still
  requires typing `RESET ZWAP DATA`; it erases the trade journal, outbox,
  and order keys. It is the only destructive local action left.
- The "Proof of work" copy in the ledger section goes; the panel says plasma
  is the extension's responsibility.

## Errors

Provider errors keep their `InjectedProviderError` shape and are reported
in the activity log; the wallet state after a failed `connect()` is
`detected`.

| Code / cause                       | Log line                                                  |
| ---------------------------------- | --------------------------------------------------------- |
| 4001 user rejected                 | "Wallet connection refused"                               |
| 4901 chain mismatch                | "Wallet is on chain N; zwap needs chain M"                |
| locked wallet, other provider error| the provider's message, verbatim, prefixed "Wallet:"      |
| no provider at action time         | "Connect your wallet before trading"                      |

Signing errors during a trade are unchanged: the coordinator already treats
a rejected `send` as a failed external action and keeps its checkpoint.

## Tests

- Delete: keystore-repository, keystore-signer, keystore-compose,
  wallet-source-guard, seed-dialog, plasma-bot, profile tests, and the
  keystore branches of `zwap-api.test.ts`, `account-actions.test.ts`,
  `dashboard.test.ts`, `shell.test.ts`.
- Add `src/ui/wallet-control.test.ts`: three states render, connect
  busy-state, popover open/close/escape, copy and disconnect handlers.
- Rewrite `zwap-api.test.ts` over a fake provider: connect success, 4001,
  4901, disconnect clears `account()`, `accountsChanged: []` → detected,
  `receivePending`/`send` refuse when not connected.
- `main`-level: `startup.test.ts` unchanged; add a `trade-runtime` test that
  `createTradeRuntime` throws while disconnected.

## Docs

`docs/guides/wallet.md` (rewrite: install, connect, disconnect, account
switch, local-data reset, the address-keying limitation),
`docs/guides/manual-swap.md` (steps 1–2 become "connect a funded extension
account"; drop the plasma-fuse step), `docs/guides/deploy-cloudflare.md` /
`deploy-docker.md` / `.env.example` (drop the two env vars), `docs/adr/0006`
(note that settlement signs through the injected provider; link the
proposal), `docs/guides/agent-api.md` (API surface).

## Sequence

1. Masthead control + `ZwapApi` rewrite over the provider, keystore still
   compiled but unreachable (page works end to end with the extension).
2. Delete the keystore/plasma/PoW/profile modules, config, CSP, tests.
3. Docs.

Each step leaves `npm run lint && npx tsc --noEmit && npx vitest run &&
npm run build` green.
