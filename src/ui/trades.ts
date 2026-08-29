import { nip19 } from "nostr-tools";

import type { TradeMessageType } from "../trade/messages.js";
import type {
  PublicTradeView,
  TradeLegEvidence
} from "../trade/session.js";
import { formatPrice, renderTokenAmount, truncateAddress, truncateHash } from "./format.js";
import { defaultTokens, type TokenLookup } from "./tokens.js";

export interface TradeRenderOptions {
  /** Symbols and decimals observed on chain; falls back to ZNN/QSR. */
  tokens?: TokenLookup;
}

function element<K extends keyof HTMLElementTagNameMap>(
  name: K,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(name);
  if (text !== undefined) node.textContent = text;
  return node;
}

function phaseLabel(phase: PublicTradeView["phase"]): string {
  return phase.split("_").map((part, index) =>
    index === 0 ? `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}` : part
  ).join(" ");
}

type LegStatus = {
  label: string;
  variant: "pending" | "success" | "warning";
};

/**
 * A leg that carries a refund operation is refunded, whatever the last
 * observed lock state says: the effects loop stops re-observing a leg once it
 * has been reclaimed, so `htlcState` can still read LOCKED forever after.
 */
export function legStatus(leg: TradeLegEvidence): LegStatus {
  if (leg.refundOperationCommitment !== null) {
    return { label: "Refunded", variant: "warning" };
  }
  switch (leg.htlcState) {
    case "UNLOCKED":
      return { label: "Unlocked", variant: "success" };
    case "RECLAIMED":
      return { label: "Reclaimed", variant: "warning" };
    case "LOCKED":
      return { label: "Locked", variant: "pending" };
    default:
      return { label: "Awaiting chain", variant: "pending" };
  }
}

function statusBadge(leg: TradeLegEvidence): HTMLElement {
  const status = legStatus(leg);
  const badge = element("span", status.label);
  badge.className = `nom-badge nom-badge--${status.variant}`;
  badge.dataset.legState = status.label.toLowerCase().replace(/\s+/g, "-");
  return badge;
}

function htlcLine(leg: TradeLegEvidence): HTMLElement {
  const line = element("p");
  line.className = "trade-leg__htlc nom-address";
  const label = element("span", "HTLC");
  label.className = "text-ledger";
  const value = element("span");
  value.className = "font-mono";
  value.dataset.htlcId = leg.htlcId ?? "";
  if (leg.htlcId === null) {
    value.textContent = "not created";
  } else {
    value.textContent = truncateHash(leg.htlcId);
    value.title = leg.htlcId;
  }
  line.append(label, value);
  return line;
}

function legCard(
  label: string,
  token: string,
  amount: string,
  leg: TradeLegEvidence,
  tokens: TokenLookup
): HTMLElement {
  const info = tokens(token);
  const item = element("li");
  item.className = "trade-leg";
  item.dataset.tradeLeg = label.toLowerCase();

  const heading = element("div");
  heading.className = "trade-leg__heading";
  const caption = element("span", label);
  caption.className = "text-ledger";
  heading.append(caption, statusBadge(leg));

  const value = renderTokenAmount(amount, info.decimals, info.symbol);
  value.classList.add("trade-leg__amount");

  const standard = element("small", token);
  standard.className = "font-mono trade-leg__token";

  item.append(heading, value, standard, htlcLine(leg));
  return item;
}

function identity(label: string, value: string | null): HTMLElement {
  const item = element("li");
  const caption = element("span", label);
  caption.className = "text-ledger";
  item.append(caption);
  if (value === null) {
    item.append(element("strong", "Waiting for authenticated session"));
    return item;
  }
  const npub = nip19.npubEncode(value);
  const rendered = element("strong", truncateAddress(npub));
  rendered.className = "font-mono";
  rendered.title = npub;
  item.append(rendered);
  return item;
}

