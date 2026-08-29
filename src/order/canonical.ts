/**
 * Deterministic JSON encoding used to compare order state and to persist
 * `intent.compatibility` in the order outbox. Object keys are sorted by UTF-16
 * code unit - `localeCompare` is locale- and ICU-version-sensitive, and a
 * comparator that can change between browsers would make a valid persisted
 * record fail its re-canonicalisation check on read.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("Value cannot be canonically encoded");
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
