import { describe, expect, it, vi } from "vitest";

import {
  beginButtonFeedback,
  endButtonFeedback,
  withButtonFeedback
} from "./button-feedback.js";

function button(html = "<span data-button-label>Take</span>"): HTMLButtonElement {
  const node = document.createElement("button");
  node.innerHTML = html;
  return node;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("button feedback", () => {
  it("marks the button busy and restores it exactly", async () => {
    const node = button();
    const idle = node.innerHTML;

    await withButtonFeedback(node, "Settling…", async () => {
      expect(node.disabled).toBe(true);
      expect(node.getAttribute("aria-busy")).toBe("true");
      expect(node.textContent).toBe("Settling…");
    });

    expect(node.innerHTML).toBe(idle);
    expect(node.disabled).toBe(false);
    expect(node.hasAttribute("aria-busy")).toBe(false);
    expect(node.dataset.busy).toBeUndefined();
  });

  it("reports whether it actually claimed the button", () => {
    const node = button();

    expect(beginButtonFeedback(node, "Settling…")).toBe(true);
    expect(beginButtonFeedback(node, "Settling again…")).toBe(false);
    expect(node.textContent).toBe("Settling…");

    endButtonFeedback(node);
    expect(beginButtonFeedback(node, "Settling…")).toBe(true);
  });

  it("refuses an overlapping run instead of ending the first one early", async () => {
    // The second run used to no-op its begin, then re-enable the button in its
    // own finally - restoring the idle label while the first task was still
    // in flight, and inviting a second click on a live action.
    const node = button();
    const first = deferred();
    const secondTask = vi.fn(async () => undefined);

    const running = withButtonFeedback(node, "Settling…", () => first.promise);
    await expect(withButtonFeedback(node, "Retrying…", secondTask))
      .rejects.toThrow("This action is already running");

    expect(secondTask).not.toHaveBeenCalled();
    expect(node.disabled).toBe(true);
    expect(node.textContent).toBe("Settling…");

    first.resolve();
    await running;
    expect(node.disabled).toBe(false);
    expect(node.textContent).toBe("Take");
  });

  it("releases the button when the task throws", async () => {
    const node = button();

    await expect(withButtonFeedback(node, "Settling…", async () => {
      throw new Error("relay refused");
    })).rejects.toThrow("relay refused");

    expect(node.disabled).toBe(false);
    expect(node.textContent).toBe("Take");
    await expect(withButtonFeedback(node, "Settling…", async () => "ok"))
      .resolves.toBe("ok");
  });

  it("falls back to the whole button when there is no label slot", async () => {
    const node = button("Refresh");

    const running = withButtonFeedback(node, "Refreshing…", () => new Promise<void>(() => {}));
    void running.catch(() => undefined);

    expect(node.textContent).toBe("Refreshing…");
  });
});
