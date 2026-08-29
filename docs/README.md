# zwap documentation

## Protocol reference

- [Security invariants](protocol/security-invariants.md)
- [Step 7: minimal swap coordinator](protocol/step7-minimal-coordinator.md)

## Guides

- [Manual swap walkthrough](guides/manual-swap.md)
- [Browser agent API](guides/agent-api.md)
- [Wallet notes](guides/wallet.md)
- [Deploy to Cloudflare Pages](guides/deploy-cloudflare.md)
- [Deploy with Docker](guides/deploy-docker.md)

## Architecture decisions

- [ADR 0001: Ephemeral Nostr order projections](adr/0001-nostr-order-events.md)
- [ADR 0002: Ephemeral per-order Nostr signing keys](adr/0002-maker-signing-identity.md)
- [ADR 0003: Nostr private swap messages](adr/0003-nostr-private-swap-messages.md)
- [ADR 0004: One- or two-mint settlement with staggered Cashu HTLCs](adr/0004-cashu-htlc-settlement.md) — superseded, see ADR 0006
- [ADR 0005: Integer `price` — quote minor units per 10^8 base minor units](adr/0005-quote-minor-unit-settlement.md)
- [ADR 0006: Zenon HTLC embedded contract as the settlement layer](adr/0006-zenon-htlc-settlement.md)
