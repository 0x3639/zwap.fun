import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey
} from "nostr-tools/pure";

import type { OrderApi } from "../api/order-api.js";
import { TradeApi } from "../api/trade-api.js";
import type { ZwapConfig } from "../config.js";
import {
  createInboxList,
  probeInboxRelayLive,
  type InboxRelayPort,
  type VerifiedInboxLiveProbeResult
} from "../nostr/inbox.js";
import { NostrToolsInboxRelayPort } from "../nostr/inbox-relay.js";
import type { MakerIdentity } from "../nostr/identity.js";
import type { TradeSubscriptionRelayPort } from "../nostr/trade-subscription.js";
import { NostrTradeTransport } from "../nostr/trade-transport.js";
import type { ExactMarket } from "../order/model.js";
import type { NostrOrderService } from "../order/service.js";
import type { OrderOutboxRepository } from "../storage/order-outbox.js";
import { TradeSessionRepository } from "../storage/trade-session.js";
import type { StorageDriver } from "../storage/driver.js";
import { TradeCoordinator } from "../trade/coordinator.js";
import { ZwapCoordinatorEffects } from "../trade/effects.js";
import { deploymentFor } from "../trade/messages.js";
import { FundsReservationRepository } from "../zenon/funds-reservations.js";
import {
  sdkReclaimDecoder,
  sdkUnlockDecoder,
  type ReclaimDecoder,
  type UnlockDecoder
} from "../zenon/htlc.js";
import { ZenonTradeClient } from "../zenon/trade-client.js";
import { QSR_ZTS, ZNN_ZTS, type ZenonNodePort, type ZenonSigner } from "../zenon/types.js";
import {
  withAccountLock,
  withTradeSessionLock,
  withTradeSessionStorageLock
} from "./lock.js";

/** Fallback inbox relay when the deployment configures none. */
export const TRADE_INBOX_RELAY = "wss://auth.nostr1.com";

type KeyGenerator = () => Uint8Array;

export interface TradeInboxProbeInput {
  relay: string;
  port: InboxRelayPort;
  now: number;
  generateSecretKey?: KeyGenerator;
}

export async function probeTradeInboxRelay(
  input: TradeInboxProbeInput
): Promise<VerifiedInboxLiveProbeResult> {
  const generate = input.generateSecretKey ?? generateSecretKey;
  const recipient = generate();
  const sender = generate();
  const other = generate();
  const wrapperSigner = generate();
  try {
    const recipientPubkey = getPublicKey(recipient);
    const inboxList = createInboxList([input.relay], recipient, input.now);
    const wrapper = finalizeEvent({
      kind: 1059,
      created_at: input.now,
      tags: [
        ["p", recipientPubkey],
        ["expiration", String(input.now + 3_600)]
      ],
      content: "zwap-inbox-live-probe"
    }, wrapperSigner);
    return await probeInboxRelayLive({
      relay: input.relay,
      inboxList,
      wrapper,
      recipientProtocolSecretKey: recipient,
      senderProtocolSecretKey: sender,
      otherProtocolSecretKey: other,
      port: input.port,
      now: input.now
    });
  } finally {
    recipient.fill(0);
    sender.fill(0);
    other.fill(0);
    wrapperSigner.fill(0);
  }
}

export interface CreateBrowserTradeRuntimeInput {
  profile: string;
  driver: StorageDriver;
  /** The connected node every chain read in this runtime goes through. */
  node: ZenonNodePort;
  /**
   * The page's single signer. It serializes its own sends, so the wallet API
   * and this runtime must share one instance or they would race each other's
   * account-chain height.
   */
  signer: ZenonSigner;
  config: ZwapConfig;
  makerIdentity: MakerIdentity;
  orderApi: OrderApi;
  orderService: NostrOrderService;
  orderOutbox: OrderOutboxRepository;
  inboxPort?: BrowserInboxPort;
  inboxRelay?: string;
  discoveryRelays?: readonly string[];
  now?: () => number;
  generateSecretKey?: KeyGenerator;
  /** Reads `Unlock` preimages off chain blocks; the fake node needs its own. */
  decodeUnlock?: UnlockDecoder;
  /** Reads `Reclaim` markers off chain blocks; the fake node needs its own. */
  decodeReclaim?: ReclaimDecoder;
}

export interface BrowserTradeRuntime {
  api: TradeApi;
  sessions: TradeSessionRepository;
  transport: NostrTradeTransport;
  inboxPort: BrowserInboxPort;
  inboxRelay: string;
  market: ExactMarket;
}

export interface BrowserInboxPort
  extends InboxRelayPort, TradeSubscriptionRelayPort {}

export async function createBrowserTradeRuntime(
  input: CreateBrowserTradeRuntimeInput
): Promise<BrowserTradeRuntime> {
  const now = input.now ?? (() => Math.floor(Date.now() / 1_000));
  const currentTime = now();
  if (!Number.isSafeInteger(currentTime) || currentTime < 0) {
    throw new Error("Trade runtime clock must be a non-negative Unix timestamp");
  }
  const inboxRelay = input.inboxRelay
    ?? (input.config.inboxRelay.length > 0 ? input.config.inboxRelay : TRADE_INBOX_RELAY);
  const discoveryRelays = input.discoveryRelays ?? input.config.discoveryRelays;
  const inboxPort = input.inboxPort ?? new NostrToolsInboxRelayPort();
  const chainId = String(input.config.chainId);
  const market: ExactMarket = {
    chainId,
    baseToken: ZNN_ZTS,
    quoteToken: QSR_ZTS
  };
  const probe = await probeTradeInboxRelay({
    relay: inboxRelay,
    port: inboxPort,
    now: currentTime,
    ...(input.generateSecretKey
      ? { generateSecretKey: input.generateSecretKey }
      : {})
  });
  const transport = new NostrTradeTransport(
    inboxPort,
    discoveryRelays,
    [inboxRelay],
    now,
    [probe]
  );
  const sessions = new TradeSessionRepository(
    input.driver,
    (action) => withTradeSessionStorageLock(input.profile, action)
  );
  const reservations = new FundsReservationRepository(input.driver);
  const chain = new ZenonTradeClient({
    node: input.node,
    signer: input.signer,
    decodeUnlock: input.decodeUnlock ?? sdkUnlockDecoder,
    decodeReclaim: input.decodeReclaim ?? sdkReclaimDecoder,
    now,
    scanPages: input.config.htlcScanPages,
    pageSize: input.config.htlcPageSize
  });
  const effects = new ZwapCoordinatorEffects({
    orderApi: input.orderApi,
    orderOutbox: input.orderOutbox,
    orderReader: input.orderService,
    nostr: transport,
    chain,
    node: input.node,
    reservations,
    makerIdentity: input.makerIdentity,
    discoveryRelays,
    withAccountLock: (action) => withAccountLock(input.profile, action),
    network: deploymentFor(chainId)
  });
  const coordinator = new TradeCoordinator({
    repository: sessions,
    effects,
    now,
    runSessionExclusive: (sessionId, action) =>
      withTradeSessionLock(input.profile, sessionId, action)
  });
  return {
    api: new TradeApi({
      coordinator,
      orders: input.orderService,
      chain: input.node,
      reservations,
      localAddress: () => input.signer.address(),
      sessions,
      market,
      now,
      shortLockSeconds: input.config.shortLockSeconds,
      longLockSeconds: input.config.longLockSeconds
    }),
    sessions,
    transport,
    inboxPort,
    inboxRelay,
    market
  };
}
