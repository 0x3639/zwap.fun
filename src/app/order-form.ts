import type { OrderApi, PublishOrderInput } from "../api/order-api.js";
import { withButtonFeedback } from "../ui/button-feedback.js";
import {
  describeSettlement,
  orderFormToPublishInput
} from "../ui/order-form.js";
import type { TokenLookup } from "../ui/tokens.js";
import {
  messageOf,
  publicNpub,
  shortIdentifier,
  type StatusSurface
} from "./status.js";

export interface OrderFormElements {
  orderForm: HTMLFormElement;
  orderSettlementHint: HTMLElement;
}

export interface OrderFormInput {
  elements: OrderFormElements;
  status: StatusSurface;
  tokens: () => TokenLookup;
  publishOrder: OrderApi["publishOrder"];
  refreshOrderBook: () => Promise<void>;
  refreshPendingPublications: () => Promise<void>;
}

/**
 * The publish form: the live settlement hint under it and the one submit that
 * signs an order. Everything it reaches for afterwards — the order book, the
 * relay outbox — is handed in, so the form owns nothing but its own inputs.
 */
export function mountOrderForm(input: OrderFormInput): void {
  const { orderForm, orderSettlementHint } = input.elements;
  const { report, trace } = input.status;
  const tokens = input.tokens;

  function requiredOrderInput(name: string): HTMLInputElement {
    const field = orderForm.querySelector<HTMLInputElement>(`input[name="${name}"]`);
    if (field === null) throw new Error(`Missing order input ${name}`);
    return field;
  }
  const orderAmountInput = requiredOrderInput("amount");
  const orderPriceInput = requiredOrderInput("price");
  const orderSubmitButton = orderForm.querySelector<HTMLButtonElement>("button[type=submit]");
  if (orderSubmitButton === null) throw new Error("Missing order submit button");

  const defaultOrderSettlementHint = orderSettlementHint.textContent ?? "";

  function updateOrderSettlementHint(): void {
    orderAmountInput.setCustomValidity("");
    // `null` while the form is mid-edit: the default copy is honest, a stale
    // number would not be. Native patterns and the submit handler own the error.
    orderSettlementHint.textContent =
      describeSettlement(orderAmountInput.value.trim(), orderPriceInput.value.trim(), tokens()) ??
      defaultOrderSettlementHint;
  }

  orderAmountInput.addEventListener("input", () => updateOrderSettlementHint());
  orderPriceInput.addEventListener("input", () => updateOrderSettlementHint());
  orderAmountInput.addEventListener("change", () => updateOrderSettlementHint());
  orderPriceInput.addEventListener("change", () => updateOrderSettlementHint());
  orderAmountInput.addEventListener("invalid", () => {
    if (orderAmountInput.validationMessage.length > 0) {
      report(orderAmountInput.validationMessage, true);
    }
  });
  updateOrderSettlementHint();

  orderForm.addEventListener("submit", (event) => {
    event.preventDefault();
    updateOrderSettlementHint();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    void withButtonFeedback(orderSubmitButton, "Posting…", async () => {
      // One pure conversion from what was typed to what gets signed; the same
      // token decimals drive it and the settlement hint above.
      const order: PublishOrderInput = orderFormToPublishInput(
        {
          side: String(form.get("side")),
          amount: String(form.get("amount")),
          price: String(form.get("price")),
          hours: String(form.get("hours"))
        },
        tokens(),
        Math.floor(Date.now() / 1000)
      );
      const side = order.side;
      const publication = await input.publishOrder(order);
      const acknowledgements = publication.receipts.filter((receipt) => receipt.ok).length;
      trace("Order", "Public order published", [
        { label: "side", value: side },
        shortIdentifier(publication.orderId),
        shortIdentifier(publication.projectionId),
        { label: "revision", value: publication.revision },
        publicNpub("order npub", publication.makerPubkey),
        { label: "relay acks", value: String(acknowledgements) }
      ]);
      await Promise.all([input.refreshOrderBook(), input.refreshPendingPublications()]);
      report(`Order published with ${acknowledgements} relay acknowledgements`);
    }).catch(async (error: unknown) => {
      await input.refreshPendingPublications();
      report(messageOf(error), true);
    });
  });
}
