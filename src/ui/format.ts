import { priceToHumanPrice } from "../order/human-price.js";

const MINOR_UNITS = /^(0|[1-9]\d*)$/;

function groupInteger(value: string): string {
  return value.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

interface AmountParts {
  whole: string;
  /** Every fractional digit, trailing zeros included. Empty at 0 decimals. */
  fraction: string;
  /** The trailing run of zeros inside `fraction` — dimmed, never dropped. */
  insignificant: string;
}

function splitAmount(amount: string, decimals: number): AmountParts {
  if (!MINOR_UNITS.test(amount)) {
    throw new Error("Amount must be a canonical minor-unit integer string");
  }
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error("Decimals must be a non-negative integer");
  }
  if (decimals === 0) {
    return { whole: groupInteger(amount), fraction: "", insignificant: "" };
  }
  const padded = amount.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals);
  const fraction = padded.slice(-decimals);
  const significant = fraction.replace(/0+$/, "");
  return {
    whole: groupInteger(whole),
    fraction,
    insignificant: fraction.slice(significant.length)
  };
}

/**
 * The exact on-chain amount, at full token precision. Trailing zeros stay in
 * the string — the brand dims them rather than rounding them away, and
 * `renderTokenAmount` is the variant that can actually do the dimming.
 */
export function formatTokenAmount(
  amount: string,
  decimals: number,
  symbol: string
): string {
  const parts = splitAmount(amount, decimals);
  const digits = parts.fraction === "" ? parts.whole : `${parts.whole}.${parts.fraction}`;
  return `${digits} ${symbol}`;
}

/** The same value as a DOM node: mono, tabular, trailing zeros dimmed. */
export function renderTokenAmount(
  amount: string,
  decimals: number,
  symbol: string
): HTMLElement {
  const parts = splitAmount(amount, decimals);
  const node = document.createElement("span");
  node.className = "amount font-mono tabular-nums";
  node.title = formatTokenAmount(amount, decimals, symbol);

  const significant = parts.fraction.slice(
    0,
    parts.fraction.length - parts.insignificant.length
  );
  const lead = parts.fraction === ""
    ? parts.whole
    : `${parts.whole}.${significant}`;
  node.append(document.createTextNode(lead));
  if (parts.insignificant !== "") {
    const dim = document.createElement("span");
    dim.className = "dim";
    dim.textContent = parts.insignificant;
    node.append(dim);
  }
  const unit = document.createElement("span");
  unit.className = "amount__symbol";
  unit.textContent = ` ${symbol}`;
  node.append(unit);
  return node;
}

/**
 * `z1qzal…a0mz` — the full value belongs in a `title`, never dropped. `tail`
 * widens the trailing run for surfaces with room for it (the masthead pill and
 * its popover ask for 6); the default stays 4 so every other caller is unmoved.
 * Below `7 + tail` characters the ellipsis would save nothing, so pass it through.
 */
export function truncateAddress(address: string, tail = 4): string {
  return address.length <= 7 + tail
    ? address
    : `${address.slice(0, 6)}…${address.slice(-tail)}`;
}

/** Hashes and HTLC ids get a longer head: eight hex digits identify them. */
export function truncateHash(value: string): string {
  return value.length <= 17 ? value : `${value.slice(0, 8)}…${value.slice(-8)}`;
}

/** The exact human price, thousands grouped. Trailing zeros are trimmed. */
export function formatHumanPrice(price: string, quoteDecimals: number): string {
  const human = priceToHumanPrice(price, quoteDecimals);
  const [whole = "0", fraction] = human.split(".");
  return fraction === undefined
    ? groupInteger(whole)
    : `${groupInteger(whole)}.${fraction}`;
}

/**
 * A price difference, which a crossed book can make negative or zero.
 * `priceToHumanPrice` only speaks canonical positive integers, so the sign is
 * carried here with the functional `−` glyph the brand allows.
 */
export function formatPriceDelta(delta: bigint, quoteDecimals: number): string {
  if (delta === 0n) return "0";
  const magnitude = formatHumanPrice((delta < 0n ? -delta : delta).toString(), quoteDecimals);
  return delta < 0n ? `−${magnitude}` : magnitude;
}

/** `3.5 QSR/ZNN` — the exact integer price rendered as quote per base. */
export function formatPrice(
  price: string,
  quoteDecimals: number,
  quoteSymbol: string,
  baseSymbol: string
): string {
  return `${formatHumanPrice(price, quoteDecimals)} ${quoteSymbol}/${baseSymbol}`;
}
