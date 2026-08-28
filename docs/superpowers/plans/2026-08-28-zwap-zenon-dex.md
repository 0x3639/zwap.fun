# zwap.fun — Zenon HTLC DEX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fork granola (Nostr order book + private DM coordination + hash-linked atomic settlement) and replace its Cashu settlement layer with Zenon's native HTLC embedded contract, so ZNN/QSR/ZTS pairs trade peer-to-peer from a browser with no custodian.

**Architecture:** Keep granola's `nostr/`, `order/`, `trade/coordinator*`, message/transcript, storage, API and UI shells. Delete `cashu/` and the proof wallet. Add `src/zenon/` — a node port + signer interface (with an in-memory fake for tests), a keystore signer built on `znn-typescript-sdk`, pure HTLC validators, and a trade client that executes the coordinator's lock/claim/refund/observe actions against the chain. Rename the session/message vocabulary from mint/keyset/token to chain/ZTS/HTLC-id.

**Tech Stack:** TypeScript 7 (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `.js` import extensions), Vite 8, vitest 4 (jsdom, co-located `*.test.ts`), `nostr-tools@2.23.3`, `znn-typescript-sdk@^1.0.5`, `vite-plugin-node-polyfills`, `buffer`, zenon-design-system CSS tokens.

**Spec:** `docs/superpowers/specs/2026-08-28-zwap-zenon-dex-design.md`

## Global Constraints

- Default network is Zenon **mainnet**: `VITE_ZENON_NODE_WS=wss://node.zenon.network:35998`, `VITE_ZENON_CHAIN_ID=1`. Testnet alternate: `ws://172.245.236.40:35998`, chain `73404`. Chain id is verified on connect and bound into every trade.
- Never log, render, persist unencrypted, or put in fixtures: mnemonics, private keys, unreleased preimages. Tests use `KeyStore.newRandom()` or fixed throwaway mnemonics clearly labelled as such.
- Every Zenon action is an account block: sends from one address are **strictly sequential** (frontier-based autofill). PoW/plasma is decided by the node inside `zenon.send`.
- `Hash.parse` takes bare 64-hex; the ABI layer wants `0x`-prefixed hex; `block.data` from the SDK is a `Buffer`. Convert at the `zenon/sdk-node` boundary only — everything above it uses bare lowercase hex strings.
- HTLC parameters: `hashType = 1` (SHA-256), `keyMaxSize = 32`, preimage is 32 random bytes, `hashLock = sha256(preimage)`.
- Default locktimes: short `1800` s, long `3600` s, reservation `long + 600`; claim cutoffs are locktime − 120; refund guard 60 s.
- Price semantics: `price` = quote minor units per `10^8` base minor units; `quoteAmount = baseAmount * price / 10^8` (bigint, truncating). ZNN and QSR both have 8 decimals.
- Schema strings: `zwap/order/v1`, `zwap/trade-session/v1`, `zwap/atomic-swap-body/v1`; Nostr `d` tag `zwap:order:v1:<orderId>`, `t` tag `zwap-order`; domain tags `zwap-transcript-v1`, `zwap-terms-v1`, `zwap-market-v1`, `zwap-spend-v1`. Browser facade `window.zwap`.
- UI: framework-free DOM; design-system tokens/classes only, no raw hex, Space Grotesk/JetBrains Mono, no emoji, plasma gradient only on the primary action, light+dark.
- Commit after every task; `npm run typecheck && npm test` must pass at every commit.

---

## File structure (end state)

```
src/
  config.ts                      env → ZwapConfig (node url, chain id, plasma bot url, relays, locktimes)
  zenon/
    types.ts                     ZenonNodePort, ZenonSigner, ZenonTemplate, HtlcInfoView, AccountBlockView, BalanceView, HtlcState
    hex.ts                       hex helpers, sha256 hex, random bytes
    htlc-material.ts             createHtlcMaterial(), verifyHtlcMaterial()
    validate.ts                  isZenonAddress(), isTokenStandard(), isHex32()
    fake-node.ts                 FakeZenonNode (in-memory chain + signers) for tests
    sdk-node.ts                  SdkZenonNode: ZenonNodePort over znn-typescript-sdk
    keystore-signer.ts           KeystoreSigner: ZenonSigner over SDK KeyPair, serial send queue, PoW hook
    keystore-repository.ts       encrypted mnemonic at rest (EncryptedStorageDriver)
    htlc.ts                      validateHtlcInfo(), decodeUnlockPreimage(), htlcValidationCommitment()
    trade-client.ts              ZenonTradeClient (executor for coordinator effects)
    account.ts                   ZenonAccount: balances, auto-receive, plasma status
    plasma-bot.ts                fusePlasma() via plazma.bot agent API
    funds-reservations.ts        FundsReservationRepository (earmarked amounts per session)
  api/zwap-api.ts                replaces granola-api.ts (ZenonPort)
  ...everything else from granola, edited
public/pow.js, public/pow.wasm  copied by vite plugin
```

---

### Task 0: Fork granola into zwap.fun and establish a green baseline

**Files:**
- Create: everything under `/Users/dfriestedt/Github/zwap.fun` from the granola clone at `/private/tmp/claude-501/-Users-dfriestedt-Github-zwap-fun/1960ad64-5a64-46ef-81f0-a39f71b2f598/scratchpad/granola` (re-clone `https://github.com/brenorb/granola` if the scratch dir is gone)
- Modify: `package.json`, `README.md`

- [ ] **Step 1: Copy the source tree (not `.git`, not `node_modules`)**

```bash
cd /Users/dfriestedt/Github/zwap.fun
SRC=/private/tmp/claude-501/-Users-dfriestedt-Github-zwap-fun/1960ad64-5a64-46ef-81f0-a39f71b2f598/scratchpad/granola
[ -d "$SRC" ] || git clone --depth 1 https://github.com/brenorb/granola "$SRC"
rsync -a --exclude .git --exclude node_modules --exclude dist "$SRC"/ ./
git status --short | head
```

- [ ] **Step 2: Rename the package**

Edit `package.json`: `"name": "zwap"`, `"version": "0.1.0"`. Leave dependencies untouched for now (Cashu is removed in Task 8 once nothing imports it).

- [ ] **Step 3: Install and run the baseline**

```bash
npm ci
npm run typecheck && npm test
```
Expected: all granola suites pass (40 files). If a test fails only because of network access, note it and continue — it will be deleted with the Cashu layer.

- [ ] **Step 4: Prepend a fork notice to README.md**

Replace the first heading/paragraph with:

```markdown
# zwap.fun

zwap.fun is a decentralized exchange for Zenon Network of Momentum assets
(ZNN, QSR and any ZTS token). Orders are public Nostr events, coordination is
private Nostr DMs, and settlement is atomic through Zenon's native HTLC
embedded contract. No custodian, no additional settlement party.

It is a fork of [granola](https://github.com/brenorb/granola) with the Cashu
settlement layer replaced by Zenon HTLCs. Design:
`docs/superpowers/specs/2026-08-28-zwap-zenon-dex-design.md`.

> **Status:** proof of concept on Zenon mainnet with small amounts. Real funds.
```

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "chore: fork granola as zwap.fun baseline"
```

---

### Task 1: Config module and Zenon SDK bundling

**Files:**
- Create: `src/config.ts`, `src/config.test.ts`, `.env.example`, `.env.testnet`, `vite-pow-plugin.ts`
- Modify: `vite.config.ts`, `package.json`, `src/main.ts` (Buffer polyfill line only), `.gitignore`

**Interfaces:**
- Produces: `interface ZwapConfig { nodeUrl: string; chainId: number; plasmaBotUrl: string | null; discoveryRelays: string[]; inboxRelay: string; shortLockSeconds: number; longLockSeconds: number; network: string }`, `function loadConfig(env: Record<string, string | undefined>): ZwapConfig`, `function networkName(chainId: number): string` (returns `"zenon-mainnet"` for 1, `"zenon-testnet-73404"` style for others).

- [ ] **Step 1: Write the failing test**

`src/config.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { loadConfig, networkName } from "./config.js";