const MESSAGE_COPY: Record<TradeMessageType, {
  title: string;
  meaning: string;
}> = {
  reserve_propose: {
    title: "Order taken",
    meaning: "The taker commits to this exact order, amount, and settlement identity."
  },
  reserve_accept: {
    title: "Accepted · offer locked",
    meaning: "The maker accepts and names the Zenon HTLC that locks the offered token."
  },
  reserve_reject: {
    title: "Reservation rejected",
    meaning: "The maker declines the reservation request."
  },
  session_ack: {
    title: "Session acknowledged",
    meaning: "The taker confirms the private settlement session and its terms."
  },
  base_lock: {
    title: "Base locked",
    meaning: "The base-side HTLC is created on Zenon and its commitment is shared."
  },
  base_lock_ack: {
    title: "Base lock verified",
    meaning: "The counterparty verifies the base-side lock against chain state."
  },
  quote_lock: {
    title: "Payment locked",
    meaning: "The taker creates the matching quote HTLC. The chain now drives " +
      "settlement — an unlock on the quote HTLC reveals the preimage."
  },
  quote_lock_ack: {
    title: "Quote lock verified",
    meaning: "The counterparty verifies the quote-side lock against chain state."
  },
  claim_notice: {
    title: "Unlock observed",
    meaning: "A verified chain observation proves that one leg of the swap was unlocked."
  },
  ack: {
    title: "Message acknowledged",
    meaning: "The counterparty confirms receipt of the preceding protocol message."
  },
  abort: {
    title: "Swap aborted",
    meaning: "The session requests the protocol-safe abort and reclaim path."
  },
  fill_request: {
    title: "Fill requested",
    meaning: "The completed private settlement requests the public order fill."
  },
  settlement_ack: {
    title: "Settlement complete",
    meaning: "The counterparty confirms that the atomic swap settled."
  },
  refund: {
    title: "Reclaim observed",
    meaning: "A timed-out settlement leg was safely reclaimed by its creator."
  },
  error: {
    title: "Protocol error",
    meaning: "The counterparty reports a protocol validation or settlement error."
  }
};

function fullNpub(value: string | undefined): string {
  if (value === undefined || !/^[0-9a-f]{64}$/.test(value)) {
    return "Unavailable";
  }
  return nip19.npubEncode(value);
}

function technicalValue(label: string, value: string): HTMLElement {
  const row = element("div");
  const term = element("dt", label);
  term.className = "text-ledger";
  const detail = element("dd", value);
  detail.className = "font-mono";
  row.append(term, detail);
  return row;
}

function messageDirection(
  trade: PublicTradeView,
  authorPubkey: string | undefined,
  recipientPubkey: string | undefined
): string {
  if (
    trade.protocol.localNostrPubkey !== null &&
    authorPubkey === trade.protocol.localNostrPubkey
  ) return "Sent by you";
  if (
    trade.protocol.localNostrPubkey !== null &&
    recipientPubkey === trade.protocol.localNostrPubkey
  ) return "Received by you";
  return "Authenticated private message";
}

function messageTranscript(trade: PublicTradeView): HTMLOListElement {
  const transcript = element("ol");
  transcript.className = "trade-dm-list";
  for (const message of trade.protocol.messages) {
    const copy = message.type === undefined
      ? {
          title: "Private protocol message",
          meaning: "An authenticated legacy protocol message was accepted."
        }
      : MESSAGE_COPY[message.type];
    const item = element("li");
    item.className = "trade-dm";

    const heading = element("div");
    heading.className = "trade-dm__heading";
    const sequence = element("span", `DM ${message.sequence}`);
    sequence.className = "text-ledger";
    heading.append(sequence);
    heading.append(element(
      "small",
      messageDirection(trade, message.authorPubkey, message.recipientPubkey)
    ));
    item.append(heading);
    item.append(element("h4", copy.title));
    item.append(element("p", copy.meaning));

    const envelope = element("details");
    envelope.className = "trade-dm__envelope";
    envelope.append(element("summary", "Read technical envelope"));
    const values = element("dl");
    values.append(
      technicalValue("From", fullNpub(message.authorPubkey)),
      technicalValue("To", fullNpub(message.recipientPubkey)),
      technicalValue("Message ID", message.messageId),
      technicalValue("Rumor ID", message.rumorId),
      technicalValue("Transcript hash", message.transcriptHash)
    );
    envelope.append(values);
    item.append(envelope);
    transcript.append(item);
  }
  return transcript;
}

function showDialog(dialog: HTMLDialogElement): void {
  if (typeof dialog.showModal === "function") {
    dialog.showModal();
  } else {
    dialog.setAttribute("open", "");
  }
}

function closeDialog(dialog: HTMLDialogElement): void {
  if (typeof dialog.close === "function") {
    dialog.close();
  } else {
    dialog.removeAttribute("open");
  }
}

