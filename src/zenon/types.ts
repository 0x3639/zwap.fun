export type HtlcState = "UNKNOWN" | "LOCKED" | "UNLOCKED" | "RECLAIMED";
export const HTLC_HASH_TYPE_SHA256 = 1 as const;
export const HTLC_KEY_MAX_SIZE = 32 as const;
export const HTLC_ADDRESS = "z1qxemdeddedxhtlcxxxxxxxxxxxxxxxxxygecvw";
export const ZNN_ZTS = "zts1znnxxxxxxxxxxxxx9z4ulx";
export const QSR_ZTS = "zts1qsrxxxxxxxxxxxxxmrhjll";
export interface HtlcInfoView { id: string; timeLocked: string; hashLocked: string; tokenStandard: string; amount: string; expirationTime: number; hashType: number; keyMaxSize: number; hashLock: string; }
export interface AccountBlockView { hash: string; height: number; blockType: number; address: string; toAddress: string; amount: string; tokenStandard: string; fromBlockHash: string; data: string; confirmations: number | null; momentumTimestamp: number | null; }
export interface BalanceView { tokenStandard: string; symbol: string; decimals: number; balance: string; }
export interface PlasmaView { currentPlasma: number; maxPlasma: number; qsrFused: string; }
export interface MomentumView { hash: string; height: number; timestamp: number; }
export interface ZenonNodePort {
  chainIdentifier(): Promise<number>;
  frontierMomentum(): Promise<MomentumView>;
  getHtlc(id: string): Promise<HtlcInfoView | null>;
  getAccountBlock(hash: string): Promise<AccountBlockView | null>;
  listAccountBlocks(address: string, pageIndex: number, pageSize: number): Promise<AccountBlockView[]>;
  getBalances(address: string): Promise<BalanceView[]>;
  listUnreceived(address: string): Promise<AccountBlockView[]>;
  getTokenDecimals(zts: string): Promise<number>;
  getPlasma(address: string): Promise<PlasmaView>;
}
export type ZenonTemplate =
  | { kind: "htlc_create"; tokenStandard: string; amount: string; hashLocked: string; expirationTime: number; hashType: 1; keyMaxSize: 32; hashLock: string }
  | { kind: "htlc_unlock"; id: string; preimage: string }
  | { kind: "htlc_reclaim"; id: string }
  | { kind: "receive"; fromBlockHash: string }
  | { kind: "send"; toAddress: string; tokenStandard: string; amount: string };
export interface SendReceipt { blockHash: string; }
export interface ZenonSigner { address(): string; send(template: ZenonTemplate): Promise<SendReceipt>; }
