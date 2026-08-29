/**
 * Marks a button busy.
 *
 * Returns `false` when it already was, so the caller can decline to start a
 * second run rather than silently sharing one button's busy state between two
 * overlapping actions - whichever finished first would re-enable the button
 * and restore the other one's stale label.
 */
export function beginButtonFeedback(
  button: HTMLButtonElement,
  busyLabel: string
): boolean {
  if (button.dataset.busy === "true") return false;
  button.dataset.idleHtml = button.innerHTML;
  button.dataset.busy = "true";
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  const label = button.querySelector<HTMLElement>("[data-button-label]");
  if (label) {
    label.textContent = busyLabel;
  } else {
    button.textContent = busyLabel;
  }
  return true;
}

export function endButtonFeedback(button: HTMLButtonElement): void {
  const idleHtml = button.dataset.idleHtml;
  if (idleHtml !== undefined) button.innerHTML = idleHtml;
  delete button.dataset.idleHtml;
  delete button.dataset.busy;
  button.removeAttribute("aria-busy");
  button.disabled = false;
}

export async function withButtonFeedback<T>(
  button: HTMLButtonElement,
  busyLabel: string,
  task: () => Promise<T>
): Promise<T> {
  if (!beginButtonFeedback(button, busyLabel)) {
    throw new Error("This action is already running");
  }
  try {
    return await task();
  } finally {
    endButtonFeedback(button);
  }
}
