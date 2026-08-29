import { describe, expect, it } from "vitest";

import headers from "../public/_headers?raw";
import nginx from "../deploy/nginx.conf?raw";

/**
 * The wallet holds a hot signing key and a decrypted seed in one page. A
 * framing attacker who can overlay it can drive every confirmation the user
 * thinks they are giving, so the anti-framing headers are part of the product,
 * not a deployment detail - and both shipped deployments must carry them.
 */
describe("deployment security headers", () => {
  const GLOBAL = [
    "X-Frame-Options: DENY",
    "Content-Security-Policy: frame-ancestors 'none'",
    "X-Content-Type-Options: nosniff",
    "Referrer-Policy: no-referrer"
  ];

  it("applies the global block to every Cloudflare Pages path", () => {
    const blocks = headers.split(/^(?=\S)/m);
    const global = blocks.find((block) => block.startsWith("/*"));
    expect(global).toBeDefined();
    for (const header of GLOBAL) {
      expect(global).toContain(header);
    }
    // Every rule has to be reachable: `/*` must not be the last word on a path
    // that a later, more specific block silently narrows.
    expect(blocks[0]!.startsWith("/*")).toBe(true);
  });

  it("repeats them in every nginx location that sets headers of its own", () => {
    // `add_header` in a location replaces the inherited server-level set, so a
    // location with any header of its own must restate all of them.
    const locations = nginx.split(/^\s{4}location/m).slice(1);
    expect(locations.length).toBeGreaterThan(0);
    for (const header of GLOBAL) {
      const [name, value] = header.split(": ");
      expect(nginx).toContain(`add_header ${name} "${value}"`);
      for (const location of locations.filter((block) => block.includes("add_header"))) {
        expect(location).toContain(`add_header ${name} "${value}"`);
      }
    }
    expect(nginx).toMatch(/#.*Strict-Transport-Security/);
  });
});
