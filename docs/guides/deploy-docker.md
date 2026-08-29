# Deploy with Docker (secondary — Coolify or self-hosted)

[Cloudflare Pages](deploy-cloudflare.md) is the primary deployment target.
This path is for self-hosting the same static site — for example with
[Coolify](https://coolify.io)'s Dockerfile build pack, or any other
Docker-capable host.

The image is a two-stage build: `node:22-alpine` runs `npm ci && npm run
build`, then the built `dist/` is copied into an `nginx:1.27-alpine` image
configured by [`deploy/nginx.conf`](../../deploy/nginx.conf). There is no
backend process and no persistent volume — the container serves static
files only.

## Build

The five network-identity `VITE_*` variables are Docker build args, defaulting
to the mainnet values in `.env.example`:

```bash
docker build -t zwap .
```

For a testnet image, override the build args with the values from
`.env.testnet` (leave `VITE_PLASMA_BOT_URL` empty — there is no plasma bot on
testnet today):

```bash
docker build -t zwap-testnet \
  --build-arg VITE_ZENON_NODE_WS=ws://172.245.236.40:35998 \
  --build-arg VITE_ZENON_CHAIN_ID=73404 \
  --build-arg VITE_PLASMA_BOT_URL= \
  .
```

Because these are **build** args, not runtime environment variables, one
image is baked for exactly one network — there is no way to reconfigure a
running container without rebuilding, the same constraint Cloudflare Pages
has.

If you also need non-default locktimes or a non-default relay list, edit the
`ARG`/`ENV` lines in the `Dockerfile` directly, or pass the matching
`--build-arg` after adding it there — the Dockerfile currently only
parameterizes the five variables without a safe code default worth
overriding at deploy time; `VITE_SHORT_LOCK_SECONDS` and
`VITE_LONG_LOCK_SECONDS` already default sensibly in `src/config.ts` if
unset.

## Run

```bash
docker run -d -p 8080:80 zwap
curl -sI localhost:8080/pow.wasm | grep -i 'application/wasm'
```

The `curl` check confirms nginx is serving `pow.wasm` with the correct MIME
type — required for the browser's WebAssembly proof-of-work worker to load;
`node_modules` and any local `.env*` files are excluded from the build
context by `.dockerignore`, so nothing outside `deploy/nginx.conf` and the
built `dist/` reaches the final image.

## Coolify

Point a Coolify application at this repository with the **Dockerfile** build
pack (not Nixpacks/buildpacks — there is no runtime process for Coolify to
detect). Set the same five `VITE_*` variables under the application's
**Build Args** (not Environment Variables — they must be available at
`docker build` time, before nginx ever starts). Coolify handles the reverse
proxy and TLS termination in front of the container's port 80.

## HTTPS

As with Cloudflare Pages, the deployed site's CSP allows `wss://` connections
to the Zenon node and Nostr relays, which browsers generally refuse to open
from a page served over plain HTTP. Put this container behind a TLS-terminating
reverse proxy (Coolify does this automatically; otherwise use Caddy, Traefik,
or nginx with a certificate) rather than exposing port 80 directly to the
public internet.
