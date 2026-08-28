import { OrderApi } from "../src/api/order-api.js";
import { MakerIdentity } from "../src/nostr/identity.js";
import { PUBLIC_RELAYS, RelayClient, type RelayReadback } from "../src/nostr/relay.js";
import { humanPriceToPrice } from "../src/order/human-price.js";
import { NostrOrderService } from "../src/order/service.js";
import { OrderOutboxRepository } from "../src/storage/order-outbox.js";
import { MemoryStorageDriver } from "../src/storage/wallet-repository.js";

// QSR uses 8 decimal places, matching the sat-scale price convention.
const QUOTE_DECIMALS = 8;

interface SeedOrder {
  label: string;
  side: "buy" | "sell";
  amount: string;
  qsrPerZnn: string;
}

const seeds: SeedOrder[] = [
  { label: "ask-1.05", side: "sell", amount: "2000", qsrPerZnn: "1.05" },
  { label: "ask-1.10", side: "sell", amount: "1000", qsrPerZnn: "1.10" },
  { label: "ask-1.20", side: "sell", amount: "1000", qsrPerZnn: "1.20" },
  { label: "bid-0.95", side: "buy", amount: "2000", qsrPerZnn: "0.95" },
  { label: "bid-0.90", side: "buy", amount: "1000", qsrPerZnn: "0.90" },
  { label: "bid-0.80", side: "buy", amount: "1000", qsrPerZnn: "0.80" }
];

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function confirmedReadback(
  client: RelayClient,
  event: Parameters<RelayClient["readback"]>[0]
): Promise<RelayReadback[]> {
  let result: RelayReadback[] = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await sleep(750 * (attempt + 1));
    result = await client.readback(event);
    if (result.some((receipt) => receipt.found)) return result;
  }
  throw new Error(`Event ${event.id} did not read back from a configured relay`);
}

const relayClient = new RelayClient({ maxWait: 8_000 });
const startedAt = new Date().toISOString();
const publications = [];

try {
  for (const seed of seeds) {
    const driver = new MemoryStorageDriver();
    const identity = new MakerIdentity(driver);
    const service = new NostrOrderService(identity, relayClient);
    const api = new OrderApi(
      identity,
      service,
      undefined,
      () => crypto.randomUUID(),
      new OrderOutboxRepository(driver)
    );
    const result = await api.publishOrder({
      side: seed.side,
      amount: seed.amount,
      price: humanPriceToPrice(seed.qsrPerZnn, QUOTE_DECIMALS),
      execution: "all_or_none"
    });
    const projectionReadback = await confirmedReadback(relayClient, servicePublicationEvent(
      result.projectionId,
      result.makerPubkey,
      30078
    ));
    publications.push({
      ...seed,
      orderId: result.orderId,
      makerPubkey: result.makerPubkey,
      projectionId: result.projectionId,
      revision: result.revision,
      receipts: result.receipts,
      projectionReadback
    });
  }
} finally {
  relayClient.dispose();
}

console.log(JSON.stringify({
  schema: "granola/order-publication-trace/v1",
  startedAt,
  completedAt: new Date().toISOString(),
  relays: PUBLIC_RELAYS,
  acknowledgementsRequired: 1,
  publications
}, null, 2));

function servicePublicationEvent(id: string, pubkey: string, kind: number) {
  return { id, pubkey, kind };
}
