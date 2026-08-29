import { describe, expect, it } from "vitest";
import { accountBlockToView, htlcInfoToView, isNotFound } from "./sdk-node.js";
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

  it("treats only a real not-found answer as an absent HTLC", () => {
    expect(isNotFound(new Error("data not found"))).toBe(true);
    expect(isNotFound(new Error("No HTLC with that id"))).toBe(true);
    expect(isNotFound(new Error("account block does not exist"))).toBe(true);
    expect(isNotFound({ code: -32000, message: "data non existent" })).toBe(true);
    expect(isNotFound({ code: -32000, message: "leaf node does not exist" })).toBe(true);

    // Regression: a local bug must propagate, not read as "no such HTLC" and
    // silently turn a live lock into an absent one.
    expect(isNotFound(new TypeError("Cannot read properties of null (reading 'id')")))
      .toBe(false);
    expect(isNotFound(new Error("null"))).toBe(false);
    expect(isNotFound(new Error("connection reset"))).toBe(false);
    expect(isNotFound({ code: -32601, message: "method not supported" })).toBe(false);
    // -32000 is the node's generic server error. On its own it proves nothing:
    // requiring the message too keeps a real fault from reading as "absent".
    expect(isNotFound({ code: -32000, message: "whatever" })).toBe(false);
    expect(isNotFound({ code: -32000, message: "internal database failure" })).toBe(false);
    expect(isNotFound({ code: -32601, message: "data non existent" })).toBe(false);
  });
});
