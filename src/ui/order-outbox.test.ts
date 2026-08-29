import { describe, expect, it, vi } from "vitest";

import type { PublicOrderPublication } from "../api/order-api.js";
import { renderPendingPublications } from "./order-outbox.js";

const pending: PublicOrderPublication = {
  orderId: "11111111-1111-4111-8111-111111111111",
  makerPubkey: "a".repeat(64),
  projectionId: "c".repeat(64),
  revision: "0",
  receipts: [
    { relay: "wss://one.example", ok: true, message: "stored" },
    { relay: "wss://two.example", ok: false, message: "blocked" }
  ]
};

describe("pending order publications", () => {
  it("renders an actionable, secret-free retry without hiding partial success", () => {
    const root = document.createElement("section");
    const retry = vi.fn();

    renderPendingPublications(root, [pending], retry, 2);

    expect(root.hidden).toBe(false);
    expect(root.textContent).toContain("1/2 relay acknowledgements · sufficient");
    expect(root.textContent).toContain("11111111…11111111");
    expect(root.textContent).not.toContain(pending.makerPubkey);
    root.querySelector("button")?.click();
    expect(retry).toHaveBeenCalledWith(pending.orderId, expect.any(HTMLButtonElement));
  });

  it("hides the outbox when no retry is pending", () => {
    const root = document.createElement("section");
    renderPendingPublications(root, [], () => undefined, 3);
    expect(root.hidden).toBe(true);
    expect(root.textContent).toBe("");
  });
  it("counts the relays the caller actually attempted, not a fixed three", () => {
    const root = document.createElement("section");

    renderPendingPublications(root, [pending], vi.fn(), 5);

    expect(root.textContent).toContain("1/5 relay acknowledgements");
    expect(root.textContent).not.toContain("1/3");
  });
});
