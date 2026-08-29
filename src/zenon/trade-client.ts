import { sha256Text } from "./hex.js";
import { verifyHtlcMaterial } from "./htlc-material.js";
import { findReclaim, findUnlockPreimage, htlcValidationCommitment, validateHtlcInfo, type ExpectedZenonLock, type ReclaimDecoder, type UnlockDecoder } from "./htlc.js";
import { HTLC_ADDRESS, type HtlcState, type ZenonNodePort, type ZenonSigner } from "./types.js";

export interface PreparedChainOperation {
  version: 1;
  kind: "lock" | "claim" | "refund";
  chainId: string;
  tokenStandard: string;
  amount: string;
  htlcId: string | null;
  expected: ExpectedZenonLock;
  operationCommitment: string;
}
export interface LockSummary { htlcId: string; validationCommitment: string; observedAt: number; }
export interface CompletedLock { blockHash: string; htlcId: string; summary: LockSummary; }
export interface CompletedSpend { blockHash: string; htlcId: string; }
export interface HtlcObservation { state: HtlcState; observedAt: number; preimage: string | null; witnessCommitment: string | null; }

export class ZenonTradeError extends Error {
  constructor(readonly code: string, message = `Zenon trade error: ${code}`) { super(message); }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function operationCommitment(input: Omit<PreparedChainOperation, "version" | "operationCommitment">): Promise<string> {
  return sha256Text(`zwap-operation-v1\n${canonical(input)}`);
}

export interface ZenonTradeClientDependencies {
  node: ZenonNodePort;
  signer: ZenonSigner;
  decodeUnlock: UnlockDecoder;
  decodeReclaim: ReclaimDecoder;
  now: () => number;
  scanPages?: number;
  pageSize?: number;
}

export class ZenonTradeClient {
  private readonly scanPages: number;
  private readonly pageSize: number;
  constructor(private readonly deps: ZenonTradeClientDependencies) {
    this.scanPages = deps.scanPages ?? 3;
    this.pageSize = deps.pageSize ?? 100;
  }

  address(): string { return this.deps.signer.address(); }

  private async artifact(kind: PreparedChainOperation["kind"], expected: ExpectedZenonLock, htlcId: string | null): Promise<PreparedChainOperation> {
    const base = { kind, chainId: expected.chainId, tokenStandard: expected.tokenStandard, amount: expected.amount, htlcId, expected };
    return { version: 1, ...base, operationCommitment: await operationCommitment(base) };
  }

  private assertArtifact(artifact: PreparedChainOperation, kind: PreparedChainOperation["kind"]): void {
    if (artifact.version !== 1) throw new ZenonTradeError("artifact-version");
    if (artifact.kind !== kind) throw new ZenonTradeError("artifact-kind");
  }

  async prepareLock(input: { expected: ExpectedZenonLock; now: number }): Promise<PreparedChainOperation> {
    const { expected } = input;
    if (expected.timeLockedAddress !== this.address()) throw new ZenonTradeError("wrong-signer");
    if (expected.expirationTime <= input.now) throw new ZenonTradeError("expired");
    const balances = await this.deps.node.getBalances(this.address());
    const available = BigInt(balances.find((b) => b.tokenStandard === expected.tokenStandard)?.balance ?? "0");
    if (available < BigInt(expected.amount)) throw new ZenonTradeError("insufficient-balance");
    return this.artifact("lock", expected, null);
  }

  /**
   * Finds an HTLC this account already created for exactly these terms.
   *
   * An HTLC's id is the hash of the create block, so a send whose read-back
   * failed leaves a fully valid, discoverable lock on chain. Adopting it keeps
   * `completeLock` idempotent: a retry after a transient node failure returns
   * the original lock instead of funding a second one and orphaning the first.
   */
  private async adoptExistingLock(expected: ExpectedZenonLock): Promise<CompletedLock | null> {
    for (let page = 0; page < this.scanPages; page += 1) {
      const blocks = await this.deps.node.listAccountBlocks(this.address(), page, this.pageSize);
      for (const block of blocks) {
        if (
          block.toAddress !== HTLC_ADDRESS ||
          block.tokenStandard !== expected.tokenStandard ||
          block.amount !== expected.amount
        ) continue;
        const info = await this.deps.node.getHtlc(block.hash);
        if (!info) continue;
        try {
          validateHtlcInfo(info, expected);
        } catch {
          continue;
        }
        return {
          blockHash: block.hash,
          htlcId: block.hash,
          summary: {
            htlcId: block.hash,
            validationCommitment: await htlcValidationCommitment(info),
            observedAt: this.deps.now()
          }
        };
      }
      if (blocks.length < this.pageSize) break;
    }
    return null;
  }

