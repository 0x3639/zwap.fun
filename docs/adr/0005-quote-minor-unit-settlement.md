# ADR 0005: Integer `price` — quote minor units per 10^8 base minor units

## Status

Accepted. Amends the field this ADR originally defined
(`price_cents_per_btc`, SAT/USD-specific) to `price`, the general two-ZTS-leg
field zwap uses today. The truncation rule and the reasoning below are
unchanged; only the field name, unit, and worked examples moved from
cents-per-BTC to Zenon minor units.

## Context

zwap trades two arbitrary Zenon ZTS tokens (by default ZNN and QSR, both with
8 decimals) instead of SAT against a fiat-minor-unit mint quote. A limit price
still has to be one canonical positive integer — no floating point, no GCD
reduction, no numerator/denominator pair — but it can no longer be scoped to
"cents per BTC," because neither leg of a ZTS/ZTS market is guaranteed to be
BTC-shaped or fiat-shaped.

The user-selected base amount remains the economic intent. Truncation on the
quote leg is still preferred to changing the base amount, for the same reason
as before: a maker who asked to sell exactly `N` base minor units should sell
exactly `N`, not a rounded neighbor.

## Decision

Public order state and private trade terms carry one positive canonical
decimal integer string, `price`, defined as **quote minor units per 10^8 base
minor units** — i.e. per one whole base token, regardless of the base token's
own decimal count:

```json
{ "price": "350000000" }
```

Settlement uses integer arithmetic only:

```text
quote_minor = (base_minor * price) / 100_000_000n
```

For positive JavaScript `BigInt` values, `/` truncates the remainder. A result
of zero is rejected (`quoteAmountForSettlement` in `src/order/model.ts`
throws) because no ZTS token can represent a zero-value leg.

`10^8` is fixed in the formula regardless of the base token's actual decimal
count: it mirrors "per whole token" the way `price_cents_per_btc` meant "per
whole BTC" even though BTC amounts were carried in satoshis (also 8
decimals). For ZNN and QSR, both 8-decimal tokens, `price` is directly "quote
minor units per one ZNN," which is why `3.5` QSR per ZNN encodes as
`350000000`.

Human-facing amount and price fields are decimal strings (`"20"` ZNN, `"3.5"`
QSR/ZNN) converted with exact bigint arithmetic — `humanAmountToMinor` for
amounts (never rounds; a fraction finer than the token's decimals is rejected
outright, since this is real-funds input, not a demo) and `humanPriceToPrice`
for price (rounds to the nearest representable minor unit under
`quoteDecimals`, half-up) — both in `src/order/human-price.ts`. The order form
and `describeSettlement` (`src/ui/order-form.ts`) show the exact converted
integers next to the human input before signing.

Examples (`quoteDecimals = 8`, ZNN/QSR):

- `20` ZNN at `3.5` QSR/ZNN → `price = 350000000`, `amount = 2000000000`
  (minor), settles `2000000000 * 350000000 / 100000000 = 7000000000` QSR minor
  units = `70` QSR.
- `1` ZNN at `10.5` QSR/ZNN → `price = 1050000000`, settles `10.5` QSR exactly.
- A base amount and price whose truncated quote is zero minor units is
  rejected at order-creation time.

Each partial fill applies the formula independently against the exact fill
amount. Both parties bind the actual integer quote amount, exact base amount,
and integer `price` into the encrypted trade terms before either HTLC is
created.

## Consequences

- No binary floating point, GCD, numerator, denominator, or "exact ratio" is
  part of pricing.
- Order-book comparison is direct `BigInt` comparison.
- The maker's base quantity is never silently changed by the price
  conversion.
- Any sub-minor-unit remainder is discarded from the quote leg.
- The realized rate can differ materially for very small orders, though the
  absolute difference is always less than one quote minor unit per fill.
- Orders whose truncated quote is zero remain invalid because Zenon cannot
  settle a zero-value HTLC leg.
- Counterparties can deterministically recompute and validate the settlement
  amount using integer arithmetic.
- `price` is generic to any two-ZTS-token market; a market whose base token
  has a decimal count other than 8 still divides by the fixed `10^8`, because
  `price` is defined per whole base token, not per base minor unit.

## Executable vectors

- `src/order/model.test.ts`: base/price pairs settle the expected truncated
  quote amount, and a truncated-to-zero pair is rejected.
- `src/order/human-price.test.ts`: human-entered amount and price round-trip
  through the exact bigint conversions.
- `src/order/funding.ts` / its tests: the funding check for a buy order uses
  the same `quoteAmountForSettlement` formula the settlement plan will use.
