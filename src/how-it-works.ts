// The explainer page's entire runtime: theme and the honesty badge. No wallet,
// node, or Nostr code loads here — nothing on this page signs or connects.
import { browserConfig } from "./config.js";
import { applyTheme, mountThemeToggle } from "./ui/theme.js";

applyTheme(document.documentElement);
const toggle = document.getElementById("theme-toggle");
if (toggle instanceof HTMLButtonElement) {
  mountThemeToggle(toggle, document.documentElement);
}
const badge = document.getElementById("network-badge");
if (badge) {
  const config = browserConfig();
  badge.textContent = config.chainId === 1
    ? "MAINNET · REAL FUNDS"
    : `TESTNET · CHAIN ${config.chainId}`;
  badge.classList.toggle("nom-badge--warning", config.chainId === 1);
  badge.classList.toggle("nom-badge--outline", config.chainId !== 1);
}
