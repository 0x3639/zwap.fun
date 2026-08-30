import { describe, expect, it } from "vitest";

import tutorial from "../docs/guides/manual-swap.md?raw";
import html from "../index.html?raw";
import howItWorks from "../how-it-works.html?raw";

describe("manual swap tutorial", () => {
  it("keeps the complete shared-page happy-path recipe", () => {
    expect(tutorial).toContain("Connect a funded extension account");
    expect(tutorial).toContain("two separate browser profiles");
    expect(tutorial).toContain("Connect wallet");
    expect(tutorial).toContain("proof-of-work");
    expect(tutorial).not.toContain("?wallet=");
    expect(tutorial).not.toContain("Create wallet");
    expect(tutorial).not.toContain("Fuse plasma");
    expect(tutorial).toContain("Receive pending");
    expect(tutorial).toContain("automatically");
    expect(tutorial).not.toContain("Sync maker listener");
    expect(tutorial).toContain("20 ZNN");
    expect(tutorial).toContain("3.5 QSR/ZNN");
    expect(tutorial).not.toContain("runUntilSettled(");
    expect(tutorial).toContain("advanceTrade");
    expect(tutorial).toContain("Filled");
    expect(tutorial).toContain("filled");
    expect(tutorial).toContain("long locktime");
    expect(tutorial).toContain("refund");
  });

  it("links the human tutorial from the deployed static pages", () => {
    // `docs/` is not part of the built bundle, so a relative link would 404
    // in production. The agent strip lives on the how-it-works page now; it
    // points at this repository's hosted copy — never the upstream project
    // this was forked from.
    expect(howItWorks).toContain(
      'href="https://github.com/0x3639/zwap.fun/blob/main/docs/guides/manual-swap.md"'
    );
    expect(howItWorks).toContain(
      'href="https://github.com/0x3639/zwap.fun/blob/main/docs/guides/agent-api.md"'
    );
    expect(howItWorks).toContain("Manual test tutorial");
    for (const page of [html, howItWorks]) {
      expect(page).not.toContain("github.com/brenorb");
      // Every off-site link opens severed from this page's window handle.
      for (const [, attributes] of page.matchAll(/<a\s([^>]*href="https?:[^>]*)>/g)) {
        expect(attributes).toContain('target="_blank"');
        expect(attributes).toContain('rel="noopener"');
      }
    }
    expect(html).toContain('id="order-settlement-hint"');
    expect(html).not.toContain('id="mint-form"');
  });

  it("keeps the public market header focused on the wallet and order book", () => {
    expect(html).not.toContain('class="market-tape"');
    expect(html).not.toContain("Base issuer");
    expect(html).not.toContain("Active order keys");
  });

  it("places pending relay publications below the order form", () => {
    expect(html.indexOf('id="pending-publications"')).toBeGreaterThan(
      html.indexOf('class="order-entry"')
    );
  });

  it("keeps minimum fill out of the current order form", () => {
    expect(html).not.toContain("Minimum fill");
    expect(html).not.toContain('name="minimumFillAmount"');
  });

  it("gates erasing this browser's zwap data behind the typed phrase", () => {
    expect(html).toContain('id="reset-local-data-confirmation"');
    expect(html).toContain("Type RESET ZWAP DATA to confirm");
    // Shipped disabled: only the typed phrase enables it, and the API
    // re-checks the phrase it is given.
    expect(html).toMatch(/id="reset-local-data"[^>]*\sdisabled/);
    // The seed and the profile switcher are gone: the extension holds the keys.
    expect(html).not.toContain('id="clear-wallet"');
    expect(html).not.toContain('id="reset-profile"');
    expect(html).not.toContain('id="backup"');
    expect(html).not.toContain("DELETE TEST WALLET");
  });
});
