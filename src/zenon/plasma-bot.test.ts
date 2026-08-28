import { describe, expect, it, vi } from "vitest";

import { fusePlasma, PlasmaBotError } from "./plasma-bot.js";

const BASE_URL = "https://plasma.example";
const ADDRESS = "z1qzal6c5s9rjnnxd2z7dvdhjxpmmj4fmw56a0mz";

function respond(status: number, body: unknown): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  })) as unknown as typeof fetch;
}

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PlasmaBotError) return error.code;
    throw error;
  }
  throw new Error("Expected the plasma bot call to fail");
}

describe("fusePlasma", () => {
  it("posts the address and tier and returns the fusion receipt", async () => {
    const fetchImpl = respond(200, {
      success: true,
      txHash: "ab".repeat(32),
      amount: 20,
      tier: "low"
    });

    await expect(fusePlasma(BASE_URL, ADDRESS, "low", fetchImpl))
      .resolves.toEqual({ txHash: "ab".repeat(32), amount: 20, tier: "low" });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://plasma.example/api/agent/fuse",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address: ADDRESS, tier: "low" })
      }
    );
  });

  it("classifies an HTTP 429 as rate_limited", async () => {
    const fetchImpl = respond(429, {
      success: false,
      error: { code: "RATE_LIMITED", message: "Too many requests today" }
    });

    await expect(fusePlasma(BASE_URL, ADDRESS, "high", fetchImpl))
      .rejects.toThrow(/too many requests today/i);
    await expect(code(fusePlasma(BASE_URL, ADDRESS, "high", fetchImpl)))
      .resolves.toBe("rate_limited");
  });

  it("classifies a VALIDATION_FAILED rejection as validation", async () => {
    const fetchImpl = respond(400, {
      success: false,
      error: { code: "VALIDATION_FAILED", message: "address is not valid" }
    });

    await expect(code(fusePlasma(BASE_URL, "nope", "medium", fetchImpl)))
      .resolves.toBe("validation");
  });

  it("classifies an active-fusion conflict ahead of the generic codes", async () => {
    for (const [status, payload] of [
      [409, { success: false, error: { code: "CONFLICT", message: "An active fusion already exists" } }],
      [400, { success: false, error: { code: "VALIDATION_FAILED", message: "Active fusion for this address" } }]
    ] as const) {
      await expect(code(fusePlasma(BASE_URL, ADDRESS, "low", respond(status, payload))))
        .resolves.toBe("active_fusion");
    }
  });

  it("classifies a transport failure as unavailable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;

    await expect(code(fusePlasma(BASE_URL, ADDRESS, "low", fetchImpl)))
      .resolves.toBe("unavailable");
    await expect(fusePlasma(BASE_URL, ADDRESS, "low", fetchImpl))
      .rejects.toThrow(/plasma bot unreachable: connection refused/i);
  });

  it("treats an unparsable body or a false success flag as unavailable", async () => {
    const garbage = vi.fn(async () => new Response("<html>502</html>", {
      status: 502
    })) as unknown as typeof fetch;
    await expect(code(fusePlasma(BASE_URL, ADDRESS, "low", garbage)))
      .resolves.toBe("unavailable");
    await expect(fusePlasma(BASE_URL, ADDRESS, "low", garbage))
      .rejects.toThrow(/returned 502/);

    await expect(code(fusePlasma(
      BASE_URL,
      ADDRESS,
      "low",
      respond(200, { success: false })
    ))).resolves.toBe("unavailable");
  });
});
