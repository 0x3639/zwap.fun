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
