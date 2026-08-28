import { quoteAmountForSettlement, type OrderSide } from "./model.js";

const AMOUNT = /^[1-9]\d*$/;

export interface FundingRequirementInput {
  side: OrderSide;
  amount: string;
  price: string;
}

export interface FundingRequirement {
  token: "base" | "quote";
  amount: string;
}

/**
 * Which token an order needs funded, and how much of it: the exact base
 * amount for a sell, or the settlement quote amount for a buy.
 */
export function fundingRequirement(input: FundingRequirementInput): FundingRequirement {
  if (!AMOUNT.test(input.amount)) {
    throw new Error("Order amount must be a canonical integer string");
  }
  if (input.side === "sell") {
    return { token: "base", amount: input.amount };
  }
  return { token: "quote", amount: quoteAmountForSettlement(input.amount, input.price) };
}
