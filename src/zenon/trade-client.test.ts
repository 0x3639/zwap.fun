import { describe, expect, it } from "vitest";
import { FakeZenonNode } from "./fake-node.js";
import { fakeReclaimDecoder, fakeUnlockDecoder, type ExpectedZenonLock } from "./htlc.js";
import { createHtlcMaterial } from "./htlc-material.js";
import { ZenonTradeClient } from "./trade-client.js";
import { HTLC_ADDRESS, QSR_ZTS, ZNN_ZTS, type ZenonNodePort } from "./types.js";

function harness() {
  let now = 1_000_000;
  const node = new FakeZenonNode({ chainId: 1, now: () => now });
  const maker = node.createAddress("maker");
  const taker = node.createAddress("taker");
  node.fund(maker, ZNN_ZTS, "1000000000");
  node.fund(taker, QSR_ZTS, "5000000000");
  const clock = () => now;
  const makerClient = new ZenonTradeClient({ node, signer: node.signer(maker), decodeUnlock: fakeUnlockDecoder, decodeReclaim: fakeReclaimDecoder, now: clock });
  const takerClient = new ZenonTradeClient({ node, signer: node.signer(taker), decodeUnlock: fakeUnlockDecoder, decodeReclaim: fakeReclaimDecoder, now: clock });
  const binding = { protocolVersion: "1" as const, network: "zenon-mainnet", orderId: "o", sessionId: "s", reservationId: "r", transcriptHash: "cd".repeat(32) };
  return { node, maker, taker, makerClient, takerClient, binding, tick: (s: number) => { now += s; }, now: clock };
}

/**
 * Delegates to the fake node but makes the first `failures` `getHtlc` calls
 * throw, which is exactly how a transient node error hits `completeLock`: the
 * `htlc_create` block is already on chain, only the read-back fails.
 */
