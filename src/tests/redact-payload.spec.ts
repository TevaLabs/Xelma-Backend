import { describe, it, expect } from "@jest/globals";
import { redactDlqPayload } from "../utils/redact-payload";

describe("redactDlqPayload", () => {
  it("redacts sensitive keys and partial wallet addresses", () => {
    const redacted = redactDlqPayload({
      userId: "user-1",
      walletAddress: "GBZXN7KW34J5XFG2EXAMPLE9QRA",
      apiKey: "sk-live-secret",
      nested: { authorization: "Bearer abc.def.ghi" },
    }) as Record<string, unknown>;

    expect(redacted.apiKey).toBe("[REDACTED]");
    expect(redacted.walletAddress).toMatch(/^GBZX…9QRA$/);
    expect((redacted.nested as Record<string, unknown>).authorization).toBe(
      "Bearer [REDACTED]",
    );
  });
});
