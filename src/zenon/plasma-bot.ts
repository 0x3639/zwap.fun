export type PlasmaTier = "low" | "medium" | "high";

export interface FuseResult {
  txHash: string;
  amount: number;
  tier: PlasmaTier;
}

export type PlasmaBotErrorCode =
  | "rate_limited"
  | "validation"
  | "unavailable"
  | "active_fusion";

export class PlasmaBotError extends Error {
  constructor(readonly code: PlasmaBotErrorCode, message: string) {
    super(message);
    this.name = "PlasmaBotError";
  }
}

interface PlasmaBotResponseBody {
  success?: boolean;
  txHash?: string;
  amount?: number;
  tier?: PlasmaTier;
  error?: { code?: string; message?: string };
}

/**
 * Asks the community plasma bot to fuse QSR for `address`. The bot is a public
 * courtesy service, so every failure mode is classified rather than thrown
 * raw: the UI needs to tell "wait a day" apart from "try another node".
 */
export async function fusePlasma(
  baseUrl: string,
  address: string,
  tier: PlasmaTier,
  fetchImpl: typeof fetch = fetch
): Promise<FuseResult> {
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}/api/agent/fuse`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address, tier })
    });
  } catch (error) {
    throw new PlasmaBotError(
      "unavailable",
      `Plasma bot unreachable: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const body = (await response.json().catch(() => ({}))) as PlasmaBotResponseBody;
  if (response.status === 429) {
    throw new PlasmaBotError(
      "rate_limited",
      body.error?.message ?? "Plasma bot rate limit reached (10 per day per IP)"
    );
  }
  if (!response.ok || body.success !== true) {
    const message = body.error?.message ?? `Plasma bot returned ${response.status}`;
    if (/active fusion/i.test(message)) throw new PlasmaBotError("active_fusion", message);
    if (body.error?.code === "VALIDATION_FAILED") {
      throw new PlasmaBotError("validation", message);
    }
    throw new PlasmaBotError("unavailable", message);
  }
  return { txHash: body.txHash ?? "", amount: body.amount ?? 0, tier: body.tier ?? tier };
}
