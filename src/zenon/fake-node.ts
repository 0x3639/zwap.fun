import { bytesToHex, hexToBytes, sha256Hex, sha256Text } from "./hex.js";
import {
  HTLC_ADDRESS, QSR_ZTS, ZNN_ZTS,
  type AccountBlockView, type BalanceView, type HtlcInfoView, type MomentumView,
  type PlasmaView, type SendReceipt, type ZenonNodePort, type ZenonSigner, type ZenonTemplate
} from "./types.js";

interface FakeHtlc extends HtlcInfoView {}

const KNOWN_TOKENS: Record<string, { symbol: string; decimals: number }> = {
  [ZNN_ZTS]: { symbol: "ZNN", decimals: 8 },
  [QSR_ZTS]: { symbol: "QSR", decimals: 8 }
};

export function encodeFakeUnlockData(id: string, preimage: string): string {
  return bytesToHex(new TextEncoder().encode(`unlock:${id}:${preimage}`));
}

export function decodeFakeUnlockData(dataHex: string): { id: string; preimage: string } | null {
  try {
    const text = new TextDecoder().decode(hexToBytes(dataHex));
    const m = /^unlock:([0-9a-f]{64}):([0-9a-f]+)$/.exec(text);
    return m ? { id: m[1]!, preimage: m[2]! } : null;
  } catch {
    return null;
  }
}

export class FakeZenonNode implements ZenonNodePort {
  now: () => number;
  private readonly chainId: number;
  private readonly balances = new Map<string, Map<string, bigint>>();
  private readonly blocks = new Map<string, AccountBlockView[]>();
  private readonly blocksByHash = new Map<string, AccountBlockView>();
  private readonly unreceived = new Map<string, AccountBlockView[]>();
  private readonly htlcs = new Map<string, FakeHtlc>();
  private readonly pow = new Map<string, boolean>();
  private readonly failures = new Map<ZenonTemplate["kind"], Error>();
  private height = 1;
  private addressCounter = 0;

  constructor(options: { chainId?: number; now?: () => number } = {}) {
    this.chainId = options.chainId ?? 1;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  createAddress(label = `addr${this.addressCounter}`): string {
    this.addressCounter += 1;
    const alphabet = "023456789acdefghjklmnpqrstuvwxyz";
    let seed = 0;
    for (const ch of `${label}:${this.addressCounter}`) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
    let body = "";
    for (let i = 0; i < 38; i += 1) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      body += alphabet[seed % alphabet.length];
    }
    return `z1${body}`;
  }

  fund(address: string, zts: string, amount: string): void {
    this.credit(address, zts, BigInt(amount));
  }

  setPow(address: string, requiresPow: boolean): void { this.pow.set(address, requiresPow); }
  failNext(kind: ZenonTemplate["kind"], error: Error): void { this.failures.set(kind, error); }

  signer(address: string): ZenonSigner {
    return { address: () => address, send: (template) => this.apply(address, template) };
  }

  async chainIdentifier(): Promise<number> { return this.chainId; }
  async frontierMomentum(): Promise<MomentumView> {
    this.height += 1;
    return { hash: await sha256Text(`momentum:${this.height}`), height: this.height, timestamp: this.now() };
  }
  async getHtlc(id: string): Promise<HtlcInfoView | null> { return this.htlcs.get(id) ?? null; }
  async getAccountBlock(hash: string): Promise<AccountBlockView | null> { return this.blocksByHash.get(hash) ?? null; }
  async listAccountBlocks(address: string, pageIndex: number, pageSize: number): Promise<AccountBlockView[]> {
    const all = [...(this.blocks.get(address) ?? [])].reverse();
    return all.slice(pageIndex * pageSize, pageIndex * pageSize + pageSize);
  }
  async getBalances(address: string): Promise<BalanceView[]> {
    const map = this.balances.get(address) ?? new Map<string, bigint>();
    return [...map.entries()].filter(([, v]) => v > 0n).map(([zts, v]) => ({
      tokenStandard: zts,
      symbol: KNOWN_TOKENS[zts]?.symbol ?? zts.slice(4, 8).toUpperCase(),
      decimals: KNOWN_TOKENS[zts]?.decimals ?? 8,
      balance: v.toString()
    }));
  }
  async listUnreceived(address: string): Promise<AccountBlockView[]> { return [...(this.unreceived.get(address) ?? [])]; }
  async getTokenDecimals(zts: string): Promise<number> { return KNOWN_TOKENS[zts]?.decimals ?? 8; }
  async getPlasma(address: string): Promise<PlasmaView> {
    return this.pow.get(address) ? { currentPlasma: 0, maxPlasma: 0, qsrFused: "0" } : { currentPlasma: 210000, maxPlasma: 210000, qsrFused: "10000000000" };
  }

