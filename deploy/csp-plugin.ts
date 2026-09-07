import { readFile, writeFile } from "node:fs/promises";
import type { Plugin } from "vite";

import { renderCsp, renderTemplate } from "./csp.js";

const here = new URL("./", import.meta.url);

/** The meta tag as injected; a string so the quotes stay verbatim. */
export function cspMetaTag(): string {
  return `<meta http-equiv="Content-Security-Policy" content="${renderCsp("meta")}" />`;
}

/** Puts the CSP first in `<head>`, before anything the policy should govern. */
export function injectCspMeta(html: string): string {
  const heads = html.match(/<head>/g)?.length ?? 0;
  if (heads !== 1) throw new Error(`Expected exactly one <head>, found ${heads}`);
  return html.replace("<head>", `<head>\n    ${cspMetaTag()}`);
}

/**
 * Renders every deployed copy of the CSP from `csp.ts`:
 *
 * - the `<meta http-equiv>` tag, injected into each HTML entry in dev and
 *   build so the page carries the policy even where no header is set;
 * - `dist/_headers` for Cloudflare Pages, from `_headers.template`;
 * - `deploy/nginx.conf` for the Docker image, from `nginx.conf.template`
 *   (written beside the template, outside `dist/`, so it is never served).
 */
export function cspPlugin(): Plugin {
  return {
    name: "zwap:csp",
    transformIndexHtml: {
      order: "pre",
      handler: (html) => injectCspMeta(html)
    },
    async generateBundle() {
      const template = await readFile(new URL("_headers.template", here), "utf8");
      this.emitFile({ type: "asset", fileName: "_headers", source: renderTemplate(template) });
    },
    async closeBundle() {
      const template = await readFile(new URL("nginx.conf.template", here), "utf8");
      await writeFile(new URL("nginx.conf", here), renderTemplate(template));
    }
  };
}