describe("loadConfig", () => {
  it("applies mainnet defaults", () => {
    const config = loadConfig({});
    expect(config.nodeUrl).toBe("wss://node.zenon.network:35998");
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

  it("names networks", () => {
    expect(networkName(1)).toBe("zenon-mainnet");
    expect(networkName(73404)).toBe("zenon-testnet-73404");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/config.test.ts`
Expected: FAIL — cannot resolve `./config.js`.

- [ ] **Step 3: Implement `src/config.ts`**

```ts
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
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run src/config.test.ts` — Expected: PASS.

- [ ] **Step 5: Add env files**

`.env.example`:
```
VITE_ZENON_NODE_WS=wss://node.zenon.network:35998
VITE_ZENON_CHAIN_ID=1
VITE_PLASMA_BOT_URL=https://plazma.bot
VITE_NOSTR_RELAYS=wss://relay.primal.net,wss://nos.lol,wss://offchain.pub
VITE_NOSTR_INBOX_RELAY=wss://auth.nostr1.com
VITE_SHORT_LOCK_SECONDS=1800
VITE_LONG_LOCK_SECONDS=3600
```
`.env.testnet`:
```
VITE_ZENON_NODE_WS=ws://172.245.236.40:35998
VITE_ZENON_CHAIN_ID=73404
VITE_PLASMA_BOT_URL=
```
Append `.env` and `.env.local` to `.gitignore` (keep `.env.example`/`.env.testnet` tracked).

- [ ] **Step 6: Install the SDK and polyfills**

```bash
npm install znn-typescript-sdk@^1.0.5 buffer@^6.0.3
npm install -D vite-plugin-node-polyfills@^0.25.0
```

- [ ] **Step 7: PoW asset plugin — `vite-pow-plugin.ts`**

```ts
import { copyFileSync, createReadStream, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";

const POW_FILES = ["pow.js", "pow.wasm"] as const;
const powSrcDir = resolve(process.cwd(), "node_modules/znn-typescript-sdk/dist/browser");

export function copyPowFiles(): Plugin {
  return {
    name: "zwap-copy-pow-files",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const name = req.url?.split("?")[0]?.slice(1);
        if (name && (POW_FILES as readonly string[]).includes(name)) {
          res.setHeader("Content-Type", name.endsWith(".wasm") ? "application/wasm" : "application/javascript");
          createReadStream(resolve(powSrcDir, name)).pipe(res);
          return;
        }
        next();
      });
    },
    writeBundle(options) {
      const outDir = options.dir ?? resolve(process.cwd(), "dist");
      if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
      for (const name of POW_FILES) copyFileSync(resolve(powSrcDir, name), resolve(outDir, name));
    }
  };
}
```

- [ ] **Step 8: Update `vite.config.ts`**

```ts
import { defineConfig } from "vitest/config";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import { copyPowFiles } from "./vite-pow-plugin.js";

export default defineConfig({
  base: "./",
  plugins: [
    copyPowFiles(),
    nodePolyfills({
      include: ["crypto", "buffer", "stream", "util"],
      globals: { Buffer: true, global: true, process: true }
    })
  ],
  optimizeDeps: {
    esbuildOptions: { define: { global: "globalThis" } },
    exclude: ["znn-typescript-sdk"]
  },
  worker: { format: "es" },
  test: {
    environment: "jsdom",
    coverage: { reporter: ["text", "html"] }
  }
});
```
Add `"vite-pow-plugin.ts"` to `tsconfig.json` `include`.

- [ ] **Step 9: Buffer polyfill at app entry**

At the very top of `src/main.ts` add:
```ts
import { Buffer } from "buffer";
(globalThis as { Buffer?: typeof Buffer }).Buffer ??= Buffer;
```

- [ ] **Step 10: Verify build + tests**

Run: `npm run typecheck && npm test && npm run build && ls dist/pow.js dist/pow.wasm`
Expected: green; both PoW files present in `dist/`.

- [ ] **Step 11: Commit**

```bash
git add -A && git commit -m "feat: config module, znn-typescript-sdk bundling, PoW assets"
```

---

### Task 2: Zenon primitives — types, hex helpers, HTLC material, validators

**Files:**
- Create: `src/zenon/types.ts`, `src/zenon/hex.ts`, `src/zenon/hex.test.ts`, `src/zenon/htlc-material.ts`, `src/zenon/htlc-material.test.ts`, `src/zenon/validate.ts`, `src/zenon/validate.test.ts`

**Interfaces:**
- Produces (`types.ts`):
```ts
export type HtlcState = "UNKNOWN" | "LOCKED" | "UNLOCKED" | "RECLAIMED";
export const HTLC_HASH_TYPE_SHA256 = 1 as const;
export const HTLC_KEY_MAX_SIZE = 32 as const;
export const HTLC_ADDRESS = "z1qxemdeddedxhtlcxxxxxxxxxxxxxxxxxygecvw";
export const ZNN_ZTS = "zts1znnxxxxxxxxxxxxx9z4ulx";
export const QSR_ZTS = "zts1qsrxxxxxxxxxxxxxmrhjll";
export interface HtlcInfoView { id: string; timeLocked: string; hashLocked: string; tokenStandard: string; amount: string; expirationTime: number; hashType: number; keyMaxSize: number; hashLock: string; }
export interface AccountBlockView { hash: string; height: number; blockType: number; address: string; toAddress: string; amount: string; tokenStandard: string; fromBlockHash: string; data: string; confirmations: number | null; momentumTimestamp: number | null; }
export interface BalanceView { tokenStandard: string; symbol: string; decimals: number; balance: string; }
export interface PlasmaView { currentPlasma: number; maxPlasma: number; qsrFused: string; }
export interface MomentumView { hash: string; height: number; timestamp: number; }
export interface ZenonNodePort {
  chainIdentifier(): Promise<number>;
  frontierMomentum(): Promise<MomentumView>;
  getHtlc(id: string): Promise<HtlcInfoView | null>;
  getAccountBlock(hash: string): Promise<AccountBlockView | null>;
  listAccountBlocks(address: string, pageIndex: number, pageSize: number): Promise<AccountBlockView[]>;
  getBalances(address: string): Promise<BalanceView[]>;
  listUnreceived(address: string): Promise<AccountBlockView[]>;
  getTokenDecimals(zts: string): Promise<number>;
  getPlasma(address: string): Promise<PlasmaView>;
}
export type ZenonTemplate =
  | { kind: "htlc_create"; tokenStandard: string; amount: string; hashLocked: string; expirationTime: number; hashType: 1; keyMaxSize: 32; hashLock: string }
  | { kind: "htlc_unlock"; id: string; preimage: string }
  | { kind: "htlc_reclaim"; id: string }
  | { kind: "receive"; fromBlockHash: string }
  | { kind: "send"; toAddress: string; tokenStandard: string; amount: string };
export interface SendReceipt { blockHash: string; }
export interface ZenonSigner { address(): string; send(template: ZenonTemplate): Promise<SendReceipt>; }
```
- `hex.ts`: `bytesToHex(bytes: Uint8Array): string`, `hexToBytes(hex: string): Uint8Array` (throws on odd/invalid), `sha256Hex(bytes: Uint8Array): Promise<string>` (WebCrypto), `sha256Text(text: string): Promise<string>`, `randomBytes(n: number): Uint8Array`.
- `htlc-material.ts`: `createHtlcMaterial(): Promise<{ preimage: string; hash: string }>`, `verifyHtlcMaterial(preimage: string, hash: string): Promise<boolean>`.
- `validate.ts`: `isZenonAddress(value: unknown): value is string` (`/^z1[02-9ac-hj-np-z]{38}$/`), `isTokenStandard(value: unknown): value is string` (`/^zts1[02-9ac-hj-np-z]{22}$/`), `isHex32(value: unknown): value is string` (`/^[0-9a-f]{64}$/`), `isAmount(value: unknown): value is string` (`/^[1-9]\d*$/`).

- [ ] **Step 1: Write failing tests**

`src/zenon/hex.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { bytesToHex, hexToBytes, sha256Hex, sha256Text, randomBytes } from "./hex.js";

describe("hex", () => {
  it("round-trips", () => {
    expect(bytesToHex(hexToBytes("00ff10"))).toBe("00ff10");
  });
  it("rejects odd or invalid hex", () => {
    expect(() => hexToBytes("abc")).toThrow();
    expect(() => hexToBytes("zz")).toThrow();
  });
  it("hashes", async () => {
    expect(await sha256Text("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(await sha256Hex(new Uint8Array([0x61, 0x62, 0x63]))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  it("random bytes have the requested length and differ", () => {
    expect(randomBytes(32)).toHaveLength(32);
    expect(bytesToHex(randomBytes(32))).not.toBe(bytesToHex(randomBytes(32)));
  });
});
```

`src/zenon/htlc-material.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { createHtlcMaterial, verifyHtlcMaterial } from "./htlc-material.js";

describe("htlc material", () => {
  it("creates a 32-byte preimage and its sha256", async () => {
    const m = await createHtlcMaterial();
    expect(m.preimage).toMatch(/^[0-9a-f]{64}$/);
    expect(m.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await verifyHtlcMaterial(m.preimage, m.hash)).toBe(true);
    expect(await verifyHtlcMaterial(m.preimage, "0".repeat(64))).toBe(false);
  });
});
```

`src/zenon/validate.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { isAmount, isHex32, isTokenStandard, isZenonAddress } from "./validate.js";
import { QSR_ZTS, ZNN_ZTS, HTLC_ADDRESS } from "./types.js";

describe("validate", () => {
  it("accepts known addresses and token standards", () => {
    expect(isZenonAddress(HTLC_ADDRESS)).toBe(true);
    expect(isZenonAddress("z1qzal6c5s9rjnnxd2z7dvdhjxpmmj4fmw56a0mz")).toBe(true);
    expect(isZenonAddress("z1short")).toBe(false);
    expect(isTokenStandard(ZNN_ZTS)).toBe(true);
    expect(isTokenStandard(QSR_ZTS)).toBe(true);
    expect(isTokenStandard("zts1nope")).toBe(false);
  });
  it("checks hex32 and amounts", () => {
    expect(isHex32("a".repeat(64))).toBe(true);
    expect(isHex32("A".repeat(64))).toBe(false);
    expect(isAmount("100000000")).toBe(true);
    expect(isAmount("0")).toBe(false);
    expect(isAmount("01")).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/zenon` — Expected: FAIL (modules missing).

- [ ] **Step 3: Implement**

`src/zenon/types.ts`: exactly the block in **Interfaces** above.

`src/zenon/hex.ts`:
```ts
export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) throw new Error("Invalid hex string");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return bytesToHex(new Uint8Array(digest));
}

export async function sha256Text(text: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(text));
}

export function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  crypto.getRandomValues(out);
  return out;
}
```

`src/zenon/htlc-material.ts`:
```ts
import { bytesToHex, hexToBytes, randomBytes, sha256Hex } from "./hex.js";

export async function createHtlcMaterial(): Promise<{ preimage: string; hash: string }> {
  const preimageBytes = randomBytes(32);
  return { preimage: bytesToHex(preimageBytes), hash: await sha256Hex(preimageBytes) };
}

export async function verifyHtlcMaterial(preimage: string, hash: string): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/.test(preimage) || !/^[0-9a-f]{64}$/.test(hash)) return false;
  return (await sha256Hex(hexToBytes(preimage))) === hash;
}
```

`src/zenon/validate.ts`:
```ts
const BECH32 = "[02-9ac-hj-np-z]";
const ADDRESS = new RegExp(`^z1${BECH32}{38}$`);
const ZTS = new RegExp(`^zts1${BECH32}{22}$`);

export function isZenonAddress(value: unknown): value is string {
  return typeof value === "string" && ADDRESS.test(value);
}
export function isTokenStandard(value: unknown): value is string {
  return typeof value === "string" && ZTS.test(value);
}
export function isHex32(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}
export function isAmount(value: unknown): value is string {
  return typeof value === "string" && /^[1-9]\d*$/.test(value);
}
```

- [ ] **Step 4: Run tests** — `npx vitest run src/zenon` — Expected: PASS.

- [ ] **Step 5: Commit** — `git add src/zenon && git commit -m "feat(zenon): primitives, hex, HTLC material, validators"`

---

### Task 3: FakeZenonNode — in-memory chain with HTLC semantics

**Files:**
- Create: `src/zenon/fake-node.ts`, `src/zenon/fake-node.test.ts`

**Interfaces:**
- Consumes: `types.ts`, `hex.ts`.
- Produces:
```ts
export class FakeZenonNode implements ZenonNodePort {
  constructor(options?: { chainId?: number; now?: () => number });
  now: () => number;                       // replaceable clock (unix seconds)
  createAddress(label?: string): string;   // deterministic fake z1 address
  fund(address: string, zts: string, amount: string): void;   // credits balance directly
  signer(address: string): ZenonSigner;    // sends are applied synchronously to the fake chain
  setPow(address: string, requiresPow: boolean): void;
  failNext(kind: ZenonTemplate["kind"], error: Error): void;  // next send of that kind throws
  // ZenonNodePort methods...
}
```
Rules the fake enforces (mirroring go-zenon `vm/embedded/implementation/htlc.go`):
- `htlc_create`: sender must hold `amount` of `tokenStandard`; `expirationTime > now`; `hashLock` 32 bytes; HTLC id = hash of the create block; balance debited.
- `htlc_unlock`: HTLC must exist and not be expired (`now < expirationTime`); `sha256(preimage) == hashLock`; `preimage.length <= keyMaxSize`; funds credited to `hashLocked` as an unreceived block (any sender allowed = proxy unlock default).
- `htlc_reclaim`: HTLC must exist, `now >= expirationTime`, sender must equal `timeLocked`; funds returned to `timeLocked` as unreceived.
- `receive`: moves the unreceived block amount into the balance; block must be addressed to the sender.
- `send`: debits sender, creates unreceived block for recipient.
- Every send block gets `hash = sha256Text(address + ":" + height + ":" + JSON.stringify(template))`, sequential heights per address, `confirmations: 1`, `momentumTimestamp: now()`. Block `data` for HTLC calls is a fake-but-parseable encoding: `"unlock:" + id + ":" + preimage` hex-encoded UTF-8 (so `decodeUnlockPreimage` in Task 5 supports both the real ABI and this fake encoding through a `BlockDataDecoder` injected into the trade client — see Task 5).

- [ ] **Step 1: Write failing tests**

`src/zenon/fake-node.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { FakeZenonNode } from "./fake-node.js";
import { ZNN_ZTS, QSR_ZTS } from "./types.js";
import { createHtlcMaterial } from "./htlc-material.js";

async function setup() {
  let now = 1_000_000;
  const node = new FakeZenonNode({ chainId: 1, now: () => now });
  const alice = node.createAddress("alice");
  const bob = node.createAddress("bob");
  node.fund(alice, ZNN_ZTS, "500000000");
  node.fund(bob, QSR_ZTS, "2000000000");
  return { node, alice, bob, tick: (s: number) => { now += s; } };
}

describe("FakeZenonNode", () => {
  it("reports chain id, momentum, balances", async () => {
    const { node, alice } = await setup();
    expect(await node.chainIdentifier()).toBe(1);
    expect((await node.frontierMomentum()).timestamp).toBe(1_000_000);
    expect(await node.getBalances(alice)).toEqual([{ tokenStandard: ZNN_ZTS, symbol: "ZNN", decimals: 8, balance: "500000000" }]);
  });

  it("creates, unlocks and delivers an HTLC", async () => {
    const { node, alice, bob } = await setup();
    const m = await createHtlcMaterial();
    const { blockHash } = await node.signer(alice).send({
      kind: "htlc_create", tokenStandard: ZNN_ZTS, amount: "100000000", hashLocked: bob,
      expirationTime: 1_000_000 + 3600, hashType: 1, keyMaxSize: 32, hashLock: m.hash
    });
    const info = await node.getHtlc(blockHash);
    expect(info).toMatchObject({ id: blockHash, timeLocked: alice, hashLocked: bob, amount: "100000000", hashLock: m.hash });
    expect((await node.getBalances(alice))[0]?.balance).toBe("400000000");

    await node.signer(bob).send({ kind: "htlc_unlock", id: blockHash, preimage: m.preimage });
    expect(await node.getHtlc(blockHash)).toBeNull();
    const unreceived = await node.listUnreceived(bob);
    expect(unreceived).toHaveLength(1);
    await node.signer(bob).send({ kind: "receive", fromBlockHash: unreceived[0]!.hash });
    expect((await node.getBalances(bob)).find((b) => b.tokenStandard === ZNN_ZTS)?.balance).toBe("100000000");
    const bobBlocks = await node.listAccountBlocks(bob, 0, 10);
    expect(bobBlocks.some((b) => b.data.length > 0)).toBe(true);
  });

  it("rejects a wrong preimage, an expired unlock, and an early reclaim", async () => {
    const { node, alice, bob, tick } = await setup();
    const m = await createHtlcMaterial();
    const { blockHash } = await node.signer(alice).send({
      kind: "htlc_create", tokenStandard: ZNN_ZTS, amount: "1", hashLocked: bob,
      expirationTime: 1_000_000 + 60, hashType: 1, keyMaxSize: 32, hashLock: m.hash
    });
    await expect(node.signer(bob).send({ kind: "htlc_unlock", id: blockHash, preimage: "00".repeat(32) })).rejects.toThrow(/preimage/);
    await expect(node.signer(alice).send({ kind: "htlc_reclaim", id: blockHash })).rejects.toThrow(/expir/);
    tick(61);
    await expect(node.signer(bob).send({ kind: "htlc_unlock", id: blockHash, preimage: m.preimage })).rejects.toThrow(/expir/);
    await expect(node.signer(bob).send({ kind: "htlc_reclaim", id: blockHash })).rejects.toThrow(/timeLocked/);
    await node.signer(alice).send({ kind: "htlc_reclaim", id: blockHash });
    expect(await node.getHtlc(blockHash)).toBeNull();
    expect(await node.listUnreceived(alice)).toHaveLength(1);
  });

  it("rejects overspending and injected failures", async () => {
    const { node, alice, bob } = await setup();
    await expect(node.signer(alice).send({ kind: "send", toAddress: bob, tokenStandard: ZNN_ZTS, amount: "999999999999" })).rejects.toThrow(/balance/);
    node.failNext("send", new Error("node down"));
    await expect(node.signer(alice).send({ kind: "send", toAddress: bob, tokenStandard: ZNN_ZTS, amount: "1" })).rejects.toThrow("node down");
    await node.signer(alice).send({ kind: "send", toAddress: bob, tokenStandard: ZNN_ZTS, amount: "1" });
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/zenon/fake-node.test.ts` — FAIL.

- [ ] **Step 3: Implement `src/zenon/fake-node.ts`**

```ts
import { bytesToHex, hexToBytes, sha256Hex, sha256Text } from "./hex.js";
import {
  QSR_ZTS, ZNN_ZTS,
  type AccountBlockView, type BalanceView, type HtlcInfoView, type MomentumView,
  type PlasmaView, type SendReceipt, type ZenonNodePort, type ZenonSigner, type ZenonTemplate
} from "./types.js";

interface FakeHtlc extends HtlcInfoView {}

const KNOWN_TOKENS: Record<string, { symbol: string; decimals: number }> = {
  [ZNN_ZTS]: { symbol: "ZNN", decimals: 8 },
  [QSR_ZTS]: { symbol: "QSR", decimals: 8 }
};

export function encodeFakeUnlockData(id: string, preimage: string): string {
  return bytesToHex(new TextEncoder().encode(`unlock:${id}:${preimage}`));
}

export function decodeFakeUnlockData(dataHex: string): { id: string; preimage: string } | null {
  try {
    const text = new TextDecoder().decode(hexToBytes(dataHex));
    const m = /^unlock:([0-9a-f]{64}):([0-9a-f]+)$/.exec(text);
    return m ? { id: m[1]!, preimage: m[2]! } : null;
  } catch {
    return null;
  }
}

export class FakeZenonNode implements ZenonNodePort {
  now: () => number;
  private readonly chainId: number;
  private readonly balances = new Map<string, Map<string, bigint>>();
  private readonly blocks = new Map<string, AccountBlockView[]>();
  private readonly blocksByHash = new Map<string, AccountBlockView>();
  private readonly unreceived = new Map<string, AccountBlockView[]>();
  private readonly htlcs = new Map<string, FakeHtlc>();
  private readonly pow = new Map<string, boolean>();
  private readonly failures = new Map<ZenonTemplate["kind"], Error>();
  private height = 1;
  private addressCounter = 0;

  constructor(options: { chainId?: number; now?: () => number } = {}) {
    this.chainId = options.chainId ?? 1;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  createAddress(label = `addr${this.addressCounter}`): string {
    this.addressCounter += 1;
    const alphabet = "023456789acdefghjklmnpqrstuvwxyz";
    let seed = 0;
    for (const ch of `${label}:${this.addressCounter}`) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
    let body = "";
    for (let i = 0; i < 38; i += 1) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      body += alphabet[seed % alphabet.length];
    }
    return `z1${body}`;
  }

  fund(address: string, zts: string, amount: string): void {
    this.credit(address, zts, BigInt(amount));
  }

  setPow(address: string, requiresPow: boolean): void { this.pow.set(address, requiresPow); }
  failNext(kind: ZenonTemplate["kind"], error: Error): void { this.failures.set(kind, error); }

  signer(address: string): ZenonSigner {
    return { address: () => address, send: (template) => this.apply(address, template) };
  }

  async chainIdentifier(): Promise<number> { return this.chainId; }
  async frontierMomentum(): Promise<MomentumView> {
    this.height += 1;
    return { hash: await sha256Text(`momentum:${this.height}`), height: this.height, timestamp: this.now() };
  }
  async getHtlc(id: string): Promise<HtlcInfoView | null> { return this.htlcs.get(id) ?? null; }
  async getAccountBlock(hash: string): Promise<AccountBlockView | null> { return this.blocksByHash.get(hash) ?? null; }
  async listAccountBlocks(address: string, pageIndex: number, pageSize: number): Promise<AccountBlockView[]> {
    const all = [...(this.blocks.get(address) ?? [])].reverse();
    return all.slice(pageIndex * pageSize, pageIndex * pageSize + pageSize);
  }
  async getBalances(address: string): Promise<BalanceView[]> {
    const map = this.balances.get(address) ?? new Map<string, bigint>();
    return [...map.entries()].filter(([, v]) => v > 0n).map(([zts, v]) => ({
      tokenStandard: zts,
      symbol: KNOWN_TOKENS[zts]?.symbol ?? zts.slice(4, 8).toUpperCase(),
      decimals: KNOWN_TOKENS[zts]?.decimals ?? 8,
      balance: v.toString()
    }));
  }
  async listUnreceived(address: string): Promise<AccountBlockView[]> { return [...(this.unreceived.get(address) ?? [])]; }
  async getTokenDecimals(zts: string): Promise<number> { return KNOWN_TOKENS[zts]?.decimals ?? 8; }
  async getPlasma(address: string): Promise<PlasmaView> {
    return this.pow.get(address) ? { currentPlasma: 0, maxPlasma: 0, qsrFused: "0" } : { currentPlasma: 210000, maxPlasma: 210000, qsrFused: "10000000000" };
  }

  private balance(address: string, zts: string): bigint {
    return this.balances.get(address)?.get(zts) ?? 0n;
  }
  private credit(address: string, zts: string, amount: bigint): void {
    const map = this.balances.get(address) ?? new Map<string, bigint>();
    map.set(zts, (map.get(zts) ?? 0n) + amount);
    this.balances.set(address, map);
  }
  private debit(address: string, zts: string, amount: bigint): void {
    if (this.balance(address, zts) < amount) throw new Error("insufficient balance");
    this.credit(address, zts, -amount);
  }

  private async record(address: string, toAddress: string, zts: string, amount: bigint, blockType: number, data: string, fromBlockHash = "0".repeat(64)): Promise<AccountBlockView> {
    const list = this.blocks.get(address) ?? [];
    const height = list.length + 1;
    const hash = await sha256Text(`${address}:${height}:${toAddress}:${amount}:${data}:${fromBlockHash}`);
    const block: AccountBlockView = {
      hash, height, blockType, address, toAddress, amount: amount.toString(), tokenStandard: zts,
      fromBlockHash, data, confirmations: 1, momentumTimestamp: this.now()
    };
    list.push(block);
    this.blocks.set(address, list);
    this.blocksByHash.set(hash, block);
    return block;
  }

  private async deliver(from: string, to: string, zts: string, amount: bigint, data = ""): Promise<void> {
    const block = await this.record(from, to, zts, amount, 4, data);
    const pending = this.unreceived.get(to) ?? [];
    pending.push(block);
    this.unreceived.set(to, pending);
  }

  private async apply(sender: string, template: ZenonTemplate): Promise<SendReceipt> {
    const injected = this.failures.get(template.kind);
    if (injected) { this.failures.delete(template.kind); throw injected; }
    const now = this.now();
    switch (template.kind) {
      case "send": {
        const amount = BigInt(template.amount);
        this.debit(sender, template.tokenStandard, amount);
        const block = await this.record(sender, template.toAddress, template.tokenStandard, amount, 2, "");
        const pending = this.unreceived.get(template.toAddress) ?? [];
        pending.push(block);
        this.unreceived.set(template.toAddress, pending);
        return { blockHash: block.hash };
      }
      case "receive": {
        const pending = this.unreceived.get(sender) ?? [];
        const index = pending.findIndex((b) => b.hash === template.fromBlockHash);
        if (index < 0) throw new Error("no such unreceived block for this address");
        const [block] = pending.splice(index, 1);
        this.credit(sender, block!.tokenStandard, BigInt(block!.amount));
        const receive = await this.record(sender, sender, block!.tokenStandard, BigInt(block!.amount), 3, "", block!.hash);
        return { blockHash: receive.hash };
      }
      case "htlc_create": {
        if (template.expirationTime <= now) throw new Error("expirationTime must be in the future");
        if (!/^[0-9a-f]{64}$/.test(template.hashLock)) throw new Error("hashLock must be 32 bytes");
        const amount = BigInt(template.amount);
        this.debit(sender, template.tokenStandard, amount);
        const block = await this.record(sender, "z1qxemdeddedxhtlcxxxxxxxxxxxxxxxxxygecvw", template.tokenStandard, amount, 2, bytesToHex(new TextEncoder().encode(`create:${template.hashLock}`)));
        this.htlcs.set(block.hash, {
          id: block.hash, timeLocked: sender, hashLocked: template.hashLocked, tokenStandard: template.tokenStandard,
          amount: template.amount, expirationTime: template.expirationTime, hashType: template.hashType,
          keyMaxSize: template.keyMaxSize, hashLock: template.hashLock
        });
        return { blockHash: block.hash };
      }
      case "htlc_unlock": {
        const htlc = this.htlcs.get(template.id);
        if (!htlc) throw new Error("htlc not found");
        if (now >= htlc.expirationTime) throw new Error("htlc expired");
        const preimageBytes = hexToBytes(template.preimage);
        if (preimageBytes.length > htlc.keyMaxSize) throw new Error("preimage exceeds keyMaxSize");
        if ((await sha256Hex(preimageBytes)) !== htlc.hashLock) throw new Error("invalid preimage");
        this.htlcs.delete(template.id);
        const block = await this.record(sender, "z1qxemdeddedxhtlcxxxxxxxxxxxxxxxxxygecvw", htlc.tokenStandard, 0n, 2, encodeFakeUnlockData(template.id, template.preimage));
        await this.deliver("z1qxemdeddedxhtlcxxxxxxxxxxxxxxxxxygecvw", htlc.hashLocked, htlc.tokenStandard, BigInt(htlc.amount));
        return { blockHash: block.hash };
      }
      case "htlc_reclaim": {
        const htlc = this.htlcs.get(template.id);
        if (!htlc) throw new Error("htlc not found");
        if (now < htlc.expirationTime) throw new Error("htlc not yet expired");
        if (htlc.timeLocked !== sender) throw new Error("only timeLocked may reclaim");
        this.htlcs.delete(template.id);
        const block = await this.record(sender, "z1qxemdeddedxhtlcxxxxxxxxxxxxxxxxxygecvw", htlc.tokenStandard, 0n, 2, bytesToHex(new TextEncoder().encode(`reclaim:${template.id}`)));
        await this.deliver("z1qxemdeddedxhtlcxxxxxxxxxxxxxxxxxygecvw", htlc.timeLocked, htlc.tokenStandard, BigInt(htlc.amount));
        return { blockHash: block.hash };
      }
    }
  }
}
```

- [ ] **Step 4: Run tests** — `npx vitest run src/zenon/fake-node.test.ts` — PASS.

- [ ] **Step 5: Commit** — `git add src/zenon && git commit -m "feat(zenon): in-memory fake node with HTLC semantics"`

---

### Task 4: SDK node adapter and keystore signer

**Files:**
- Create: `src/zenon/sdk-node.ts`, `src/zenon/keystore-signer.ts`, `src/zenon/keystore-signer.test.ts`, `src/zenon/sdk-node.test.ts`

**Interfaces:**
- Consumes: SDK — `Zenon.getInstance()`, `Zenon.setChainID/setNetworkID/setPowBasePath/usePowWorker/setPowProvider`, `zenon.initialize(url, timeoutMs)`, `zenon.send(template, keyPair)`, `zenon.ledger.*`, `zenon.embedded.htlc.*`, `zenon.embedded.plasma.get`, `zenon.embedded.token.getByZts`, `KeyStore`, `KeyPair`, `Address`, `Hash`, `TokenStandard`, `AccountBlockTemplate`, `isPowWorkerSupported`.
- Produces:
```ts
export interface SdkZenonNodeOptions { nodeUrl: string; chainId: number; connectTimeoutMs?: number; }
export class SdkZenonNode implements ZenonNodePort {
  static async connect(options: SdkZenonNodeOptions): Promise<SdkZenonNode>;   // initializes SDK, verifies chain id, throws ChainMismatchError
  disconnect(): void;
  readonly zenon: Zenon;   // exposed for the signer
}
export class ChainMismatchError extends Error { constructor(readonly expected: number, readonly actual: number) }
export class KeystoreSigner implements ZenonSigner {
  constructor(zenon: Pick<Zenon, "send">, keyPair: KeyPair, hooks?: { onPowStart?: () => void; onPowEnd?: () => void });
  address(): string;
  send(template: ZenonTemplate): Promise<SendReceipt>;   // serialized per instance
  static installPowWorker(hooks?: { onPowStart?: () => void; onPowEnd?: () => void }): void;
}
export function toSdkTemplate(template: ZenonTemplate, zenon: Zenon): AccountBlockTemplate;   // pure mapping, unit-tested
```

- [ ] **Step 1: Write failing tests**

`src/zenon/keystore-signer.test.ts` (tests the pure mapping and the serial queue with a stubbed `send`):
```ts
import { describe, expect, it } from "vitest";
import { KeyStore, Zenon, HTLC_ADDRESS as SDK_HTLC } from "znn-typescript-sdk";
import { KeystoreSigner, toSdkTemplate } from "./keystore-signer.js";
import { ZNN_ZTS } from "./types.js";

const TEST_MNEMONIC = KeyStore.newRandom().mnemonic; // throwaway, never funded

describe("toSdkTemplate", () => {
  it("maps an htlc_create to a call on the HTLC contract carrying the locked amount", () => {
    const zenon = Zenon.getInstance();
    const t = toSdkTemplate({
      kind: "htlc_create", tokenStandard: ZNN_ZTS, amount: "100000000",
      hashLocked: "z1qzal6c5s9rjnnxd2z7dvdhjxpmmj4fmw56a0mz", expirationTime: 1_700_000_000,
      hashType: 1, keyMaxSize: 32, hashLock: "ab".repeat(32)
    }, zenon);
    expect(t.toAddress.toString()).toBe(SDK_HTLC.toString());
    expect(t.tokenStandard.toString()).toBe(ZNN_ZTS);
    expect(String(t.amount)).toBe("100000000");
    expect(t.data.length).toBeGreaterThan(4);
  });
  it("maps unlock, reclaim, receive and send", () => {
    const zenon = Zenon.getInstance();
    expect(toSdkTemplate({ kind: "htlc_unlock", id: "00".repeat(32), preimage: "11".repeat(32) }, zenon).toAddress.toString()).toBe(SDK_HTLC.toString());
    expect(toSdkTemplate({ kind: "htlc_reclaim", id: "00".repeat(32) }, zenon).toAddress.toString()).toBe(SDK_HTLC.toString());
    expect(toSdkTemplate({ kind: "receive", fromBlockHash: "22".repeat(32) }, zenon).fromBlockHash.toString()).toBe("22".repeat(32));
    const s = toSdkTemplate({ kind: "send", toAddress: "z1qzal6c5s9rjnnxd2z7dvdhjxpmmj4fmw56a0mz", tokenStandard: ZNN_ZTS, amount: "5" }, zenon);
    expect(String(s.amount)).toBe("5");
  });
});

describe("KeystoreSigner", () => {
  it("serializes sends and returns the published hash", async () => {
    const keyPair = KeyStore.fromMnemonic(TEST_MNEMONIC).getKeyPair(0);
    const order: number[] = [];
    let counter = 0;
    const fakeZenon = {
      send: async (template: { hash: { toString(): string } }) => {
        const id = counter++;
        order.push(id);
        await new Promise((r) => setTimeout(r, id === 0 ? 20 : 0));
        return { ...template, hash: { toString: () => `${id}`.padStart(64, "0") } } as never;
      }
    };
    const signer = new KeystoreSigner(fakeZenon as never, keyPair);
    expect(signer.address()).toBe(keyPair.address.toString());
    const [a, b] = await Promise.all([
      signer.send({ kind: "receive", fromBlockHash: "aa".repeat(32) }),
      signer.send({ kind: "receive", fromBlockHash: "bb".repeat(32) })
    ]);
    expect(a.blockHash).toBe("0".repeat(63) + "0");
    expect(b.blockHash).toBe("0".repeat(63) + "1");
    expect(order).toEqual([0, 1]);
  });
});
```

`src/zenon/sdk-node.test.ts` — only the pure conversion helpers (`htlcInfoToView`, `accountBlockToView`) are unit-tested; the live connection is exercised by the gated integration test in Task 15:
```ts
import { describe, expect, it } from "vitest";
import { accountBlockToView, htlcInfoToView } from "./sdk-node.js";
import { HtlcInfo, AccountBlock } from "znn-typescript-sdk";

describe("sdk-node views", () => {
  it("converts HtlcInfo with base64 hashLock into bare hex", () => {
    const info = HtlcInfo.fromJson({
      id: "aa".repeat(32), timeLocked: "z1qzal6c5s9rjnnxd2z7dvdhjxpmmj4fmw56a0mz", hashLocked: "z1qzal6c5s9rjnnxd2z7dvdhjxpmmj4fmw56a0mz",
      tokenStandard: "zts1znnxxxxxxxxxxxxx9z4ulx", amount: "100", expirationTime: 5, hashType: 1, keyMaxSize: 32,
      hashLock: Buffer.from("cd".repeat(32), "hex").toString("base64")
    });
    expect(htlcInfoToView(info)).toEqual({
      id: "aa".repeat(32), timeLocked: "z1qzal6c5s9rjnnxd2z7dvdhjxpmmj4fmw56a0mz", hashLocked: "z1qzal6c5s9rjnnxd2z7dvdhjxpmmj4fmw56a0mz",
      tokenStandard: "zts1znnxxxxxxxxxxxxx9z4ulx", amount: "100", expirationTime: 5, hashType: 1, keyMaxSize: 32, hashLock: "cd".repeat(32)
    });
  });
  it("converts an AccountBlock with confirmation detail", () => {
    const block = AccountBlock.fromJson({
      version: 1, chainIdentifier: 1, blockType: 2, hash: "ab".repeat(32), previousHash: "00".repeat(32), height: 3,
      momentumAcknowledged: { hash: "00".repeat(32), height: 1 }, address: "z1qzal6c5s9rjnnxd2z7dvdhjxpmmj4fmw56a0mz",
      toAddress: "z1qxemdeddedxhtlcxxxxxxxxxxxxxxxxxygecvw", amount: "7", tokenStandard: "zts1znnxxxxxxxxxxxxx9z4ulx",
      fromBlockHash: "00".repeat(32), data: Buffer.from("0102", "hex").toString("base64"), fusedPlasma: 0, difficulty: 0, nonce: "0000000000000000",
      publicKey: "", signature: "", descendantBlocks: [], basePlasma: 0, usedPlasma: 0, changesHash: "00".repeat(32),
      confirmationDetail: { numConfirmations: 4, momentumHeight: 9, momentumHash: "00".repeat(32), momentumTimestamp: 123 }, pairedAccountBlock: null, token: null
    });
    expect(accountBlockToView(block)).toMatchObject({ hash: "ab".repeat(32), height: 3, blockType: 2, amount: "7", data: "0102", confirmations: 4, momentumTimestamp: 123 });
  });
});
```
If `AccountBlock.fromJson` requires more fields than shown, add them with zero values until it parses — the assertion is on the view mapping.

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/zenon/keystore-signer.test.ts src/zenon/sdk-node.test.ts` — FAIL.

- [ ] **Step 3: Implement `src/zenon/keystore-signer.ts`**

```ts
import { Buffer } from "buffer";
import {
  AccountBlockTemplate, Address, Hash, TokenStandard, Zenon, isPowWorkerSupported,
  type KeyPair
} from "znn-typescript-sdk";
import type { SendReceipt, ZenonSigner, ZenonTemplate } from "./types.js";

export function toSdkTemplate(template: ZenonTemplate, zenon: Pick<Zenon, "embedded">): AccountBlockTemplate {
  switch (template.kind) {
    case "htlc_create":
      return zenon.embedded.htlc.create(
        TokenStandard.parse(template.tokenStandard), BigInt(template.amount), Address.parse(template.hashLocked),
        template.expirationTime, template.hashType, template.keyMaxSize, Buffer.from(template.hashLock, "hex")
      );
    case "htlc_unlock":
      return zenon.embedded.htlc.unlock(Hash.parse(template.id), Buffer.from(template.preimage, "hex"));
    case "htlc_reclaim":
      return zenon.embedded.htlc.reclaim(Hash.parse(template.id));
    case "receive":
      return AccountBlockTemplate.receive(Hash.parse(template.fromBlockHash));
    case "send":
      return AccountBlockTemplate.send(Address.parse(template.toAddress), TokenStandard.parse(template.tokenStandard), BigInt(template.amount));
  }
}

export interface PowHooks { onPowStart?: () => void; onPowEnd?: () => void; }

export class KeystoreSigner implements ZenonSigner {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly zenon: Pick<Zenon, "send" | "embedded">,
    private readonly keyPair: KeyPair
  ) {}

  static installPowWorker(hooks: PowHooks = {}): void {
    Zenon.setPowBasePath("/");
    if (!isPowWorkerSupported()) return;
    const worker = Zenon.usePowWorker();
    Zenon.setPowProvider(async (hashHex, difficulty) => {
      hooks.onPowStart?.();
      try { return await worker.generate(hashHex, difficulty); } finally { hooks.onPowEnd?.(); }
    });
  }

  address(): string { return this.keyPair.address.toString(); }

  send(template: ZenonTemplate): Promise<SendReceipt> {
    const run = this.queue.then(async () => {
      const sdkTemplate = toSdkTemplate(template, this.zenon);
      const published = await this.zenon.send(sdkTemplate, this.keyPair);
      return { blockHash: published.hash.toString() };
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}
```
Note: the test passes a stub without `embedded` for `receive` templates — `toSdkTemplate` only touches `zenon.embedded` for HTLC kinds, so the stub is sufficient. In the test, `Zenon.getInstance()` is used for the mapping test (no network needed to build templates).

- [ ] **Step 4: Implement `src/zenon/sdk-node.ts`**

```ts
import {
  Address, Hash, TokenStandard, Zenon, type AccountBlock, type HtlcInfo
} from "znn-typescript-sdk";
import type {
  AccountBlockView, BalanceView, HtlcInfoView, MomentumView, PlasmaView, ZenonNodePort
} from "./types.js";

export class ChainMismatchError extends Error {
  constructor(readonly expected: number, readonly actual: number) {
    super(`Connected node reports chain ${actual}, expected ${expected}`);
  }
}

export function htlcInfoToView(info: HtlcInfo): HtlcInfoView {
  return {
    id: info.id.toString(), timeLocked: info.timeLocked.toString(), hashLocked: info.hashLocked.toString(),
    tokenStandard: info.tokenStandard.toString(), amount: info.amount.toString(), expirationTime: info.expirationTime,
    hashType: info.hashType, keyMaxSize: info.keyMaxSize, hashLock: Buffer.from(info.hashLock).toString("hex")
  };
}

export function accountBlockToView(block: AccountBlock): AccountBlockView {
  return {
    hash: block.hash.toString(), height: block.height, blockType: block.blockType, address: block.address.toString(),
    toAddress: block.toAddress.toString(), amount: block.amount.toString(), tokenStandard: block.tokenStandard.toString(),
    fromBlockHash: block.fromBlockHash.toString(), data: Buffer.from(block.data).toString("hex"),
    confirmations: block.confirmationDetail?.numConfirmations ?? null,
    momentumTimestamp: block.confirmationDetail?.momentumTimestamp ?? null
  };
}

export interface SdkZenonNodeOptions { nodeUrl: string; chainId: number; connectTimeoutMs?: number; }

export class SdkZenonNode implements ZenonNodePort {
  private constructor(readonly zenon: Zenon, private readonly chainId: number) {}

  static async connect(options: SdkZenonNodeOptions): Promise<SdkZenonNode> {
    Zenon.setChainID(options.chainId);
    Zenon.setNetworkID(options.chainId === 1 ? 1 : options.chainId);
    const zenon = Zenon.getInstance();
    await zenon.initialize(options.nodeUrl, options.connectTimeoutMs ?? 8000);
    const momentum = await zenon.ledger.getFrontierMomentum();
    if (momentum.chainIdentifier !== options.chainId) {
      zenon.clearConnection();
      throw new ChainMismatchError(options.chainId, momentum.chainIdentifier);
    }
    return new SdkZenonNode(zenon, options.chainId);
  }

  disconnect(): void { this.zenon.clearConnection(); }

  async chainIdentifier(): Promise<number> { return this.chainId; }
  async frontierMomentum(): Promise<MomentumView> {
    const m = await this.zenon.ledger.getFrontierMomentum();
    return { hash: m.hash.toString(), height: m.height, timestamp: m.timestamp };
  }
  async getHtlc(id: string): Promise<HtlcInfoView | null> {
    try {
      return htlcInfoToView(await this.zenon.embedded.htlc.getById(Hash.parse(id)));
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }
  async getAccountBlock(hash: string): Promise<AccountBlockView | null> {
    const block = await this.zenon.ledger.getAccountBlockByHash(Hash.parse(hash));
    return block ? accountBlockToView(block) : null;
  }
  async listAccountBlocks(address: string, pageIndex: number, pageSize: number): Promise<AccountBlockView[]> {
    const list = await this.zenon.ledger.getAccountBlocksByPage(Address.parse(address), pageIndex, pageSize);
    return list.list.map(accountBlockToView);
  }
  async getBalances(address: string): Promise<BalanceView[]> {
    const info = await this.zenon.ledger.getAccountInfoByAddress(Address.parse(address));
    if (!info) return [];
    return Object.entries(info.balanceInfoMap).filter(([, v]) => v.balance > 0n).map(([zts, v]) => ({
      tokenStandard: zts, symbol: v.token.symbol, decimals: v.token.decimals, balance: v.balance.toString()
    }));
  }
  async listUnreceived(address: string): Promise<AccountBlockView[]> {
    const list = await this.zenon.ledger.getUnreceivedBlocksByAddress(Address.parse(address), 0, 50);
    return list.list.map(accountBlockToView);
  }
  async getTokenDecimals(zts: string): Promise<number> {
    const token = await this.zenon.embedded.token.getByZts(TokenStandard.parse(zts));
    if (!token) throw new Error(`Unknown token standard ${zts}`);
    return token.decimals;
  }
  async getPlasma(address: string): Promise<PlasmaView> {
    const p = await this.zenon.embedded.plasma.get(Address.parse(address));
    return { currentPlasma: p.currentPlasma, maxPlasma: p.maxPlasma, qsrFused: p.qsrAmount.toString() };
  }
}

function isNotFound(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /not found|no htlc|null/i.test(message) || (typeof error === "object" && error !== null && "code" in error && (error as { code: unknown }).code === -32000);
}
```
`getById` on a spent/reclaimed HTLC returns an RPC error (`data not found` style) — `isNotFound` maps it to `null`. If the live node returns a different message, widen the regex in the integration test (Task 15) and note it in the ADR.

- [ ] **Step 5: Run tests** — `npx vitest run src/zenon` — PASS. If the SDK import fails under vitest (jsdom + webpack bundle), add to `vite.config.ts` `test.server.deps.inline: ["znn-typescript-sdk"]` and `test.environmentOptions.jsdom.url: "http://localhost/"`; if `argon2-browser` complains about WASM in tests, that is fine — the keystore file encryption is not imported by these tests.

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(zenon): SDK node adapter and keystore signer"`

---

### Task 5: Pure HTLC validation and unlock decoding

**Files:**
- Create: `src/zenon/htlc.ts`, `src/zenon/htlc.test.ts`

**Interfaces:**
- Consumes: `HtlcInfoView`, `AccountBlockView`, `decodeFakeUnlockData` from `fake-node.ts`, SDK `Htlc` contract (`HtlcContract.decodeCallData`).
- Produces:
```ts
export interface ExpectedZenonLock {
  leg: "base" | "quote";
  chainId: string;
  tokenStandard: string;
  amount: string;
  hashLock: string;
  hashType: 1;
  keyMaxSize: 32;
  hashLockedAddress: string;
  timeLockedAddress: string;
  expirationTime: number;
  binding: { protocolVersion: "1"; network: string; orderId: string; sessionId: string; reservationId: string; transcriptHash: string };
}
export type HtlcValidationCode = "htlc-token" | "htlc-amount" | "htlc-hashlock" | "htlc-hashtype" | "htlc-keymaxsize" | "htlc-hashlocked" | "htlc-timelocked" | "htlc-expiration";
export class HtlcValidationError extends Error { constructor(readonly code: HtlcValidationCode) }
export function validateHtlcInfo(info: HtlcInfoView, expected: ExpectedZenonLock): void;  // throws HtlcValidationError
export function htlcValidationCommitment(info: HtlcInfoView): Promise<string>;              // sha256 of canonical JSON of the view
export type UnlockDecoder = (block: AccountBlockView) => { id: string; preimage: string } | null;
export const sdkUnlockDecoder: UnlockDecoder;    // real ABI: HtlcContract.decodeCallData("0x"+data)
export const fakeUnlockDecoder: UnlockDecoder;   // decodeFakeUnlockData
export function findUnlockPreimage(blocks: AccountBlockView[], htlcId: string, hashLock: string, decode: UnlockDecoder): Promise<{ preimage: string; blockHash: string } | null>;  // verifies sha256(preimage) === hashLock
```

- [ ] **Step 1: Write failing tests**

`src/zenon/htlc.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { fakeUnlockDecoder, findUnlockPreimage, htlcValidationCommitment, sdkUnlockDecoder, validateHtlcInfo, type ExpectedZenonLock } from "./htlc.js";
import { encodeFakeUnlockData } from "./fake-node.js";
import { HTLC_ADDRESS, ZNN_ZTS, type AccountBlockView, type HtlcInfoView } from "./types.js";
import { createHtlcMaterial } from "./htlc-material.js";
import { Zenon } from "znn-typescript-sdk";

const A = "z1qzal6c5s9rjnnxd2z7dvdhjxpmmj4fmw56a0mz";
const B = "z1qqw6sypygz8sq4tzy4c8u7tlmqf5dh9kupt2wgv";

function expected(over: Partial<ExpectedZenonLock> = {}): ExpectedZenonLock {
  return {
    leg: "base", chainId: "1", tokenStandard: ZNN_ZTS, amount: "100", hashLock: "ab".repeat(32), hashType: 1, keyMaxSize: 32,
    hashLockedAddress: B, timeLockedAddress: A, expirationTime: 2000,
    binding: { protocolVersion: "1", network: "zenon-mainnet", orderId: "o", sessionId: "s", reservationId: "r", transcriptHash: "cd".repeat(32) },
    ...over
  };
}
function info(over: Partial<HtlcInfoView> = {}): HtlcInfoView {
  return { id: "ef".repeat(32), timeLocked: A, hashLocked: B, tokenStandard: ZNN_ZTS, amount: "100", expirationTime: 2000, hashType: 1, keyMaxSize: 32, hashLock: "ab".repeat(32), ...over };
}

describe("validateHtlcInfo", () => {
  it("accepts a matching HTLC", () => { expect(() => validateHtlcInfo(info(), expected())).not.toThrow(); });
  it.each([
    ["htlc-token", { tokenStandard: "zts1qsrxxxxxxxxxxxxxmrhjll" }],
    ["htlc-amount", { amount: "99" }],
    ["htlc-hashlock", { hashLock: "00".repeat(32) }],
    ["htlc-hashtype", { hashType: 0 }],
    ["htlc-keymaxsize", { keyMaxSize: 16 }],
    ["htlc-hashlocked", { hashLocked: A }],
    ["htlc-timelocked", { timeLocked: B }],
    ["htlc-expiration", { expirationTime: 1999 }]
  ] as const)("rejects %s", (code, over) => {
    expect(() => validateHtlcInfo(info(over), expected())).toThrow(expect.objectContaining({ code }));
  });
  it("commits to the whole view", async () => {
    expect(await htlcValidationCommitment(info())).toMatch(/^[0-9a-f]{64}$/);
    expect(await htlcValidationCommitment(info())).not.toBe(await htlcValidationCommitment(info({ amount: "1" })));
  });
});

describe("findUnlockPreimage", () => {
  it("finds a fake-encoded unlock and verifies it", async () => {
    const m = await createHtlcMaterial();
    const id = "11".repeat(32);
    const blocks: AccountBlockView[] = [
      { hash: "a".repeat(64), height: 2, blockType: 2, address: B, toAddress: A, amount: "1", tokenStandard: ZNN_ZTS, fromBlockHash: "0".repeat(64), data: "", confirmations: 1, momentumTimestamp: 1 },
      { hash: "b".repeat(64), height: 1, blockType: 2, address: B, toAddress: HTLC_ADDRESS, amount: "0", tokenStandard: ZNN_ZTS, fromBlockHash: "0".repeat(64), data: encodeFakeUnlockData(id, m.preimage), confirmations: 1, momentumTimestamp: 1 }
    ];
    expect(await findUnlockPreimage(blocks, id, m.hash, fakeUnlockDecoder)).toEqual({ preimage: m.preimage, blockHash: "b".repeat(64) });
    expect(await findUnlockPreimage(blocks, id, "00".repeat(32), fakeUnlockDecoder)).toBeNull();
    expect(await findUnlockPreimage(blocks, "22".repeat(32), m.hash, fakeUnlockDecoder)).toBeNull();
  });
  it("decodes a real ABI-encoded unlock", async () => {
    const m = await createHtlcMaterial();
    const id = "33".repeat(32);
    const t = Zenon.getInstance().embedded.htlc.unlock(
      (await import("znn-typescript-sdk")).Hash.parse(id), Buffer.from(m.preimage, "hex")
    );
    const block: AccountBlockView = { hash: "c".repeat(64), height: 1, blockType: 2, address: B, toAddress: HTLC_ADDRESS, amount: "0", tokenStandard: ZNN_ZTS, fromBlockHash: "0".repeat(64), data: Buffer.from(t.data).toString("hex"), confirmations: 1, momentumTimestamp: 1 };
    expect(await findUnlockPreimage([block], id, m.hash, sdkUnlockDecoder)).toEqual({ preimage: m.preimage, blockHash: "c".repeat(64) });
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/zenon/htlc.test.ts` — FAIL.

- [ ] **Step 3: Implement `src/zenon/htlc.ts`**

```ts
import { Htlc as HtlcContract } from "znn-typescript-sdk";
import { decodeFakeUnlockData } from "./fake-node.js";
import { hexToBytes, sha256Hex, sha256Text } from "./hex.js";
import { HTLC_ADDRESS, type AccountBlockView, type HtlcInfoView } from "./types.js";

export interface ExpectedZenonLock {
  leg: "base" | "quote";
  chainId: string;
  tokenStandard: string;
  amount: string;
  hashLock: string;
  hashType: 1;
  keyMaxSize: 32;
  hashLockedAddress: string;
  timeLockedAddress: string;
  expirationTime: number;
  binding: {
    protocolVersion: "1";
    network: string;
    orderId: string;
    sessionId: string;
    reservationId: string;
    transcriptHash: string;
  };
}

export type HtlcValidationCode =
  | "htlc-token" | "htlc-amount" | "htlc-hashlock" | "htlc-hashtype" | "htlc-keymaxsize"
  | "htlc-hashlocked" | "htlc-timelocked" | "htlc-expiration";

export class HtlcValidationError extends Error {
  constructor(readonly code: HtlcValidationCode) { super(`HTLC does not match expected terms: ${code}`); }
}

export function validateHtlcInfo(info: HtlcInfoView, expected: ExpectedZenonLock): void {
  if (info.tokenStandard !== expected.tokenStandard) throw new HtlcValidationError("htlc-token");
  if (info.amount !== expected.amount) throw new HtlcValidationError("htlc-amount");
  if (info.hashLock !== expected.hashLock) throw new HtlcValidationError("htlc-hashlock");
  if (info.hashType !== expected.hashType) throw new HtlcValidationError("htlc-hashtype");
  if (info.keyMaxSize !== expected.keyMaxSize) throw new HtlcValidationError("htlc-keymaxsize");
  if (info.hashLocked !== expected.hashLockedAddress) throw new HtlcValidationError("htlc-hashlocked");
  if (info.timeLocked !== expected.timeLockedAddress) throw new HtlcValidationError("htlc-timelocked");
  if (info.expirationTime !== expected.expirationTime) throw new HtlcValidationError("htlc-expiration");
}

export async function htlcValidationCommitment(info: HtlcInfoView): Promise<string> {
  const ordered = Object.fromEntries(Object.entries(info).sort(([a], [b]) => (a < b ? -1 : 1)));
  return sha256Text(`zwap-htlc-view-v1\n${JSON.stringify(ordered)}`);
}

export type UnlockDecoder = (block: AccountBlockView) => { id: string; preimage: string } | null;

export const sdkUnlockDecoder: UnlockDecoder = (block) => {
  if (block.toAddress !== HTLC_ADDRESS || block.data.length < 8) return null;
  try {
    const call = HtlcContract.decodeCallData(`0x${block.data}`, true) as { name: string; args: Record<string, string> };
    if (call.name !== "Unlock") return null;
    const id = call.args.id?.replace(/^0x/, "").toLowerCase();
    const preimage = call.args.preimage?.replace(/^0x/, "").toLowerCase();
    return id && preimage ? { id, preimage } : null;
  } catch {
    return null;
  }
};

export const fakeUnlockDecoder: UnlockDecoder = (block) =>
  block.toAddress === HTLC_ADDRESS ? decodeFakeUnlockData(block.data) : null;

export async function findUnlockPreimage(
  blocks: AccountBlockView[], htlcId: string, hashLock: string, decode: UnlockDecoder
): Promise<{ preimage: string; blockHash: string } | null> {
  for (const block of blocks) {
    const call = decode(block);
    if (!call || call.id !== htlcId) continue;
    if ((await sha256Hex(hexToBytes(call.preimage))) === hashLock) return { preimage: call.preimage, blockHash: block.hash };
  }
  return null;
}
```

- [ ] **Step 4: Run tests** — PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(zenon): HTLC validation and unlock decoding"`

---

### Task 6: ZenonTradeClient — executor for lock / claim / refund / observe

**Files:**
- Create: `src/zenon/trade-client.ts`, `src/zenon/trade-client.test.ts`

**Interfaces:**
- Consumes: `ZenonNodePort`, `ZenonSigner`, `ExpectedZenonLock`, `validateHtlcInfo`, `htlcValidationCommitment`, `findUnlockPreimage`, `UnlockDecoder`, `sha256Text`.
- Produces:
```ts
export interface PreparedChainOperation {
  version: 1;
  kind: "lock" | "claim" | "refund";
  chainId: string;
  tokenStandard: string;
  amount: string;
  htlcId: string | null;          // null for lock (assigned on completion)
  expected: ExpectedZenonLock;
  operationCommitment: string;    // sha256 of canonical operation terms
}
export interface LockSummary { htlcId: string; validationCommitment: string; observedAt: number; }
export interface CompletedLock { blockHash: string; htlcId: string; summary: LockSummary; }
export interface CompletedSpend { blockHash: string; htlcId: string; }
export interface HtlcObservation { state: HtlcState; observedAt: number; preimage: string | null; witnessCommitment: string | null; }
export class ZenonTradeError extends Error { constructor(readonly code: string) }
export class ZenonTradeClient {
  constructor(deps: { node: ZenonNodePort; signer: ZenonSigner; decodeUnlock: UnlockDecoder; now: () => number; scanPages?: number; pageSize?: number });
  address(): string;
  prepareLock(input: { expected: ExpectedZenonLock; now: number }): Promise<PreparedChainOperation>;  // asserts balance >= amount, expiration in future, signer == timeLockedAddress
  completeLock(artifact: PreparedChainOperation): Promise<CompletedLock>;                            // send htlc_create; verify getHtlc(blockHash) matches expected
  validateIncomingLock(htlcId: string, expected: ExpectedZenonLock): Promise<LockSummary>;           // getHtlc + validateHtlcInfo
  prepareClaim(input: { htlcId: string; expected: ExpectedZenonLock; preimage: string; now: number; claimCutoff: number }): Promise<PreparedChainOperation>;
  completeClaim(artifact: PreparedChainOperation, preimage: string): Promise<CompletedSpend>;
  prepareRefund(input: { htlcId: string; expected: ExpectedZenonLock; now: number; expiryGrace: number }): Promise<PreparedChainOperation>;
  completeRefund(artifact: PreparedChainOperation): Promise<CompletedSpend>;
  observe(htlcId: string, expected: ExpectedZenonLock): Promise<HtlcObservation>;
}
```
`observe` semantics: if `getHtlc` returns a matching HTLC → `LOCKED`. If `null`: scan `listAccountBlocks(expected.hashLockedAddress, page, pageSize)` for `scanPages` (default 3) pages with `decodeUnlock`; found → `UNLOCKED` with `preimage` and `witnessCommitment = sha256Text("zwap-spend-v1:" + blockHash + ":" + preimage)`; not found and `now >= expirationTime` → `RECLAIMED`; otherwise `UNKNOWN`.
`operationCommitment = sha256Text("zwap-operation-v1\n" + canonicalJson({kind, chainId, tokenStandard, amount, htlcId, expected}))`.
Error codes: `insufficient-balance`, `expired`, `claim-cutoff`, `not-yet-refundable`, `wrong-signer`, `artifact-kind`, `artifact-version`, `htlc-missing`, `lock-mismatch`, plus `HtlcValidationError` codes passed through.

- [ ] **Step 1: Write failing tests**

`src/zenon/trade-client.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { FakeZenonNode } from "./fake-node.js";
import { fakeUnlockDecoder, type ExpectedZenonLock } from "./htlc.js";
import { createHtlcMaterial } from "./htlc-material.js";
import { ZenonTradeClient } from "./trade-client.js";
import { QSR_ZTS, ZNN_ZTS } from "./types.js";

function harness() {
  let now = 1_000_000;
  const node = new FakeZenonNode({ chainId: 1, now: () => now });
  const maker = node.createAddress("maker");
  const taker = node.createAddress("taker");
  node.fund(maker, ZNN_ZTS, "1000000000");
  node.fund(taker, QSR_ZTS, "5000000000");
  const clock = () => now;
  const makerClient = new ZenonTradeClient({ node, signer: node.signer(maker), decodeUnlock: fakeUnlockDecoder, now: clock });
  const takerClient = new ZenonTradeClient({ node, signer: node.signer(taker), decodeUnlock: fakeUnlockDecoder, now: clock });
  const binding = { protocolVersion: "1" as const, network: "zenon-mainnet", orderId: "o", sessionId: "s", reservationId: "r", transcriptHash: "cd".repeat(32) };
  return { node, maker, taker, makerClient, takerClient, binding, tick: (s: number) => { now += s; }, now: clock };
}

describe("ZenonTradeClient", () => {
  it("runs the full lock → lock → claim → observe → claim path", async () => {
    const h = harness();
    const m = await createHtlcMaterial();
    const baseExpected: ExpectedZenonLock = { leg: "base", chainId: "1", tokenStandard: ZNN_ZTS, amount: "100000000", hashLock: m.hash, hashType: 1, keyMaxSize: 32, hashLockedAddress: h.taker, timeLockedAddress: h.maker, expirationTime: h.now() + 3600, binding: h.binding };
    const quoteExpected: ExpectedZenonLock = { leg: "quote", chainId: "1", tokenStandard: QSR_ZTS, amount: "350000000", hashLock: m.hash, hashType: 1, keyMaxSize: 32, hashLockedAddress: h.maker, timeLockedAddress: h.taker, expirationTime: h.now() + 1800, binding: h.binding };

    const baseArtifact = await h.makerClient.prepareLock({ expected: baseExpected, now: h.now() });
    expect(baseArtifact).toMatchObject({ version: 1, kind: "lock", htlcId: null, amount: "100000000" });
    const baseLock = await h.makerClient.completeLock(baseArtifact);
    expect(baseLock.htlcId).toBe(baseLock.blockHash);

    const takerView = await h.takerClient.validateIncomingLock(baseLock.htlcId, baseExpected);
    expect(takerView.validationCommitment).toBe(baseLock.summary.validationCommitment);

    const quoteLock = await h.takerClient.completeLock(await h.takerClient.prepareLock({ expected: quoteExpected, now: h.now() }));
    await h.makerClient.validateIncomingLock(quoteLock.htlcId, quoteExpected);

    expect((await h.takerClient.observe(quoteLock.htlcId, quoteExpected)).state).toBe("LOCKED");
    const claim = await h.makerClient.prepareClaim({ htlcId: quoteLock.htlcId, expected: quoteExpected, preimage: m.preimage, now: h.now(), claimCutoff: quoteExpected.expirationTime - 120 });
    await h.makerClient.completeClaim(claim, m.preimage);

    const observed = await h.takerClient.observe(quoteLock.htlcId, quoteExpected);
    expect(observed.state).toBe("UNLOCKED");
    expect(observed.preimage).toBe(m.preimage);
    expect(observed.witnessCommitment).toMatch(/^[0-9a-f]{64}$/);

    const baseClaim = await h.takerClient.prepareClaim({ htlcId: baseLock.htlcId, expected: baseExpected, preimage: observed.preimage!, now: h.now(), claimCutoff: baseExpected.expirationTime - 120 });
    await h.takerClient.completeClaim(baseClaim, observed.preimage!);
    expect((await h.makerClient.observe(baseLock.htlcId, baseExpected)).state).toBe("UNLOCKED");
  });

  it("refunds after expiry and reports RECLAIMED", async () => {
    const h = harness();
    const m = await createHtlcMaterial();
    const expected: ExpectedZenonLock = { leg: "base", chainId: "1", tokenStandard: ZNN_ZTS, amount: "1", hashLock: m.hash, hashType: 1, keyMaxSize: 32, hashLockedAddress: h.taker, timeLockedAddress: h.maker, expirationTime: h.now() + 100, binding: h.binding };
    const lock = await h.makerClient.completeLock(await h.makerClient.prepareLock({ expected, now: h.now() }));
    await expect(h.makerClient.prepareRefund({ htlcId: lock.htlcId, expected, now: h.now(), expiryGrace: 60 })).rejects.toThrow(expect.objectContaining({ code: "not-yet-refundable" }));
    h.tick(161);
    const refund = await h.makerClient.prepareRefund({ htlcId: lock.htlcId, expected, now: h.now(), expiryGrace: 60 });
    await h.makerClient.completeRefund(refund);
    expect((await h.takerClient.observe(lock.htlcId, expected)).state).toBe("RECLAIMED");
  });

  it("rejects insufficient balance, wrong signer, late claims and mismatched incoming locks", async () => {
    const h = harness();
    const m = await createHtlcMaterial();
    const expected: ExpectedZenonLock = { leg: "base", chainId: "1", tokenStandard: ZNN_ZTS, amount: "99999999999", hashLock: m.hash, hashType: 1, keyMaxSize: 32, hashLockedAddress: h.taker, timeLockedAddress: h.maker, expirationTime: h.now() + 3600, binding: h.binding };
    await expect(h.makerClient.prepareLock({ expected, now: h.now() })).rejects.toThrow(expect.objectContaining({ code: "insufficient-balance" }));
    await expect(h.takerClient.prepareLock({ expected: { ...expected, amount: "1" }, now: h.now() })).rejects.toThrow(expect.objectContaining({ code: "wrong-signer" }));
    const lock = await h.makerClient.completeLock(await h.makerClient.prepareLock({ expected: { ...expected, amount: "1" }, now: h.now() }));
    await expect(h.takerClient.validateIncomingLock(lock.htlcId, { ...expected, amount: "2" })).rejects.toThrow(expect.objectContaining({ code: "htlc-amount" }));
    await expect(h.takerClient.prepareClaim({ htlcId: lock.htlcId, expected: { ...expected, amount: "1" }, preimage: m.preimage, now: expected.expirationTime - 60, claimCutoff: expected.expirationTime - 120 })).rejects.toThrow(expect.objectContaining({ code: "claim-cutoff" }));
    await expect(h.takerClient.validateIncomingLock("00".repeat(32), expected)).rejects.toThrow(expect.objectContaining({ code: "htlc-missing" }));
  });
});
```

- [ ] **Step 2: Run to verify failure** — FAIL.

- [ ] **Step 3: Implement `src/zenon/trade-client.ts`**

```ts
import { sha256Text } from "./hex.js";
import { findUnlockPreimage, htlcValidationCommitment, validateHtlcInfo, type ExpectedZenonLock, type UnlockDecoder } from "./htlc.js";
import type { HtlcState, ZenonNodePort, ZenonSigner } from "./types.js";

export interface PreparedChainOperation {
  version: 1;
  kind: "lock" | "claim" | "refund";
  chainId: string;
  tokenStandard: string;
  amount: string;
  htlcId: string | null;
  expected: ExpectedZenonLock;
  operationCommitment: string;
}
export interface LockSummary { htlcId: string; validationCommitment: string; observedAt: number; }
export interface CompletedLock { blockHash: string; htlcId: string; summary: LockSummary; }
export interface CompletedSpend { blockHash: string; htlcId: string; }
export interface HtlcObservation { state: HtlcState; observedAt: number; preimage: string | null; witnessCommitment: string | null; }

export class ZenonTradeError extends Error {
  constructor(readonly code: string, message = `Zenon trade error: ${code}`) { super(message); }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function operationCommitment(input: Omit<PreparedChainOperation, "version" | "operationCommitment">): Promise<string> {
  return sha256Text(`zwap-operation-v1\n${canonical(input)}`);
}

export interface ZenonTradeClientDependencies {
  node: ZenonNodePort;
  signer: ZenonSigner;
  decodeUnlock: UnlockDecoder;
  now: () => number;
  scanPages?: number;
  pageSize?: number;
}

export class ZenonTradeClient {
  private readonly scanPages: number;
  private readonly pageSize: number;
  constructor(private readonly deps: ZenonTradeClientDependencies) {
    this.scanPages = deps.scanPages ?? 3;
    this.pageSize = deps.pageSize ?? 100;
  }

  address(): string { return this.deps.signer.address(); }

  private async artifact(kind: PreparedChainOperation["kind"], expected: ExpectedZenonLock, htlcId: string | null): Promise<PreparedChainOperation> {
    const base = { kind, chainId: expected.chainId, tokenStandard: expected.tokenStandard, amount: expected.amount, htlcId, expected };
    return { version: 1, ...base, operationCommitment: await operationCommitment(base) };
  }

  private assertArtifact(artifact: PreparedChainOperation, kind: PreparedChainOperation["kind"]): void {
    if (artifact.version !== 1) throw new ZenonTradeError("artifact-version");
    if (artifact.kind !== kind) throw new ZenonTradeError("artifact-kind");
  }

  async prepareLock(input: { expected: ExpectedZenonLock; now: number }): Promise<PreparedChainOperation> {
    const { expected } = input;
    if (expected.timeLockedAddress !== this.address()) throw new ZenonTradeError("wrong-signer");
    if (expected.expirationTime <= input.now) throw new ZenonTradeError("expired");
    const balances = await this.deps.node.getBalances(this.address());
    const available = BigInt(balances.find((b) => b.tokenStandard === expected.tokenStandard)?.balance ?? "0");
    if (available < BigInt(expected.amount)) throw new ZenonTradeError("insufficient-balance");
    return this.artifact("lock", expected, null);
  }

  async completeLock(artifact: PreparedChainOperation): Promise<CompletedLock> {
    this.assertArtifact(artifact, "lock");
    const e = artifact.expected;
    const { blockHash } = await this.deps.signer.send({
      kind: "htlc_create", tokenStandard: e.tokenStandard, amount: e.amount, hashLocked: e.hashLockedAddress,
      expirationTime: e.expirationTime, hashType: e.hashType, keyMaxSize: e.keyMaxSize, hashLock: e.hashLock
    });
    const summary = await this.validateIncomingLock(blockHash, e);
    return { blockHash, htlcId: blockHash, summary };
  }

  async validateIncomingLock(htlcId: string, expected: ExpectedZenonLock): Promise<LockSummary> {
    const info = await this.deps.node.getHtlc(htlcId);
    if (!info) throw new ZenonTradeError("htlc-missing");
    validateHtlcInfo(info, expected);
    return { htlcId, validationCommitment: await htlcValidationCommitment(info), observedAt: this.deps.now() };
  }

  async prepareClaim(input: { htlcId: string; expected: ExpectedZenonLock; preimage: string; now: number; claimCutoff: number }): Promise<PreparedChainOperation> {
    if (input.expected.hashLockedAddress !== this.address()) throw new ZenonTradeError("wrong-signer");
    if (input.now > input.claimCutoff) throw new ZenonTradeError("claim-cutoff");
    await this.validateIncomingLock(input.htlcId, input.expected);
    return this.artifact("claim", input.expected, input.htlcId);
  }

  async completeClaim(artifact: PreparedChainOperation, preimage: string): Promise<CompletedSpend> {
    this.assertArtifact(artifact, "claim");
    if (artifact.htlcId === null) throw new ZenonTradeError("artifact-kind");
    const { blockHash } = await this.deps.signer.send({ kind: "htlc_unlock", id: artifact.htlcId, preimage });
    return { blockHash, htlcId: artifact.htlcId };
  }

  async prepareRefund(input: { htlcId: string; expected: ExpectedZenonLock; now: number; expiryGrace: number }): Promise<PreparedChainOperation> {
    if (input.expected.timeLockedAddress !== this.address()) throw new ZenonTradeError("wrong-signer");
    if (input.now < input.expected.expirationTime + input.expiryGrace) throw new ZenonTradeError("not-yet-refundable");
    await this.validateIncomingLock(input.htlcId, input.expected);
    return this.artifact("refund", input.expected, input.htlcId);
  }

  async completeRefund(artifact: PreparedChainOperation): Promise<CompletedSpend> {
    this.assertArtifact(artifact, "refund");
    if (artifact.htlcId === null) throw new ZenonTradeError("artifact-kind");
    const { blockHash } = await this.deps.signer.send({ kind: "htlc_reclaim", id: artifact.htlcId });
    return { blockHash, htlcId: artifact.htlcId };
  }

  async observe(htlcId: string, expected: ExpectedZenonLock): Promise<HtlcObservation> {
    const observedAt = this.deps.now();
    const info = await this.deps.node.getHtlc(htlcId);
    if (info) {
      validateHtlcInfo(info, expected);
      return { state: "LOCKED", observedAt, preimage: null, witnessCommitment: null };
    }
    for (let page = 0; page < this.scanPages; page += 1) {
      const blocks = await this.deps.node.listAccountBlocks(expected.hashLockedAddress, page, this.pageSize);
      const found = await findUnlockPreimage(blocks, htlcId, expected.hashLock, this.deps.decodeUnlock);
      if (found) {
        return {
          state: "UNLOCKED", observedAt, preimage: found.preimage,
          witnessCommitment: await sha256Text(`zwap-spend-v1:${found.blockHash}:${found.preimage}`)
        };
      }
      if (blocks.length < this.pageSize) break;
    }
    if (observedAt >= expected.expirationTime) return { state: "RECLAIMED", observedAt, preimage: null, witnessCommitment: null };
    return { state: "UNKNOWN", observedAt, preimage: null, witnessCommitment: null };
  }
}
```

- [ ] **Step 4: Run tests** — `npx vitest run src/zenon` — PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(zenon): trade client executing HTLC lock/claim/refund/observe"`

---

### Task 7: Protocol vocabulary — settlement plan, trade terms, atomic-swap bodies

This task renames the wire/protocol vocabulary from Cashu to Zenon in the three pure modules the coordinator depends on. It is a coordinated rename; the tests in `messages.test.ts` and `atomic-messages.test.ts` are updated in the same task.

**Files:**
- Modify: `src/trade/model.ts`, `src/trade/model.test.ts`, `src/trade/messages.ts`, `src/trade/messages.test.ts`, `src/trade/atomic-messages.ts`, `src/trade/atomic-messages.test.ts`

**Interfaces:**
- Produces (`model.ts`):
```ts
export const SHORT_LOCK_SECONDS = 1800;
export const LONG_LOCK_SECONDS = 3600;
export const RESERVATION_GRACE_SECONDS = 600;
export const CLAIM_CUTOFF_MARGIN = 120;
export interface SettlementPlanInput { localNow: number; chainNow: number; orderExpiresAt: number; shortLockSeconds?: number; longLockSeconds?: number; }
export function createSettlementPlan(input: SettlementPlanInput): SettlementPlan;   // SettlementPlan shape unchanged
export interface SettlementAmountInput { remainingBaseAmount: string; fillBaseAmount: string; price: string; execution: "all_or_none" | "partial"; minimumFillAmount: string; }
```
- Produces (`messages.ts`):
```ts
export interface ZwapTradeTerms { maker_side?: OrderSide; chain_id: string; base_token: string; quote_token: string; base_amount: string; quote_amount: string; price: string; }
export interface ZwapTradeMessage { /* as GranolaTradeMessage but */ deployment: string; /* validated as `zenon-${chain_id}-v1` */ terms: ZwapTradeTerms; }
export function transcriptHash(previous: string | null, rumorId: string): Promise<string>;  // domain "zwap-transcript-v1\n"
export function termsHash(terms: ZwapTradeTerms): Promise<string>;                            // domain "zwap-terms-v1\n"
```
- Produces (`atomic-messages.ts`):
```ts
export const ATOMIC_SWAP_BODY_SCHEMA = "zwap/atomic-swap-body/v1";
export interface ReserveProposeBody { schema; taker_session_pubkey: string; taker_address: string; fill_amount: string; }
export interface ReserveAcceptBody { schema; taker_session_pubkey; maker_session_pubkey; maker_address: string; reserve_projection_id; reserve_revision; settlement_hash; short_locktime; maker_claim_cutoff; long_locktime; taker_claim_cutoff; reservation_expires_at; base_lock: LockBody; }
export interface LockBody { schema; htlc_id: string; validation_commitment: string; settlement_hash: string; chain_id: string; token_standard: string; amount: string; hash_locked_address: string; time_locked_address: string; expiration_time: number; }
export interface LockAckBody { schema; lock_message_id; lock_transcript_hash; htlc_id: string; validation_commitment; settlement_hash; }
export interface ClaimNoticeBody { schema; quote_htlc_id: string; claim_operation_commitment; settlement_hash; claimed_at; }
export interface FillRequestBody { schema; base_htlc_id: string; quote_htlc_id: string; base_spend_commitment; quote_spend_commitment; settlement_hash; }
export interface SettlementAckBody { schema; fill_projection_id; fill_revision; base_htlc_id: string; quote_htlc_id: string; settlement_hash; }
export interface RefundBody { schema; leg: RefundLeg; htlc_id: string; refund_operation_commitment; settlement_hash; refunded_at; }
export const ATOMIC_SWAP_ERROR_CODES = ["invalid_message","protocol_violation","terms_mismatch","order_changed","relay_unavailable","node_unavailable","chain_rejected","htlc_state_invalid","plasma_unavailable","witness_invalid","deadline_reached","counterparty_abort","internal_error"] as const;
export interface AtomicSwapParticipants { makerOrderPubkey: string; makerSessionPubkey?: string; takerSessionPubkey?: string; makerAddress?: string; takerAddress?: string; }
```

- [ ] **Step 1: `model.ts` — repoint the plan at chain time and the new constants**

Replace the constants and `createSettlementPlan`:
```ts
export const SHORT_LOCK_SECONDS = 1800;
export const LONG_LOCK_SECONDS = 3600;
export const RESERVATION_GRACE_SECONDS = 600;
export const CLAIM_CUTOFF_MARGIN = 120;
export const MAX_CLOCK_SKEW_SECONDS = 120;

export interface SettlementPlanInput {
  localNow: number;
  chainNow: number;
  orderExpiresAt: number;
  shortLockSeconds?: number;
  longLockSeconds?: number;
}

export function createSettlementPlan(input: SettlementPlanInput): SettlementPlan {
  const local = unixTime(input.localNow, "Local clock");
  const chain = unixTime(input.chainNow, "Chain clock");
  const orderExpiresAt = unixTime(input.orderExpiresAt, "Order expiry");
  if (Math.abs(chain - local) > MAX_CLOCK_SKEW_SECONDS) {
    throw new Error(`Chain clock differs from the local clock by more than ${MAX_CLOCK_SKEW_SECONDS} seconds`);
  }
  const short = input.shortLockSeconds ?? SHORT_LOCK_SECONDS;
  const long = input.longLockSeconds ?? LONG_LOCK_SECONDS;
  if (long <= short) throw new Error("Long locktime must exceed the short locktime");
  const anchor = Math.max(local, chain);
  const reservationExpiresAt = anchor + long + RESERVATION_GRACE_SECONDS;
  if (orderExpiresAt < reservationExpiresAt) {
    throw new Error("The order expires before the settlement recovery window");
  }
  return {
    anchor,
    shortLocktime: anchor + short,
    makerClaimCutoff: anchor + short - CLAIM_CUTOFF_MARGIN,
    longLocktime: anchor + long,
    takerClaimCutoff: anchor + long - CLAIM_CUTOFF_MARGIN,
    reservationExpiresAt,
    refundGuardSeconds: 60
  };
}
```
Rename `priceCentsPerBtc` → `price` in `SettlementAmountInput` and `settlementAmounts` (error text "Price"). `quoteAmountForSettlement(fill, price)` keeps its formula (`base * price / 10^8`). Update `model.test.ts`: inputs become `{ localNow, chainNow, orderExpiresAt }`; expected values use 1800/3600/4200 offsets; the skew test uses a 121 s difference.

- [ ] **Step 2: `messages.ts` — terms and domain tags**

- Rename `GranolaTradeTerms` → `ZwapTradeTerms` with fields `{ maker_side?, chain_id, base_token, quote_token, base_amount, quote_amount, price }`; `GranolaTradeMessage` → `ZwapTradeMessage` with `deployment: string`.
- `assertTerms`: `chain_id` must match `/^[1-9]\d*$/`; `base_token`/`quote_token` must pass `isTokenStandard` (import from `../zenon/validate.js`) and differ; amounts `/^[1-9]\d*$/`; `quote_amount === (BigInt(base_amount) * BigInt(price)) / 100_000_000n`.
- `assertMessage` (wherever `deployment === "cashu-testnet-v1"` was checked): require `message.deployment === \`zenon-${message.terms.chain_id}-v1\``.
- `transcriptHash` domain string → `"zwap-transcript-v1\n"`; `termsHash` domain → `"zwap-terms-v1\n"`.
- Export `export function deploymentFor(chainId: string): string { return \`zenon-${chainId}-v1\`; }`.
- Update `messages.test.ts` fixtures: terms `{ chain_id: "1", base_token: ZNN_ZTS, quote_token: QSR_ZTS, base_amount: "100000000", quote_amount: "350000000", price: "350000000" }`, deployment `"zenon-1-v1"`; keep every replay/expiry/signature test as-is.

- [ ] **Step 3: `atomic-messages.ts` — bodies and validators**

- `ATOMIC_SWAP_BODY_SCHEMA = "zwap/atomic-swap-body/v1"`.
- Replace bodies with the shapes in **Interfaces**. Remove `COMPRESSED_PUBKEY`, `TOKEN_PREFIX`, `KEYSET`, `UNIT`, `normalizedMint` and the 24 KiB token cap. Add validators: `isZenonAddress`, `isTokenStandard`, `isHex32`, `isAmount` from `../zenon/validate.js`; `chain_id` `/^[1-9]\d*$/`; `expiration_time` a positive safe integer.
- Cross-body invariants in `validateAtomicSwapMessage`:
  - `base_lock.hash_locked_address === taker_address` (in `reserve_accept`, the taker address comes from the proposal choreography state) and `base_lock.time_locked_address === maker_address`; `quote_lock.hash_locked_address === maker_address`, `time_locked_address === taker_address`.
  - `expiration_time > sent_at`; `maker_claim_cutoff === short_locktime - 120`, `taker_claim_cutoff === long_locktime - 120`; `long_locktime - short_locktime >= 600`; `reservation_expires_at >= long_locktime + 600`.
  - `LockBody.chain_id`, `token_standard`, `amount` must equal the message `terms` (`chain_id`, `base_token`/`quote_token`, `base_amount`/`quote_amount`) — this replaces `assertLockTerms` mint/unit/keyset comparisons.
  - `maker_address !== taker_address`.
- `AtomicSwapParticipants`: replace the four pubkey fields with `makerAddress?`, `takerAddress?`; `advanceAtomicSwapChoreography` records `takerAddress` from `reserve_propose` and `makerAddress` from `reserve_accept`.
- Error codes list as in **Interfaces**.
- Update `atomic-messages.test.ts` fixtures accordingly (`htlc_id: "a".repeat(64)`, addresses `z1qzal6c5s9rjnnxd2z7dvdhjxpmmj4fmw56a0mz` / `z1qqw6sypygz8sq4tzy4c8u7tlmqf5dh9kupt2wgv`, locktimes 1800/3600). Keep the negative tests (unknown keys, bad schema, replay) and add: wrong `hash_locked_address`, `expiration_time <= sent_at`, `amount` not matching terms.

- [ ] **Step 4: Run the three suites** — `npx vitest run src/trade/model.test.ts src/trade/messages.test.ts src/trade/atomic-messages.test.ts` — PASS. `npm run typecheck` will now fail in `session*.ts`, `effects.ts`, `trade-api.ts`, `storage/trade-session.ts` — expected; those are Tasks 8–10. Commit anyway (the tree is intentionally mid-port; `npm test` for *these* suites passes).

- [ ] **Step 5: Commit** — `git add -A && git commit -m "refactor(protocol): Zenon vocabulary for terms, locks and error codes"`

---

### Task 8: Session shape, session factory, coordinator plan renames

**Files:**
- Modify: `src/trade/session.ts`, `src/trade/session-factory.ts`, `src/trade/session-factory.test.ts`, `src/trade/coordinator-plan.ts`, `src/trade/coordinator-plan.test.ts`, `src/trade/coordinator.ts` (type imports only), `src/storage/trade-session.ts`, `src/storage/trade-session.test.ts`
- Delete: `src/core/wallet.ts`, `src/core/wallet.test.ts`, `src/core/proof-reservations.ts`, `src/core/proof-reservations.test.ts`, `src/trade/wallet-reconcile.ts`, `src/trade/wallet-reconcile.test.ts`, `src/storage/wallet-repository.ts` (keep `StorageDriver`, `MemoryStorageDriver`, `IndexedDbStorageDriver` — move them to `src/storage/driver.ts` first), `src/storage/proof-reservation-repository.ts` + tests
- Create: `src/storage/driver.ts`, `src/zenon/funds-reservations.ts`, `src/zenon/funds-reservations.test.ts`

**Interfaces:**
- Produces (`session.ts`):
```ts
export interface TradeTerms { makerSide?: OrderSide; chainId: string; baseToken: string; baseAmount: string; quoteToken: string; quoteAmount: string; price: string; }
export type PersistedHtlcState = HtlcState;   // "UNKNOWN" | "LOCKED" | "UNLOCKED" | "RECLAIMED"
export interface TradeLegEvidence { htlcId: string | null; validationCommitment: string | null; htlcState: PersistedHtlcState; observedAt: number | null; spendCommitment: string | null; claimOperationCommitment: string | null; refundOperationCommitment: string | null; }
export interface TradeEvidence { makerPubkey: string; commitments: string[]; chainStates: string[]; reserveProjectionId; reserveProjectionRevision; fillProjectionId; fillProjectionRevision; reservation: {...unchanged}; legs: { base: TradeLegEvidence; quote: TradeLegEvidence }; }
export interface ChainOperationResult { blockHash: string; htlcId: string; tokenStandard: string; amount: string; }
export interface ChainOperationJournal { operationId: string; leg: "base"|"quote"; kind: "lock"|"claim"|"refund"; status: "prepared"|"completed"|"account_applied"; preparedAt: number; fundsReserved: boolean; artifact: PreparedChainOperation; result: ChainOperationResult | null; }
export interface PrivateLegJournal { htlcId: string | null; expected: ExpectedZenonLock | null; observations: Array<{ observedAt: number; state: PersistedHtlcState; witnessCommitment: string | null }>; }
export interface TradePrivateState { nostrPrivateKey: string; localAddress: string; counterpartyAddress: string | null; preimage: string | null; htlcHash: string | null; settlementTranscriptHash: string | null; inbox; pendingIncoming; transcript; outbox; chainOperation: ChainOperationJournal | null; legs: { base: PrivateLegJournal; quote: PrivateLegJournal }; }
export interface TradeSession { schema: "zwap/trade-session/v1"; ...unchanged...; terms: TradeTerms; }
```
- Produces (`session-factory.ts`):
```ts
export interface SessionMarketSelection { chainId: string; baseToken: string; quoteToken: string; }
export type SessionKeyPurpose = "nostr";
export interface SessionFactoryEntropy { sessionId(): string; reservationId(): string; privateKey(purpose: "nostr"): string; htlcMaterial(): Promise<{ preimage: string; hash: string }>; }
export interface TakerSessionInput { order: OrderRecord; expectedOrderProjectionId: string; expectedOrderRevision: string; market: SessionMarketSelection; fillBaseAmount: string; clocks: Omit<SettlementPlanInput, "orderExpiresAt">; localAddress: string; }
export interface MakerSessionInput { order: OrderRecord; proposal: VerifiedInitialReserveProposal; market: SessionMarketSelection; clocks: Omit<SettlementPlanInput, "orderExpiresAt">; localAddress: string; }
```
- Produces (`coordinator-plan.ts`): action kinds renamed `reserve_cashu_inputs`→`reserve_funds`, `execute_cashu_operation`→`execute_chain_operation`, `reconcile_wallet`→`reconcile_account`, `clear_cashu_operation`→`clear_chain_operation`.
- Produces (`funds-reservations.ts`):
```ts
export interface FundsReservation { sessionId: string; tokenStandard: string; amount: string; reservedAt: number; }
export interface FundsReservationState { version: 1; revision: number; reservations: FundsReservation[]; }
export class FundsReservationRepository {
  constructor(driver: StorageDriver);
  load(): Promise<FundsReservationState>;
  reserve(expectedRevision: number, input: FundsReservation): Promise<FundsReservationState>;   // one per sessionId; revision must match
  release(expectedRevision: number, input: { sessionId: string }): Promise<FundsReservationState>;
}
export function reservedAmount(state: FundsReservationState, tokenStandard: string, excludeSessionId?: string): bigint;
```

- [ ] **Step 1: Funds reservations (new, TDD)**

`src/zenon/funds-reservations.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { MemoryStorageDriver } from "../storage/driver.js";
import { FundsReservationRepository, reservedAmount } from "./funds-reservations.js";
import { ZNN_ZTS } from "./types.js";

describe("FundsReservationRepository", () => {
  it("reserves once per session with optimistic revisions", async () => {
    const repo = new FundsReservationRepository(new MemoryStorageDriver());
    const empty = await repo.load();
    expect(empty).toEqual({ version: 1, revision: 0, reservations: [] });
    const one = await repo.reserve(0, { sessionId: "s1", tokenStandard: ZNN_ZTS, amount: "5", reservedAt: 1 });
    expect(one.revision).toBe(1);
    await expect(repo.reserve(0, { sessionId: "s2", tokenStandard: ZNN_ZTS, amount: "5", reservedAt: 1 })).rejects.toThrow(/revision/);
    await expect(repo.reserve(1, { sessionId: "s1", tokenStandard: ZNN_ZTS, amount: "5", reservedAt: 1 })).rejects.toThrow(/already/);
    const two = await repo.reserve(1, { sessionId: "s2", tokenStandard: ZNN_ZTS, amount: "7", reservedAt: 1 });
    expect(reservedAmount(two, ZNN_ZTS)).toBe(12n);
    expect(reservedAmount(two, ZNN_ZTS, "s1")).toBe(7n);
    const released = await repo.release(2, { sessionId: "s1" });
    expect(released.reservations.map((r) => r.sessionId)).toEqual(["s2"]);
  });
});
```
Create `src/storage/driver.ts` by moving `StorageDriver`, `MemoryStorageDriver`, `IndexedDbStorageDriver` out of `wallet-repository.ts` (database name `"zwap-wallet"`, store `"private-wallet"`); update every import of those three symbols across `src/` and `scripts/` to `../storage/driver.js`.

`src/zenon/funds-reservations.ts`:
```ts
import type { StorageDriver } from "../storage/driver.js";
import { isAmount, isTokenStandard } from "./validate.js";

export interface FundsReservation { sessionId: string; tokenStandard: string; amount: string; reservedAt: number; }
export interface FundsReservationState { version: 1; revision: number; reservations: FundsReservation[]; }

const KEY = "zwap.funds-reservations.v1";

function assertState(value: unknown): FundsReservationState {
  if (!value || typeof value !== "object") throw new Error("Corrupt funds reservation state");
  const state = value as FundsReservationState;
  if (state.version !== 1 || !Number.isSafeInteger(state.revision) || !Array.isArray(state.reservations)) throw new Error("Corrupt funds reservation state");
  for (const r of state.reservations) {
    if (typeof r.sessionId !== "string" || !isTokenStandard(r.tokenStandard) || !isAmount(r.amount) || !Number.isSafeInteger(r.reservedAt)) throw new Error("Corrupt funds reservation entry");
  }
  return state;
}

export function reservedAmount(state: FundsReservationState, tokenStandard: string, excludeSessionId?: string): bigint {
  return state.reservations
    .filter((r) => r.tokenStandard === tokenStandard && r.sessionId !== excludeSessionId)
    .reduce((sum, r) => sum + BigInt(r.amount), 0n);
}

export class FundsReservationRepository {
  constructor(private readonly driver: StorageDriver) {}

  async load(): Promise<FundsReservationState> {
    const raw = await this.driver.get(KEY);
    return raw === undefined || raw === null ? { version: 1, revision: 0, reservations: [] } : assertState(raw);
  }

  private async commit(expectedRevision: number, mutate: (s: FundsReservationState) => FundsReservation[]): Promise<FundsReservationState> {
    const current = await this.load();
    if (current.revision !== expectedRevision) throw new Error("Funds reservation revision mismatch");
    const next: FundsReservationState = { version: 1, revision: current.revision + 1, reservations: mutate(current) };
    await this.driver.set(KEY, next);
    return next;
  }

  reserve(expectedRevision: number, input: FundsReservation): Promise<FundsReservationState> {
    return this.commit(expectedRevision, (s) => {
      if (s.reservations.some((r) => r.sessionId === input.sessionId)) throw new Error("Session already has a funds reservation");
      return [...s.reservations, input];
    });
  }

  release(expectedRevision: number, input: { sessionId: string }): Promise<FundsReservationState> {
    return this.commit(expectedRevision, (s) => s.reservations.filter((r) => r.sessionId !== input.sessionId));
  }
}
```
Run `npx vitest run src/zenon/funds-reservations.test.ts` — PASS.

- [ ] **Step 2: `session.ts`**

Apply the **Interfaces** shapes. Import `PreparedChainOperation` from `../zenon/trade-client.js`, `ExpectedZenonLock` from `../zenon/htlc.js`, `HtlcState` from `../zenon/types.js`. `publicTradeView` stays, but strip nothing new — `TradeLegEvidence` now contains no bearer data. Delete `CashuOperationResult`/`CashuOperationJournal` names entirely (no aliases).

- [ ] **Step 3: `session-factory.ts`**

- Remove all `@cashu/cashu-ts` and `core/wallet` imports. `defaultEntropy.htlcMaterial = () => createHtlcMaterial()` (from `../zenon/htlc-material.js`); `privateKey("nostr")` only.
- `canonicalMarket`: `chainId` `/^[1-9]\d*$/`, `baseToken`/`quoteToken` pass `isTokenStandard` and differ.
- `assertOpenOrder`: `state.offered.token`/`state.requested.token` (see Task 9 order model) must equal `market.baseToken`/`market.quoteToken` per side; `state.chain_id === market.chainId`.
- `localKeys` → returns only the Nostr key; `input.localAddress` must pass `isZenonAddress`.
- `emptyEvidence`: `legs.base = { htlcId: null, validationCommitment: null, htlcState: "UNKNOWN", observedAt: null, spendCommitment: null, claimOperationCommitment: null, refundOperationCommitment: null }` (same for quote); `chainStates: []`.
- `terms`: `{ chainId: market.chainId, baseToken, baseAmount, quoteToken, quoteAmount, price: state.price }`.
- Maker: `const material = await entropy.htlcMaterial(); if (!(await verifyHtlcMaterial(material.preimage, material.hash))) throw ...`; `privateState.localAddress = input.localAddress`, `counterpartyAddress = proposal.body.taker_address`; choreography participants `makerAddress`, `takerAddress`.
- Taker: `localAddress = input.localAddress`, `counterpartyAddress = null` (learned from `reserve_accept`), `preimage: null`, `htlcHash: null`.
- `session.schema = "zwap/trade-session/v1"`, `chainOperation: null`.
- Update `session-factory.test.ts`: fixtures use a `FakeZenonNode().createAddress()` string for `localAddress`, order states from Task 9's `createOrderState` (do Task 9's model edits first if the compiler forces it — order model is a pure rename, see Task 9 Step 1), and assertions on `terms`/`privateState.localAddress`/participants. Remove refund/cashu key tests; keep uniqueness/binding tests.

- [ ] **Step 4: `coordinator-plan.ts`**

- Rename the four action kinds (see **Interfaces**) in the union and every `return { kind: ... }`.
- `session.privateState.cashuOperation` → `chainOperation`; `.inputsReserved` → `.fundsReserved`; `"wallet_applied"` → `"account_applied"`; `evidence.legs[leg].mintState` → `.htlcState`; `"SPENT"` → `"UNLOCKED"`; `"UNSPENT"` → `"LOCKED"`.
- `independentlySpent`: drop the `proofCount >= 1` requirement; require `htlcState === "UNLOCKED"`, `observedAt !== null`, `isHex32(spendCommitment)`, and a matching observation `witnessCommitment`.
- `lockReady`: compare `expected.{leg, chainId, tokenStandard, amount, hashLock, expirationTime, binding.*}` against `terms.chainId`, `terms.baseToken|quoteToken`, `terms.baseAmount|quoteAmount`, `privateState.htlcHash`, `plan.longLocktime|shortLocktime`, `sessionId`, `reservationId`, `settlementTranscriptHash`; require `privateState.legs[leg].htlcId` and `evidence.legs[leg].{htlcId, validationCommitment}` non-null and equal.
- `hasPostExpiryUnspentObservation` → rename `hasPostExpiryLockedObservation` (state `"LOCKED"` observed at or after `eligibleAfter`).
- Update `coordinator-plan.test.ts` fixtures via a shared `src/trade/test-fixtures.ts` helper `sessionFixture(overrides)` producing a valid `TradeSession` with the new shape (create this helper here; later tasks reuse it). Rename the action expectations.

- [ ] **Step 5: `storage/trade-session.ts` validator**

- `schema` literal `"zwap/trade-session/v1"`.
- `validateExpectedLock` → validate `ExpectedZenonLock` keys exactly: `leg`, `chainId` (`/^[1-9]\d*$/`), `tokenStandard` (`isTokenStandard`), `amount` (`isAmount`), `hashLock` (`isHex32`), `hashType === 1`, `keyMaxSize === 32`, `hashLockedAddress`/`timeLockedAddress` (`isZenonAddress`, distinct), `expirationTime` (positive safe integer), `binding` `{protocolVersion:"1", network: /^zenon-[a-z0-9-]+$/, orderId, sessionId, reservationId, transcriptHash: isHex32}`.
- Artifact validator: exact keys `version, kind, chainId, tokenStandard, amount, htlcId, expected, operationCommitment`; `kind ∈ {lock, claim, refund}`; `htlcId` null or hex32; `operationCommitment` hex32.
- Result validator: exact keys `blockHash, htlcId, tokenStandard, amount`.
- Journal: `status ∈ {prepared, completed, account_applied}`, `fundsReserved` boolean.
- Leg evidence: exact keys per `TradeLegEvidence`; `htlcState ∈ {UNKNOWN, LOCKED, UNLOCKED, RECLAIMED}`.
- Private state: `localAddress` (`isZenonAddress`), `counterpartyAddress` (null or address), no `cashuPrivateKey`/`refundPrivateKey`.
- Terms: exact keys per `TradeTerms`.
- Update `trade-session.test.ts` to use `sessionFixture` and the new negative cases (bad address, hashType ≠ 1, unknown key).

- [ ] **Step 6: Delete the proof-wallet modules** listed under **Files → Delete**, fix remaining imports (`storage/driver.js`), run `npx vitest run src/trade/session-factory.test.ts src/trade/coordinator-plan.test.ts src/storage/trade-session.test.ts src/zenon` — PASS. Typecheck still fails only in `effects.ts`, `trade-api.ts`, `granola-api.ts`, `trade-runtime.ts`, `main.ts`, `ui/*` (Tasks 9–13).

- [ ] **Step 7: Commit** — `git add -A && git commit -m "refactor(session): Zenon session shape, funds reservations, plan action renames"`

---

### Task 9: Order model, Nostr order events, order API market

**Files:**
- Modify: `src/order/model.ts`, `src/order/model.test.ts`, `src/order/events.ts`, `src/order/events.test.ts`, `src/order/service.ts` (only if it references `mint`), `src/order/human-price.ts`, `src/order/human-price.test.ts`, `src/order/funding.ts`, `src/order/funding.test.ts`, `src/order/ephemeral-projection.test.ts`, `src/api/order-api.ts`, `src/api/order-api.test.ts`, `scripts/publish-test-orders.ts`

**Interfaces:**
- Produces (`order/model.ts`):
```ts
export interface OfferedAsset { token: string; }
export interface RequestedAsset { token: string; }
export interface OrderState { schema: "zwap/order/v1"; order_id; revision; created_at; expires_at; side; chain_id: string; base_token: string; quote_token: string; offered: OfferedAsset; requested: RequestedAsset; original_amount; remaining_amount; reserved_amount; price: string; minimum_fill_amount; execution; status; reservation; }
export interface CreateOrderInput { orderId; createdAt; expiresAt?; side; chainId: string; baseToken: string; quoteToken: string; amount: string; price: string; execution?; minimumFillAmount?; }
export interface ExactMarket { chainId: string; baseToken: string; quoteToken: string; }
export function marketId(market: ExactMarket): Promise<string>;   // sha256("zwap-market-v1\n{chainId}\n{baseToken}\n{quoteToken}")
export function eligibleMarketIds(state: OrderState): Promise<string[]>;   // exactly one id now
export function quoteAmountForSettlement(baseAmount: string, price: string): string;
```
- Produces (`order/events.ts`): tags `["d", "zwap:order:v1:<id>"]`, `["t", "zwap-order"]`, `["v","1"]`, `["s", status]`, `["side", side]`, `["m", marketId]`, `["chain", chain_id]`, `["expires_at", ...]`, `["expiration", ...]`; `orderAddress = "30078:<pubkey>:zwap:order:v1:<id>"`.
- Produces (`api/order-api.ts`): `export const DEFAULT_MARKET: ExactMarket = { chainId: "1", baseToken: ZNN_ZTS, quoteToken: QSR_ZTS }`; `OrderApi` constructor `market` param defaults to `DEFAULT_MARKET`; `PublishOrderInput.price` replaces `priceCentsPerBtc`.

- [ ] **Step 1: `order/model.ts`** — apply the shapes above. `createOrderState` computes `offered = { token: side === "sell" ? baseToken : quoteToken }`, `requested = { token: side === "sell" ? quoteToken : baseToken }`. `eligibleMarketIds(state)` returns `[await marketId({ chainId: state.chain_id, baseToken: state.base_token, quoteToken: state.quote_token })]`. Validation: `chain_id` `/^[1-9]\d*$/`, tokens via `isTokenStandard`, base ≠ quote. `quoteAmountForSettlement` unchanged except the parameter name and error text ("limit price"). Update `model.test.ts` (fixtures: `chainId: "1"`, `baseToken: ZNN_ZTS`, `quoteToken: QSR_ZTS`, `price: "350000000"`).

- [ ] **Step 2: `order/events.ts`** — tag/prefix strings per **Interfaces**; `parseProjectionEvent` derives and checks the `chain` tag equals `state.chain_id`. Update `events.test.ts`.

- [ ] **Step 3: `order/human-price.ts`** — this converted cents/BTC ↔ human. Rewrite as: `humanPriceToPrice(human: string, quoteDecimals: number): string` (decimal string quote-per-base → integer `price` = quote minor units per 10^8 base minor; formula `round(human * 10^quoteDecimals)` computed with bigint on the decimal string, max 8 fractional digits) and `priceToHumanPrice(price: string, quoteDecimals: number): string`. Tests: `"3.5"`→`"350000000"`, `"0.00000001"`→`"1"`, `"350000000"`→`"3.5"`, rejects `"1e3"`, `"-1"`, more than 8 fractional digits.

- [ ] **Step 4: `order/funding.ts`** — replaces mint-based funding hints: `fundingRequirement(input: { side, amount, price }): { token: "base" | "quote"; amount: string }` (sell → base amount; buy → `quoteAmountForSettlement`). Update tests.

- [ ] **Step 5: `api/order-api.ts`** — `TEST_MARKET` → `DEFAULT_MARKET`; `publishOrder` builds `CreateOrderInput` with `chainId/baseToken/quoteToken` from the market and `price: input.price`. Update `order-api.test.ts` and `scripts/publish-test-orders.ts` (uses `price` and ZTS constants; keep publishing to relays only with throwaway keys).

- [ ] **Step 6: Run** — `npx vitest run src/order src/api/order-api.test.ts` — PASS.
- [ ] **Step 7: Commit** — `git add -A && git commit -m "refactor(order): chain/token markets and integer price"`

---

### Task 10: Coordinator effects on Zenon

**Files:**
- Modify: `src/trade/effects.ts`, `src/trade/effects.test.ts`, `src/trade/coordinator.test.ts` (fixtures only)

**Interfaces:**
- Consumes: `ZenonTradeClient` (Task 6), `FundsReservationRepository` + `reservedAmount` (Task 8), `ZenonNodePort.getBalances`, session shapes (Task 8), bodies (Task 7).
- Produces:
```ts
export interface ZwapCoordinatorEffectsOptions {
  orderApi: Pick<OrderApi, "ensureReserveStaged" | "ensureFillStaged" | "ensureReleaseStaged" | "publishNextStage" | "clearAcknowledgedOrderPublication" | "pruneCommittedOrderPublication">;
  orderOutbox: Pick<OrderOutboxPort, "load">;
  orderReader: CoordinatorOrderReadPort;
  nostr: Pick<NostrTradeTransport, "createRegistration" | "publishRegistration" | "discoverInbox" | "send" | "read">;
  chain: Pick<ZenonTradeClient, "address" | "prepareLock" | "completeLock" | "validateIncomingLock" | "prepareClaim" | "completeClaim" | "prepareRefund" | "completeRefund" | "observe">;
  node: Pick<ZenonNodePort, "getBalances">;
  reservations: Pick<FundsReservationRepository, "load" | "reserve" | "release">;
  makerIdentity: CoordinatorMakerIdentity;
  discoveryRelays: readonly string[];
  withAccountLock: <T>(action: () => Promise<T>) => Promise<T>;
  network: string;
  entropy?: CoordinatorEffectsEntropy;
  commitment?: (value: string) => Promise<string>;
}
export class ZwapCoordinatorEffects implements CoordinatorEffectPort { constructor(options: ZwapCoordinatorEffectsOptions) }
```

- [ ] **Step 1: Rewrite the Cashu paths in `effects.ts`**

Guided by the granola line references (effects.ts:294–509, 1355–1453, 1575–1810):

- Remove `@cashu/cashu-ts` imports; import `verifyHtlcMaterial` from `../zenon/htlc-material.js`, `reservedAmount` from `../zenon/funds-reservations.js`, `HtlcValidationError` from `../zenon/htlc.js`, `ZenonTradeError` from `../zenon/trade-client.js`.
- `localCashuPubkey` → delete. Addresses come from `session.privateState.localAddress` / `counterpartyAddress`.
- `expectedLock(session, slot)`:
```ts
private expectedLock(session: TradeSession, slot: "base" | "quote"): ExpectedZenonLock {
  const leg = slotLeg(session, slot);
  const p = session.privateState;
  if (!p.htlcHash || !p.settlementTranscriptHash || !p.counterpartyAddress) throw new Error("Settlement terms are not bound yet");
  const makerLocksThisLeg = (leg === "base") === makerOffersBase(session);   // base leg is always locked by the maker's offered side
  const localIsLocker = (session.role === "maker") === makerLocksThisLeg;
  const timeLockedAddress = localIsLocker ? p.localAddress : p.counterpartyAddress;
  const hashLockedAddress = localIsLocker ? p.counterpartyAddress : p.localAddress;
  return {
    leg,
    chainId: session.terms.chainId,
    tokenStandard: leg === "base" ? session.terms.baseToken : session.terms.quoteToken,
    amount: leg === "base" ? session.terms.baseAmount : session.terms.quoteAmount,
    hashLock: p.htlcHash,
    hashType: 1,
    keyMaxSize: 32,
    hashLockedAddress,
    timeLockedAddress,
    expirationTime: leg === "base" ? session.plan.longLocktime : session.plan.shortLocktime,
    binding: { protocolVersion: "1", network: this.network, orderId: orderId(session), sessionId: session.sessionId, reservationId: session.reservationId, transcriptHash: p.settlementTranscriptHash }
  };
}
```
  Keep granola's convention: the maker locks `base` (long locktime), the taker locks `quote` (short locktime) — `slotLeg`/`makerOffersBase` remain as in granola.
- `completedLockBody(session, slot): AtomicSwapBody<"base_lock"|"quote_lock">` → `{ schema, htlc_id, validation_commitment, settlement_hash: htlcHash, chain_id, token_standard, amount, hash_locked_address, time_locked_address, expiration_time }` from `privateState.legs[leg]` + `evidence.legs[leg]` + `expected`.
- `prepareChain` (was `prepareCashu`): under `withAccountLock`: for `_lock` — `reservations.load()`, `balances = node.getBalances(chain.address())`, `available = balance(token) - reservedAmount(reservations, token, session.sessionId)`; throw `ZenonTradeError("insufficient-balance")` if `available < amount`; `artifact = chain.prepareLock({ expected, now })`. For `_claim` — `chain.prepareClaim({ htlcId: privateState.legs[leg].htlcId, expected, preimage: privateState.preimage, now, claimCutoff })`. For `_refund` — `chain.prepareRefund({ htlcId, expected, now, expiryGrace: plan.refundGuardSeconds })`. Write `privateState.chainOperation = { operationId, leg, kind, status: "prepared", preparedAt: now, fundsReserved: kind !== "lock", artifact, result: null }` (claims/refunds need no funds reservation) and the `claim/refundOperationCommitment` evidence as before.
- `reserve_funds`: `reservations.reserve(revision, { sessionId, tokenStandard: artifact.tokenStandard, amount: artifact.amount, reservedAt: preparedAt })`; set `fundsReserved = true`.
- `execute_chain_operation`: `lock` → `completed = chain.completeLock(artifact)`; set `privateState.legs[leg].htlcId = completed.htlcId`, push observation `{observedAt: now, state: "LOCKED", witnessCommitment: null}`, `evidence.legs[leg] = {...leg, htlcId, validationCommitment: completed.summary.validationCommitment, htlcState: "LOCKED", observedAt: now}`, `result = { blockHash, htlcId, tokenStandard, amount }`. `claim` → `chain.completeClaim(artifact, privateState.preimage)`; `refund` → `chain.completeRefund(artifact)`; both set `result`. Status → `"completed"`.
- `reconcile_account` (was `reconcileWallet`): under `withAccountLock`, if `fundsReserved` and kind is `lock`: `reservations.release(revision, { sessionId })`. Status → `"account_applied"`.
- `clear_chain_operation`: assert `"account_applied"`, set `chainOperation = null`.
- `observeLeg`: `observed = chain.observe(htlcId, expected)`; push observation; `evidence.legs[leg] = {..., htlcState: observed.state, observedAt, spendCommitment: observed.witnessCommitment}`; if `observed.state === "UNLOCKED"`: assert `verifyHtlcMaterial(observed.preimage, expected.hashLock)`, and **if `session.role === "taker" && leg === "quote"` set `privateState.preimage = observed.preimage`**.
- `validateIncoming` for lock bodies: `summary = chain.validateIncomingLock(body.htlc_id, expected)`; check `summary.validationCommitment === body.validation_commitment`, `body.amount === expected.amount`, `body.chain_id === expected.chainId`; set `privateState.legs[leg] = { htlcId: body.htlc_id, expected, observations: [{observedAt, state: "LOCKED", witnessCommitment: null}] }` and evidence. For `reserve_accept`: set `privateState.counterpartyAddress = body.maker_address` and `htlcHash = body.settlement_hash` before validating the nested `base_lock`. For `reserve_propose` (maker side): `counterpartyAddress` was already set by the session factory.
- Message bodies referencing `*_token_commitment` → `*_htlc_id`; `claim_notice.quote_htlc_id`, `fill_request.{base,quote}_htlc_id` from `evidence.legs.*.htlcId`.
- Error mapping in the catch paths: `ZenonTradeError("insufficient-balance")` → `chain_rejected`; `HtlcValidationError` → `terms_mismatch`; any `/plasma|pow/i` error message → `plasma_unavailable` (retryable: true); network errors (`ZnnClientException` by name) → `node_unavailable` (retryable: true).
- `externalFingerprintMaterial`: for `_lock` → `{ reservationRevision, address: chain.address(), expected }`; claim/refund → `{ reservationRevision, htlcId, expected }`.
- Rename the class/options to `ZwapCoordinatorEffects` / `ZwapCoordinatorEffectsOptions`; `EXTERNAL_ACTIONS` uses the renamed action kinds.

- [ ] **Step 2: Rewrite `effects.test.ts`**

Replace the Cashu mocks with a `FakeZenonNode` + two `ZenonTradeClient`s (maker/taker) and a `FundsReservationRepository(new MemoryStorageDriver())`. Keep the structure of granola's tests (one `describe` per action). Minimum coverage:
  - `prepare_base_lock` reserves nothing yet, stores the artifact, rejects when balance − reserved < amount (`chain_rejected` outcome).
  - `reserve_funds` → `execute_chain_operation` → `reconcile_account` → `clear_chain_operation` produces an on-chain HTLC (`node.getHtlc(htlcId)` non-null), evidence `LOCKED`, and an empty reservation list at the end.
  - `validate_incoming` for a `base_lock` body accepts a matching HTLC and rejects a tampered `amount` with `terms_mismatch`.
  - `observe_quote` on the taker learns the preimage after the maker unlocks (drive the maker's unlock through `node.signer(maker)` directly).
  - `prepare_quote_refund` before expiry → `enter_recovery` path untouched; after expiry (advance the fake clock) → refund executes and evidence shows `RECLAIMED` on the counterparty's next observe.
  - Fingerprint material differs when the reservation revision changes.

- [ ] **Step 3: Run** — `npx vitest run src/trade` — PASS (coordinator.test.ts fixtures updated via `sessionFixture`).
- [ ] **Step 4: Commit** — `git add -A && git commit -m "feat(trade): coordinator effects settle over Zenon HTLCs"`

---

### Task 11: Trade API and account layer

**Files:**
- Modify: `src/api/trade-api.ts`, `src/api/trade-api.test.ts`, `src/trade/happy-path.integration.test.ts`
- Create: `src/zenon/account.ts`, `src/zenon/account.test.ts`, `src/zenon/plasma-bot.ts`, `src/zenon/plasma-bot.test.ts`, `src/zenon/keystore-repository.ts`, `src/zenon/keystore-repository.test.ts`

**Interfaces:**
- Produces (`trade-api.ts`):
```ts
export interface TradeChainPort { chainIdentifier(): Promise<number>; frontierMomentum(): Promise<MomentumView>; getBalances(address: string): Promise<BalanceView[]>; }
export interface TradeApiOptions { coordinator; orders; chain: TradeChainPort; reservations: Pick<FundsReservationRepository, "load">; localAddress: () => string; sessions; market: ExactMarket; now?; sessionFactory?; shortLockSeconds?: number; longLockSeconds?: number; }
```
  `takeOrder`/`acceptReserveProposal`: `preflightMarket` asserts `order.state.chain_id === market.chainId` and `String(await chain.chainIdentifier()) === market.chainId`; `clocks = { localNow: now(), chainNow: (await chain.frontierMomentum()).timestamp, shortLockSeconds, longLockSeconds }`; funding check = `balance(fundingToken) - reservedAmount(reservations, fundingToken) >= targetAmount` else throw `"Insufficient <SYMBOL> balance for this trade"`. Remove `TradeMintPreflightPort`, `TradeWalletPort`, `TradeSpendabilityPort`, `assertFunding`, `exactPocket`.
- Produces (`account.ts`):
```ts
export interface AccountSnapshot { address: string; balances: BalanceView[]; unreceived: number; plasma: PlasmaView; powRequired: boolean; }
export class ZenonAccount {
  constructor(deps: { node: ZenonNodePort; signer: ZenonSigner; now?: () => number });
  address(): string;
  snapshot(): Promise<AccountSnapshot>;               // powRequired = plasma.currentPlasma < 21000
  receiveAll(limit?: number): Promise<number>;         // receives up to `limit` (default 50) unreceived blocks sequentially; returns count
  send(toAddress: string, tokenStandard: string, amount: string): Promise<SendReceipt>;
}
```
- Produces (`plasma-bot.ts`):
```ts
export type PlasmaTier = "low" | "medium" | "high";
export interface FuseResult { txHash: string; amount: number; tier: PlasmaTier; }
export class PlasmaBotError extends Error { constructor(readonly code: "rate_limited" | "validation" | "unavailable" | "active_fusion", message: string) }
export async function fusePlasma(baseUrl: string, address: string, tier: PlasmaTier, fetchImpl?: typeof fetch): Promise<FuseResult>;   // POST {baseUrl}/api/agent/fuse
```
- Produces (`keystore-repository.ts`):
```ts
export class KeystoreRepository {
  constructor(driver: StorageDriver, runExclusive?: StorageExclusiveRunner);   // wraps EncryptedStorageDriver(driver, "zwap.keystore")
  exists(): Promise<boolean>;
  create(): Promise<{ address: string }>;                  // KeyStore.newRandom(), stores mnemonic encrypted
  import(mnemonic: string): Promise<{ address: string }>;  // validates via KeyStore.fromMnemonic
  useKeyPair<T>(action: (keyPair: KeyPair) => Promise<T>): Promise<T>;   // decrypts, derives index 0, clears after
  revealMnemonic(confirmation: string): Promise<string>;   // confirmation must equal "REVEAL SEED"
  clear(confirmation: string): Promise<void>;              // "DELETE WALLET"
}
```

- [ ] **Step 1: `account.test.ts` (fake node)** — snapshot reflects balances/unreceived count; `receiveAll` receives two pending blocks in order and credits balance; `powRequired` true when `node.setPow(address, true)`. Implement `account.ts` (sequential loop over `node.listUnreceived`, `signer.send({kind:"receive"})`).

- [ ] **Step 2: `plasma-bot.test.ts`** — with an injected `fetch` stub: success `{success:true, txHash, amount:20, tier:"low"}` → `FuseResult`; HTTP 429 → `rate_limited`; 400 with `error.code === "VALIDATION_FAILED"` → `validation`; network throw → `unavailable`; a 409/400 whose message matches `/active fusion/i` → `active_fusion`. Implement `plasma-bot.ts`:
```ts
export async function fusePlasma(baseUrl: string, address: string, tier: PlasmaTier, fetchImpl: typeof fetch = fetch): Promise<FuseResult> {
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}/api/agent/fuse`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address, tier }) });
  } catch (error) {
    throw new PlasmaBotError("unavailable", `Plasma bot unreachable: ${error instanceof Error ? error.message : String(error)}`);
  }
  const body = (await response.json().catch(() => ({}))) as { success?: boolean; txHash?: string; amount?: number; tier?: PlasmaTier; error?: { code?: string; message?: string } };
  if (response.status === 429) throw new PlasmaBotError("rate_limited", body.error?.message ?? "Plasma bot rate limit reached (10 per day per IP)");
  if (!response.ok || body.success !== true) {
    const message = body.error?.message ?? `Plasma bot returned ${response.status}`;
    if (/active fusion/i.test(message)) throw new PlasmaBotError("active_fusion", message);
    if (body.error?.code === "VALIDATION_FAILED") throw new PlasmaBotError("validation", message);
    throw new PlasmaBotError("unavailable", message);
  }
  return { txHash: body.txHash ?? "", amount: body.amount ?? 0, tier: body.tier ?? tier };
}
```

- [ ] **Step 3: `keystore-repository.test.ts`** — with `MemoryStorageDriver`: `exists()` false → `create()` returns a `z1…` address → `exists()` true; `import()` of the same mnemonic yields the same address; `useKeyPair` gives a key pair whose address matches; `revealMnemonic("wrong")` throws, `revealMnemonic("REVEAL SEED")` returns the words; `clear("DELETE WALLET")` then `exists()` false. Implement using `EncryptedStorageDriver` from `../storage/encrypted-storage.js` (key `"mnemonic"`), `KeyStore` from the SDK. If WebCrypto `subtle` is unavailable in jsdom, the existing `encrypted-storage.test.ts` shows how granola polyfills it — reuse that setup.

- [ ] **Step 4: `trade-api.ts`** — apply the **Interfaces** changes; update `trade-api.test.ts` with a `FakeZenonNode` (chain id 1, funded addresses) and `FundsReservationRepository`, asserting: chain-id mismatch is rejected; insufficient balance is rejected with the SYMBOL message; a taker session is created with `localAddress` and plan locktimes 1800/3600 from the fake momentum time.

- [ ] **Step 5: `happy-path.integration.test.ts`** — rebuild on the fake node: two `ZwapCoordinatorEffects` (maker/taker) sharing one `FakeZenonNode` and granola's in-memory Nostr transport test doubles; drive both coordinators until `filled`; assert final balances (maker gained quote, taker gained base after `receiveAll`) and that no reservation remains. Add a second scenario: taker never locks quote → after advancing the clock past `longLocktime + 60`, the maker refunds and ends `released`.

- [ ] **Step 6: Run** — `npx vitest run src/api/trade-api.test.ts src/zenon src/trade/happy-path.integration.test.ts` — PASS.
- [ ] **Step 7: Commit** — `git add -A && git commit -m "feat: Zenon account, plasma bot, keystore repository, trade API funding checks"`

---

### Task 12: ZwapApi (wallet-facing) and browser runtime composition

**Files:**
- Create: `src/api/zwap-api.ts`, `src/api/zwap-api.test.ts`
- Delete: `src/api/granola-api.ts`, `src/api/granola-api.test.ts`, `src/cashu/*`
- Modify: `src/browser/trade-runtime.ts`, `src/browser/trade-runtime.test.ts`, `src/browser/trade-controller.ts` (phase labels only if changed), `src/main.ts`, `package.json` (remove `@cashu/cashu-ts`), `scripts/probe-inbox.ts` (imports)

**Interfaces:**
- Produces (`zwap-api.ts`):
```ts
export interface ZwapState { address: string | null; network: string; chainId: number; balances: BalanceView[]; unreceived: number; plasma: PlasmaView | null; powRequired: boolean; plasmaBotAvailable: boolean; }
export interface ZenonPort { account(): ZenonAccount | null; }   // null until a keystore exists and is unlocked
export class ZwapApi {
  constructor(deps: { keystore: KeystoreRepository; node: ZenonNodePort; config: ZwapConfig; createAccount: (keyPair: KeyPair) => ZenonAccount; fetchImpl?: typeof fetch });
  getState(): Promise<ZwapState>;
  createWallet(): Promise<ZwapState>;
  importWallet(mnemonic: string): Promise<ZwapState>;
  receivePending(): Promise<ZwapState>;
  fusePlasma(tier: PlasmaTier): Promise<FuseResult>;     // throws if config.plasmaBotUrl is null
  send(toAddress: string, tokenStandard: string, amount: string): Promise<SendReceipt>;
  revealMnemonic(confirmation: string): Promise<string>;
  clearWallet(confirmation: string): Promise<void>;
}
```
- Produces (`trade-runtime.ts`): `CreateBrowserTradeRuntimeInput` gains `node: ZenonNodePort`, `signer: ZenonSigner`, `config: ZwapConfig`, `decodeUnlock?: UnlockDecoder` (default `sdkUnlockDecoder`) and loses `wallet`, `cashu`, `cashuTrade`; constructs `ZenonTradeClient`, `FundsReservationRepository`, `ZwapCoordinatorEffects`, `TradeApi` with `market: { chainId: String(config.chainId), baseToken: ZNN_ZTS, quoteToken: QSR_ZTS }`.

- [ ] **Step 1: `zwap-api.test.ts`** — fake node + `MemoryStorageDriver`; `getState()` before a wallet has `address: null`; `createWallet()` yields an address and zero balances; after `node.fund(address, ZNN, "5")` + `node`-side pending send, `receivePending()` increments balance; `fusePlasma` with `plasmaBotUrl: null` throws `"Plasma bot is not configured for this network"`; with a stub fetch it returns the result. Implement `zwap-api.ts`. The keystore signer for the fake path is `node.signer(address)` — make `createAccount` injectable so tests avoid the SDK `KeyPair` (`createAccount` receives the key pair only in the browser wiring; in tests pass a factory that ignores it and returns a `ZenonAccount` over the fake signer).

- [ ] **Step 2: `trade-runtime.ts`** — rewire per **Interfaces**. `trade-runtime.test.ts`: assert the runtime constructs with a fake node/signer and exposes `market.chainId === "1"`.

- [ ] **Step 3: `main.ts` composition root** — replace the Cashu construction block with:
```ts
const config = browserConfig();
const driver = new IndexedDbStorageDriver(storageNameForProfile(profile));
const keystore = new KeystoreRepository(driver, locked);
const node = await SdkZenonNode.connect({ nodeUrl: config.nodeUrl, chainId: config.chainId });
KeystoreSigner.installPowWorker({ onPowStart: () => setStatus("Generating proof of work…"), onPowEnd: () => clearStatus() });
const api = new ZwapApi({ keystore, node, config, createAccount: (keyPair) => new ZenonAccount({ node, signer: new KeystoreSigner(node.zenon, keyPair) }) });
```
  and pass `node`, a `KeystoreSigner` (created inside `keystore.useKeyPair` once at unlock; keep the key pair resident for the page lifetime — document this in the custody panel), and `config` into `createBrowserTradeRuntime`. `window.zwap` facade: `getState, createWallet, importWallet, receivePending, fusePlasma, send, revealMnemonic, clearWallet, getOrderBook, publishOrder, cancelOrder, takeOrder, listTrades, advanceTrade, enableMaker`. Show a `ChainMismatchError` as a blocking status message.

- [ ] **Step 4: Remove Cashu** — `git rm -r src/cashu src/api/granola-api.ts src/api/granola-api.test.ts`; `npm uninstall @cashu/cashu-ts`; grep `-rn "cashu\|granola" src scripts` and fix every remaining reference (identifiers, strings, comments). `npm run typecheck && npm test` — PASS (UI files may still fail to typecheck; if so, do Task 13 before committing the typecheck claim — but commit this step regardless).

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: ZwapApi and browser runtime over Zenon; remove Cashu"`

---

### Task 13: UI on the Zenon design system

**Files:**
- Create: `src/styles/design-system/` (copied from `zenon-design-system/design-system/{tokens,components,styles.css}`), `src/ui/account-actions.ts`, `src/ui/account-actions.test.ts`, `src/ui/theme.ts`
- Modify: `index.html`, `src/styles.css`, `src/ui/dashboard.ts` + test, `src/ui/trades.ts` + test, `src/ui/orderbook.ts` + test, `src/ui/format.ts` + test, `src/ui/order-outbox.ts`, `src/ui/activity-log.ts`, `src/main.ts` (element ids, order form)
- Delete: `src/ui/mint-actions.ts` + test

**Interfaces:**
- `format.ts`: `formatTokenAmount(amount: string, decimals: number, symbol: string): string` (grouped integer part, full fractional precision with trailing zeros dimmed via a `<span class="dim">` — return an `HTMLElement` variant `renderTokenAmount(...)` for DOM use), `truncateAddress(address: string): string` (`z1qzal…a0mz`), `formatPrice(price: string, quoteDecimals: number, quoteSymbol: string, baseSymbol: string): string` (`"3.5 QSR/ZNN"`).
- `account-actions.ts`: `renderAccountActions(root: HTMLElement, state: ZwapState, handlers: { onCreate; onImport(mnemonic); onReceive; onFuse(tier); onReveal; onCopyAddress }): void`.
- `theme.ts`: `applyTheme(root: HTMLElement): void` — toggles `.dark` on `<html>` from `prefers-color-scheme` and persists an explicit choice in `localStorage["zwap.theme"]`.

- [ ] **Step 1: Bring in the design system** — copy `tokens/*.css`, `components/components.css`, `styles.css` from the zenon-design-system repo (`/private/tmp/.../scratchpad/zds/design-system`, or clone `https://github.com/digitalSloth/zenon-design-system`) into `src/styles/design-system/`; add `assets/znn-logo.svg`, `assets/qsr-logo.svg` to `public/`. In `index.html` replace the `<link href="/src/styles.css">` with `/src/styles/design-system/styles.css` followed by `/src/styles.css`. Add `https://fonts.googleapis.com` and `https://fonts.gstatic.com` to the CSP `style-src`/`font-src`, the Zenon node host to `connect-src` (`wss://node.zenon.network:35998 ws://172.245.236.40:35998`), `https://plazma.bot` to `connect-src`, `blob:` to `worker-src`, and `'wasm-unsafe-eval'` to `script-src`; remove the testnut hosts.

- [ ] **Step 2: Rewrite `src/styles.css`** as app-layout-only rules using tokens (`var(--background)`, `var(--card)`, `var(--border)`, `var(--radius-xl)`, `var(--shadow-sm)`, `var(--font-mono)`, `.text-ledger` eyebrows). Remove every raw hex and the Georgia/Courier stacks. Fix the undefined `--muted` bug by using `var(--muted-foreground)`.

- [ ] **Step 3: `index.html`** — keep the same section ids `main.ts` needs (`dashboard`, `wallet-summary`, `orderbook`, `pending-publications`, `trades`, `status`, `order-settlement-hint`, `activity-log`, `profile-label`, `refresh`, `refresh-orderbook`, `refresh-trades`, `order-form`, `backup`, `clear-wallet`, `reset-profile`) and rename `mint-actions` → `account-actions`. Copy: masthead badge `MAINNET · REAL FUNDS` (or `TESTNET 73404`) rendered from config; sections "Order book" (ZNN/QSR), "Account", "Trades", "Custody", "Trace"; protocol diagram retitled "How a swap settles on Zenon" with the HTLC sequence (Create → verify → Create → Unlock reveals preimage → Unlock) as inline SVG using `var(--primary)`/`var(--info)` strokes; agent strip documents `window.zwap`. Order form fields: side, base amount (ZNN), price (QSR per ZNN), expiry in **hours** (min 2). No emoji anywhere; use inline Lucide SVG paths for the copy/refresh icons.

- [ ] **Step 4: `account-actions.ts` (TDD)** — test with jsdom: no wallet → "Create wallet" + "Import" form; wallet → address (mono, truncated, full in `title`), balance list, "Receive N pending" button disabled when 0, "Fuse plasma" select+button only when `plasmaBotAvailable`, PoW warning when `powRequired`, "Reveal seed" button. Primary action (`Create wallet` / `Fuse plasma`) uses `nom-btn nom-btn--primary`; others `nom-btn--outline`.

- [ ] **Step 5: `dashboard.ts`, `trades.ts`, `orderbook.ts`, `format.ts`** — replace mint/unit/proof rendering with token symbol + decimals from `BalanceView`, `truncateAddress` for counterparties, `htlcState` badges (`nom-badge--pending` for LOCKED/UNKNOWN, `--success` for UNLOCKED, `--warning` for RECLAIMED), HTLC ids as `nom-address`-style mono links (`title` = full id). Trade DM copy: replace mint sentences with "The chain now drives settlement — an unlock on the quote HTLC reveals the preimage." Update tests.

- [ ] **Step 6: Visual check** — `npm run dev`, open `http://localhost:5173/`, verify light and dark (`applyTheme` toggle in masthead), no console CSP errors, `pow.js` served. Run `npm run typecheck && npm test` — PASS.

- [ ] **Step 7: Commit** — `git add -A && git commit -m "feat(ui): Zenon design system, account panel, HTLC trade views"`

---

### Task 14: Docs, ADR, CI, scripts

**Files:**
- Create: `docs/adr/0006-zenon-htlc-settlement.md`, `docs/guides/manual-swap.md`
- Modify: `README.md`, `docs/README.md`, `docs/guides/agent-api.md`, `docs/guides/testnet-wallet.md` → rename `docs/guides/wallet.md`, `docs/protocol/security-invariants.md`, `AGENTS.md`, `src/manual-tutorial.test.ts`
- Create: `public/_headers`, `docs/guides/deploy-cloudflare.md`, `Dockerfile`, `deploy/nginx.conf`, `.dockerignore`, `docs/guides/deploy-docker.md`, `.github/workflows/ci.yml`
- Delete: `.github/workflows/pages.yml`
- Delete: `docs/adr/0004-cashu-htlc-settlement.md` (superseded — keep a one-line stub pointing at 0006), `docs/adr/0005-quote-minor-unit-settlement.md` content replaced with the `price` rule

- [ ] **Step 1: ADR 0006** — decision: Zenon HTLC embedded contract as the settlement layer; hashType SHA-256 / keyMaxSize 32; maker locks base with the long locktime, taker locks quote with the short one; preimage learned from the on-chain Unlock block (scan of `hashLocked` address account chain, `scanPages × pageSize`); refund = `Reclaim` after expiry + guard; plasma/PoW requirement and `plasma_unavailable` retry semantics; trust boundary: the node you connect to is your view of the chain (recommend running your own node for real volume); no list-HTLC RPC, hence ids travel in DMs and are re-verified.
- [ ] **Step 2: `manual-swap.md`** — two browsers (`?wallet=maker`, `?wallet=taker`), fund both via go-syrius or nom-webwallet with ≥ 1 ZNN / ≥ 4 QSR plus 10 QSR fused (or accept PoW), publish a sell order, take it, watch the phases through `filled`, then `Receive pending`; include the refund drill (take an order, close the taker tab, wait `long locktime + 60 s`, advance the maker). Update `manual-tutorial.test.ts` to assert the guide mentions the steps it checks (`Create wallet`, `Fuse plasma`, `Receive pending`).
- [ ] **Step 3: `agent-api.md`** — document `window.zwap` methods and which ones return bearer material (`revealMnemonic` only).
- [ ] **Step 4: `security-invariants.md` / `AGENTS.md`** — replace mint/NUT language with chain invariants: verify every HTLC from the node before acting; never trust DM-carried ids without `getById`; chain-id binding; sequential sends; never expose mnemonic/preimage.
- [ ] **Step 5: Deployment — Cloudflare Pages primary, Docker/Coolify secondary (replaces GitHub Pages)** — delete `.github/workflows/pages.yml`; add `.github/workflows/ci.yml` (Node 22, `npm ci`, `npm run typecheck`, `npm test`, `npm run build` on push/PR; no deploy step — Cloudflare's Git integration deploys). Add `public/_headers` (copied verbatim into `dist/` by Vite):
```
/index.html
  Cache-Control: no-cache
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
/assets/*
  Cache-Control: public, max-age=31536000, immutable
/pow.wasm
  Content-Type: application/wasm
/pow.js
  Content-Type: application/javascript
```
Write `docs/guides/deploy-cloudflare.md`: Cloudflare Pages → connect the GitHub repo; production branch `main`; build command `npm run build`; build output `dist`; Node version via env `NODE_VERSION=22`; build environment variables = the five `VITE_*` keys with the mainnet values (a second Pages project or a preview-branch env with the testnet values gives a testnet instance); custom domain `zwap.fun`; note that every `wss://` target and `https://plazma.bot` must appear in `index.html`'s CSP `connect-src` (already the case) and that Pages serves the site over HTTPS (required for `wss://`). Also add the secondary path — a multi-stage `Dockerfile` (`node:22-alpine` build with the five `VITE_*` as `ARG`s defaulting to mainnet → `nginx:1.27-alpine` serving `dist` with `deploy/nginx.conf`: wasm MIME, `no-cache` for `index.html`, immutable `/assets/`) plus `.dockerignore` (`node_modules`, `dist`, `.git`, `.superpowers`, `docs`) and a short `docs/guides/deploy-docker.md` (works for Coolify's Dockerfile build pack with the same variables as build args). README: replace the Pages note with links to both guides and the `vite --mode testnet` note. Verify locally: `npm run build && ls dist/_headers dist/pow.wasm` and `docker build -t zwap . && docker run -d -p 8080:80 zwap && curl -sI localhost:8080/pow.wasm | grep -i 'application/wasm'`.
- [ ] **Step 6: `scripts/probe-inbox.ts`** — keep; update imports. Delete `publish:test-orders` if it can't run without a keystore, or make it read `ZWAP_TEST_NSEC` from env and publish to relays with `price` semantics.
- [ ] **Step 7: Run** — `npm run typecheck && npm test && npm run build` — PASS.
- [ ] **Step 8: Commit** — `git add -A && git commit -m "docs+deploy: Zenon HTLC ADR, guides, Cloudflare Pages + Docker, CI"`

---

### Task 15: Gated live-chain integration test

**Files:**
- Create: `src/zenon/live.integration.test.ts`, `docs/guides/live-test.md`

- [ ] **Step 1: Write the test** (skipped unless `ZENON_INTEGRATION=1`; reads `ZENON_NODE_WS`, `ZENON_CHAIN_ID`, `ZWAP_MAKER_MNEMONIC`, `ZWAP_TAKER_MNEMONIC` from `process.env`; **never** commit values):
```ts
import { describe, expect, it } from "vitest";
import { KeyStore } from "znn-typescript-sdk";
import { SdkZenonNode } from "./sdk-node.js";
import { KeystoreSigner } from "./keystore-signer.js";
import { ZenonTradeClient } from "./trade-client.js";
import { sdkUnlockDecoder, type ExpectedZenonLock } from "./htlc.js";
import { createHtlcMaterial } from "./htlc-material.js";
import { ZNN_ZTS, QSR_ZTS } from "./types.js";

const enabled = process.env.ZENON_INTEGRATION === "1";

describe.skipIf(!enabled)("live Zenon HTLC swap (small amounts)", () => {
  it("locks, unlocks and observes on the real chain", async () => {
    const node = await SdkZenonNode.connect({ nodeUrl: process.env.ZENON_NODE_WS!, chainId: Number(process.env.ZENON_CHAIN_ID ?? "1") });
    const maker = new KeystoreSigner(node.zenon, KeyStore.fromMnemonic(process.env.ZWAP_MAKER_MNEMONIC!).getKeyPair(0));
    const taker = new KeystoreSigner(node.zenon, KeyStore.fromMnemonic(process.env.ZWAP_TAKER_MNEMONIC!).getKeyPair(0));
    const now = () => Math.floor(Date.now() / 1000);
    const makerClient = new ZenonTradeClient({ node, signer: maker, decodeUnlock: sdkUnlockDecoder, now });
    const takerClient = new ZenonTradeClient({ node, signer: taker, decodeUnlock: sdkUnlockDecoder, now });
    const m = await createHtlcMaterial();
    const chainId = String(await node.chainIdentifier());
    const binding = { protocolVersion: "1" as const, network: `zenon-${chainId}`, orderId: "live", sessionId: "live", reservationId: "live", transcriptHash: "00".repeat(32) };
    const base: ExpectedZenonLock = { leg: "base", chainId, tokenStandard: ZNN_ZTS, amount: "1000000", hashLock: m.hash, hashType: 1, keyMaxSize: 32, hashLockedAddress: taker.address(), timeLockedAddress: maker.address(), expirationTime: now() + 3600, binding };
    const quote: ExpectedZenonLock = { leg: "quote", chainId, tokenStandard: QSR_ZTS, amount: "1000000", hashLock: m.hash, hashType: 1, keyMaxSize: 32, hashLockedAddress: maker.address(), timeLockedAddress: taker.address(), expirationTime: now() + 1800, binding };

    const baseLock = await makerClient.completeLock(await makerClient.prepareLock({ expected: base, now: now() }));
    await takerClient.validateIncomingLock(baseLock.htlcId, base);
    const quoteLock = await takerClient.completeLock(await takerClient.prepareLock({ expected: quote, now: now() }));
    await makerClient.completeClaim(await makerClient.prepareClaim({ htlcId: quoteLock.htlcId, expected: quote, preimage: m.preimage, now: now(), claimCutoff: quote.expirationTime - 120 }), m.preimage);

    let observed = await takerClient.observe(quoteLock.htlcId, quote);
    for (let i = 0; i < 30 && observed.state !== "UNLOCKED"; i += 1) {
      await new Promise((r) => setTimeout(r, 10_000));
      observed = await takerClient.observe(quoteLock.htlcId, quote);
    }
    expect(observed.state).toBe("UNLOCKED");
    expect(observed.preimage).toBe(m.preimage);
    await takerClient.completeClaim(await takerClient.prepareClaim({ htlcId: baseLock.htlcId, expected: base, preimage: m.preimage, now: now(), claimCutoff: base.expirationTime - 120 }), m.preimage);
    node.disconnect();
  }, 600_000);
});
```
- [ ] **Step 2: `live-test.md`** — how to fund two throwaway seeds with ~0.02 ZNN / ~0.02 QSR and plasma, run `ZENON_INTEGRATION=1 ZWAP_MAKER_MNEMONIC="…" ZWAP_TAKER_MNEMONIC="…" npx vitest run src/zenon/live.integration.test.ts`, and how to reclaim leftovers (`Reclaim` after expiry via the app's custody panel).
- [ ] **Step 3: Run the live test once** on mainnet with the amounts above (0.01 ZNN ↔ 0.01 QSR); record the two HTLC ids and block hashes in `docs/guides/live-test.md` under "Reference run". If `getById` on a spent HTLC does not surface as `null`, adjust `isNotFound` in `sdk-node.ts` and note the observed error text in ADR 0006.
- [ ] **Step 4: Commit** — `git add -A && git commit -m "test: gated live-chain HTLC integration test"`

---

## Self-review

**Spec coverage:** §2.1 module fate → Tasks 8, 12, 13; §2.2 modules → Tasks 2–6, 11; §3 settlement steps → Tasks 6, 10 (`expectedLock` locktime mapping, preimage learning in `observeLeg`, refund via `prepareRefund`/`Reclaim`, `plasma_unavailable` retry, chain-id binding via `binding.network` + `terms.chainId`, `claim_notice` retained); §4 markets/price → Task 9; §5 config → Task 1 (+ CSP in Task 13); §6 design system → Task 13; §7 agent API → Tasks 12, 14; §8 testing → fake node throughout, integration Task 11 Step 5, live Task 15; §9 out of scope respected (signer interface exists but only the keystore implementation ships).

**Placeholder scan:** none; every code step contains the code or the exact edit list with symbols.

**Type consistency:** `ExpectedZenonLock` defined in Task 5 and consumed unchanged in Tasks 6, 8, 10; `PreparedChainOperation`/`ChainOperationJournal` field names (`fundsReserved`, `account_applied`) match between Tasks 8 and 10; action kinds (`reserve_funds`, `execute_chain_operation`, `reconcile_account`, `clear_chain_operation`) match Tasks 8 and 10; `ZenonTemplate` kinds match Tasks 2, 3, 4, 6; `HtlcState` values match Tasks 2, 6, 8, 13; `price` semantics identical in Tasks 7, 9, 13.
