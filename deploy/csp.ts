/**
 * The single source of the site's Content Security Policy. Every deployed
 * copy is rendered from here at build time by `csp-plugin.ts`: the meta tag
 * in both HTML entries, Cloudflare's `_headers`, and nginx's `add_header`
 * lines. Edit this file, never the rendered copies.
 */

/** Marks where a template wants the header-form CSP inserted. */
export const CSP_PLACEHOLDER = "__CSP__";

const RELAYS = [
  "wss://auth.nostr1.com",
  "wss://nos.lol",
  "wss://relay.primal.net",
  "wss://offchain.pub"
];

const NODES = [
  "wss://my.hc1node.com:35998",
  "wss://node.zenon.network:35998",
  // Public testnet: plaintext only, so only a plain-HTTP dev build can use it.
  "ws://172.245.236.40:35998"
];

const DIRECTIVES: Record<string, string[]> = {
  "default-src": ["'self'"],
  "script-src": ["'self'"],
  "style-src": ["'self'", "https://fonts.googleapis.com"],
  "font-src": ["'self'", "https://fonts.gstatic.com"],
  "img-src": ["'self'", "data:"],
  "connect-src": [
    "'self'",
    ...NODES,
    // NIP-11 relay information documents are fetched over https before the
    // websocket opens.
    ...RELAYS.map((relay) => relay.replace(/^wss:/, "https:")),
    ...RELAYS
  ],
  "object-src": ["'none'"],
  "base-uri": ["'self'"],
  "form-action": ["'self'"],
  // Browsers ignore frame-ancestors in a meta tag (and warn), so only the
  // header form carries it. The page holds a hot signing key: never framed.
  "frame-ancestors": ["'none'"]
};

const HEADER_ONLY = new Set(["frame-ancestors"]);

/**
 * Renders the policy. `"meta"` drops the directives a `<meta http-equiv>`
 * cannot carry; `"header"` is the full policy for response headers.
 */
export function renderCsp(form: "meta" | "header"): string {
  return Object.entries(DIRECTIVES)
    .filter(([name]) => form === "header" || !HEADER_ONLY.has(name))
    .map(([name, values]) => `${name} ${values.join(" ")}`)
    .join("; ");
}

/** Substitutes the header-form CSP for every placeholder in a template. */
export function renderTemplate(template: string): string {
  if (!template.includes(CSP_PLACEHOLDER)) {
    throw new Error(`Template has no ${CSP_PLACEHOLDER} placeholder`);
  }
  return template.split(CSP_PLACEHOLDER).join(renderCsp("header"));
}