function withFailingReadBack(node: FakeZenonNode, failures: number): ZenonNodePort {
  let remaining = failures;
  return {
    chainIdentifier: () => node.chainIdentifier(),
    frontierMomentum: () => node.frontierMomentum(),
    getHtlc: async (id) => {
      if (remaining > 0) {
        remaining -= 1;
        throw new Error("network unreachable");
      }
      return node.getHtlc(id);
    },
    getAccountBlock: (hash) => node.getAccountBlock(hash),
    listAccountBlocks: (address, page, size) => node.listAccountBlocks(address, page, size),
    getBalances: (address) => node.getBalances(address),
    listUnreceived: (address) => node.listUnreceived(address),
    getTokenDecimals: (zts) => node.getTokenDecimals(zts),
    getPlasma: (address) => node.getPlasma(address)
  };
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

  it("reports UNKNOWN for an expired HTLC with no reclaim block on chain", async () => {
    // Regression: an expired HTLC that had simply fallen out of the scan window
    // was reported as RECLAIMED, which is terminal evidence the chain never
    // gave. Only a decoded `Reclaim` block may retire a leg.
    const h = harness();
    const m = await createHtlcMaterial();
    const expected: ExpectedZenonLock = { leg: "base", chainId: "1", tokenStandard: ZNN_ZTS, amount: "1", hashLock: m.hash, hashType: 1, keyMaxSize: 32, hashLockedAddress: h.taker, timeLockedAddress: h.maker, expirationTime: h.now() + 100, binding: h.binding };
    const lock = await h.makerClient.completeLock(await h.makerClient.prepareLock({ expected, now: h.now() }));

    // The HTLC is gone from the node's index but nobody spent it in view.
    h.node.forgetHtlc(lock.htlcId);
    h.tick(161);

    const observed = await h.takerClient.observe(lock.htlcId, expected);
    expect(observed.state).toBe("UNKNOWN");
    expect(observed.witnessCommitment).toBeNull();
  });

  it("reports RECLAIMED only from a decoded reclaim block on the time-locked chain", async () => {
    const h = harness();
    const m = await createHtlcMaterial();
    const expected: ExpectedZenonLock = { leg: "base", chainId: "1", tokenStandard: ZNN_ZTS, amount: "1", hashLock: m.hash, hashType: 1, keyMaxSize: 32, hashLockedAddress: h.taker, timeLockedAddress: h.maker, expirationTime: h.now() + 100, binding: h.binding };
    const lock = await h.makerClient.completeLock(await h.makerClient.prepareLock({ expected, now: h.now() }));
    h.tick(161);
    await h.makerClient.completeRefund(
      await h.makerClient.prepareRefund({ htlcId: lock.htlcId, expected, now: h.now(), expiryGrace: 60 })
    );

    const observed = await h.takerClient.observe(lock.htlcId, expected);
    expect(observed.state).toBe("RECLAIMED");
    expect(observed.preimage).toBeNull();

    // A reclaim of some *other* HTLC on the same chain proves nothing here.
    const decoy = await h.makerClient.completeLock(await h.makerClient.prepareLock({
      expected: { ...expected, hashLock: (await createHtlcMaterial()).hash, expirationTime: h.now() + 100 },
      now: h.now()
    }));
    h.node.forgetHtlc(decoy.htlcId);
    h.tick(161);
    expect((await h.takerClient.observe(decoy.htlcId, expected)).state).toBe("UNKNOWN");
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

  it("refuses to prepare a claim whose preimage does not open the lock", async () => {
    // Regression: `prepareClaim` took a preimage and ignored it, so a wrong or
    // corrupted one was only caught by the node after the block was signed.
    const h = harness();
    const m = await createHtlcMaterial();
    const other = await createHtlcMaterial();
    const expected: ExpectedZenonLock = { leg: "quote", chainId: "1", tokenStandard: QSR_ZTS, amount: "1", hashLock: m.hash, hashType: 1, keyMaxSize: 32, hashLockedAddress: h.maker, timeLockedAddress: h.taker, expirationTime: h.now() + 1800, binding: h.binding };
    const lock = await h.takerClient.completeLock(await h.takerClient.prepareLock({ expected, now: h.now() }));

    await expect(h.makerClient.prepareClaim({
      htlcId: lock.htlcId, expected, preimage: other.preimage,
      now: h.now(), claimCutoff: expected.expirationTime - 120
    })).rejects.toThrow(expect.objectContaining({ code: "preimage-mismatch" }));

    await expect(h.makerClient.prepareClaim({
      htlcId: lock.htlcId, expected, preimage: "not hex",
      now: h.now(), claimCutoff: expected.expirationTime - 120
    })).rejects.toThrow(expect.objectContaining({ code: "preimage-mismatch" }));

    const prepared = await h.makerClient.prepareClaim({
      htlcId: lock.htlcId, expected, preimage: m.preimage,
      now: h.now(), claimCutoff: expected.expirationTime - 120
    });
    expect(prepared.kind).toBe("claim");
  });

  it("adopts its own existing HTLC instead of creating a second one after a failed read-back", async () => {
    const h = harness();
    const m = await createHtlcMaterial();
    const expected: ExpectedZenonLock = {
      leg: "base", chainId: "1", tokenStandard: ZNN_ZTS, amount: "100000000", hashLock: m.hash,
      hashType: 1, keyMaxSize: 32, hashLockedAddress: h.taker, timeLockedAddress: h.maker,
      expirationTime: h.now() + 3600, binding: h.binding
    };
    const client = new ZenonTradeClient({
      node: withFailingReadBack(h.node, 1),
      signer: h.node.signer(h.maker),
      decodeUnlock: fakeUnlockDecoder,
      decodeReclaim: fakeReclaimDecoder,
      now: h.now
    });
    const artifact = await client.prepareLock({ expected, now: h.now() });

    // The send lands; only the read-back fails, so nothing is returned.
    await expect(client.completeLock(artifact)).rejects.toThrow(/network unreachable/);

    const retry = await client.completeLock(artifact);
    const second = await client.completeLock(artifact);

    const created = (await h.node.listAccountBlocks(h.maker, 0, 100))
      .filter((block) => block.toAddress === HTLC_ADDRESS && block.amount === expected.amount);
    expect(created).toHaveLength(1);
    expect(retry.htlcId).toBe(created[0]!.hash);
    expect(second.htlcId).toBe(retry.htlcId);
    expect(second.summary.validationCommitment).toBe(retry.summary.validationCommitment);
    expect(await h.node.getHtlc(retry.htlcId)).not.toBeNull();
  });

  it("never adopts an HTLC that does not match the expected terms", async () => {
    const h = harness();
    const m = await createHtlcMaterial();
    const expected: ExpectedZenonLock = {
      leg: "base", chainId: "1", tokenStandard: ZNN_ZTS, amount: "5", hashLock: m.hash,
      hashType: 1, keyMaxSize: 32, hashLockedAddress: h.taker, timeLockedAddress: h.maker,
      expirationTime: h.now() + 3600, binding: h.binding
    };
    const other = await createHtlcMaterial();
    const decoy = await h.makerClient.completeLock(
      await h.makerClient.prepareLock({ expected: { ...expected, hashLock: other.hash }, now: h.now() })
    );

    const lock = await h.makerClient.completeLock(
      await h.makerClient.prepareLock({ expected, now: h.now() })
    );

    expect(lock.htlcId).not.toBe(decoy.htlcId);
    expect((await h.node.getHtlc(decoy.htlcId))?.hashLock).toBe(other.hash);
    expect((await h.node.getHtlc(lock.htlcId))?.hashLock).toBe(m.hash);
  });
});
