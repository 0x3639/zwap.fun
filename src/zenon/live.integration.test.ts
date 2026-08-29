// @vitest-environment node
//
// Gated live-chain integration test. Skipped unless ZENON_INTEGRATION=1.
//
// This is the one test in the suite that spends real funds on a real Zenon
// node (mainnet by default). It exercises the full happy path this repo's
// unit and fake-node tests only simulate: both HTLC legs are created,
// verified, claimed, and observed against an actual node connection, and
// `isNotFound` in `sdk-node.ts` is the one heuristic this run validates end
// to end (see docs/guides/live-test.md).
//
// Never commit mnemonics, private keys, or preimages. This file must never
// print a seed, even on failure.
import { describe, expect, it } from "vitest";
import { KeyStore } from "znn-typescript-sdk";
import { SdkZenonNode } from "./sdk-node.js";
import { KeystoreSigner } from "./keystore-signer.js";
import { ZenonTradeClient } from "./trade-client.js";
import { ZenonAccount } from "./account.js";
import { sdkReclaimDecoder, sdkUnlockDecoder, type ExpectedZenonLock } from "./htlc.js";
import { createHtlcMaterial } from "./htlc-material.js";
import { ZNN_ZTS, QSR_ZTS } from "./types.js";

const enabled = process.env.ZENON_INTEGRATION === "1";

/** 0.01 ZNN / 0.01 QSR at 8 decimals: small enough to be a safe throwaway loss. */
const AMOUNT = "1000000";

interface RecoverableLeg {
  label: string;
  htlcId: string;
  expirationTime: number;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `live integration test requires the ${name} environment variable (see docs/guides/live-test.md)`
    );
  }
  return value;
}

async function assertFunded(
  node: SdkZenonNode,
  address: string,
  tokenStandard: string,
  amount: string,
  role: string
): Promise<void> {
  const balances = await node.getBalances(address);
  const available = BigInt(balances.find((b) => b.tokenStandard === tokenStandard)?.balance ?? "0");
  if (available < BigInt(amount)) {
    throw new Error(
      `${role} address ${address} holds ${available} minor units of ${tokenStandard}, needs at least ` +
        `${amount}. Fund it before running the live integration test (see docs/guides/live-test.md).`
    );
  }
}

/**
 * Prints how to recover funds locked on chain when the run fails partway
 * through. Never prints the preimage or either seed — only public,
 * already-on-chain identifiers and the expiry each reclaim waits on.
 */
function printRecoveryInstructions(legs: RecoverableLeg[]): void {
  console.error(
    "\nLive integration test failed after creating on-chain HTLC lock(s). " +
      "Once each lock's expiration time passes, reclaim it (the app's custody panel's " +
      "Reclaim action, or `htlc.reclaim(id)`):\n"
  );
  for (const leg of legs) {
    const expiresAt = new Date(leg.expirationTime * 1000).toISOString();
    console.error(`  - ${leg.label}: htlcId=${leg.htlcId} expires=${expiresAt} (unix ${leg.expirationTime})`);
  }
  console.error("\n(No seed or preimage is printed here.)\n");
}

