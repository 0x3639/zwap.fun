import { describe, it } from "vitest";

// TODO(Task 11): rebuild the end-to-end happy path on Zenon HTLCs.
//
// The Cashu version of this suite drove the whole stack — `GranolaTradeApi`,
// `CashuTradeClient`, the wallet repository and the proof-reservation store —
// none of which exist any more. `src/api/trade-api.ts` is Task 11's file and is
// still red, so the suite cannot be rewritten here without reaching into
// another task's code. It is parked as a skipped placeholder so that the
// package typechecks; the full Cashu original is preserved in git at
// 291dbcd:src/trade/happy-path.integration.test.ts and is the starting point
// for the Zenon rewrite (two `ZwapCoordinatorEffects` over one `FakeZenonNode`,
// one `FundsReservationRepository` per participant).

describe.skip("granola atomic swap happy path", () => {
  it("settles a full maker/taker session end to end", () => {
    throw new Error("Not implemented until the Zenon trade API lands");
  });
});
