import { describe, expect, it } from "vitest";

import headersTemplate from "./_headers.template?raw";
import nginxTemplate from "./nginx.conf.template?raw";
import { renderCsp, renderTemplate } from "./csp.js";

/**
 * The page drives a hot signing wallet. A framing attacker who can overlay it
 * can drive every confirmation the user thinks they are giving, so the
 * anti-framing headers are part of the product, not a deployment detail - and
 * both shipped deployments must carry them.
 *
 * The meta tag alone is not enough: it is parsed only once the document body
 * starts arriving, and `frame-ancestors` is ignored in meta entirely. So the
 * full policy is served as a response header too. These checks run against
 * the rendered deployment files exactly as the build emits them.
 */
describe("deployment security headers", () => {
  const SIMPLE = [
    "X-Frame-Options: DENY",
    "X-Content-Type-Options: nosniff",
    "Referrer-Policy: no-referrer"
  ];

  const headerPolicy = renderCsp("header");
  const headers = renderTemplate(headersTemplate);
  const nginx = renderTemplate(nginxTemplate);

  it("does not allow the opt-in local mesh relay from a shipped page", () => {
    // `ws://localhost:4870` is a developer relay. A production page must not be
    // able to reach it, and a browser on an https page would block it anyway.
    for (const policy of [renderCsp("meta"), headerPolicy]) {
      expect(policy).not.toContain("localhost:4870");
    }
  });

  it("applies the global block to every Cloudflare Pages path", () => {
    const rules = headers.split("\n").filter((line) => !line.startsWith("#")).join("\n");
    const blocks = rules.split(/^(?=\S)/m);
    const global = blocks.find((block) => block.startsWith("/*"));
    expect(global).toBeDefined();
    for (const header of [...SIMPLE, `Content-Security-Policy: ${headerPolicy}`]) {
      expect(global).toContain(header);
    }
    // Every rule has to be reachable: `/*` must not be the last word on a path
    // that a later, more specific block silently narrows.
    expect(blocks[0]!.startsWith("/*")).toBe(true);
  });

  it("stays under Cloudflare's 2,000-character line limit", () => {
    // Pages rejects longer lines; the CSP line is the only one that can grow.
    for (const line of headers.split("\n")) expect(line.length).toBeLessThan(2000);
  });

  it("repeats them in every nginx location that sets headers of its own", () => {
    // `add_header` in a location replaces the inherited server-level set, so a
    // location with any header of its own must restate all of them.
    const locations = nginx.split(/^\s{4}location/m).slice(1);
    expect(locations.length).toBeGreaterThan(0);
    const all = [
      ...SIMPLE.map((header) => header.split(": ") as [string, string]),
      ["Content-Security-Policy", headerPolicy] as [string, string]
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
