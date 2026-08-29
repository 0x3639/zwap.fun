import { describe, expect, it } from "vitest";

import tutorial from "../docs/guides/manual-swap.md?raw";
import html from "../index.html?raw";

describe("manual swap tutorial", () => {
  it("keeps the complete shared-page happy-path recipe", () => {
    expect(tutorial).toContain("?wallet=maker");
    expect(tutorial).toContain("?wallet=taker");
    expect(tutorial).toContain("Create wallet");
    expect(tutorial).toContain("Fuse plasma");
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

  it("links the human tutorial from the deployed static shell", () => {
    // `docs/` is not part of the built bundle, so a relative link would 404
    // in production. The shell points at this repository's hosted copy —
    // never the upstream project it was forked from.
    expect(html).toContain(
      'href="https://github.com/0x3639/zwap.fun/blob/main/docs/guides/manual-swap.md"'
    );
    expect(html).toContain(
      'href="https://github.com/0x3639/zwap.fun/blob/main/docs/guides/agent-api.md"'
    );
    expect(html).toContain("Manual test tutorial");
    expect(html).not.toContain("github.com/brenorb");
    // Every off-site link opens severed from this page's window handle.
    for (const [, attributes] of html.matchAll(/<a\s([^>]*href="https?:[^>]*)>/g)) {
      expect(attributes).toContain('target="_blank"');
      expect(attributes).toContain('rel="noopener"');
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

  it("keeps demo wallet deletion to one click", () => {
    expect(html).toContain('id="clear-wallet"');
    expect(html).toContain('id="reset-profile"');
    expect(html).not.toContain('name="confirmation"');
    expect(html).not.toContain("DELETE TEST WALLET");
    expect(html).not.toContain("RESET ZWAP PROFILE");
  });
});
