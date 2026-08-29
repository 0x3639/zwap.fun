# Deploy to Cloudflare Pages (primary)

zwap is a static site with no backend — Vite builds `dist/`, and everything
else (the Zenon node connection, Nostr relays, the plasma bot) is called
directly from the browser. Cloudflare Pages is the primary deployment target;
[Docker/Coolify](deploy-docker.md) is the secondary path for self-hosting.

## One-time setup

1. In the Cloudflare dashboard, **Workers & Pages → Create → Pages → Connect
   to Git**, and select this repository.
2. **Production branch**: `main` (or whichever branch you promote to
   production — at the time of writing this project's default branch is
   `zenon-dex`; point Pages at whatever branch you intend to serve from).
3. **Build settings**:
   - Framework preset: none / Vite
   - Build command: `npm run build`
   - Build output directory: `dist`
4. **Environment variables** (Settings → Environment variables → Production).
   Set `NODE_VERSION=22` so the build uses the same Node major version CI
   uses, plus the `VITE_*` keys from `.env.example` (mainnet values):

   | Variable | Mainnet value |
   | --- | --- |
   | `NODE_VERSION` | `22` |
   | `VITE_ZENON_NODE_WS` | `wss://node.zenon.network:35998` |
   | `VITE_ZENON_CHAIN_ID` | `1` |
   | `VITE_PLASMA_BOT_URL` | `https://plazma.bot` |
   | `VITE_NOSTR_RELAYS` | `wss://relay.primal.net,wss://nos.lol,wss://offchain.pub` |
   | `VITE_NOSTR_INBOX_RELAY` | `wss://auth.nostr1.com` |
   | `VITE_SHORT_LOCK_SECONDS` | `1800` |
   | `VITE_LONG_LOCK_SECONDS` | `3600` |
   | `VITE_HTLC_SCAN_PAGES` | `3` |
   | `VITE_HTLC_PAGE_SIZE` | `100` |

   Vite only inlines `VITE_*` variables that are set at build time, so these
   must be configured as Pages **build** environment variables, not runtime
   secrets — there is no server to read a runtime secret from.
5. Save and deploy. Cloudflare rebuilds and republishes automatically on
   every push to the production branch; there is no separate deploy step or
   GitHub Actions job for this (see [`ci.yml`](../../.github/workflows/ci.yml),
   which only runs the test suite and a local build to gate merges).

## A testnet instance

The public testnet (chain `73404`) has no faucet or plasma bot yet, so a
testnet deployment is mostly useful for reviewing the UI, not for swaps. To
run one anyway, either:

- create a **second Pages project** pointed at the same repository with the
  `.env.testnet` values (`VITE_ZENON_NODE_WS=ws://172.245.236.40:35998`,
  `VITE_ZENON_CHAIN_ID=73404`, `VITE_PLASMA_BOT_URL` left unset); or
- add a **preview-branch environment variable** override in the same Pages
  project (Cloudflare Pages supports distinct env vars for Production vs.
  Preview deployments) with the testnet values, and push to a non-production
  branch to get a preview URL running against testnet.

## Custom domain

Add `zwap.fun` under the Pages project's **Custom domains** tab and follow
Cloudflare's DNS instructions (a `CNAME` to the project's `pages.dev`
subdomain, or an `A`/`AAAA` record if the zone itself is on Cloudflare).
Cloudflare provisions and renews the TLS certificate automatically.

## Why HTTPS matters here specifically

Pages serves every deployment over HTTPS by default, which is a hard
requirement for this app, not just a nicety: `index.html`'s Content Security
Policy allows the page to open `wss://` (secure WebSocket) connections to the
Zenon node and the Nostr relays, and a page served over plain HTTP cannot
open a `wss://` connection reliably in most browsers (mixed active content).
Every `wss://` target and `https://plazma.bot` already appear in
`connect-src` in `index.html` — if you change `VITE_ZENON_NODE_WS` or the
relay list, update the CSP `connect-src` to match, or the browser will block
the connection silently.

## Verify locally before pushing

```bash
npm run build
ls dist/_headers dist/pow.wasm
```

`public/_headers` is copied verbatim into `dist/` by Vite's default
`publicDir` behavior, and Cloudflare Pages reads `_headers` from the deploy
output to set response headers (cache policy for `index.html` vs. hashed
assets, and the correct MIME types for `pow.wasm`/`pow.js`, which some static
hosts otherwise misserve).

Its `/*` block carries the security headers every path needs: `X-Frame-Options:
DENY` and `Content-Security-Policy: frame-ancestors 'none'` (the page holds a
hot signing key - a framing attacker could overlay every confirmation),
`X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`. HSTS
comes from Cloudflare's own TLS settings, not from this file.