  async completeLock(artifact: PreparedChainOperation): Promise<CompletedLock> {
    this.assertArtifact(artifact, "lock");
    const e = artifact.expected;
    const adopted = await this.adoptExistingLock(e);
    if (adopted) return adopted;
    const { blockHash } = await this.deps.signer.send({
      kind: "htlc_create", tokenStandard: e.tokenStandard, amount: e.amount, hashLocked: e.hashLockedAddress,
      expirationTime: e.expirationTime, hashType: e.hashType, keyMaxSize: e.keyMaxSize, hashLock: e.hashLock
    });
    const summary = await this.validateIncomingLock(blockHash, e);
    return { blockHash, htlcId: blockHash, summary };
  }

  async validateIncomingLock(htlcId: string, expected: ExpectedZenonLock): Promise<LockSummary> {
    const info = await this.deps.node.getHtlc(htlcId);
    if (!info) throw new ZenonTradeError("htlc-missing");
    validateHtlcInfo(info, expected);
    return { htlcId, validationCommitment: await htlcValidationCommitment(info), observedAt: this.deps.now() };
  }

  /**
   * Checks the preimage against the agreed hashlock before anything is signed.
   * The node would reject a wrong one anyway, but only after a block was built
   * and plasma or PoW spent on it - and a claim that fails at the wire this
   * close to the cutoff is a claim that may not get retried in time.
   */
  async prepareClaim(input: { htlcId: string; expected: ExpectedZenonLock; preimage: string; now: number; claimCutoff: number }): Promise<PreparedChainOperation> {
    if (input.expected.hashLockedAddress !== this.address()) throw new ZenonTradeError("wrong-signer");
    if (input.now > input.claimCutoff) throw new ZenonTradeError("claim-cutoff");
    if (!(await verifyHtlcMaterial(input.preimage, input.expected.hashLock))) {
      throw new ZenonTradeError("preimage-mismatch");
    }
    await this.validateIncomingLock(input.htlcId, input.expected);
    return this.artifact("claim", input.expected, input.htlcId);
  }

  async completeClaim(artifact: PreparedChainOperation, preimage: string): Promise<CompletedSpend> {
    this.assertArtifact(artifact, "claim");
    if (artifact.htlcId === null) throw new ZenonTradeError("artifact-kind");
    const { blockHash } = await this.deps.signer.send({ kind: "htlc_unlock", id: artifact.htlcId, preimage });
    return { blockHash, htlcId: artifact.htlcId };
  }

  async prepareRefund(input: { htlcId: string; expected: ExpectedZenonLock; now: number; expiryGrace: number }): Promise<PreparedChainOperation> {
    if (input.expected.timeLockedAddress !== this.address()) throw new ZenonTradeError("wrong-signer");
    if (input.now < input.expected.expirationTime + input.expiryGrace) throw new ZenonTradeError("not-yet-refundable");
    await this.validateIncomingLock(input.htlcId, input.expected);
    return this.artifact("refund", input.expected, input.htlcId);
  }

  async completeRefund(artifact: PreparedChainOperation): Promise<CompletedSpend> {
    this.assertArtifact(artifact, "refund");
    if (artifact.htlcId === null) throw new ZenonTradeError("artifact-kind");
    const { blockHash } = await this.deps.signer.send({ kind: "htlc_reclaim", id: artifact.htlcId });
    return { blockHash, htlcId: artifact.htlcId };
  }

  /**
   * Reads one leg's state from the chain alone.
   *
   * Both spends are proved by a decoded block, never inferred: an `Unlock` on
   * the hash-locked account's chain, a `Reclaim` on the time-locked one. A
   * missing HTLC with neither block in the scanned window is `UNKNOWN` - it may
   * simply be older than `scanPages * pageSize` blocks - because `RECLAIMED` is
   * terminal evidence the caller acts on, and an expired clock is not evidence.
   */
  async observe(htlcId: string, expected: ExpectedZenonLock): Promise<HtlcObservation> {
    const observedAt = this.deps.now();
    const info = await this.deps.node.getHtlc(htlcId);
    if (info) {
      validateHtlcInfo(info, expected);
      return { state: "LOCKED", observedAt, preimage: null, witnessCommitment: null };
    }
    for (let page = 0; page < this.scanPages; page += 1) {
      const blocks = await this.deps.node.listAccountBlocks(expected.hashLockedAddress, page, this.pageSize);
      const found = await findUnlockPreimage(blocks, htlcId, expected.hashLock, this.deps.decodeUnlock);
      if (found) {
        return {
          state: "UNLOCKED", observedAt, preimage: found.preimage,
          witnessCommitment: await sha256Text(`zwap-spend-v1:${found.blockHash}:${found.preimage}`)
        };
      }
      if (blocks.length < this.pageSize) break;
    }
    for (let page = 0; page < this.scanPages; page += 1) {
      const blocks = await this.deps.node.listAccountBlocks(expected.timeLockedAddress, page, this.pageSize);
      if (findReclaim(blocks, htlcId, this.deps.decodeReclaim)) {
        return { state: "RECLAIMED", observedAt, preimage: null, witnessCommitment: null };
      }
      if (blocks.length < this.pageSize) break;
    }
    return { state: "UNKNOWN", observedAt, preimage: null, witnessCommitment: null };
  }
}
