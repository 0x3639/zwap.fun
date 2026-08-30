# Running the gated live-chain integration test

`src/zenon/live.integration.test.ts` runs the exact HTLC happy path — lock,
verify, claim, observe, sweep — against a real Zenon node with real funds. It
is `describe.skipIf`-gated on `ZENON_INTEGRATION=1` and does not run in `npm
test` or CI. Every other test in the suite exercises this logic against the
in-memory fake node (`zenon/fake-node.ts`); this is the one test that proves
the SDK, the embedded contract, and this repo's `zenon/sdk-node.ts`
adaptation actually agree with a live node.

**This spends real ZNN and QSR.** Use two throwaway seeds you do not reuse
anywhere else, and fund them with only the small amounts below.

## 1. Create two throwaway seeds

Generate two fresh 24-word mnemonics with a wallet you trust, independent of
zwap itself:

- [nom-webwallet](https://github.com/digitalSloth/nom-webwallet) — open it,
  choose "Create new wallet" twice (once per seed), and record each mnemonic
  and its first address (index 0).
- [go-syrius](https://github.com/0x3639/go-syrius) — `syrius wallet.new`
  twice, or use its wallet UI's "Create new" flow.

Call one seed "maker" and the other "taker." Never reuse a seed you hold real
funds on, and never paste either mnemonic anywhere other than the
`ZWAP_MAKER_MNEMONIC` / `ZWAP_TAKER_MNEMONIC` environment variables described
below.

## 2. Fund both addresses

The test locks and claims exactly `1000000` minor units per leg — 0.01 ZNN
and 0.01 QSR (8 decimals each). Send a small margin above that so plasma
fusion or a refund still leaves dust behind:

| Address | Send |
| --- | --- |
| maker | ≥ 0.02 ZNN, ≥ 0.02 QSR |
| taker | ≥ 0.02 ZNN, ≥ 0.02 QSR |

Both addresses need a little of both tokens: the base leg is funded by the
maker in ZNN, the quote leg by the taker in QSR, and QSR (or PoW, see below)
is what pays for every account block either address signs, including the
receives at the end. Receive the pending sends in your funding wallet's UI
(nom-webwallet and go-syrius both show unreceived blocks and a receive
action) before running the test — the test's own `assertFunded` pre-flight
check fails fast with a clear message if either balance is short, but it
does not receive pending blocks for you.

## 3. Fuse plasma on both addresses

Every account block (including `htlc.Create`, `htlc.Unlock`, and `receive`)
needs plasma or proof-of-work. This test signs through
[`test/helpers/sdk-signer.ts`](../../test/helpers/sdk-signer.ts)'s
`SdkSigner` — the SDK-signing core the app's own in-page signer used before
it was removed in favor of a browser-extension wallet (see [ADR
0006](../adr/0006-zenon-htlc-settlement.md)). Its comment is explicit: it
installs no PoW provider, so **the addresses this test runs against must
hold fused plasma**. Fuse ≥ 10 QSR on each address — either through
nom-webwallet/go-syrius directly, or the community bot at
`https://plazma.bot` — and wait a few minutes for it to become spendable.

If plasma is not fused, `znn-typescript-sdk` itself still falls back to
computing proof-of-work under Node (`generatePoW`'s `init()` detects
`isNode()` and loads `pow.wasm`/`pow.js` straight from the SDK's own `lib/`
directory via `fs` and a dynamic `import()` — no browser, no worker, no
extra wiring needed), which is why the test's timeout is a generous 600 s.
`SdkSigner` neither relies on nor blocks this fallback, but it can add tens
of seconds per block across up to five signed blocks (two locks, two
claims, up to two receives), so fusing plasma first is faster and the
scenario this doc verifies.

## 4. Run the test

```bash
ZENON_INTEGRATION=1 \
ZENON_NODE_WS=wss://my.hc1node.com:35998 \
ZENON_CHAIN_ID=1 \
ZWAP_MAKER_MNEMONIC="<24 words>" \
ZWAP_TAKER_MNEMONIC="<24 words>" \
npx vitest run src/zenon/live.integration.test.ts
```

`ZENON_NODE_WS` and `ZENON_CHAIN_ID` default to zwap's mainnet configuration
(`.env.example`'s values) if omitted, but pass them explicitly if you are
targeting a different node — for example the public testnet, chain `73404`,
which has no community plasma-fusion service yet, so budget for the
in-test proof-of-work fallback there instead. An alternative public node is
available at `wss://node.zenon.network:35998`.

What the run does, in order: connects to the node; checks both addresses'
balances (fails fast if either is short); generates one preimage/hash pair;
has the maker lock 0.01 ZNN (long, 3600 s locktime) and the taker verify it;
has the taker lock 0.01 QSR (short, 1800 s locktime) and the maker verify it;
has the maker claim the quote leg, revealing the preimage on chain; polls
`observe` on the quote leg until it reports `UNLOCKED`; has the taker claim
the base leg with that preimage; polls `observe` on the base leg until it
too reports `UNLOCKED` (proving both legs, not just the one whose reveal the
first poll already confirmed); and finally sweeps both parties' pending
receives with `ZenonAccount.receiveAll()` so the swapped funds land in
spendable balances. Each `observe` poll is up to 30 attempts, 10 s apart
(5 minutes), inside the test's overall 600 s timeout.

If the run fails after either lock was created, it prints (to stderr) the
HTLC id and expiration time for every lock created so far, and how to
reclaim it — see the next section. It never prints a seed or the preimage.

## 5. Reclaim leftovers after expiry

If the run fails partway through, funds are never lost — they sit in an
on-chain HTLC that only unlocks with the preimage (which the failed run may
or may not have revealed) or reclaims back to the sender after expiry plus a
60 s grace period. The test's own failure output gives you the exact HTLC id
and expiration time to act on; to reclaim:

- **Using the zwap UI**: connect the browser-extension wallet holding the
  account that created the lock (the sender, i.e. `timeLockedAddress`) —
  import that seed into the extension if it is not there already — wait
  until the printed expiration time has passed, and use the custody/reclaim
  panel's **Reclaim** action for that HTLC id.
- **Using go-syrius or nom-webwallet directly**: call the HTLC embedded
  contract's `Reclaim(id)` method with the id printed by the failed run, from
  the address that created that lock, once `now >= expirationTime + 60s`.

You do not need the preimage to reclaim — only to claim before expiry.

## Reference run

*(Template — fill in after the first successful run against mainnet.)*

- Date (UTC):
- Node URL / chain id:
- Base leg (ZNN) HTLC id:
- Quote leg (QSR) HTLC id:
- Base `Create` block hash:
- Quote `Create` block hash:
- Quote `Unlock` block hash (preimage reveal):
- Base `Unlock` block hash:
- Wall-clock duration:
- Notes (PoW vs. fused plasma, any retries):

## What this run validates that the fake-node tests cannot

`isNotFound` in `src/zenon/sdk-node.ts` is a heuristic: it maps a spent
HTLC's `getById` error to `null` by matching on message text (`/not found|no
htlc|null/i`) or a JSON-RPC `-32000` code, because the SDK does not expose a
typed "not found" error. Every other test in this repo runs against
`zenon/fake-node.ts`, which never has to guess at this — it can just return
`null` directly. This live run is the only place that heuristic meets a real
node's real error text.

If a real node ever returns something `isNotFound` does not recognize — for
example after the taker's `Unlock` spends the base HTLC, a subsequent
`getById` on it should look like "not found" to the maker's `observe` call
but instead throws unrecognized — **widen the regex in `isNotFound`** and
record the exact observed error text (message and/or code) in [ADR
0006](../adr/0006-zenon-htlc-settlement.md)'s "Known limitations" section, so
future readers know which node/version combination produced it.