function dmViewer(trade: PublicTradeView): {
  trigger: HTMLButtonElement;
  dialog: HTMLDialogElement;
} {
  const dialog = element("dialog");
  const dialogId = `trade-dms-${trade.sessionId}`;
  dialog.id = dialogId;
  dialog.className = "trade-dm-dialog";
  dialog.dataset.dmSession = trade.sessionId;
  dialog.setAttribute("aria-labelledby", `${dialogId}-title`);

  const header = element("header");
  const heading = element("div");
  const count = element("p", `${trade.protocol.messages.length} authenticated DMs`);
  count.className = "text-ledger";
  heading.append(count);
  const title = element("h3", "Private protocol transcript");
  title.id = `${dialogId}-title`;
  heading.append(title);
  const close = element("button", "Close");
  close.className = "nom-btn nom-btn--sm nom-btn--outline trade-dm-dialog__close";
  close.type = "button";
  close.addEventListener("click", () => closeDialog(dialog));
  header.append(heading, close);
  dialog.append(header);

  if (trade.protocol.messages.length === 0) {
    const empty = element("p", "No authenticated private messages have been accepted yet.");
    empty.className = "trade-dm-dialog__empty";
    dialog.append(empty);
  } else {
    dialog.append(messageTranscript(trade));
  }
  const privacy = element(
    "p",
    "Preimages, private keys, and raw signed operations are intentionally omitted."
  );
  privacy.className = "trade-dm-dialog__privacy";
  dialog.append(privacy);
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) closeDialog(dialog);
  });

  const trigger = element("button");
  trigger.type = "button";
  trigger.className = "nom-btn nom-btn--sm nom-btn--ghost trade-dms-trigger";
  trigger.setAttribute("aria-haspopup", "dialog");
  trigger.setAttribute("aria-controls", dialogId);
  const label = element("span", "DMs");
  label.className = "text-ledger";
  trigger.append(label);
  trigger.append(element("strong", `${trade.protocol.messages.length} accepted`));
  trigger.addEventListener("click", () => showDialog(dialog));

  return { trigger, dialog };
}

export function renderTrades(
  root: HTMLElement,
  trades: PublicTradeView[],
  options: TradeRenderOptions = {}
): void {
  const tokens = options.tokens ?? defaultTokens;
  root.replaceChildren();
  root.setAttribute("aria-live", "polite");
  if (trades.length === 0) {
    const empty = element("div");
    empty.className = "empty-state nom-card";
    empty.append(element("h3", "No active swap sessions"));
    empty.append(element(
      "p",
      "Take a verified order to open a hash-locked settlement session on Zenon."
    ));
    root.append(empty);
    return;
  }

  for (const trade of trades) {
    const card = element("article");
    card.className = "trade-card nom-card";
    card.dataset.tradeSession = trade.sessionId;
    card.dataset.tradeRole = trade.role;

    const heading = element("div");
    heading.className = "trade-card__heading";
    const role = element("span", `${trade.role === "maker" ? "Maker" : "Taker"} session`);
    role.className = `nom-badge nom-badge--${trade.role === "maker" ? "default" : "secondary"}`;
    role.dataset.tradeRoleBadge = trade.role;
    const reservation = element("span", truncateHash(trade.reservationId));
    reservation.className = "font-mono trade-card__reservation";
    reservation.title = trade.reservationId;
    heading.append(role, reservation);
    heading.append(element("h3", phaseLabel(trade.phase)));
    card.append(heading);

    const legs = element("ul");
    legs.className = "trade-legs";
    legs.append(legCard(
      "Base",
      trade.terms.baseToken,
      trade.terms.baseAmount,
      trade.evidence.legs.base,
      tokens
    ));
    legs.append(legCard(
      "Quote",
      trade.terms.quoteToken,
      trade.terms.quoteAmount,
      trade.evidence.legs.quote,
      tokens
    ));
    card.append(legs);

    const price = element("p", formatPrice(
      trade.terms.price,
      tokens(trade.terms.quoteToken).decimals,
      tokens(trade.terms.quoteToken).symbol,
      tokens(trade.terms.baseToken).symbol
    ));
    price.className = "trade-card__price font-mono tabular-nums";
    price.dataset.tradePrice = trade.terms.price;
    card.append(price);

    const progress = element("p", trade.evidence.chainStates.length > 0
      ? trade.evidence.chainStates.join(" · ")
      : "Waiting for verified chain state");
    progress.className = "trade-card__state font-mono";
    card.append(progress);

    const protocol = element("ul");
    protocol.className = "trade-protocol-summary";
    protocol.append(identity("Your key", trade.protocol.localNostrPubkey));
    protocol.append(identity("Counterparty", trade.protocol.counterpartyNostrPubkey));
    const messages = element("li");
    messages.className = "trade-protocol-summary__messages";
    const viewer = dmViewer(trade);
    messages.append(viewer.trigger);
    protocol.append(messages);
    card.append(protocol);
    card.append(viewer.dialog);

    root.append(card);
  }
}
