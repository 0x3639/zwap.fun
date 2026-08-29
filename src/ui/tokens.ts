import type { BalanceView } from "../zenon/types.js";
import { QSR_ZTS, ZNN_ZTS } from "../zenon/types.js";
import { truncateAddress } from "./format.js";

export interface TokenInfo {
  symbol: string;
  decimals: number;
}

/** The two tokens this market trades. Both are 8-decimal by protocol. */
const KNOWN: Readonly<Record<string, TokenInfo>> = {
  [ZNN_ZTS]: { symbol: "ZNN", decimals: 8 },
  [QSR_ZTS]: { symbol: "QSR", decimals: 8 }
};

export type TokenLookup = (tokenStandard: string) => TokenInfo;

/**
 * Symbols and decimals as the chain reports them, falling back to the two
 * protocol tokens and finally to the truncated ZTS itself — the panel never
 * invents a symbol for a token it has not seen.
 */
export function tokenDirectory(balances: readonly BalanceView[] = []): TokenLookup {
  const observed = new Map<string, TokenInfo>();
  for (const balance of balances) {
    observed.set(balance.tokenStandard, {
      symbol: balance.symbol,
      decimals: balance.decimals
    });
  }
  return (tokenStandard) =>
    observed.get(tokenStandard) ??
    KNOWN[tokenStandard] ??
    { symbol: truncateAddress(tokenStandard), decimals: 8 };
}

export const defaultTokens: TokenLookup = tokenDirectory();
