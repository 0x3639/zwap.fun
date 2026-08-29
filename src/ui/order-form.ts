import type { PublishOrderInput } from "../api/order-api.js";
import { humanAmountToMinor, humanPriceToPrice } from "../order/human-price.js";
import { quoteAmountForSettlement } from "../order/model.js";
import { QSR_ZTS, ZNN_ZTS } from "../zenon/types.js";
import { formatTokenAmount } from "./format.js";
import type { TokenLookup } from "./tokens.js";

/**
 * Two hours is the floor: the settlement plan needs the full long locktime
 * plus its recovery grace to fit inside the order's own lifetime.
 */
export const MIN_ORDER_HOURS = 2;
export const MAX_ORDER_HOURS = 720;
export const DEFAULT_ORDER_HOURS = 24;

const HOURS = /^[1-9]\d*$/;

export interface OrderFormFields {
  side: string;
  /** Human ZNN, e.g. "20" or "1.5" — never minor units. */
  amount: string;
  /** Human QSR per ZNN, e.g. "10.5". */
  price: string;
  hours: string;
}

function groupInteger(value: string): string {
  return value.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * The whole form, converted. Pure so the mapping from what a person typed to
 * what actually gets signed is testable without a DOM — on a real-funds form
 * that conversion is the part worth pinning down.
 */
export function orderFormToPublishInput(
  fields: OrderFormFields | Record<string, string>,
  tokens: TokenLookup,
  now: number
): PublishOrderInput {
  const side = String(fields.side);
  if (side !== "buy" && side !== "sell") throw new Error("Unknown order side");

  const rawHours = String(fields.hours);
  const hours = HOURS.test(rawHours) ? Number(rawHours) : Number.NaN;
  if (!Number.isSafeInteger(hours) || hours < MIN_ORDER_HOURS || hours > MAX_ORDER_HOURS) {
    throw new Error(`Order lifetime must be ${MIN_ORDER_HOURS}–${MAX_ORDER_HOURS} hours`);
  }

  return {
    side,
    amount: humanAmountToMinor(String(fields.amount), tokens(ZNN_ZTS).decimals),
    price: humanPriceToPrice(String(fields.price), tokens(QSR_ZTS).decimals),
    expiresAt: now + hours * 3_600,
    execution: "all_or_none"
  };
}

/**
 * What the order actually settles for, in both the units a person reads and
 * the integers the signature commits to. Returns `null` mid-edit rather than
 * a number that would be wrong.
 */
export function describeSettlement(
  humanAmount: string,
  humanPrice: string,
  tokens: TokenLookup
): string | null {
  const base = tokens(ZNN_ZTS);
  const quote = tokens(QSR_ZTS);
  try {
    const amount = humanAmountToMinor(humanAmount, base.decimals);
    const price = humanPriceToPrice(humanPrice, quote.decimals);
    const quoteAmount = quoteAmountForSettlement(amount, price);
    return (
      `At ${humanPrice} ${quote.symbol} per ${base.symbol}, ` +
      `${humanAmount} ${base.symbol} (${groupInteger(amount)} minor units) ` +
      `settles for exactly ` +
      `${formatTokenAmount(quoteAmount, quote.decimals, quote.symbol)} ` +
      `(${groupInteger(quoteAmount)} minor units) across one HTLC pair.`
    );
  } catch {
    return null;
  }
}
