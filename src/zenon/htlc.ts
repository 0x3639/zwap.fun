import { HtlcContract } from "znn-typescript-sdk";
import { decodeFakeReclaimData, decodeFakeUnlockData } from "./fake-node.js";
import { hexToBytes, sha256Hex, sha256Text } from "./hex.js";
import { HTLC_ADDRESS, type AccountBlockView, type HtlcInfoView } from "./types.js";

export interface ExpectedZenonLock {
  leg: "base" | "quote";
  chainId: string;
  tokenStandard: string;
  amount: string;
  hashLock: string;
  hashType: 1;
  keyMaxSize: 32;
  hashLockedAddress: string;
  timeLockedAddress: string;
  expirationTime: number;
  binding: {
    protocolVersion: "1";
    network: string;
    orderId: string;
    sessionId: string;
    reservationId: string;
    transcriptHash: string;
  };
}

export type HtlcValidationCode =
  | "htlc-token" | "htlc-amount" | "htlc-hashlock" | "htlc-hashtype" | "htlc-keymaxsize"
  | "htlc-hashlocked" | "htlc-timelocked" | "htlc-expiration";

export class HtlcValidationError extends Error {
  constructor(readonly code: HtlcValidationCode) { super(`HTLC does not match expected terms: ${code}`); }
}

export function validateHtlcInfo(info: HtlcInfoView, expected: ExpectedZenonLock): void {
  if (info.tokenStandard !== expected.tokenStandard) throw new HtlcValidationError("htlc-token");
  if (info.amount !== expected.amount) throw new HtlcValidationError("htlc-amount");
  if (info.hashLock !== expected.hashLock) throw new HtlcValidationError("htlc-hashlock");
  if (info.hashType !== expected.hashType) throw new HtlcValidationError("htlc-hashtype");
  if (info.keyMaxSize !== expected.keyMaxSize) throw new HtlcValidationError("htlc-keymaxsize");
  if (info.hashLocked !== expected.hashLockedAddress) throw new HtlcValidationError("htlc-hashlocked");
  if (info.timeLocked !== expected.timeLockedAddress) throw new HtlcValidationError("htlc-timelocked");
  if (info.expirationTime !== expected.expirationTime) throw new HtlcValidationError("htlc-expiration");
}

export async function htlcValidationCommitment(info: HtlcInfoView): Promise<string> {
  const ordered = Object.fromEntries(Object.entries(info).sort(([a], [b]) => (a < b ? -1 : 1)));
  return sha256Text(`zwap-htlc-view-v1\n${JSON.stringify(ordered)}`);
}

export type UnlockDecoder = (block: AccountBlockView) => { id: string; preimage: string } | null;

export const sdkUnlockDecoder: UnlockDecoder = (block) => {
  if (block.toAddress !== HTLC_ADDRESS || block.data.length < 8) return null;
  try {
    const call = HtlcContract.decodeCallData(`0x${block.data}`, true) as { name: string; args: Record<string, string> };
    if (call.name !== "Unlock") return null;
    const id = call.args.id?.replace(/^0x/, "").toLowerCase();
    const preimage = call.args.preimage?.replace(/^0x/, "").toLowerCase();
    return id && preimage ? { id, preimage } : null;
  } catch {
    return null;
  }
};

export const fakeUnlockDecoder: UnlockDecoder = (block) =>
  block.toAddress === HTLC_ADDRESS ? decodeFakeUnlockData(block.data) : null;

export type ReclaimDecoder = (block: AccountBlockView) => { id: string } | null;

export const sdkReclaimDecoder: ReclaimDecoder = (block) => {
  if (block.toAddress !== HTLC_ADDRESS || block.data.length < 8) return null;
  try {
    const call = HtlcContract.decodeCallData(`0x${block.data}`, true) as { name: string; args: Record<string, string> };
    if (call.name !== "Reclaim") return null;
    const id = call.args.id?.replace(/^0x/, "").toLowerCase();
    return id ? { id } : null;
  } catch {
    return null;
  }
};

export const fakeReclaimDecoder: ReclaimDecoder = (block) =>
  block.toAddress === HTLC_ADDRESS ? decodeFakeReclaimData(block.data) : null;

/** The block that reclaimed this HTLC, or null if none is in the scanned range. */
export function findReclaim(
  blocks: AccountBlockView[], htlcId: string, decode: ReclaimDecoder
): { blockHash: string } | null {
  for (const block of blocks) {
    const call = decode(block);
    if (call?.id === htlcId) return { blockHash: block.hash };
  }
  return null;
}

export async function findUnlockPreimage(
  blocks: AccountBlockView[], htlcId: string, hashLock: string, decode: UnlockDecoder
): Promise<{ preimage: string; blockHash: string } | null> {
  for (const block of blocks) {
    const call = decode(block);
    if (!call || call.id !== htlcId) continue;
    if ((await sha256Hex(hexToBytes(call.preimage))) === hashLock) return { preimage: call.preimage, blockHash: block.hash };
  }
  return null;
}
