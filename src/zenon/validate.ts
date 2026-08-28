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
