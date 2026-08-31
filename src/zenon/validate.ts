const BECH32 = "[02-9ac-hj-np-z]";
const ADDRESS = new RegExp(`^z1${BECH32}{38}$`);
const ZTS = new RegExp(`^zts1${BECH32}{22}$`);

export function isZenonAddress(value: unknown): value is string {
  return typeof value === "string" && ADDRESS.test(value);
}
export function isTokenStandard(value: unknown): value is string {
  return typeof value === "string" && ZTS.test(value);
}
export function isHex32(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}
export function isAmount(value: unknown): value is string {
  return typeof value === "string" && /^[1-9]\d*$/.test(value);
}

/**
 * The one shared Unix-timestamp validator: non-negative safe integers only.
 * Every protocol layer used to carry its own copy of this function; the label
 * keeps each caller's error text unchanged.
 */
export function safeUnixTimestamp(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe Unix timestamp`);
  }
  return value;
}
