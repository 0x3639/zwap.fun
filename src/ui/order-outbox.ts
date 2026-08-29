import type { PublicOrderPublication } from "../api/order-api.js";
import { truncateHash } from "./format.js";
import { icon } from "./icons.js";

function element<K extends keyof HTMLElementTagNameMap>(
  name: K,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(name);
  if (text !== undefined) node.textContent = text;
  return node;
}

export function renderPendingPublications(
  root: HTMLElement,
  publications: PublicOrderPublication[],
  retry: (orderId: string, button: HTMLButtonElement) => void,
  /** How many relays were actually attempted - never a guess. */
  relayCount: number
): void {
  root.replaceChildren();
  root.hidden = publications.length === 0;
  if (publications.length === 0) return;

  const heading = element("p", "Pending relay publication");
  heading.className = "text-ledger";
  root.append(heading);
  const list = element("ul");
  for (const publication of publications) {
    const acknowledgements = publication.receipts.filter((receipt) => receipt.ok).length;
    const item = element("li");
    const description = element(
      "span",
      `${truncateHash(publication.orderId)} · ${acknowledgements}/${relayCount} relay acknowledgements` +
      (acknowledgements > 0 ? " · sufficient" : "")
    );
    description.className = "font-mono tabular-nums";
    const button = element("button");
    button.type = "button";
    button.className = "nom-btn nom-btn--sm nom-btn--outline";
    button.append(icon("refresh"));
    const label = element("span", "Retry same signed projection");
    label.dataset.buttonLabel = "true";
    button.append(label);
    button.addEventListener("click", () => retry(publication.orderId, button));
    item.append(description, button);
    list.append(item);
  }
  root.append(list);
}
