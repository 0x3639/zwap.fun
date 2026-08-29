# ADR 0004: One- or two-mint settlement with staggered Cashu HTLCs

- Status: **superseded** by [ADR 0006: Zenon HTLC embedded contract as the settlement layer](0006-zenon-htlc-settlement.md)
- Date: 2026-07-23

zwap no longer settles with Cashu ecash. This decision and its Cashu-specific
mechanics (mint/keyset topology, NUT-07/NUT-14 spending conditions, the
4-day/7-day testnet locktime profile) applied to granola's original ecash
prototype and do not describe the current Zenon-settled protocol. See
[ADR 0006](0006-zenon-htlc-settlement.md) for the settlement layer zwap
actually uses today.
