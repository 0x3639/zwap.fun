import { describe, expect, it } from "vitest";

import indexHtml from "../index.html?raw";
import howItWorksHtml from "../how-it-works.html?raw";
import headersTemplate from "./_headers.template?raw";
import nginxTemplate from "./nginx.conf.template?raw";
import { DEFAULT_DISCOVERY_RELAYS, loadConfig } from "../src/config.js";
import {
  CSP_PLACEHOLDER,
  renderCsp,
  renderTemplate
} from "./csp.js";
import { cspPlugin, injectCspMeta } from "./csp-plugin.js";

function directives(csp: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const part of csp.split(";")) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) map.set(name, values.sort());
  }
  return map;
}

describe("CSP single source", () => {
  it("renders the header form with frame-ancestors and the meta form without", () => {
    const header = directives(renderCsp("header"));
    const meta = directives(renderCsp("meta"));
    expect(header.get("frame-ancestors")).toEqual(["'none'"]);
    expect(meta.has("frame-ancestors")).toBe(false);
    header.delete("frame-ancestors");
    expect(meta).toEqual(header);
  });

  it("locks down the directives a hot-signing page needs", () => {
    const header = directives(renderCsp("header"));
    expect(header.get("default-src")).toEqual(["'self'"]);
    expect(header.get("script-src")).toEqual(["'self'"]);
    expect(header.get("object-src")).toEqual(["'none'"]);
    expect(header.get("base-uri")).toEqual(["'self'"]);
    expect(header.get("form-action")).toEqual(["'self'"]);
  });

  it("allows every configured default endpoint in connect-src", () => {
    const allowed = directives(renderCsp("header")).get("connect-src") ?? [];
    const config = loadConfig({});
    for (const url of [config.nodeUrl, config.inboxRelay, ...DEFAULT_DISCOVERY_RELAYS]) {
      expect(allowed, `CSP connect-src is missing ${url}`).toContain(url);
    }
  });

  it("never emits a double quote, which would break the HTML attribute and nginx string", () => {
    expect(renderCsp("header")).not.toContain('"');
  });
});

describe("CSP templates", () => {
  it("keeps the source HTML free of a hand-written CSP meta", () => {
    // A second meta CSP would silently intersect with the injected one.
    for (const html of [indexHtml, howItWorksHtml]) {
      expect(html).not.toMatch(/Content-Security-Policy/i);
    }
  });

  it("fills every placeholder in the Cloudflare _headers template", () => {
    expect(headersTemplate.split(CSP_PLACEHOLDER)).toHaveLength(2);
    const rendered = renderTemplate(headersTemplate);
    expect(rendered).not.toContain(CSP_PLACEHOLDER);
    expect(rendered).toContain(`Content-Security-Policy: ${renderCsp("header")}`);
    expect(rendered).toContain("X-Frame-Options: DENY");
  });

  it("fills every nginx add_header site, one per location that restates headers", () => {
    const sites = nginxTemplate.split(CSP_PLACEHOLDER).length - 1;
    expect(sites).toBe(3);
    const rendered = renderTemplate(nginxTemplate);
    expect(rendered).not.toContain(CSP_PLACEHOLDER);
    const matches = [...rendered.matchAll(/Content-Security-Policy "([^"]*)" always;/g)];
    expect(matches).toHaveLength(3);
    for (const match of matches) expect(match[1]).toBe(renderCsp("header"));
  });

  it("refuses a template that lost its placeholder", () => {
    expect(() => renderTemplate("no placeholder here")).toThrow(/placeholder/);
  });
});

describe("CSP vite plugin", () => {
  it("injects the meta form first in <head>, quotes verbatim", () => {
    const html = "<html>\n  <head>\n    <meta charset=\"UTF-8\" />\n  </head>\n</html>";
    const out = injectCspMeta(html);
    expect(out).toBe(
      `<html>\n  <head>\n    <meta http-equiv="Content-Security-Policy" content="${renderCsp("meta")}" />\n    <meta charset="UTF-8" />\n  </head>\n</html>`
    );
    expect(out).not.toContain("&#39;");
  });

  it("refuses HTML without exactly one <head>", () => {
    expect(() => injectCspMeta("<html></html>")).toThrow(/<head>/);
    expect(() => injectCspMeta("<head></head><head></head>")).toThrow(/<head>/);
  });

  it("wires the injector as the pre-order transformIndexHtml hook", () => {
    const transform = cspPlugin().transformIndexHtml;
    if (typeof transform !== "object" || typeof transform.handler !== "function") {
      throw new Error("plugin has no transformIndexHtml handler");
    }
    expect(transform.order).toBe("pre");
    expect(transform.handler.call({} as never, "<head></head>", {} as never)).toBe(injectCspMeta("<head></head>"));
  });
});
