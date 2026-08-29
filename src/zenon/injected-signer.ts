import type { SendReceipt, ZenonSigner, ZenonTemplate } from "./types.js";
import { isHex32, isZenonAddress } from "./validate.js";

/**
 * The page half of the Zenon injected-provider protocol proposed in
 * `docs/proposals/zenon-injected-provider.md`. zwap never sees a key here: the
 * extension owns the seed, fills in address/height/previousHash, decides
 * plasma vs proof of work, signs and publishes. This module only speaks the
 * wire protocol and adapts it to the same `ZenonSigner` the keystore
 * implements, so the trade runtime cannot tell the two apart.
 */

/** EIP-6963-style discovery events. */
export const PROVIDER_ANNOUNCE_EVENT = "zenon:announceProvider";
export const PROVIDER_REQUEST_EVENT = "zenon:requestProvider";

/** How long discovery waits for a wallet to answer before giving up. */
export const DEFAULT_DETECT_TIMEOUT_MS = 300;

export interface ZenonProviderInfo {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
}

export interface ZenonProvider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, handler: (payload: unknown) => void): void;
  removeListener?(event: string, handler: (payload: unknown) => void): void;
}

export interface DetectedProvider {
  /** `null` when the wallet was found through the `window.zenon` fallback. */
  info: ZenonProviderInfo | null;
  provider: ZenonProvider;
}

/** JSON-RPC-style error codes this client raises or forwards. */
export const PROVIDER_ERROR = {
  userRejected: 4001,
  unauthorized: 4100,
  unsupportedMethod: 4200,
  disconnected: 4900,
  chainMismatch: 4901,
  invalidParams: -32602,
  internal: -32603
} as const;

export class InjectedProviderError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown
  ) {
    super(message);
    this.name = "InjectedProviderError";
  }
}

function isProvider(value: unknown): value is ZenonProvider {
  return typeof value === "object"
    && value !== null
    && typeof (value as { request?: unknown }).request === "function";
}

function readProviderInfo(value: unknown): ZenonProviderInfo | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  const fields = ["uuid", "name", "icon", "rdns"] as const;
  for (const field of fields) {
    if (typeof candidate[field] !== "string" || candidate[field] === "") return null;
  }
  return {
    uuid: candidate["uuid"] as string,
    name: candidate["name"] as string,
    icon: candidate["icon"] as string,
    rdns: candidate["rdns"] as string
  };
}

function readAnnouncement(event: Event): DetectedProvider | null {
  const detail = (event as CustomEvent<unknown>).detail;
  if (typeof detail !== "object" || detail === null) return null;
  const provider = (detail as { provider?: unknown }).provider;
  if (!isProvider(provider)) return null;
  return { info: readProviderInfo((detail as { info?: unknown }).info), provider };
}

/**
 * Announces first, `window.zenon` second. A conforming wallet answers
 * `zenon:requestProvider` synchronously, so the common case costs nothing; the
 * timeout only runs for a page with no wallet, where it resolves `null` and
 * the keystore stays in charge.
 */
export function detectInjectedProvider(
  win: Window & { zenon?: ZenonProvider },
  timeoutMs: number = DEFAULT_DETECT_TIMEOUT_MS
): Promise<DetectedProvider | null> {
  return new Promise<DetectedProvider | null>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAnnounce = (event: Event): void => {
      const detected = readAnnouncement(event);
      if (detected !== null) finish(detected);
    };
    function finish(result: DetectedProvider | null): void {
      if (settled) return;
      settled = true;
      win.removeEventListener(PROVIDER_ANNOUNCE_EVENT, onAnnounce);
      if (timer !== undefined) clearTimeout(timer);
      resolve(result);
    }

    win.addEventListener(PROVIDER_ANNOUNCE_EVENT, onAnnounce);
    win.dispatchEvent(new CustomEvent(PROVIDER_REQUEST_EVENT));
    if (settled) return;

    const legacy = win.zenon;
    if (isProvider(legacy)) {
      finish({ info: null, provider: legacy });
      return;
    }
    timer = setTimeout(() => finish(null), timeoutMs);
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The extension is a foreign process: whatever it throws is data, not a
 * trusted `Error`. A well-formed `{ code, message }` keeps its code so the UI
 * can tell a user rejection from a node failure; anything else is internal.
 */
function asProviderError(error: unknown): InjectedProviderError {
  if (error instanceof InjectedProviderError) return error;
  if (typeof error === "object" && error !== null) {
    const shape = error as { code?: unknown; message?: unknown; data?: unknown };
    if (typeof shape.code === "number" && Number.isInteger(shape.code)) {
      const message = typeof shape.message === "string" && shape.message !== ""
        ? shape.message
        : `Wallet error ${shape.code}`;
      return shape.data === undefined
        ? new InjectedProviderError(shape.code, message)
        : new InjectedProviderError(shape.code, message, shape.data);
    }
  }
  return new InjectedProviderError(PROVIDER_ERROR.internal, messageOf(error));
}

async function call(
  provider: ZenonProvider,
  method: string,
  params?: unknown[]
): Promise<unknown> {
  try {
    return await provider.request(params === undefined ? { method } : { method, params });
  } catch (error) {
    throw asProviderError(error);
  }
}

function addressList(value: unknown): string[] {
  return Array.isArray(value) && value.every(isZenonAddress) ? [...value] : [];
}

/**
 * A `ZenonSigner` backed by a browser-extension wallet. Sends are serialized
 * per instance exactly as `KeystoreSigner` serializes them: the extension
 * builds each block on the account-chain height the previous one produced, so
 * two in-flight blocks would race the same frontier.
 */
export class InjectedZenonSigner implements ZenonSigner {
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly provider: ZenonProvider,
    private readonly account: string
  ) {}

  static async connect(
    provider: ZenonProvider,
    expectedChainId: number
  ): Promise<InjectedZenonSigner> {
    const chainId = await call(provider, "zenon_chainId");
    if (chainId !== expectedChainId) {
      throw new InjectedProviderError(
        PROVIDER_ERROR.chainMismatch,
        `The extension wallet is on chain ${String(chainId)}; zwap is on chain ${expectedChainId}`
      );
    }
    const accounts = addressList(await call(provider, "zenon_requestAccounts"));
    const address = accounts[0];
    if (address === undefined) {
      throw new InjectedProviderError(
        PROVIDER_ERROR.unauthorized,
        "The extension wallet authorized no Zenon address for this site"
      );
    }
    return new InjectedZenonSigner(provider, address);
  }

  address(): string {
    return this.account;
  }

  send(template: ZenonTemplate): Promise<SendReceipt> {
    const run = this.queue.then(async () => {
      const published = await call(this.provider, "zenon_sendBlock", [{ template }]);
      const hash = typeof published === "object" && published !== null
        ? (published as { hash?: unknown }).hash
        : undefined;
      if (!isHex32(hash)) {
        throw new InjectedProviderError(
          PROVIDER_ERROR.internal,
          "The extension wallet returned no published block hash"
        );
      }
      return { blockHash: hash };
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * The user can switch accounts in the extension at any time. Payloads that
   * are not a list of canonical addresses are dropped rather than forwarded —
   * the page must never render an address the wallet did not actually vouch
   * for.
   */
  onAccountsChanged(handler: (accounts: string[]) => void): void {
    this.provider.on?.("accountsChanged", (payload) => {
      if (!Array.isArray(payload) || !payload.every(isZenonAddress)) return;
      handler([...payload]);
    });
  }
}
