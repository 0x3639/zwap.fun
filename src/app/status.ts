import { nip19 } from "nostr-tools";

import {
  renderActivityLog,
  type ActivityDetail,
  type ActivityEntry
} from "../ui/activity-log.js";

export interface StatusElements {
  status: HTMLElement;
  activity: HTMLOListElement;
}

export interface StatusSurface {
  showStatus: (message: string, error: boolean) => void;
  blockTrading: (message: string) => void;
  disableRetryActions: () => void;
  clearStatus: () => void;
  report: (message: string, error?: boolean) => void;
  blockedReason: () => string | undefined;
  unavailable: () => string;
  log: (message: string) => void;
  trace: (label: string, title: string, details?: ActivityDetail[]) => void;
}

export function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

export function shortIdentifier(value: string): ActivityDetail {
  return { label: "id", value: `${value.slice(0, 8)}…`, title: value };
}

export function publicNpub(label: string, pubkey: string): ActivityDetail {
  const npub = nip19.npubEncode(pubkey);
  return { label, value: `${npub.slice(0, 12)}…${npub.slice(-8)}`, title: npub };
}

/**
 * The `#status` bar and the activity log: the two surfaces that speak for every
 * other one. `blockedReason` is the page's single source of truth for "nothing
 * can be signed", so it is read back out rather than duplicated.
 */
export function createStatusSurface(elements: StatusElements): StatusSurface {
  const { status, activity } = elements;
  const activityEntries: ActivityEntry[] = [];
  let blockedReason: string | undefined;

  function showStatus(message: string, error: boolean): void {
    status.textContent = message;
    status.classList.toggle("error", error);
    status.classList.add("visible");
  }

  /**
   * A permanent banner. The page still renders — the order book and the local
   * trade journal are readable without a node — but nothing that signs or reads
   * chain state can run, so the message must not be scrolled away by a later
   * transient report.
   */
  function blockTrading(message: string): void {
    blockedReason = message;
    showStatus(message, true);
    document.documentElement.dataset.zwapChain = "unavailable";
    // Erasing this browser's zwap data stays reachable: it needs no node, and a
    // user who cannot reach one must still be able to get out.
    for (const node of document.querySelectorAll<HTMLButtonElement>(
      "#order-form button[type=submit], #refresh"
    )) {
      node.disabled = true;
    }
    disableRetryActions();
  }

  /**
   * Retry is wired on every outbox paint whether or not a node is reachable, so
   * it has to be disabled after the fact. Take and Cancel need no equivalent:
   * `refreshOrderBook` stops passing their handlers while blocked, so the
   * buttons are never rendered — which also leaves the show-more toggle usable.
   */
  function disableRetryActions(): void {
    for (const node of document.querySelectorAll<HTMLButtonElement>(
      "#pending-publications button"
    )) {
      node.disabled = true;
      node.title = blockedReason ?? "";
    }
  }

  function clearStatus(): void {
    if (blockedReason !== undefined) return;
    status.classList.remove("visible");
  }

  function report(message: string, error = false): void {
    if (blockedReason !== undefined) {
      // The banner owns `#status` while trading is blocked, but a swallowed
      // error is worse than a crowded status bar: keep it findable.
      console.warn(`[zwap] suppressed while blocked: ${message}`);
      trace(error ? "Error" : "Activity", message, [
        { label: "suppressed by", value: blockedReason }
      ]);
      return;
    }
    showStatus(message, error);
    window.setTimeout(clearStatus, 5000);
  }

  function log(message: string): void {
    trace("Activity", message);
  }

  function trace(label: string, title: string, details: ActivityDetail[] = []): void {
    activityEntries.unshift({ at: Date.now(), label, title, details });
    activityEntries.splice(100);
    renderActivityLog(activity, activityEntries);
  }

  function unavailable(): string {
    return blockedReason ?? "The Zenon node is unavailable";
  }

  return {
    showStatus,
    blockTrading,
    disableRetryActions,
    clearStatus,
    report,
    blockedReason: () => blockedReason,
    unavailable,
    log,
    trace
  };
}
