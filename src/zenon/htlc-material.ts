import { bytesToHex, hexToBytes, randomBytes, sha256Hex } from "./hex.js";

export async function createHtlcMaterial(): Promise<{ preimage: string; hash: string }> {
  const preimageBytes = randomBytes(32);
  return { preimage: bytesToHex(preimageBytes), hash: await sha256Hex(preimageBytes) };
}

export async function verifyHtlcMaterial(preimage: string, hash: string): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/.test(preimage) || !/^[0-9a-f]{64}$/.test(hash)) return false;
  return (await sha256Hex(hexToBytes(preimage))) === hash;
}
