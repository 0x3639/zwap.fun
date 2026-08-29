import { describe, expect, it } from "vitest";
import { loadConfig, networkName } from "./config.js";

describe("loadConfig", () => {
  it("applies mainnet defaults", () => {
    const config = loadConfig({});
    expect(config.nodeUrl).toBe("wss://my.hc1node.com:35998");
    expect(config.chainId).toBe(1);
    expect(config.plasmaBotUrl).toBe("https://plazma.bot");
    expect(config.network).toBe("zenon-mainnet");
    expect(config.shortLockSeconds).toBe(1800);
    expect(config.longLockSeconds).toBe(3600);
    expect(config.discoveryRelays).toEqual([
      "wss://relay.primal.net", "wss://nos.lol", "wss://offchain.pub"
    ]);
    expect(config.inboxRelay).toBe("wss://auth.nostr1.com");
  });

  it("reads testnet overrides and treats an empty plasma bot url as disabled", () => {
    const config = loadConfig({
      VITE_ZENON_NODE_WS: "ws://172.245.236.40:35998",
      VITE_ZENON_CHAIN_ID: "73404",
      VITE_PLASMA_BOT_URL: ""
    });
    expect(config.chainId).toBe(73404);
    expect(config.plasmaBotUrl).toBeNull();
    expect(config.network).toBe("zenon-testnet-73404");
  });

  it("rejects a non-numeric chain id and a non-websocket node url", () => {
    expect(() => loadConfig({ VITE_ZENON_CHAIN_ID: "one" })).toThrow(/chain id/i);
    expect(() => loadConfig({ VITE_ZENON_NODE_WS: "https://x" })).toThrow(/ws/i);
  });

  it("configures the bounded HTLC scan window", () => {
    expect(loadConfig({}).htlcScanPages).toBe(3);
    expect(loadConfig({}).htlcPageSize).toBe(100);
    const config = loadConfig({ VITE_HTLC_SCAN_PAGES: "7", VITE_HTLC_PAGE_SIZE: "25" });
    expect(config.htlcScanPages).toBe(7);
    expect(config.htlcPageSize).toBe(25);
    expect(() => loadConfig({ VITE_HTLC_SCAN_PAGES: "0" })).toThrow(/scan pages/i);
  });

  it("rejects a locktime profile the settlement plan could never build", () => {
    expect(() => loadConfig({
      VITE_SHORT_LOCK_SECONDS: "1800",
      VITE_LONG_LOCK_SECONDS: "2100"
    })).toThrow(/at least 600 seconds/);
    expect(loadConfig({
      VITE_SHORT_LOCK_SECONDS: "1800",
      VITE_LONG_LOCK_SECONDS: "2400"
    }).longLockSeconds).toBe(2400);
  });

  it("names networks", () => {
    expect(networkName(1)).toBe("zenon-mainnet");
    expect(networkName(73404)).toBe("zenon-testnet-73404");
  });
});