describe.skipIf(!enabled)("live Zenon HTLC swap (small amounts)", () => {
  it(
    "locks, unlocks and observes on the real chain",
    async () => {
      const nodeUrl = requireEnv("ZENON_NODE_WS");
      const chainId = Number(process.env.ZENON_CHAIN_ID ?? "1");
      const makerMnemonic = requireEnv("ZWAP_MAKER_MNEMONIC");
      const takerMnemonic = requireEnv("ZWAP_TAKER_MNEMONIC");

      const node = await SdkZenonNode.connect({ nodeUrl, chainId });
      const recoverableLegs: RecoverableLeg[] = [];
      try {
        const maker = new KeystoreSigner(node.zenon, KeyStore.fromMnemonic(makerMnemonic).getKeyPair(0));
        const taker = new KeystoreSigner(node.zenon, KeyStore.fromMnemonic(takerMnemonic).getKeyPair(0));
        const now = () => Math.floor(Date.now() / 1000);
        const makerClient = new ZenonTradeClient({ node, signer: maker, decodeUnlock: sdkUnlockDecoder, decodeReclaim: sdkReclaimDecoder, now });
        const takerClient = new ZenonTradeClient({ node, signer: taker, decodeUnlock: sdkUnlockDecoder, decodeReclaim: sdkReclaimDecoder, now });

        // Pre-flight: fail fast with a clear message instead of a confusing
        // mid-swap error if either throwaway address is not actually funded.
        await assertFunded(node, maker.address(), ZNN_ZTS, AMOUNT, "maker");
        await assertFunded(node, taker.address(), QSR_ZTS, AMOUNT, "taker");

        const m = await createHtlcMaterial();
        const chainIdStr = String(await node.chainIdentifier());
        const binding = {
          protocolVersion: "1" as const,
          network: `zenon-${chainIdStr}-v1`,
          orderId: "live",
          sessionId: "live",
          reservationId: "live",
          transcriptHash: "00".repeat(32)
        };
        const base: ExpectedZenonLock = {
          leg: "base", chainId: chainIdStr, tokenStandard: ZNN_ZTS, amount: AMOUNT, hashLock: m.hash,
          hashType: 1, keyMaxSize: 32, hashLockedAddress: taker.address(), timeLockedAddress: maker.address(),
          expirationTime: now() + 3600, binding
        };
        const quote: ExpectedZenonLock = {
          leg: "quote", chainId: chainIdStr, tokenStandard: QSR_ZTS, amount: AMOUNT, hashLock: m.hash,
          hashType: 1, keyMaxSize: 32, hashLockedAddress: maker.address(), timeLockedAddress: taker.address(),
          expirationTime: now() + 1800, binding
        };

        const baseLock = await makerClient.completeLock(await makerClient.prepareLock({ expected: base, now: now() }));
        recoverableLegs.push({ label: "base (ZNN, maker locked)", htlcId: baseLock.htlcId, expirationTime: base.expirationTime });
        await takerClient.validateIncomingLock(baseLock.htlcId, base);

        const quoteLock = await takerClient.completeLock(await takerClient.prepareLock({ expected: quote, now: now() }));
        recoverableLegs.push({ label: "quote (QSR, taker locked)", htlcId: quoteLock.htlcId, expirationTime: quote.expirationTime });

        await makerClient.completeClaim(
          await makerClient.prepareClaim({
            htlcId: quoteLock.htlcId, expected: quote, preimage: m.preimage, now: now(),
            claimCutoff: quote.expirationTime - 120
          }),
          m.preimage
        );

        // One polling deadline shared by both legs, well inside the 600 s test
        // timeout: if polling exhausts it the `catch` below still runs and
        // prints the recovery ids instead of Vitest aborting the body first.
        const pollDeadline = Date.now() + 420_000;
        let observedQuote = await takerClient.observe(quoteLock.htlcId, quote);
        while (observedQuote.state !== "UNLOCKED" && Date.now() < pollDeadline) {
          await new Promise((resolve) => setTimeout(resolve, 10_000));
          observedQuote = await takerClient.observe(quoteLock.htlcId, quote);
        }
        expect(observedQuote.state).toBe("UNLOCKED");
        expect(observedQuote.preimage).toBe(m.preimage);

        await takerClient.completeClaim(
          await takerClient.prepareClaim({
            htlcId: baseLock.htlcId, expected: base, preimage: m.preimage, now: now(),
            claimCutoff: base.expirationTime - 120
          }),
          m.preimage
        );

        // Prove both legs, not just the one whose preimage-reveal the quote
        // loop already confirmed: poll the base leg to UNLOCKED too.
        let observedBase = await takerClient.observe(baseLock.htlcId, base);
        while (observedBase.state !== "UNLOCKED" && Date.now() < pollDeadline) {
          await new Promise((resolve) => setTimeout(resolve, 10_000));
          observedBase = await takerClient.observe(baseLock.htlcId, base);
        }
        expect(observedBase.state).toBe("UNLOCKED");
        expect(observedBase.preimage).toBe(m.preimage);

        // Sweep both parties' pending receives so the swap's funds actually
        // land in spendable balances, proving the run end to end.
        const makerAccount = new ZenonAccount({ node, signer: maker, now });
        const takerAccount = new ZenonAccount({ node, signer: taker, now });
        await makerAccount.receiveAll();
        await takerAccount.receiveAll();
      } catch (error) {
        if (recoverableLegs.length > 0) printRecoveryInstructions(recoverableLegs);
        throw error;
      } finally {
        node.disconnect();
      }
    },
    600_000
  );
});
