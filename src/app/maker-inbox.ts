import type { OrderApi } from "../api/order-api.js";
import type { ZwapApi } from "../api/zwap-api.js";
import type { BrowserTradeController } from "../browser/trade-controller.js";
import { messageOf, publicNpub, type StatusSurface } from "./status.js";

export interface MakerInboxInput {
  status: StatusSurface;
  orderApi: OrderApi;
  walletApi: () => ZwapApi | undefined;
  tradeController: () => Promise<BrowserTradeController>;
}

export interface MakerInboxSurface {
  syncMakerInboxes: () => Promise<void>;
  startMakerInbox: () => Promise<void>;
}

export function createMakerInboxSurface(input: MakerInboxInput): MakerInboxSurface {
  const { status, orderApi } = input;
  const { report, trace } = status;

  let makerInboxStartPromise: Promise<void> | undefined;
  let makerInboxResyncQueued = false;
  let makerInboxRetryAttempt = 0;
  let makerInboxRetryTimer: ReturnType<typeof globalThis.setTimeout> | undefined;

  async function syncMakerInboxes(): Promise<void> {
    // `enableMaker` builds the trade runtime, which needs the extension's
    // signer. Nothing to start, and nothing to report, until one is connected.
    if (input.walletApi()?.status() !== "connected") return;
    const publicKeys = await orderApi.getMakerPublicKeys();
    if (publicKeys.length === 0) {
      return;
    }
    await startMakerInbox();
  }

  function startMakerInbox(): Promise<void> {
    if (input.walletApi()?.status() !== "connected") return Promise.resolve();
    if (makerInboxStartPromise !== undefined) {
      makerInboxResyncQueued = true;
      const current = makerInboxStartPromise;
      return current.then(() => {
        if (!makerInboxResyncQueued) return;
        makerInboxResyncQueued = false;
        return startMakerInbox();
      });
    }
    makerInboxStartPromise = input.tradeController()
      .then((controller) => controller.enableMaker())
      .then(({ makerPubkey, inboxRelay }) => {
        makerInboxRetryAttempt = 0;
        if (makerInboxRetryTimer !== undefined) {
          globalThis.clearTimeout(makerInboxRetryTimer);
          makerInboxRetryTimer = undefined;
        }
        if (!makerPubkey) {
          return;
        }
        trace("Nostr", "Maker listener ready", [
          { label: "meaning", value: "public order authority for maker inbox discovery" },
          publicNpub("order npub", makerPubkey),
          { label: "relay", value: new URL(inboxRelay).host }
        ]);
        report("Maker listener is authenticated and listening");
      })
      .catch((error: unknown) => {
        const retryDelay = Math.min(
          10_000,
          500 * (2 ** Math.min(makerInboxRetryAttempt, 4))
        );
        makerInboxRetryAttempt += 1;
        trace("Nostr", "Maker listener reconnecting", [
          { label: "error", value: messageOf(error) },
          { label: "retry", value: `${retryDelay} ms` }
        ]);
        report("Maker listener unavailable; retrying automatically");
        if (makerInboxRetryTimer === undefined) {
          makerInboxRetryTimer = globalThis.setTimeout(() => {
            makerInboxRetryTimer = undefined;
            void syncMakerInboxes();
          }, retryDelay);
        }
      })
      .finally(() => {
        makerInboxStartPromise = undefined;
      });
    return makerInboxStartPromise;
  }

  return { syncMakerInboxes, startMakerInbox };
}
