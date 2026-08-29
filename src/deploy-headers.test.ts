import { describe, expect, it } from "vitest";

import indexHtml from "../index.html?raw";
import headers from "../public/_headers?raw";
import nginx from "../deploy/nginx.conf?raw";

/**
 * The wallet holds a hot signing key and a decrypted seed in one page. A
 * framing attacker who can overlay it can drive every confirmation the user
 * thinks they are giving, so the anti-framing headers are part of the product,
 * not a deployment detail - and both shipped deployments must carry them.
 *
 * The meta tag alone is not enough: it is parsed only once the document body
 * starts arriving, and `frame-ancestors` is ignored in meta entirely. So the
 * full policy is served as a response header too, and the two must not drift.
 */
describe("deployment security headers", () => {
  const SIMPLE = [
    "X-Frame-Options: DENY",
    "X-Content-Type-Options: nosniff",
    "Referrer-Policy: no-referrer"
  ];

  function directives(policy: string): Map<string, string[]> {
    return new Map(policy
      .split(";")
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .map((part) => {
        const [name, ...values] = part.split(/\s+/);
        return [name!, values] as const;
      }));
  }

  const metaPolicy = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/
    .exec(indexHtml)?.[1];
  const headerPolicy = /^\s+Content-Security-Policy:\s*(.+)$/m
    .exec(headers)?.[1]?.trim();
  const nginxPolicies = [...nginx.matchAll(
    /add_header Content-Security-Policy "([^"]+)"/g
  )].map((match) => match[1]!);

  it("ships a meta policy and a matching header policy on both deployments", () => {
    expect(metaPolicy).toBeDefined();
    expect(headerPolicy).toBeDefined();
    expect(nginxPolicies.length).toBeGreaterThan(0);
    // Every nginx `add_header` block restates the identical policy.
    expect(new Set(nginxPolicies).size).toBe(1);
    expect(nginxPolicies[0]).toBe(headerPolicy);
  });

  it("serves exactly the meta directives plus frame-ancestors", () => {
    const meta = directives(metaPolicy!);
    const served = directives(headerPolicy!);

    // The two connection-shaped directives are the ones that actually break
    // the app when they drift, so pin them explicitly as well.
    for (const name of ["connect-src", "script-src"]) {
      expect(served.get(name)).toEqual(meta.get(name));
      expect(served.get(name)!.length).toBeGreaterThan(0);
    }
    for (const [name, values] of meta) {
      expect(served.get(name)).toEqual(values);
    }
    expect(served.get("frame-ancestors")).toEqual(["'none'"]);
    expect([...served.keys()]).toEqual([...meta.keys(), "frame-ancestors"]);
  });

  it("does not allow the opt-in local mesh relay from a shipped page", () => {
    // `ws://localhost:4870` is a developer relay. A production page must not be
    // able to reach it, and a browser on an https page would block it anyway.
    for (const policy of [metaPolicy!, headerPolicy!]) {
      expect(policy).not.toContain("localhost:4870");
    }
  });

  it("applies the global block to every Cloudflare Pages path", () => {
    const blocks = headers.split(/^(?=\S)/m);
    const global = blocks.find((block) => block.startsWith("/*"));
    expect(global).toBeDefined();
    for (const header of [...SIMPLE, `Content-Security-Policy: ${headerPolicy}`]) {
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
    const all = [
      ...SIMPLE.map((header) => header.split(": ") as [string, string]),
      ["Content-Security-Policy", headerPolicy!] as [string, string]
    ];
    for (const [name, value] of all) {
      expect(nginx).toContain(`add_header ${name} "${value}"`);
      for (const location of locations.filter((block) => block.includes("add_header"))) {
        expect(location).toContain(`add_header ${name} "${value}"`);
      }
    }
    expect(nginx).toMatch(/#.*Strict-Transport-Security/);
  });
});
