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
