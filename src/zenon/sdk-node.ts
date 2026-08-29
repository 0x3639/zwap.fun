import { Buffer } from "buffer";
import {
  Address, Hash, TokenStandard, Zenon, type AccountBlock, type HtlcInfo
} from "znn-typescript-sdk";
import type {
  AccountBlockView, BalanceView, HtlcInfoView, MomentumView, PlasmaView, ZenonNodePort
} from "./types.js";

export class ChainMismatchError extends Error {
  constructor(readonly expected: number, readonly actual: number) {
    super(`Connected node reports chain ${actual}, expected ${expected}`);
  }
}

export function htlcInfoToView(info: HtlcInfo): HtlcInfoView {
  return {
    id: info.id.toString(), timeLocked: info.timeLocked.toString(), hashLocked: info.hashLocked.toString(),
    tokenStandard: info.tokenStandard.toString(), amount: info.amount.toString(), expirationTime: info.expirationTime,
    hashType: info.hashType, keyMaxSize: info.keyMaxSize, hashLock: Buffer.from(info.hashLock).toString("hex")
  };
}

export function accountBlockToView(block: AccountBlock): AccountBlockView {
  return {
    hash: block.hash.toString(), height: block.height, blockType: block.blockType, address: block.address.toString(),
    toAddress: block.toAddress.toString(), amount: block.amount.toString(), tokenStandard: block.tokenStandard.toString(),
    fromBlockHash: block.fromBlockHash.toString(), data: Buffer.from(block.data).toString("hex"),
    confirmations: block.confirmationDetail?.numConfirmations ?? null,
    momentumTimestamp: block.confirmationDetail?.momentumTimestamp ?? null
  };
}

export interface SdkZenonNodeOptions { nodeUrl: string; chainId: number; connectTimeoutMs?: number; }

export class SdkZenonNode implements ZenonNodePort {
  private constructor(readonly zenon: Zenon, private readonly chainId: number) {}

  static async connect(options: SdkZenonNodeOptions): Promise<SdkZenonNode> {
    Zenon.setChainID(options.chainId);
    Zenon.setNetworkID(options.chainId === 1 ? 1 : options.chainId);
    const zenon = Zenon.getInstance();
    await zenon.initialize(options.nodeUrl, options.connectTimeoutMs ?? 8000);
    const momentum = await zenon.ledger.getFrontierMomentum();
    if (momentum.chainIdentifier !== options.chainId) {
      zenon.clearConnection();
      throw new ChainMismatchError(options.chainId, momentum.chainIdentifier);
    }
    return new SdkZenonNode(zenon, options.chainId);
  }

  disconnect(): void { this.zenon.clearConnection(); }

  async chainIdentifier(): Promise<number> { return this.chainId; }
  async frontierMomentum(): Promise<MomentumView> {
    const m = await this.zenon.ledger.getFrontierMomentum();
    return { hash: m.hash.toString(), height: m.height, timestamp: m.timestamp };
  }
  async getHtlc(id: string): Promise<HtlcInfoView | null> {
    try {
      return htlcInfoToView(await this.zenon.embedded.htlc.getById(Hash.parse(id)));
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }
  async getAccountBlock(hash: string): Promise<AccountBlockView | null> {
    const block = await this.zenon.ledger.getAccountBlockByHash(Hash.parse(hash));
    return block ? accountBlockToView(block) : null;
  }
  async listAccountBlocks(address: string, pageIndex: number, pageSize: number): Promise<AccountBlockView[]> {
    const list = await this.zenon.ledger.getAccountBlocksByPage(Address.parse(address), pageIndex, pageSize);
    return list.list.map(accountBlockToView);
  }
  async getBalances(address: string): Promise<BalanceView[]> {
    const info = await this.zenon.ledger.getAccountInfoByAddress(Address.parse(address));
    if (!info) return [];
    return Object.entries(info.balanceInfoMap).filter(([, v]) => v.balance > 0n).map(([zts, v]) => ({
      tokenStandard: zts, symbol: v.token.symbol, decimals: v.token.decimals, balance: v.balance.toString()
    }));
  }
  async listUnreceived(address: string): Promise<AccountBlockView[]> {
    const list = await this.zenon.ledger.getUnreceivedBlocksByAddress(Address.parse(address), 0, 50);
    return list.list.map(accountBlockToView);
  }
  async getTokenDecimals(zts: string): Promise<number> {
    const token = await this.zenon.embedded.token.getByZts(TokenStandard.parse(zts));
    if (!token) throw new Error(`Unknown token standard ${zts}`);
    return token.decimals;
  }
  async getPlasma(address: string): Promise<PlasmaView> {
    const p = await this.zenon.embedded.plasma.get(Address.parse(address));
    return { currentPlasma: p.currentPlasma, maxPlasma: p.maxPlasma, qsrFused: p.qsrAmount.toString() };
  }
}

const NOT_FOUND_MESSAGE = /not found|no htlc|data not found|does not exist/i;

/**
 * True only when the node itself answered "there is nothing here".
 *
 * The match is deliberately tight. Anything looser - the old rule also matched
 * any message containing "null" - swallows local bugs such as
 * `TypeError: Cannot read properties of null` and reports a live HTLC as
 * absent, which the coordinator reads as a leg that was never funded.
 */
export function isNotFound(error: unknown): boolean {
  if (
    typeof error === "object" && error !== null && "code" in error &&
    (error as { code: unknown }).code === -32000
  ) return true;
  if (error instanceof TypeError) return false;
  const message = error instanceof Error ? error.message : String(error);
  return NOT_FOUND_MESSAGE.test(message);
}
