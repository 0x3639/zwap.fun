/**
 * FROZEN hash-compat canonicalizer. Persisted commitments, checkpoints and
 * transcript hashes were produced with this exact recursion and this exact
 * `localeCompare` key order; changing either would invalidate live sessions'
 * stored hashes. New code wanting canonical JSON must use `./canonical.js`
 * (code-unit ordering) instead - this module exists only so the three layers
 * that already hash with locale ordering share one implementation.
 */
export function localeCanonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(localeCanonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${localeCanonicalJson(item)}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Value cannot be canonically encoded");
  return encoded;
}
