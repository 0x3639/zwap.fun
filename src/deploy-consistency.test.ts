import { describe, expect, it } from "vitest";

import indexHtml from "../index.html?raw";
import headers from "../public/_headers?raw";
import nginx from "../deploy/nginx.conf?raw";
import { DEFAULT_DISCOVERY_RELAYS, loadConfig } from "./config.js";

/**
 * The CSP lives in three hand-maintained copies (index.html meta, Cloudflare
 * _headers, nginx). Until it is generated from one source, this test is the
 * guard against the copies drifting apart or dropping a configured endpoint.
 */
function connectSrc(csp: string): string[] {
  const directive = csp.split(";").map((part) => part.trim())
    .find((part) => part.startsWith("connect-src "));
  if (!directive) throw new Error("CSP has no connect-src directive");
  return directive.replace("connect-src ", "").split(/\s+/).sort();
}

function csps(): string[] {
  const meta = /content="([^"]*connect-src[^"]*)"/.exec(indexHtml)?.[1];
  const header = /Content-Security-Policy: ([^\n]*)/.exec(headers)?.[1];
  const nginxCsps = [...nginx.matchAll(/Content-Security-Policy "([^"]*)"/g)].map((m) => m[1]!);
  if (!meta || !header || nginxCsps.length === 0) throw new Error("Missing a CSP definition");
  return [meta, header, ...nginxCsps];
}

describe("deploy configuration consistency", () => {
  it("keeps every CSP copy's connect-src identical", () => {
    const [first, ...rest] = csps().map(connectSrc);
    for (const other of rest) expect(other).toEqual(first);
  });

  it("allows every configured default endpoint in the CSP", () => {
    const allowed = connectSrc(csps()[0]!);
    const config = loadConfig({});
    const required = [
      config.nodeUrl,
      config.inboxRelay,
      ...DEFAULT_DISCOVERY_RELAYS
    ];
    for (const url of required) {
      expect(allowed, `CSP connect-src is missing ${url}`).toContain(url);
    }
  });
});