  private balance(address: string, zts: string): bigint {
    return this.balances.get(address)?.get(zts) ?? 0n;
  }
  private credit(address: string, zts: string, amount: bigint): void {
    const map = this.balances.get(address) ?? new Map<string, bigint>();
    map.set(zts, (map.get(zts) ?? 0n) + amount);
    this.balances.set(address, map);
  }
  private debit(address: string, zts: string, amount: bigint): void {
    if (this.balance(address, zts) < amount) throw new Error("insufficient balance");
    this.credit(address, zts, -amount);
  }

  private async record(address: string, toAddress: string, zts: string, amount: bigint, blockType: number, data: string, fromBlockHash = "0".repeat(64)): Promise<AccountBlockView> {
    const list = this.blocks.get(address) ?? [];
    const height = list.length + 1;
    const hash = await sha256Text(`${address}:${height}:${toAddress}:${amount}:${data}:${fromBlockHash}`);
    const block: AccountBlockView = {
      hash, height, blockType, address, toAddress, amount: amount.toString(), tokenStandard: zts,
      fromBlockHash, data, confirmations: 1, momentumTimestamp: this.now()
    };
    list.push(block);
    this.blocks.set(address, list);
    this.blocksByHash.set(hash, block);
    return block;
  }

  private async deliver(from: string, to: string, zts: string, amount: bigint, data = ""): Promise<void> {
    const block = await this.record(from, to, zts, amount, 4, data);
    const pending = this.unreceived.get(to) ?? [];
    pending.push(block);
    this.unreceived.set(to, pending);
  }

  private async apply(sender: string, template: ZenonTemplate): Promise<SendReceipt> {
    const injected = this.failures.get(template.kind);
    if (injected) { this.failures.delete(template.kind); throw injected; }
    const now = this.now();
    switch (template.kind) {
      case "send": {
        const amount = BigInt(template.amount);
        this.debit(sender, template.tokenStandard, amount);
        const block = await this.record(sender, template.toAddress, template.tokenStandard, amount, 2, "");
        const pending = this.unreceived.get(template.toAddress) ?? [];
        pending.push(block);
        this.unreceived.set(template.toAddress, pending);
        return { blockHash: block.hash };
      }
      case "receive": {
        const pending = this.unreceived.get(sender) ?? [];
        const index = pending.findIndex((b) => b.hash === template.fromBlockHash);
        if (index < 0) throw new Error("no such unreceived block for this address");
        const [block] = pending.splice(index, 1);
        this.credit(sender, block!.tokenStandard, BigInt(block!.amount));
        const receive = await this.record(sender, sender, block!.tokenStandard, BigInt(block!.amount), 3, "", block!.hash);
        return { blockHash: receive.hash };
      }
      case "htlc_create": {
        if (template.expirationTime <= now) throw new Error("expirationTime must be in the future");
        if (!/^[0-9a-f]{64}$/.test(template.hashLock)) throw new Error("hashLock must be 32 bytes");
        const amount = BigInt(template.amount);
        this.debit(sender, template.tokenStandard, amount);
        const block = await this.record(sender, HTLC_ADDRESS, template.tokenStandard, amount, 2, bytesToHex(new TextEncoder().encode(`create:${template.hashLock}`)));
        this.htlcs.set(block.hash, {
          id: block.hash, timeLocked: sender, hashLocked: template.hashLocked, tokenStandard: template.tokenStandard,
          amount: template.amount, expirationTime: template.expirationTime, hashType: template.hashType,
          keyMaxSize: template.keyMaxSize, hashLock: template.hashLock
        });
        return { blockHash: block.hash };
      }
      case "htlc_unlock": {
        const htlc = this.htlcs.get(template.id);
        if (!htlc) throw new Error("htlc not found");
        if (now >= htlc.expirationTime) throw new Error("htlc expired");
        const preimageBytes = hexToBytes(template.preimage);
        if (preimageBytes.length > htlc.keyMaxSize) throw new Error("preimage exceeds keyMaxSize");
        if ((await sha256Hex(preimageBytes)) !== htlc.hashLock) throw new Error("invalid preimage");
        this.htlcs.delete(template.id);
        const block = await this.record(sender, HTLC_ADDRESS, htlc.tokenStandard, 0n, 2, encodeFakeUnlockData(template.id, template.preimage));
        await this.deliver(HTLC_ADDRESS, htlc.hashLocked, htlc.tokenStandard, BigInt(htlc.amount));
        return { blockHash: block.hash };
      }
      case "htlc_reclaim": {
        const htlc = this.htlcs.get(template.id);
        if (!htlc) throw new Error("htlc not found");
        if (now < htlc.expirationTime) throw new Error("htlc not yet expired");
        if (htlc.timeLocked !== sender) throw new Error("only timeLocked may reclaim");
        this.htlcs.delete(template.id);
        const block = await this.record(sender, HTLC_ADDRESS, htlc.tokenStandard, 0n, 2, bytesToHex(new TextEncoder().encode(`reclaim:${template.id}`)));
        await this.deliver(HTLC_ADDRESS, htlc.timeLocked, htlc.tokenStandard, BigInt(htlc.amount));
        return { blockHash: block.hash };
      }
    }
  }
}
