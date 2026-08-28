const HUMAN_PRICE = /^(0|[1-9]\d*)(?:\.(\d{1,8}))?$/;
const PRICE = /^[1-9]\d*$/;

function nonNegativeInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
}

/**
 * Convert a decimal "quote per base" string into the integer `price`
 * (quote minor units per 10^8 base minor units). The conversion is exact
 * bigint arithmetic on the decimal string; it never touches floating point.
 */
export function humanPriceToPrice(human: string, quoteDecimals: number): string {
  nonNegativeInteger(quoteDecimals, "Quote decimals");
  const match = HUMAN_PRICE.exec(human);
  if (!match) {
    throw new Error(
      "Human price must be a plain positive decimal with at most 8 fractional digits"
    );
  }
  const whole = match[1] as string;
  const fraction = match[2] ?? "";
  if (whole === "0" && fraction.replace(/0+$/, "") === "") {
    throw new Error("Human price must be greater than zero");
  }
  const numerator = BigInt(whole + fraction);
  const fractionLength = fraction.length;
  let price: bigint;
  if (quoteDecimals >= fractionLength) {
    price = numerator * 10n ** BigInt(quoteDecimals - fractionLength);
  } else {
    const divisor = 10n ** BigInt(fractionLength - quoteDecimals);
    const quotient = numerator / divisor;
    const remainder = numerator % divisor;
    price = remainder * 2n >= divisor ? quotient + 1n : quotient;
  }
  if (price <= 0n) {
    throw new Error("Human price must round to at least one minor unit");
  }
  return price.toString();
}

/**
 * Convert the integer `price` (quote minor units per 10^8 base minor units)
 * back into a decimal "quote per base" string, using exact bigint arithmetic.
 */
export function priceToHumanPrice(price: string, quoteDecimals: number): string {
  if (!PRICE.test(price)) {
    throw new Error("Price must be a canonical positive integer string");
  }
  nonNegativeInteger(quoteDecimals, "Quote decimals");
  const padded = price.padStart(quoteDecimals + 1, "0");
  const whole = padded.slice(0, padded.length - quoteDecimals) || "0";
  const fraction = quoteDecimals > 0 ? padded.slice(-quoteDecimals) : "";
  const trimmedWhole = whole.replace(/^0+(?=\d)/, "");
  const trimmedFraction = fraction.replace(/0+$/, "");
  return trimmedFraction ? `${trimmedWhole}.${trimmedFraction}` : trimmedWhole;
}
