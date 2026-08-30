import type {
  BalanceView,
  PlasmaView,
  SendReceipt,
  ZenonNodePort,
  ZenonSigner
} from "./types.js";
import { isAmount, isTokenStandard, isZenonAddress } from "./validate.js";

/**
 * Plasma a plain send or receive consumes. Below this the node demands PoW,
 * which the UI must warn about before it blocks the page for tens of seconds.
 */
export const MINIMUM_SEND_PLASMA = 21_000;

/** How many unreceived blocks one `receiveAll` sweep will drain. */
export const DEFAULT_RECEIVE_LIMIT = 50;

export interface AccountSnapshot {
  address: string;
  balances: BalanceView[];
  unreceived: number;
  plasma: PlasmaView;
  powRequired: boolean;
}

export interface ZenonAccountDeps {
  node: ZenonNodePort;
  signer: ZenonSigner;
  now?: () => number;
}

/**
 * The read/write view of one locally controlled Zenon address: what it holds,
 * what is waiting to be received, and the two plain transfers the wallet UI
 * needs. Settlement transfers go through `ZenonTradeClient` instead — this
 * class deliberately knows nothing about HTLCs.
 */
export class ZenonAccount {
  private readonly node: ZenonNodePort;
  /**
   * The signer this account was built over, exposed so the trade runtime can
   * share the exact instance: the signer serializes its own sends, and two
   * signers over one address would race each other's account-chain height.
   */
  readonly signer: ZenonSigner;
  private readonly now: () => number;

  constructor(deps: ZenonAccountDeps) {
    this.node = deps.node;
    this.signer = deps.signer;
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1_000));
  }

  address(): string {
    return this.signer.address();
  }

  async snapshot(): Promise<AccountSnapshot> {
    const address = this.address();
    const [balances, unreceived, plasma] = await Promise.all([
      this.node.getBalances(address),
      this.node.listUnreceived(address),
      this.node.getPlasma(address)
    ]);
    return {
      address,
      balances: structuredClone(balances),
      unreceived: unreceived.length,
      plasma: structuredClone(plasma),
      powRequired: plasma.currentPlasma < MINIMUM_SEND_PLASMA
    };
  }

  /**
   * Receives pending blocks one at a time. Strictly sequential: each receive
   * builds on the account chain height the previous one produced, so a
   * concurrent sweep would race itself into rejected blocks.
   */
  async receiveAll(limit: number = DEFAULT_RECEIVE_LIMIT): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error("Account receive limit must be a positive integer");
    }
    const address = this.address();
    const pending = (await this.node.listUnreceived(address)).slice(0, limit);
    let received = 0;
    for (const block of pending) {
      await this.signer.send({ kind: "receive", fromBlockHash: block.hash });
      received += 1;
    }
    return received;
  }

  async send(
    toAddress: string,
    tokenStandard: string,
    amount: string
  ): Promise<SendReceipt> {
    if (!isZenonAddress(toAddress)) {
      throw new Error("Send recipient is not a canonical Zenon address");
    }
    if (!isTokenStandard(tokenStandard)) {
      throw new Error("Send token standard is not canonical");
    }
    if (!isAmount(amount)) {
      throw new Error("Send amount must be a canonical positive integer");
    }
    if (toAddress === this.address()) {
      throw new Error("Send recipient must differ from the sending address");
    }
    return this.signer.send({ kind: "send", toAddress, tokenStandard, amount });
  }

  /** The clock this account reads, exposed for callers that stamp UI state. */
  currentTime(): number {
    return this.now();
  }
}
