# Secondary deployment path (Coolify / self-hosted). Cloudflare Pages is the
# primary target — see docs/guides/deploy-cloudflare.md. This image only
# builds and serves the same static site; there is no backend.
FROM node:22-alpine AS build

# Mainnet defaults. Override at build time (`docker build --build-arg
# VITE_ZENON_CHAIN_ID=73404 ...`, or Coolify's build-arg fields) for a
# testnet image — see .env.testnet for the testnet values.
ARG VITE_ZENON_NODE_WS=wss://node.zenon.network:35998
ARG VITE_ZENON_CHAIN_ID=1
ARG VITE_PLASMA_BOT_URL=https://plazma.bot
ARG VITE_NOSTR_RELAYS=wss://relay.primal.net,wss://nos.lol,wss://offchain.pub
ARG VITE_NOSTR_INBOX_RELAY=wss://auth.nostr1.com
ENV VITE_ZENON_NODE_WS=$VITE_ZENON_NODE_WS \
    VITE_ZENON_CHAIN_ID=$VITE_ZENON_CHAIN_ID \
    VITE_PLASMA_BOT_URL=$VITE_PLASMA_BOT_URL \
    VITE_NOSTR_RELAYS=$VITE_NOSTR_RELAYS \
    VITE_NOSTR_INBOX_RELAY=$VITE_NOSTR_INBOX_RELAY

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:1.27-alpine AS serve
COPY --from=build /app/dist /usr/share/nginx/html
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
