import { icon } from "./icons.js";

/**
 * The seed is the whole wallet, so it never goes into the status toast or the
 * activity log — it gets its own modal that is destroyed on close, and the
 * words are numbered so they can be copied onto paper without a miscount.
 */
export function renderSeedDialog(mnemonic: string): HTMLDialogElement {
  const dialog = document.createElement("dialog");
  dialog.className = "seed-dialog";
  dialog.dataset.seedDialog = "true";
  dialog.setAttribute("aria-labelledby", "seed-dialog-title");

  const header = document.createElement("header");
  const eyebrow = document.createElement("p");
  eyebrow.className = "text-ledger";
  eyebrow.textContent = "Custody";
  const title = document.createElement("h3");
  title.id = "seed-dialog-title";
  title.textContent = "Your seed phrase";
  header.append(eyebrow, title);

  const warning = document.createElement("p");
  warning.className = "seed-dialog__warning";
  warning.append(
    icon("shield"),
    document.createTextNode(
      "Anyone who reads these words controls this wallet. Write them down offline and close this."
    )
  );

  const words = document.createElement("ol");
  words.className = "seed-dialog__words font-mono";
  for (const word of mnemonic.split(/\s+/).filter((part) => part.length > 0)) {
    const item = document.createElement("li");
    item.textContent = word;
    words.append(item);
  }

  const close = document.createElement("button");
  close.type = "button";
  close.className = "nom-btn nom-btn--outline seed-dialog__close";
  close.dataset.seedClose = "true";
  close.textContent = "Close";
  close.addEventListener("click", () => {
    if (typeof dialog.close === "function") dialog.close();
    dialog.remove();
  });

  dialog.append(header, warning, words, close);
  return dialog;
}

/** Opens the dialog, wiring it so closing it removes the seed from the DOM. */
export function showSeedDialog(root: HTMLElement, mnemonic: string): HTMLDialogElement {
  const dialog = renderSeedDialog(mnemonic);
  dialog.addEventListener("close", () => dialog.remove());
  root.append(dialog);
  if (typeof dialog.showModal === "function") {
    dialog.showModal();
  } else {
    dialog.setAttribute("open", "");
  }
  return dialog;
}
