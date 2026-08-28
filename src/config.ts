export interface ZwapConfig {
  nodeUrl: string;
  chainId: number;
  plasmaBotUrl: string | null;
  discoveryRelays: string[];
  inboxRelay: string;
  shortLockSeconds: number;
  longLockSeconds: number;
  network: string;
}

export const DEFAULT_DISCOVERY_RELAYS = [
  "wss://relay.primal.net",
  "wss://nos.lol",
  "wss://offchain.pub"
] as const;

export function networkName(chainId: number): string {
  return chainId === 1 ? "zenon-mainnet" : `zenon-testnet-${chainId}`;
}

function positiveInt(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined || value === "") return fallback;
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`${label} must be a positive integer`);
  return Number(value);
}

export function loadConfig(env: Record<string, string | undefined>): ZwapConfig {
  const nodeUrl = env.VITE_ZENON_NODE_WS ?? "wss://node.zenon.network:35998";
  if (!/^wss?:\/\//.test(nodeUrl)) throw new Error("VITE_ZENON_NODE_WS must be a ws:// or wss:// URL");
  const chainId = positiveInt(env.VITE_ZENON_CHAIN_ID, 1, "Chain id (VITE_ZENON_CHAIN_ID)");
  const plasmaRaw = env.VITE_PLASMA_BOT_URL;
  const plasmaBotUrl = plasmaRaw === undefined ? "https://plazma.bot" : plasmaRaw.trim() === "" ? null : plasmaRaw.replace(/\/$/, "");
  const relays = (env.VITE_NOSTR_RELAYS ?? DEFAULT_DISCOVERY_RELAYS.join(","))
    .split(",").map((r) => r.trim()).filter((r) => r.length > 0);
  const shortLockSeconds = positiveInt(env.VITE_SHORT_LOCK_SECONDS, 1800, "Short locktime");
  const longLockSeconds = positiveInt(env.VITE_LONG_LOCK_SECONDS, 3600, "Long locktime");
  if (longLockSeconds <= shortLockSeconds) throw new Error("Long locktime must exceed the short locktime");
  return {
    nodeUrl,
    chainId,
    plasmaBotUrl,
    discoveryRelays: relays,
    inboxRelay: env.VITE_NOSTR_INBOX_RELAY ?? "wss://auth.nostr1.com",
    shortLockSeconds,
    longLockSeconds,
    network: networkName(chainId)
  };
}

export function browserConfig(): ZwapConfig {
  return loadConfig(import.meta.env as unknown as Record<string, string | undefined>);
}
