import { describe, expect, it } from "vitest";

import { renderSeedDialog, showSeedDialog } from "./seed-dialog.js";

const MNEMONIC =
  "legal winner thank year wave sausage worth useful legal winner thank yellow";

describe("seed dialog", () => {
  it("renders every word in order, numbered and mono", () => {
    const dialog = renderSeedDialog(MNEMONIC);

    const words = [...dialog.querySelectorAll("li")].map((item) => item.textContent);
    expect(words).toEqual(MNEMONIC.split(" "));
    expect(dialog.querySelector("ol")?.className).toContain("font-mono");
    expect(dialog.textContent).toContain("Anyone who reads these words controls this wallet");
  });

  it("removes the seed from the DOM when closed", () => {
    const root = document.createElement("div");
    document.body.append(root);

    const dialog = showSeedDialog(root, MNEMONIC);
    expect(root.contains(dialog)).toBe(true);

    dialog.querySelector<HTMLButtonElement>("[data-seed-close]")?.click();

    expect(root.contains(dialog)).toBe(false);
    expect(root.textContent).not.toContain("winner");
    root.remove();
  });
});
