import { describe, expect, it } from "@jest/globals";
import {
  batchSubmitPredictionsSchema,
  submitPredictionSchema,
} from "../schemas/predictions.schema";

/**
 * Unit-level guard for the batch-submit size contract documented on
 * `POST /api/predictions/batch-submit` (OpenAPI): between 1 and 50 predictions,
 * each on a distinct round.
 *
 * These run without a database or HTTP server so a regression in the Zod
 * boundaries fails fast and unambiguously, independently of the route tests
 * in `batch-routes.spec.ts`.
 */
describe("batchSubmitPredictionsSchema", () => {
  function makePrediction(index: number) {
    return { roundId: `round-${index}`, amount: 10, side: "UP" as const };
  }

  function issuePaths(payload: unknown): string[] {
    const result = batchSubmitPredictionsSchema.safeParse(payload);
    expect(result.success).toBe(false);
    return result.success ? [] : result.error.issues.map((issue) => issue.path.join("."));
  }

  function issueMessages(payload: unknown): string[] {
    const result = batchSubmitPredictionsSchema.safeParse(payload);
    expect(result.success).toBe(false);
    return result.success ? [] : result.error.issues.map((issue) => issue.message);
  }

  it("accepts a batch of exactly 50 predictions (upper boundary)", () => {
    const predictions = Array.from({ length: 50 }, (_, i) => makePrediction(i));

    const result = batchSubmitPredictionsSchema.safeParse({ predictions });

    expect(result.success).toBe(true);
  });

  it("rejects a batch of 51 predictions with a max-size error on `predictions`", () => {
    const predictions = Array.from({ length: 51 }, (_, i) => makePrediction(i));

    expect(issuePaths({ predictions })).toContain("predictions");
    expect(issueMessages({ predictions })).toContain(
      "Maximum 50 predictions per batch",
    );
  });

  it("rejects an empty batch with a min-size error on `predictions`", () => {
    expect(issuePaths({ predictions: [] })).toContain("predictions");
    expect(issueMessages({ predictions: [] })).toContain(
      "At least one prediction is required",
    );
  });

  it("rejects a batch with duplicate round IDs", () => {
    const payload = {
      predictions: [makePrediction(1), makePrediction(1)],
    };

    expect(issueMessages(payload)).toContain(
      "Duplicate round IDs are not allowed in a batch",
    );
  });

  it("requires a non-empty roundId and a positive amount on each entry", () => {
    const payload = {
      predictions: [{ roundId: "", amount: -5, side: "UP" }],
    };

    const messages = issueMessages(payload);
    expect(messages).toEqual(
      expect.arrayContaining(["Round ID is required", "Invalid amount"]),
    );
  });

  it("allows the documented amount/side item shape", () => {
    const result = submitPredictionSchema.safeParse({
      roundId: "round-1",
      amount: 10,
      side: "UP",
    });

    expect(result.success).toBe(true);
  });
});
